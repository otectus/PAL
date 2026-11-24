import { deviceRole, lapsed, workingProfile } from '../authority.ts';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { TextDecoder } from 'node:util';
import { open } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { Core } from '../core.ts';
import { remoteError, busy } from '../execution.ts';
import { RemoteStore } from './store.ts';
import type { Device } from './store.ts';
import { Identity, addresses, addressCandidates } from './identity.ts';
import { Pairing } from './pairing.ts';
import { Discovery, announceable } from './discovery.ts';
import { Wake } from './wake.ts';
import { BrowserCompanion, browserMethods, browserOfferRequest, browserLimits } from './browser.ts';
import { Router, safeError } from './router.ts';
import { digest, verified, parsePairing } from './crypto.ts';
import { endpointOrigin } from '../compatible-endpoint.ts';
import { helloSchema, pairResponseSchema, requestSchema, methods, mutations, needsProof, availableOperations, operationAllowed, protocolFeatures } from './schemas.ts';
import { RemoteStore as Registry } from './store.ts';
import { buildIdentity, brokerBuildLabel } from '../build-info.ts';
import { isApiProvider } from '../provider-catalog.ts';
import { mobileMessage } from './transcript.ts';

type Peer = {/** Which listener it came through: a device of one surface is unknown on the other. */surface:'mobile'|'browser';realtime?:{id:string;key:Buffer};socket:WebSocket;device?:Device;hello?:any;challenge?:any;authSessionId?:string;expiresAt:number;subscribed:boolean;selected?:string;
  challenges:Map<string,any>;inFlight:number;timer:NodeJS.Timeout;alive:boolean;pingAt:number;
  /** A phone waiting on its network-return pairing answer: told when the desktop confirms or the offer ends. */
  pairingId?:string;
  /** What this connection's client declared it understands (client.features), and the role it negotiated. */
  clientFeatures?:Set<string>;connectionRole?:'owner'};

export class MobileGateway {
  core:Core;registry:RemoteStore;identity:Identity;pairing:Pairing;router:Router;discovery=new Discovery();wake:Wake;browser=new BrowserCompanion(this);
  servers:Server[]=[];wsServers:WebSocketServer[]=[];peers=new Set<Peer>();closed=false;
  /** Work this gateway started that can touch Core or the store: frame handlers, media, maintenance, revocation. */
  work=new Set<Promise<unknown>>();
  closing?:Promise<void>;
  private stagingInitialized=false;
  /** Owned work still running when close stopped waiting; reported by shutdown, never awaited forever. */
  unsettled=0;
  static closeDrainMs=5000;
  heartbeat:NodeJS.Timeout;stateTimer?:NodeJS.Timeout;
  lifecycle=Promise.resolve();
  bindings=new Map<string,{server:Server;ws:WebSocketServer}>();
  networkError:string|undefined;
  availableAddresses=()=>Object.values(networkInterfaces()).flat().filter(Boolean).map(info=>info!.address);

  constructor(core:Core) {
    this.core=core;this.registry=new RemoteStore(core.store);this.identity=new Identity(this.registry);this.pairing=new Pairing(this.registry,this.identity);
    this.router=new Router(core,this.registry,id=>this.track(this.revoke(id)).then(()=>{}));
    this.wake=new Wake(this.registry);this.wake.changed=()=>this.presence();this.wake.connected=id=>[...this.peers].some(peer=>peer.device?.id===id&&peer.subscribed);this.router.wake=this.wake;
    this.router.scopeReduced=id=>{void this.track(this.reduced(id)).catch(()=>{});};
    this.router.roleChange=params=>this.pairing.setRole(params);
    this.router.roleReduced=(id,wasOwner)=>{void this.track(this.reduced(id,wasOwner)).catch(()=>{});};
    // Terminal frames go to owner sessions watching that terminal. A phone more than 1 MiB behind skips screen
    // deltas (it sees the revision gap and rereads a snapshot) instead of queueing them without bound.
    this.router.terminals.send=(deviceId,name,data,screen)=>{for(const peer of this.peers)if(peer.subscribed&&peer.device?.id===deviceId&&peer.connectionRole==='owner'&&peer.clientFeatures?.has('terminal.v1')){if(screen&&peer.socket.bufferedAmount>1024*1024)continue;this.event(peer,name,data);}};
    this.router.terminals.owners=()=>[...new Set([...this.peers].filter(peer=>peer.subscribed&&peer.device&&peer.connectionRole==='owner'&&peer.clientFeatures?.has('terminal.v1')).map(peer=>peer.device!.id))];
    this.router.ownerOps.admin={
      devices:()=>this.registry.devices(),
      setProfile:params=>{const device=this.pairing.setProfile(params);this.router.recheckActions();this.core.changed();return device;},
      setRole:params=>this.local('remote.setRole',params).then(()=>this.registry.device((params as any).id)!),
      revoke:id=>this.revoke(id).then(()=>{}),
    };
    // A capture's progress goes to the phones of the device that started it.
    this.router.captures.changed=(deviceId,dto)=>{for(const peer of this.peers)if(peer.subscribed&&peer.device?.id===deviceId)this.event(peer,'capture.updated',dto);};
    core.remoteAuthority=(execution,session)=> {
      const device=this.registry.live(execution.deviceId);
      if(!device||!this.registry.config().enabled||device.scopeVersion!==execution.scopeVersion)return false;
      // An owner snapshot needs a device that is still an owner; any role change also changed its scope version.
      if(deviceRole(execution.role)==='owner'&&deviceRole(device.role)!=='owner')return false;
      return this.router.projectFor(device,session.cwd)?.id===execution.projectId&&this.router.inScope(device,session)&&(!isApiProvider(session.provider)||this.router.apiAccess(device,session.provider,session).remoteExecution);
    };
    core.remoteProfile=deviceId=>{const device=this.registry.live(deviceId);return device&&deviceRole(device.role)==='owner'?workingProfile(device.profile):undefined;};
    core.on('realtime',this.onRealtime);
    core.on('changed',this.onChanged);core.on('state',this.onState);core.on('message',this.onMessage);core.on('notice',this.onNotice);
    this.heartbeat=setInterval(()=>{void this.track(this.maintain()).catch(()=>{});},20000);this.heartbeat.unref();this.presence();
  }
  /** Remembers owned work until it settles, so close can let it finish before Core closes the store. */
  track<T>(work:Promise<T>):Promise<T> {
    this.work.add(work);
    const forget=()=>{this.work.delete(work);};work.then(forget,forget);
    return work;
  }
  // Scope and pause enforcement follow every change at once, ahead of the paced state snapshot.
  onRealtime=(value:{sessionId:string;event:import('../realtime/contracts.ts').RealtimeEvent})=> {
    for(const peer of this.peers) {
      const active=peer.realtime;
      if(!active||active.id!==value.sessionId||!peer.device)continue;
      if(value.event.type==='audio') {
        if(peer.socket.bufferedAmount>1024*1024){this.core.realtime.transport.stop(active.id);continue;}
        peer.socket.send(this.core.realtime.transport.mobileOutputFrame(active.id,peer.device.id,active.key,value.event.audio),{binary:true});
      } else {
        this.event(peer,'realtime.event',value);
        if(value.event.type==='state'&&value.event.state==='closed'){active.key.fill(0);peer.realtime=undefined;}
      }
    }
  };
  private async realtimeOperation(peer:Peer,device:Device,method:string,p:any) {
    if(method==='owner.realtime.start'){
      if(peer.realtime)throw new Error('Stop the current realtime session first');
      const authorize=()=>{
        const current=this.registry.live(device.id);
        if(!current||!this.registry.config().enabled||peer.expiresAt<Date.now()||peer.socket.readyState!==WebSocket.OPEN||
          current.scopeVersion!==device.scopeVersion||deviceRole(current.role)!=='owner'||peer.connectionRole!=='owner'||
          !peer.clientFeatures?.has('realtime.audio.v1')) throw remoteError('AUTH_REVOKED','Realtime access ended.');
        this.router.session({...current,connectionRole:'owner'},p.conversationId);
      };
      const conversation=this.router.session(device,p.conversationId);
      const result=await this.core.realtime.start(p,authorize,this.router.execution(device,this.router.projectFor(device,conversation.cwd)));
      peer.realtime={id:result.sessionId,key:randomBytes(32)};
      return result;
    }
    if(!peer.realtime||peer.realtime.id!==p.sessionId)throw remoteError('SCOPE_DENIED','This connection does not own that realtime session.');
    this.core.realtime.check(p.sessionId);
    if(method==='owner.realtime.offer')return {...this.core.realtime.transport.mobileOffer(p.sessionId),frameKey:peer.realtime.key.toString('base64url')};
    return this.core.realtime.rpc(method.slice(6),p);
  }
  onChanged=()=> {
    this.router.recheckActions();
    if(this.core.settings.paused)for(const session of this.core.store.sessions())if(session.remote){this.core.abortActions(session.id,remoteError('POLICY_PAUSED','Desktop actions are paused.'));if(session.provider!=='ollama'&&busy(session)&&!this.core.stopping.has(session.id))void this.core.stop(session.id).catch(()=>{});}
  };
  onState=()=> {
    if(this.closed||this.stateTimer)return;
    this.stateTimer=setTimeout(()=>{this.stateTimer=undefined;for(const peer of this.peers)if(peer.subscribed&&peer.device)this.event(peer,'snapshot.changed',{});},250);this.stateTimer.unref();
  };
  onMessage=(message:any)=> {
    for(const peer of this.peers)if(peer.subscribed&&peer.device) {
      try{this.router.session(peer.device,message.sessionId);this.event(peer,'message.upsert',mobileMessage(this.core.store,message.sessionId,message.id));}catch{}
    }
  };
  // Completion, failure and stop notices for in-scope sessions, plus timers this phone's projects set,
  // so the phone can raise its own alerts. Text stays generic: provider error detail remains in Activity.
  onNotice=(notice:any)=> {
    this.wakePhones(notice);
    for(const peer of this.peers)if(peer.subscribed&&peer.device) {
      const device=peer.device;
      try {
        if(['complete','error','interrupted'].includes(notice?.kind)&&typeof notice.sessionId==='string') {
          const session=this.router.session(device,notice.sessionId);
          this.event(peer,'notice',{kind:notice.kind,sessionId:session.id,title:String(session.title||'').slice(0,100)});
        } else if(notice?.kind==='timer'&&typeof notice.remoteProjectId==='string') {
          const project=this.router.projects(device).find(p=>p.id===notice.remoteProjectId);
          if(!project||!device.caps.includes('desktop.control')||!device.categories.includes('timers'))continue;
          this.event(peer,'notice',{kind:'timer',projectId:project.id,timerId:String(notice.timerId||''),label:String(notice.text||'Timer').slice(0,200)});
        }
      } catch {}
    }
  };
  /**
   * A phone that asked to be woken, has no connection and may see what happened gets one contentless hint (wake.ts).
   * The same rules decide it as decide what a connected phone is shown.
   */
  private wakePhones(notice:any) {
    if(this.closed||this.core.closed||!this.registry.config().enabled)return;
    for(const device of this.registry.devices()) {
      if(!device.wake?.approved||device.replacementPending||!this.registry.live(device.id)||this.wake.connected(device.id))continue;
      try {
        if(['approval','complete','error','interrupted'].includes(notice?.kind)&&typeof notice.sessionId==='string') {
          if(notice.kind==='approval'&&!device.caps.includes('approvals.answer'))continue;
          this.router.session(device,notice.sessionId);
        } else if(notice?.kind==='timer'&&typeof notice.remoteProjectId==='string') {
          if(!this.router.projects(device).some(p=>p.id===notice.remoteProjectId)||!device.caps.includes('desktop.control')||!device.categories.includes('timers'))continue;
        } else continue;
      } catch {continue;}
      void this.track(this.wake.hint(device.id)).catch(()=>{});
    }
  }
  event(peer:Peer,name:string,data:any) {
    if(!peer.device||this.closed)return;
    try{this.router.current(peer.device);}catch(error){peer.socket.close(4003,(error as any)?.code||'AUTH_REVOKED');return;}
    this.registry.journal(peer.device.id,{name,...(name==='message.upsert'?{messageId:data.id}:{} )});
    this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:this.router.cursor(peer.device),name,resourceRevision:String(data.revision ?? data.rev ?? '1'),data});
  }
  send(peer:Peer,value:unknown) {
    if(peer.socket.readyState!==WebSocket.OPEN)return;
    const data=JSON.stringify(value);
    if(Buffer.byteLength(data)>1024*1024){peer.socket.close(4009,'LIMIT_EXCEEDED');return;}
    if(peer.socket.bufferedAmount+Buffer.byteLength(data)>8*1024*1024){peer.socket.close(4008,'SLOW_CONSUMER');return;}
    peer.socket.send(data);
  }
  presence() {
    // A socket closing during or after shutdown must not reach a store that is closing.
    if(this.closed||this.core.closed)return;
    this.core.remoteStatus={enabled:this.registry.config().enabled,listening:this.servers.length>0,listeningAddresses:[...this.bindings.keys()],waitingForNetwork:this.registry.config().enabled&&!this.servers.length,networkError:this.networkError,connected:[...new Map([...this.peers].filter(p=>p.device).map(p=>[p.device!.id,{id:p.device!.id,name:p.device!.name}])).values()],
      activeTurns:this.core.store.sessions().filter(s=>s.remote&&busy(s)).map(s=>({sessionId:s.id,deviceId:s.remote!.deviceId,project:s.cwd})),
      // The live network-return offer: whether a phone has answered and the six words to compare.
      pairing:this.pairing.status(),
      // The opt-in announcement on the local network: where it is made now, and why it is not.
      discovery:{active:this.discovery.active,...(this.discovery.problem?{problem:this.discovery.problem}:{})},
      browser:this.browser.status()};
    if(!this.closed)this.core.changed();
  }
  async start() {this.lifecycle=this.lifecycle.catch(()=>{}).then(()=>this.refresh());return this.lifecycle;}
  /**
   * The gateway listens while remote access is on for a live paired device, or while a network-return
   * pairing offer the owner just prepared is live (five minutes at most), when it accepts only that
   * offer's signed answer before confirmation.
   */
  shouldListen() {return this.registry.config().enabled&&this.registry.devices().some(d=>d.surface!=='browser'&&this.registry.live(d.id))||!!this.pairing.networkWindow();}
  /** Tells phones waiting on these offers that they ended, and why. */
  pairEnded(ids:string[],reason:'expired'|'cancelled'|'replaced'|'contested') {
    for(const peer of this.peers)if(peer.pairingId&&ids.includes(peer.pairingId)&&!peer.device){this.send(peer,{v:1,type:'pair.closed',reason});peer.socket.close(1000,'PAIR_CLOSED');}
  }
  pairConfirmed(id:string|undefined) {
    if(!id)return;
    for(const peer of this.peers)if(peer.pairingId===id&&!peer.device){this.send(peer,{v:1,type:'pair.confirmed'});peer.socket.close(1000,'PAIR_CONFIRMED');}
  }
  async refresh() {
    if(this.closed)return;
    if (!this.stagingInitialized) { await this.router.transfers.resetStaging(); this.stagingInitialized=true; }
    await this.completeReplacements();await this.browser.refresh();
    const config=this.registry.config();
    if(!this.shouldListen()) {await this.stopListeners();this.presence();return;}
    const available=this.availableAddresses(),wanted=config.addresses.filter(address=>available.includes(address));
    for(const address of [...this.bindings.keys()])if(!wanted.includes(address))await this.stopBinding(address);
    this.networkError=undefined;
    if(!wanted.length){await this.announce();this.presence();return;}
    try {await this.identity.ensure(config);} catch(error) {this.networkError=(error as Error).message;this.presence();return;}
    const material=this.identity.material();
    for(const address of wanted) {
      if(this.bindings.has(address))continue;
      try {
        const https=createServer({key:material.key,cert:material.cert,minVersion:'TLSv1.2',maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(_req,res)=>{res.writeHead(404);res.end();});
        const ws=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:1024*1024,handleProtocols:protocols=>protocols.has('cere.mobile.v1')?'cere.mobile.v1':false});
        https.on('upgrade',(request,socket,head)=>{
          const allowed=(this.registry.config().enabled||!!this.pairing.networkWindow())&&request.url==='/mobile/v1'&&!request.headers.origin&&request.headers['sec-websocket-protocol']==='cere.mobile.v1'&&this.peers.size<10;
          if(!allowed){socket.destroy();return;}
          ws.handleUpgrade(request,socket,head,client=>this.connection(client));
        });
        this.bindings.set(address,{server:https,ws});this.servers.push(https);this.wsServers.push(ws);
        await new Promise<void>((resolve,reject)=>{https.once('error',reject);https.listen(config.port,address,()=>{https.off('error',reject);https.on('error',error=>{if(this.bindings.get(address)?.server!==https)return;this.networkError=error.message;void this.stopBinding(address,https).then(()=>this.presence());});resolve();});});
        if(this.closed||!this.shouldListen())await this.stopBinding(address);
      } catch(error){await this.stopBinding(address);this.networkError=(error as Error).message;}
    }
    await this.announce();this.presence();
  }
  /** Announces the gateway's local addresses while the owner chose that and a paired phone may connect; nothing otherwise. */
  private async announce() {
    const config=this.registry.config(),addresses=[...this.bindings.keys()].filter(announceable);
    const wanted=!this.closed&&config.enabled&&config.discovery===true&&this.registry.devices().some(d=>d.surface!=='browser'&&this.registry.live(d.id))&&addresses.length>0;
    await this.discovery.set(wanted?{id:this.identity.id,major:1,port:config.port,addresses}:undefined).catch(error=>{this.discovery.problem=String(error?.message||error).slice(0,200);});
  }
  connection(socket:WebSocket,surface:'mobile'|'browser'='mobile') {
    const peer:Peer={surface,socket,expiresAt:0,subscribed:false,challenges:new Map(),inFlight:0,alive:true,pingAt:Date.now(),timer:setTimeout(()=>socket.close(4001,'UNAUTHENTICATED'),10000)};
    peer.timer.unref();this.peers.add(peer);
    socket.on('error',()=>{});socket.on('pong',()=>{peer.alive=true;});
    socket.on('close',()=>{if(peer.realtime){peer.realtime.key.fill(0);this.core.realtime.transport.stop(peer.realtime.id);}clearTimeout(peer.timer);peer.challenges.clear();this.peers.delete(peer);if(peer.device)this.router.terminals.disconnected(peer.device.id,[...this.peers].some(other=>other.device?.id===peer.device!.id));if(!this.closed)this.presence();});
    socket.on('message',(data,isBinary)=> {
      if(peer.device&&peer.expiresAt<Date.now()){socket.close(4001,'AUTH_EXPIRED');return;}
      const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as any);
      if(bytes.length>(peer.device?1024*1024:8192)||peer.inFlight>=8){socket.close(4009,'LIMIT_EXCEEDED');return;}
      if(isBinary) {
        if(!peer.device||peer.surface==='browser'){socket.close(4001,'UNAUTHENTICATED');return;}
        if(bytes.subarray(0,4).toString('ascii')==='PLRT'){
          try{
            if(!peer.realtime)throw new Error('No active realtime session');
            this.core.realtime.check(peer.realtime.id);
            this.core.realtime.transport.ingestMobileFrame(peer.device.id,bytes,peer.realtime.key,peer.realtime.id);
          }catch{socket.close(4009,'REALTIME_FRAME_INVALID');}
          return;
        }
        peer.inFlight++;
        // An owner phone's artifact upload (transfers.ts) or, otherwise, an attachment chunk (media.ts).
        const transfer=peer.connectionRole==='owner'&&peer.clientFeatures?.has('artifacts.transfer.v1')&&this.router.transfers.claims(peer.device,bytes);
        void this.track(this.core.withMutation<unknown>(()=>transfer?this.router.transfers.chunk(peer.device!,bytes):this.router.media.chunk(peer.device!,bytes)).then(progress=>this.event(peer,transfer?'transfer.progress':'attachment.progress',progress)).catch(()=>socket.close(4009,'ATTACHMENT_INVALID')).finally(()=>peer.inFlight--));return;
      }
      let frame:any;
      try{frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{socket.close(4000,'INVALID_ARGUMENT');return;}
      peer.inFlight++;
      // Tracked with its error handling, which can still write an audit record.
      void this.track(this.frame(peer,frame).catch(error=>{
        if(!peer.device){if(!this.core.recovery.pending&&!this.core.closed)this.registry.audit({operation:'auth.failed',decision:'denied'});socket.close(4001,'UNAUTHENTICATED');}
        else this.send(peer,{v:1,type:'response',id:frame?.id||null,error:safeError(error)});
      }).finally(()=>peer.inFlight--));
    });
  }
  async frame(peer:Peer,frame:any) {
    if(this.closed)throw remoteError('REMOTE_DISABLED','The desktop gateway is shutting down.');
    return this.core.withMutation(()=>this.frameInner(peer,frame));
  }
  private async frameInner(peer:Peer,frame:any) {
    if(!peer.device) {
      if(peer.surface==='browser'&&!peer.hello&&!peer.pairingId&&(frame.type==='browser.offer'||frame.type==='browser.pair')) {this.browserPairing(peer,frame);return;}
      if(peer.surface==='mobile'&&frame.type==='pair.response'&&!peer.hello&&!peer.pairingId) {
        const {response}=pairResponseSchema.parse(frame);
        // A phone checking an answer the desktop already confirmed learns so at once.
        if(this.pairing.confirmedDevice(response)){this.send(peer,{v:1,type:'pair.confirmed'});peer.socket.close(1000,'PAIR_CONFIRMED');return;}
        let entry;
        try {entry=this.pairing.receive(response);}
        catch(error:any) {
          let pairingId:string|undefined;try{pairingId=(parsePairing(response) as any)?.pairingId;}catch{}
          this.send(peer,{v:1,type:'pair.closed',reason:error?.code==='AUTH_EXPIRED'?'expired':'refused',message:safeError(error).message});peer.socket.close(1000,'PAIR_CLOSED');
          if(pairingId&&this.pairing.received.get(pairingId)?.contested)this.pairEnded([pairingId],'contested');
          this.presence();return;
        }
        // The phone waits on this socket, past the usual sign-in deadline, until the desktop decides or the offer ends.
        peer.pairingId=entry.pairingId;clearTimeout(peer.timer);
        peer.timer=setTimeout(()=>{this.send(peer,{v:1,type:'pair.closed',reason:'expired'});peer.socket.close(1000,'PAIR_CLOSED');},Math.max(1000,entry.expiresAt-Date.now()+1000));peer.timer.unref();
        this.send(peer,{v:1,type:'pair.received',pairingId:entry.pairingId,expiresAt:entry.expiresAt});this.presence();return;
      }
      if(peer.pairingId)throw remoteError('UNAUTHENTICATED','Authentication failed.');
      if(frame.type==='hello'&&!peer.hello) {
        const hello=helloSchema.parse(frame),device=this.registry.live(hello.deviceId);
        // An incompatible hello says which side needs updating; it reveals nothing about the device.
        if(hello.protocolMin>0){peer.socket.close(4010,'INCOMPATIBLE_CLIENT_NEWER');return;}
        if(hello.protocolMax<0){peer.socket.close(4010,'INCOMPATIBLE_CLIENT_OLDER');return;}
        if(!device||(device.surface||'mobile')!==peer.surface||device.replacementPending||hello.desktopId!==this.identity.id||[...this.peers].filter(p=>p.device?.id===device.id).length>=2)throw remoteError('UNAUTHENTICATED','Authentication failed.');
        peer.hello=hello;peer.challenge={challengeId:randomUUID(),serverNonce:randomBytes(32).toString('base64url'),epoch:this.registry.epoch,audience:this.identity.id,expiresAt:Date.now()+30000};
        this.send(peer,{v:1,type:'auth.challenge',...peer.challenge});return;
      }
      const reply=z.strictObject({v:z.literal(1),type:z.literal('auth'),challengeId:z.uuid(),signature:z.string().max(100)}).parse(frame);
      const hello=peer.hello,challenge=peer.challenge;peer.challenge=undefined;
      const device=hello?this.registry.live(hello.deviceId):undefined;
      const transcript={domain:'cere.mobile.auth.v1',helloDigest:hello?digest(hello):'',challenge,desktopId:this.identity.id,deviceId:device?.id,keyVersion:1,epoch:this.registry.epoch};
      if(!device||(device.surface||'mobile')!==peer.surface||device.replacementPending||!challenge||challenge.expiresAt<Date.now()||reply.challengeId!==challenge.challengeId||!verified(device.connectionKey,transcript,reply.signature)||!this.registry.config().enabled||[...this.peers].filter(p=>p.device?.id===device.id).length>=2)throw remoteError('UNAUTHENTICATED','Authentication failed.');
      peer.device=device;peer.authSessionId=randomUUID();peer.expiresAt=Date.now()+15*60000;clearTimeout(peer.timer);
      device.lastSeen=Date.now();this.registry.saveDevice(device);
      const build=buildIdentity();
      this.send(peer,{v:1,type:'welcome',desktopId:this.identity.id,brokerBuild:brokerBuildLabel(build),build:{version:build.version,commit:build.commit,dirty:build.dirty},authSessionId:peer.authSessionId,expiresAt:peer.expiresAt,epoch:this.registry.epoch,scopeVersion:device.scopeVersion,protocol:{major:1,minor:1},features:[...protocolFeatures],operations:this.offered(peer,availableOperations(device.caps,Registry.effectiveRole(device))),role:deviceRole(device.role),sendAuthentication:'connection-key',actionAuthentication:device.actionAuthentication||'biometric',limits:{maxFrameBytes:1024*1024,maxMessageLength:100000,maxAttachments:4}});
      this.registry.audit({deviceId:device.id,operation:'auth',decision:'connected'});this.presence();return;
    }
    const request=requestSchema.parse(frame),device=this.router.current(peer.device);
    // The stored record never carries the connection's negotiated role; each request's copy does.
    device.connectionRole=peer.connectionRole;
    if(peer.expiresAt<Date.now()){peer.socket.close(4001,'AUTH_EXPIRED');return;}
    if(peer.surface==='browser'&&!browserMethods.has(request.method))throw remoteError('SCOPE_DENIED','A browser cannot do this. Use the desktop or a paired phone.');
    const schema=methods[request.method];if(!schema)throw remoteError('INVALID_ARGUMENT','Unknown mobile operation.');
    const params:any=schema.parse(request.params),method=request.method,now=Date.now();
    // One descriptor table decides both welcome's operation list and this check (schemas.ts).
    const role=Registry.effectiveRole(device);
    // A retried mutation is answered from the ledger first, so an old command ID keeps its (possibly redacted)
    // outcome after a grant change and can never run again; only then does the current descriptor decide.
    const refuse=()=>{throw remoteError('SCOPE_DENIED',deviceRole(device.role)==='owner'&&role!=='owner'?'Update PAL Mobile to use this desktop feature from your phone.':role==='observer'?'This phone observes only: it can read, Stop and Deny.':'This phone is not granted this operation.');};
    if(!mutations.has(method)&&!operationAllowed(method,device.caps,role,peer.clientFeatures))refuse();
    if(method==='client.features') {
      // A connection negotiates once what it understands. An owner phone acts as an owner only when its
      // client declared owner policy; an older client keeps the limited behaviour it can display.
      peer.clientFeatures=new Set(params.features);
      peer.connectionRole=deviceRole(device.role)==='owner'&&peer.clientFeatures.has('owner.policy.v1')?'owner':undefined;
      device.connectionRole=peer.connectionRole;
      const negotiated=Registry.effectiveRole(device);
      this.registry.audit({deviceId:device.id,authSessionId:peer.authSessionId,operation:'client.features',decision:negotiated,scopeVersion:device.scopeVersion});
      this.send(peer,{v:1,type:'response',id:request.id,result:{role:negotiated,storedRole:deviceRole(device.role),operations:this.offered(peer,availableOperations(device.caps,negotiated,peer.clientFeatures)),features:[...protocolFeatures],access:this.router.permissions(device).access}});
      return;
    }
    if(method==='commands.challenge') {
      if(!mutations.has(params.method)||peer.surface==='browser'&&!browserMethods.has(params.method))throw remoteError('INVALID_ARGUMENT','Only a supported mutation can be authenticated.');
      for(const[id,c]of peer.challenges)if(c.expiresAt<now)peer.challenges.delete(id);
      if(peer.challenges.size>=4)throw remoteError('LIMIT_EXCEEDED','Too many pending action challenges.');
      const challenge={challengeId:randomUUID(),nonce:randomBytes(32).toString('base64url'),expiresAt:now+30000};peer.challenges.set(challenge.challengeId,{...challenge,...params});
      this.send(peer,{v:1,type:'response',id:request.id,result:challenge});return;
    }
    if(mutations.has(method)) {
      if(!request.commandId)throw remoteError('INVALID_ARGUMENT','A mutation requires a command ID.');
      const prior=this.registry.prior(device.id,request.commandId,method,request.params);
      if(prior){this.send(peer,{v:1,type:'response',id:request.id,...(prior.status==='failed'?{error:prior.error}:{result:prior.result??prior})});return;}
      if(!operationAllowed(method,device.caps,role,peer.clientFeatures))refuse();
      if(needsProof(method,params)) {
        const proof=request.proof,challenge=proof?peer.challenges.get(proof.challengeId):undefined;
        if(proof)peer.challenges.delete(proof.challengeId);
        const transcript={domain:'cere.mobile.action.v1',desktopId:this.identity.id,deviceId:device.id,keyVersion:device.keyVersion,scopeVersion:device.scopeVersion,epoch:this.registry.epoch,authSessionId:peer.authSessionId,challengeId:challenge?.challengeId,nonce:challenge?.nonce,method,paramsDigest:digest(request.params),commandId:request.commandId};
        const signatureValid=!!proof&&(verified(device.actionKey,transcript,proof.signature)||(method==='sessions.send'&&verified(device.connectionKey,transcript,proof.signature)));
        if(!challenge||challenge.expiresAt<now||challenge.method!==method||challenge.paramsDigest!==digest(request.params)||challenge.commandId!==request.commandId||!signatureValid)throw remoteError('UNAUTHENTICATED','Review and authenticate the exact operation again.');
      }
      this.registry.accept(device.id,request.commandId,method,request.params);
      this.registry.audit({deviceId:device.id,authSessionId:peer.authSessionId,commandId:request.commandId,operation:method,argsDigest:digest(request.params),decision:'authorized',scopeVersion:device.scopeVersion,policyRevision:this.core.store.get('settingsRevision','0'),sessionId:params.sessionId,projectId:params.projectId});
    }
    try {
      const result=method.startsWith('owner.realtime.')?await this.realtimeOperation(peer,device,method,params):await this.router.dispatch(device,method,params,request.commandId);
      if(!mutations.has(method))this.router.current(device);
      if(method==='sync.open'){peer.subscribed=true;peer.selected=params.selectedSessionId;}
      if(mutations.has(method)&&method!=='sessions.send')this.registry.finish(device.id,request.commandId!,{status:'completed',result});
      if(mutations.has(method))this.registry.audit({deviceId:device.id,commandId:request.commandId,operation:method,decision:'completed'});
      if(Buffer.isBuffer(result)) {
        if(peer.socket.bufferedAmount+result.length>8*1024*1024){peer.socket.close(4008,'SLOW_CONSUMER');return;}
        peer.socket.send(result,{binary:true});this.send(peer,{v:1,type:'response',id:request.id,result:{bytes:result.length-24}});
      } else this.send(peer,{v:1,type:'response',id:request.id,result});
    } catch(error) {
      if(mutations.has(method)){this.registry.finish(device.id,request.commandId!,{status:(error as any)?.code==='OUTCOME_UNKNOWN'?'unknown':'failed',error:safeError(error)});this.registry.audit({deviceId:device.id,commandId:request.commandId,operation:method,decision:(error as any)?.code==='OUTCOME_UNKNOWN'?'unknown':'failed'});}
      throw error;
    }
  }
  /** What a connection is told it may call: for a browser, only what a browser may. */
  private offered(peer:Peer,operations:string[]) {return peer.surface==='browser'?operations.filter(method=>browserMethods.has(method)):operations;}
  /** Before a browser is paired: it may read the open offer, and answer it once. */
  private browserPairing(peer:Peer,frame:any) {
    const closed=(reason:string,message='')=>{this.send(peer,{v:1,type:'pair.closed',reason,...(message?{message}:{})});peer.socket.close(1000,'PAIR_CLOSED');};
    if(frame.type==='browser.offer') {browserOfferRequest.parse(frame);const offer=this.browser.offer();if(offer)this.send(peer,{v:1,type:'browser.offer',offer});else closed('none');return;}
    let received;
    try {received=this.browser.receive(frame);}
    catch(error:any) {closed(error?.code==='AUTH_EXPIRED'?'expired':'refused',safeError(error).message);return;}
    peer.pairingId=received.pairingId;clearTimeout(peer.timer);
    peer.timer=setTimeout(()=>closed('expired'),Math.max(1000,received.expiresAt-Date.now()+1000));peer.timer.unref();
    this.send(peer,{v:1,type:'pair.received',pairingId:received.pairingId,expiresAt:received.expiresAt});
  }
  async maintain() {
    if(this.closed||this.core.recovery.pending)return;
    for(const peer of this.peers) {
      if(peer.device&&(!this.registry.live(peer.device.id)||peer.expiresAt<Date.now())){peer.socket.close(4003,'AUTH_EXPIRED');continue;}
      if(!peer.alive&&Date.now()-peer.pingAt>=20000){peer.socket.terminate();continue;}
      if(peer.alive&&Date.now()-peer.pingAt>=60000){peer.alive=false;peer.pingAt=Date.now();peer.socket.ping();}
    }
    const ended=this.pairing.end();if(ended.length){this.pairEnded(ended,'expired');this.presence();}
    this.registry.prune();
    await this.router.media.purge();
    await this.router.transfers.prune();
    const config=this.registry.config();
    if(config.enabled||ended.length||this.pairing.networkWindow()||this.browser.window) {
      await this.start();
      if(config.enabled)for(const device of this.registry.devices())if(!device.revokedAt&&lapsed(device))await this.revoke(device.id);
      if(!this.shouldListen())await this.stopListeners();
    }
  }
  async stopOwned(deviceId?:string) {
    const sessions=this.core.store.sessions().filter(s=>s.remote&&(!deviceId||s.remote.deviceId===deviceId));
    await Promise.allSettled(sessions.map(async s=>{await this.core.stop(s.id);this.core.generations.set(s.id,(this.core.generations.get(s.id)||0)+1);const adapter=this.core.adapters.get(s.id);this.core.adapters.delete(s.id);for(const[token,id]of this.core.tokens)if(id===s.id)this.core.tokens.delete(token);let timer:NodeJS.Timeout|undefined;await Promise.race([adapter?.close(),new Promise<void>(resolve=>{timer=setTimeout(resolve,3000);})]).finally(()=>clearTimeout(timer));if(busy(this.core.store.session(s.id)))this.core.updateSession(s.id,{status:'interrupted'});}));
  }
  async stopBinding(address:string,expected?:Server) {
    const binding=this.bindings.get(address);if(!binding||(expected&&binding.server!==expected))return;
    this.bindings.delete(address);
    this.servers=this.servers.filter(server=>server!==binding.server);this.wsServers=this.wsServers.filter(ws=>ws!==binding.ws);
    for(const socket of binding.ws.clients)socket.terminate();
    await new Promise<void>(resolve=>{binding.server.close(()=>resolve());binding.server.closeAllConnections();});
    binding.ws.close();
  }
  async stopListeners() {
    await this.discovery.stop();
    for(const peer of this.peers)if(peer.surface==='mobile')peer.socket.terminate();
    await Promise.all([...this.bindings.keys()].map(address=>this.stopBinding(address)));
  }
  async disable() {
    this.pairEnded(this.pairing.end(true),'cancelled');
    this.registry.configure({...this.registry.config(),enabled:false});
    this.router.abortActions();
    for(const peer of this.peers)this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:'',resourceRevision:'1',name:'remote.disabled',data:{}});
    this.core.remoteView.end();
    this.browser.endWindow('cancelled');await this.browser.stop();
    await this.stopListeners();await this.stopOwned();this.registry.audit({operation:'remote.disable',decision:'disabled'});this.presence();
  }
  async reduced(id:string, lostOwner=false){
    this.router.abortActions(id);
    this.core.remoteView.end(id);
    for(const peer of this.peers)if(peer.device?.id===id)peer.socket.close(4003,'SCOPE_CHANGED');
    await this.stopOwned(id);
    if(lostOwner){this.releaseOwnerSessions(id);await this.router.terminals.revoked(id);}
    await this.router.media.purge(id);await this.router.transfers.purge(id);this.presence();
  }
  async revoke(id:string) {
    const device=this.registry.device(id);if(!device)throw new Error('Device not found');
    this.wake.forget(id);delete device.wake;
    device.revokedAt=Date.now();device.scopeVersion=String(BigInt(device.scopeVersion)+1n);this.registry.saveDevice(device);
    this.router.abortActions(id);
    for(const peer of this.peers)if(peer.device?.id===id){this.send(peer,{v:1,type:'event',eventId:randomUUID(),cursor:'',resourceRevision:'1',name:'device.revoked',data:{}});peer.socket.close(4003,'AUTH_REVOKED');}
    await this.stopOwned(id);this.releaseOwnerSessions(id);this.core.remoteView.end(id);await this.router.media.purge(id);await this.router.transfers.purge(id);await this.router.terminals.revoked(id);
    // Routines this phone authorized stop running unattended until another owner resumes them (PAL Everywhere §17.1).
    const pausedSchedules=this.core.schedules.deviceRevoked(id);this.core.oauth.deviceRevoked(id);this.core.accounts.deviceRevoked(id);
    this.registry.audit({deviceId:id,operation:'device.revoke',decision:'revoked',...(pausedSchedules.length?{reason:`paused ${pausedSchedules.length} routine(s)`}:{})});
    if(!this.shouldListen())await this.stopListeners();await this.browser.refresh();this.presence();
    return {revoked:true,pausedSchedules};
  }
  /**
   * An owner phone's conversations carry the desktop owner's authority, so when that phone is revoked or stops
   * being an owner, its stopped conversations return to the desktop (attributed in remoteOrigin) instead of
   * waiting for a local "Detach". A limited phone's conversations keep their sticky restricted provenance.
   */
  releaseOwnerSessions(deviceId:string) {
    for(const session of this.core.store.sessions())if(session.remote?.deviceId===deviceId&&deviceRole(session.remote.role)==='owner'&&!busy(session))
      this.core.updateSession(session.id,{remote:undefined,effectivePolicy:undefined,remoteOrigin:{deviceId,role:'owner',at:Date.now()}});
  }
  // The pairing transaction writes this marker together with old-key revocation.
  // Repeated startup/maintenance completes any interrupted ownership migration before
  // the new device can authenticate. Each stopped-session update is idempotent.
  async completeReplacements() {
    for(const device of this.registry.devices()) {
      if(!device.replacementPending||!device.replacesDeviceId||!this.registry.live(device.id))continue;
      this.router.abortActions(device.replacesDeviceId);
      for(const peer of this.peers)if(peer.device?.id===device.replacesDeviceId)peer.socket.close(4003,'PAIRING_REPLACED');
      await this.stopOwned(device.replacesDeviceId);
      this.core.remoteView.end(device.replacesDeviceId);this.wake.forget(device.replacesDeviceId);
      await this.router.terminals.revoked(device.replacesDeviceId);
      await this.router.transfers.purge(device.replacesDeviceId);
      for(const session of this.core.store.sessions())if(session.remote?.deviceId===device.replacesDeviceId) {
        const project=this.router.projectFor(device,session.cwd);
        if(project)this.core.updateSession(session.id,{remote:{...this.router.execution(device,project),role:deviceRole(session.remote.role)==='owner'&&deviceRole(device.role)==='owner'?'owner' as const:'limited' as const}});
      }
      const current=this.registry.live(device.id);
      if(current){current.replacementPending=false;this.registry.saveDevice(current);}
    }
  }
  async local(method:string,params:any={}) {
    switch(method) {
      case 'remote.status':return {...this.core.remoteStatus as object,config:this.registry.config(),desktopId:this.identity.id,devices:this.registry.devices().map(({connectionKey,actionKey,wake,...d})=>({...d,wake:this.wake.describe(wake),fingerprint:digest({connectionKey,actionKey})})),
        // For choosing at pairing instead of typing: this computer's addresses, the projects PAL knows
        // and the compatible connections a phone can be granted (origins only, never keys).
        addressCandidates:addressCandidates(),knownProjects:this.core.projects.list().sort((a:any,b:any)=>Number(!!b.favorite)-Number(!!a.favorite)||(b.updated||0)-(a.updated||0)).slice(0,24).map((project:any)=>({path:project.cwd,name:project.name})),
        apiConnections:this.core.chatConnections.list().filter(c=>c.kind!=='ollama'||c.ollama?.host==='https://ollama.com').map(({id,name,kind})=>({id,name,kind})),
        compatibleConnections:this.core.chatConnections.list().filter(connection=>connection.kind==='compatible'&&connection.compatible?.baseUrl).map(connection=>({id:connection.id,name:connection.name,origin:endpointOrigin(connection.compatible!.baseUrl),settingsDefault:!!connection.migrated})),
        pairing:this.pairing.status()};
      case 'remote.preparePair': {
        const before=this.pairing.networkWindow(),prepared=await this.pairing.prepare(params);
        if(before&&before.pairingId!==prepared.pairingId)this.pairEnded([before.pairingId],'replaced');
        // A network-return offer opens the listener for its lifetime; any other leaves it as it was.
        if(prepared.networkReturn)await this.start();
        this.presence();return prepared;
      }
      case 'remote.cancelPair': {this.pairEnded(this.pairing.end(true),'cancelled');await this.start();this.presence();return true;}
      // A phone can share its public signed response as a text file; read only the response URI from it.
      case 'remote.readPairResponse': {
        const path=z.string().min(1).max(4096).parse(params.path),file=await open(path,'r');
        let text='';try{const buffer=Buffer.alloc(16384);const {bytesRead}=await file.read(buffer,0,buffer.length,0);text=buffer.subarray(0,bytesRead).toString('utf8');}finally{await file.close();}
        const response=text.match(/cere-pair:\/\/v1\/[A-Za-z0-9_-]+/)?.[0];
        if(!response)throw new Error('This file does not contain a PAL pairing response.');
        return {response};
      }
      case 'remote.reviewPair': {const {response,sas,fingerprint,offer}=this.pairing.review(params.response);return {sas,fingerprint,name:response.name,actionAuthentication:offer.actionAuthentication||'biometric',accessRole:deviceRole(offer.accessRole),replacesDeviceId:offer.replacesDeviceId};}
      case 'remote.confirmPair': {
        let pairingId:string|undefined=typeof params?.pairingId==='string'?params.pairingId:undefined;
        if(!pairingId&&typeof params?.response==='string')try{pairingId=(parsePairing(params.response) as any)?.pairingId;}catch{}
        const device=this.pairing.confirm(params);
        await this.start();
        // The phone waiting on its answer finishes by itself, then signs in as the new device.
        this.pairConfirmed(pairingId);this.presence();return {id:device.id,name:device.name};
      }
      case 'remote.configureEndpoints': {
        const p=z.strictObject({addresses:z.array(z.string()),port:z.number().int().min(1024).max(65535).default(8443),confirmed:z.literal(true)}).parse(params);
        const config={...this.registry.config(),addresses:addresses(p.addresses),port:p.port};
        await this.identity.renewCertificate(config);
        this.registry.configure(config);this.pairEnded(this.pairing.end(true),'cancelled');
        await this.stopListeners();await this.start();
        this.registry.audit({operation:'identity.endpoints',decision:'updated',argsDigest:digest(config.addresses)});
        return true;
      }
      case 'remote.browserConfigure':return this.browser.configure(params);
      case 'remote.browserPrepare':return this.browser.prepare(params);
      case 'remote.browserCancel':this.browser.endWindow('cancelled');await this.browser.refresh();this.presence();return true;
      case 'remote.browserConfirm': {const device=this.browser.confirm(params);await this.start();this.presence();return {id:device.id,name:device.name};}
      case 'remote.enable':this.registry.configure({...this.registry.config(),enabled:true});await this.start();return true;
      case 'remote.off':await this.disable();return true;
      // Whether this desktop says on the local network that PAL is here (discovery.ts). Off unless chosen.
      case 'remote.setDiscovery': {
        const {enabled}=z.strictObject({enabled:z.boolean()}).parse(params);
        this.registry.configure({...this.registry.config(),discovery:enabled});
        this.registry.audit({operation:'remote.discovery',decision:enabled?'enabled':'disabled'});
        await this.announce();this.presence();return {enabled,active:this.discovery.active,...(this.discovery.problem?{problem:this.discovery.problem}:{})};
      }
      // The owner's answer to a phone that asked to be woken through a push server; it names the server shown.
      case 'remote.decideWake': {
        const p=z.strictObject({id:z.uuid(),approved:z.boolean(),host:z.string().max(300).optional()}).parse(params);
        return this.wake.decide(p.id,p.approved,p.host);
      }
      case 'remote.resetIdentity': {
        if(params.confirmed!==true)throw new Error('Confirm locally: reset revokes every phone and requires new offline pairing.');
        await this.disable();for(const device of this.registry.devices())if(this.registry.live(device.id))await this.revoke(device.id);
        this.pairEnded(this.pairing.end(true),'cancelled');
        this.identity.reset();this.registry.audit({operation:'identity.reset',decision:'reset'});this.presence();return true;
      }
      case 'remote.revoke':return this.revoke(z.uuid().parse(params.id));
      case 'remote.updateDevice': {
        const device=this.pairing.updateScopes(params);
        await this.reduced(device.id);return true;
      }
      // Promote a phone to full access, or limit it, keeping its keys, signing mode and local work.
      case 'remote.setRole': {
        const before=this.registry.live(z.uuid().parse(params?.id));
        const device=this.pairing.setRole(params);
        if (before?.scopeVersion!==device.scopeVersion)
          await this.reduced(device.id, deviceRole(before?.role)==='owner'&&deviceRole(device.role)!=='owner');
        return {id:device.id,role:deviceRole(device.role)};
      }
      case 'remote.setProfile': {
        const device=this.pairing.setProfile(params);this.router.recheckActions();this.core.changed();
        for(const peer of this.peers)if(peer.subscribed&&peer.device?.id===device.id)this.event(peer,'snapshot.changed',{});
        return {id:device.id,profile:workingProfile(device.profile),profileRevision:device.profileRevision};
      }
      case 'remote.renewDevice': {
        const device=this.registry.live(z.uuid().parse(params.id));if(!device||params.confirmed!==true)throw new Error('Re-pair an expired device or confirm renewal locally.');
        if(device.lifetime==='until-revoked')return true;
        device.expiresAt=Date.now()+(device.surface==='browser'?browserLimits.days:90)*86400000;this.registry.saveDevice(device);this.registry.audit({deviceId:device.id,operation:'device.renew',decision:'renewed'});return true;
      }
      case 'remote.purgeMedia': {const id=z.uuid().parse(params.id);if(params.confirmed!==true)throw new Error('Confirm clearing this device’s retained images.');await this.stopOwned(id);await this.router.media.purge(id);return true;}
      default:throw new Error('Unknown remote management method');
    }
  }
  /**
   * Closes once; every caller awaits the same close. New connections and frames are refused first,
   * then owned work already running (frame handlers, media, maintenance, revocation, a listener
   * refresh) gets a bounded time to finish or observe the aborted actions, so none of it reaches the
   * store after Core closes it. Work still running at the bound is counted in `unsettled`.
   */
  close():Promise<void> {return this.closing??=this.closeOnce();}
  private async closeOnce() {
    this.closed=true;this.wake.close();this.router.abortActions();clearInterval(this.heartbeat);if(this.stateTimer)clearTimeout(this.stateTimer);
    this.core.off('realtime',this.onRealtime);
    this.core.off('changed',this.onChanged);this.core.off('state',this.onState);this.core.off('message',this.onMessage);this.core.off('notice',this.onNotice);
    await this.stopListeners();await this.browser.stop();
    let timer:NodeJS.Timeout|undefined;
    const settled=await Promise.race([Promise.allSettled([...this.work,this.lifecycle]).then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),MobileGateway.closeDrainMs);timer.unref();})]);
    clearTimeout(timer);
    this.unsettled=settled?0:this.work.size;
  }
}
