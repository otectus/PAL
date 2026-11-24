import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import QRCode from 'qrcode';
import { z } from 'zod';
import { digest, parsePairing, pairingUri, signed, verified } from './crypto.ts';
import { Identity, addresses, endpoints } from './identity.ts';
import { RemoteStore } from './store.ts';
import type { Device, Project } from './store.ts';
import { remoteError } from '../execution.ts';
import { join } from 'node:path';
import { ProviderCredentials } from '../credentials.ts';
import { apiProviders, isApiProvider } from '../provider-catalog.ts';
import { endpointOrigin } from '../compatible-endpoint.ts';
import { deviceRole, observerCaps, type DeviceRole } from '../authority.ts';
import { browserCaps } from './browser.ts';
/**
 * W08: hosted API use from a phone is its own grant (it may be billed), per provider; the compatible
 * endpoint is bound to the origin configured when the owner granted it.
 */
function apiGrant(registry:RemoteStore,granted:string[],requested:string[],connectionId?:string,namedIds:string[]=[]) {
  if(!granted.includes('providers.api'))return {apiProviders:[] as string[],apiConnections:[] as string[],apiRouteGrants:{} as Record<string,string>};
  const providers=[...new Set(requested)].filter(id=>(apiProviders as string[]).includes(id));
  // The compatible grant names one origin: the Settings endpoint's, or a named connection the owner chose.
  let baseUrl=registry.store.settings().compatible?.baseUrl||'';
  if(providers.includes('compatible')&&connectionId) {
    const row=registry.store.db.prepare("SELECT data FROM provider_connections WHERE id=? AND kind='compatible'").get(connectionId);
    if(!row)throw new Error('That compatible connection no longer exists. Choose another.');
    baseUrl=JSON.parse(String(row.data)).compatible?.baseUrl||'';
  }
  const origin=providers.includes('compatible')?endpointOrigin(baseUrl):'';
  if(providers.includes('compatible')&&!origin)throw new Error('Set the compatible endpoint before granting it to a phone.');
  const credentials = new ProviderCredentials(join(registry.store.directory,'credentials'));
  const apiRouteGrants:Record<string,string> = {};
  for (const provider of providers) apiRouteGrants['provider:'+provider] = digest([provider==='compatible'?baseUrl:'', credentials.credentialRevision('provider:'+provider)]);
  const ids = [...new Set([...namedIds,...(connectionId?[connectionId]:[])])];
  for (const id of ids) {
    const row = registry.store.db.prepare('SELECT kind, revision, data FROM provider_connections WHERE id=?').get(id);
    if (!row || !isApiProvider(row.kind) && !(row.kind==='ollama' && JSON.parse(String(row.data)).ollama?.host==='https://ollama.com')) throw new Error('Choose an existing API account to grant');
    apiRouteGrants['connection:'+id] = 'connection:'+id+':'+digest([Number(row.revision),credentials.credentialRevision('connection:'+id)]);
  }
  return {apiProviders:providers,apiConnections:ids,apiRouteGrants,...(origin?{compatibleEndpoint:origin}:{})};
}
/**
 * A phone's signed answer to a network-return offer, kept until the desktop confirms or the offer
 * ends. It carries only public keys and proofs. Two different answers to one offer void it.
 */
export type ReceivedResponse = {pairingId:string;response:string;digest:string;sas:string;name:string;deviceId:string;actionAuthentication:'biometric'|'trusted-device';accessRole:DeviceRole;replacesDeviceId?:string;receivedAt:number;expiresAt:number;contested?:boolean};

export const caps = ['chat.read','chat.write','approvals.answer','providers.execute','providers.api','approvals.provider','desktop.control','settings.write','memory.read','memory.write','web','capture.preview','attachments.write'] as const;
export const categories = ['apps','files','windows','audio','media','capture','timers','scripts','providers'] as const;
const b64=z.string().regex(/^[A-Za-z0-9_-]+$/), uuid=z.uuid();
/**
 * The stored grants of an owner phone: every capability and category, every hosted API provider. Its scope is
 * global (Router.projects) and its lifetime lasts until revoked. The desktop chooses this once, locally.
 */
function ownerGrant() {
  return {role:'owner' as const,caps:[...caps],categories:[...categories],scriptIds:[] as string[],apiProviders:[...apiProviders] as string[],lifetime:'until-revoked' as const,profile:'desktop' as const,profileRevision:'1'};
}
/** An observer reads and can Stop or Deny: only the read capabilities, no categories or scripts. */
function observerGrant(requested:string[]) { return {role:'observer' as const,caps:requested.filter(cap=>(observerCaps as readonly string[]).includes(cap)),categories:[] as string[],scriptIds:[] as string[],apiProviders:[] as string[]}; }
const responseSchema=z.strictObject({type:z.literal('response'),v:z.literal(1),desktopId:uuid,pairingId:uuid,offerDigest:b64,nonce:b64.length(43),deviceId:uuid,name:z.string().min(1).max(48),keyVersion:z.literal(1),connectionKey:b64,actionKey:b64,deviceNonce:b64.length(43),connectionProof:b64,actionProof:b64});
const words: string[]=JSON.parse(readFileSync(new URL('../../protocol/mobile/v1/sas-words.json',import.meta.url),'utf8'));
export class Pairing {
  registry:RemoteStore; identity:Identity;
  /** Answers received over the network for live offers, by pairing ID. */
  received=new Map<string,ReceivedResponse>();
  constructor(registry:RemoteStore,identity:Identity) {this.registry=registry;this.identity=identity;}
  updateScopes(params:unknown):Device {
    const p=z.strictObject({id:uuid,projectPaths:z.array(z.string()).min(1).max(32),caps:z.array(z.enum(caps)),categories:z.array(z.enum(categories)),scriptIds:z.array(z.string()).max(100).default([]),apiProviders:z.array(z.enum(apiProviders as [string,...string[]])).max(apiProviders.length).default([]),apiConnections:z.array(uuid).max(128).default([]),compatibleConnectionId:uuid.optional()}).parse(params);
    const device=this.registry.live(p.id);if(!device)throw new Error('Re-pair an expired or revoked device.');
    if(deviceRole(device.role)==='owner')throw new Error('This phone has full access. Change it to limited access first to choose its projects and grants.');
    if(device.surface==='browser'&&(p.categories.length||p.scriptIds.length||p.apiProviders.length||p.apiConnections.length||p.compatibleConnectionId))throw new Error('A browser never controls the desktop or uses hosted accounts.');
    if(device.surface==='browser')p.caps=p.caps.filter(cap=>(browserCaps as readonly string[]).includes(cap));
    const projects:Project[]=[...new Set(p.projectPaths.map(path=>realpathSync(path)))].map(path=>{if(!statSync(path).isDirectory())throw new Error('Choose a project directory');return device.projects.find(pr=>pr.path===path)||{id:randomUUID(),name:basename(path)||path,path};});
    const {compatibleEndpoint:_previousEndpoint,apiConnections:_connections,apiRouteGrants:_grants,...rest}=device;
    const scoped=deviceRole(device.role)==='observer'?observerGrant(p.caps):{caps:p.caps,categories:p.categories,scriptIds:p.scriptIds,...apiGrant(this.registry,p.caps,p.apiProviders,p.compatibleConnectionId,p.apiConnections)};
    const next={...rest,projects,...scoped,ollamaHosts:[this.registry.store.settings().ollama.host],scopeVersion:String(BigInt(device.scopeVersion)+1n)};
    this.registry.saveDevice(next);this.registry.audit({deviceId:device.id,operation:'device.scopes',decision:'updated',scopeVersion:next.scopeVersion,argsDigest:digest({projects:projects.map(p=>p.id),caps:p.caps,categories:p.categories,scriptIds:p.scriptIds,apiProviders:next.apiProviders})});return next;
  }
  /**
   * The owner changes a paired phone's role on the desktop, keeping its keys, signing mode, drafts and cache.
   * Promotion grants the owner ceiling until revoked. Demotion to limited or observer names the projects and
   * grants the phone keeps, with the 90-day expiry limited phones have. Either way the scope version changes,
   * so the phone reconnects and every earlier authorization is re-evaluated.
   */
  setRole(params:unknown):Device {
    const p=z.strictObject({id:uuid,role:z.enum(['owner','limited','observer']),confirmed:z.literal(true),projectPaths:z.array(z.string()).max(32).optional(),caps:z.array(z.enum(caps)).optional(),categories:z.array(z.enum(categories)).optional()}).parse(params);
    const device=this.registry.live(p.id);if(!device)throw new Error('Re-pair an expired or revoked device.');
    const from=deviceRole(device.role);
    if(from===p.role)return device;
    if(device.surface==='browser'&&p.role!=='observer')throw new Error('Pair the browser again to let it do more.');
    const {lifetime:_lifetime,expiresAt:_expiry,profile:_profile,profileRevision:_revision,...base}=device;
    let next:Device;
    if(p.role==='owner') next={...base,...ownerGrant(),scopeVersion:String(BigInt(device.scopeVersion)+1n)};
    else {
      const paths=p.projectPaths??device.projects.map(project=>project.path);
      if(!paths.length)throw new Error('Choose at least one project this phone keeps.');
      const projects:Project[]=[...new Set(paths.map(path=>realpathSync(path)))].map(path=>{if(!statSync(path).isDirectory())throw new Error('Choose a project directory');return device.projects.find(project=>project.path===path)||{id:randomUUID(),name:basename(path)||path,path};});
      const requested=p.caps??(from==='owner'?['chat.read','chat.write','approvals.answer']:device.caps);
      const grants=p.role==='observer'?observerGrant(requested):{role:'limited' as const,caps:requested,categories:p.categories??(from==='owner'?[]:device.categories),scriptIds:from==='owner'?[]:device.scriptIds,apiProviders:requested.includes('providers.api')&&from!=='owner'?device.apiProviders||[]:[]};
      const {compatibleEndpoint:_endpoint,apiConnections:_oldConnections,apiRouteGrants:_oldGrants,...rest}=base;
      next={...rest,...(from!=='owner'&&device.compatibleEndpoint?{compatibleEndpoint:device.compatibleEndpoint}:{}),projects,...grants,expiresAt:from==='owner'?Date.now()+90*86400000:device.expiresAt??Date.now()+90*86400000,scopeVersion:String(BigInt(device.scopeVersion)+1n)};
    }
    this.registry.saveDevice(next);
    this.registry.audit({deviceId:device.id,operation:'device.role',decision:p.role,scopeVersion:next.scopeVersion,argsDigest:digest({from,to:p.role})});
    return next;
  }
  /** An owner phone's working profile; changing it never disconnects the phone (its own revision, not the scope's). */
  setProfile(params:unknown):Device {
    const p=z.strictObject({id:uuid,profile:z.enum(['desktop','review','automatic']),expectedProfileRevision:z.string().max(20).optional()}).parse(params);
    const device=this.registry.live(p.id);if(!device)throw new Error('Re-pair an expired or revoked device.');
    if(deviceRole(device.role)!=='owner')throw remoteError('SCOPE_DENIED','Working profiles apply to phones with full access.');
    if(p.expectedProfileRevision!==undefined&&p.expectedProfileRevision!==(device.profileRevision||'0'))throw remoteError('REVISION_CONFLICT','The working profile changed on another device. Review it again.');
    const next={...device,profile:p.profile,profileRevision:String(BigInt(device.profileRevision||'0')+1n)};
    this.registry.saveDevice(next);
    this.registry.audit({deviceId:device.id,operation:'device.profile',decision:p.profile});
    return next;
  }
  async prepare(params:unknown) {
    // networkReturn: for the offer's five minutes the gateway listens on its addresses and accepts the
    // phone's signed answer (and nothing else before confirmation), instead of it being copied over.
    const p=z.strictObject({addresses:z.array(z.string()),name:z.string().min(1).max(48).default('PAL'),port:z.number().int().min(1024).max(65535).default(8443),actionAuthentication:z.enum(['biometric','trusted-device']).default('biometric'),replacesDeviceId:uuid.optional(),networkReturn:z.boolean().default(false),accessRole:z.enum(['owner','limited','observer']).default('limited')}).parse(params);
    const replaced=p.replacesDeviceId?this.registry.live(p.replacesDeviceId):undefined;
    if(p.replacesDeviceId&&(!replaced||replaced.surface==='browser'))throw new Error('Choose a live paired device to replace.');
    if(Buffer.byteLength(p.name)>48)throw new Error('Desktop name must fit in 48 UTF-8 bytes');
    const config={...this.registry.config(),addresses:addresses(p.addresses),port:p.port,name:p.name};
    // A paired browser has its own address, so it does not hold a phone's.
    if(this.registry.devices().some(d=>d.surface!=='browser'&&this.registry.live(d.id)) && JSON.stringify(endpoints(config))!==JSON.stringify(endpoints(this.registry.config())))throw new Error('Changing paired endpoints requires local identity recovery and re-pairing.');
    await this.identity.ensure(config);
    this.registry.configure(config);
    const material=this.identity.material();
    const bare={type:'offer',v:1,desktopId:this.identity.id,name:p.name,certificate:material.certificate,spki:material.spki,identityKey:material.identityKey,endpoints:endpoints(config),pairingId:randomUUID(),nonce:randomBytes(32).toString('base64url'),expiresAt:Date.now()+300000,actionAuthentication:p.actionAuthentication,...(p.replacesDeviceId?{replacesDeviceId:p.replacesDeviceId}:{}),...(p.networkReturn?{responseReturn:'network'}:{}),
      // Signed with the offer, so the phone shows the access it is being given before it answers (older phones ignore it).
      ...(p.accessRole!=='limited'?{accessRole:p.accessRole}:{})};
    const offer={...bare,signature:signed(material.identity,{domain:'cere.mobile.pair.offer.v1',offer:bare})};
    const uri=pairingUri(offer);
    if(Buffer.byteLength(uri)>2000)throw new Error('Pairing offer is too large. Select fewer addresses or a shorter desktop name.');
    this.registry.store.db.prepare('INSERT INTO remote_pair_offers VALUES (?,?,?)').run(offer.pairingId,JSON.stringify(offer),offer.expiresAt);
    // One network window at a time: a new offer ends an earlier network-return offer and what it received.
    for(const row of this.registry.store.db.prepare("SELECT id FROM remote_pair_offers WHERE id<>? AND json_extract(data,'$.responseReturn')='network'").all(offer.pairingId)) {
      this.registry.store.db.prepare('DELETE FROM remote_pair_offers WHERE id=?').run(String(row.id));this.received.delete(String(row.id));
    }
    this.registry.audit({operation:'pair.prepare',decision:'prepared'});
    return {uri,pairingId:offer.pairingId,expiresAt:offer.expiresAt,networkReturn:p.networkReturn,accessRole:p.accessRole,qr:await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',width:480,margin:2})};
  }
  /** The live network-return offer, while the gateway should accept answers for it. */
  networkWindow():{pairingId:string;expiresAt:number}|undefined {
    for(const row of this.registry.store.db.prepare('SELECT data FROM remote_pair_offers WHERE expires>?').all(Date.now())) {
      const offer=JSON.parse(String(row.data));if(offer.responseReturn==='network')return {pairingId:offer.pairingId,expiresAt:offer.expiresAt};
    }
    return undefined;
  }
  /**
   * A phone's answer arriving over the gateway: verified exactly as a pasted one is, for an offer
   * prepared for network return. The same answer again is accepted (the phone retries after a lost
   * connection); a different one voids the offer, since only one phone can have scanned it honestly.
   */
  receive(uri:string):ReceivedResponse {
    // Only an answer signed for this offer (its nonce and digest come from the QR) can contest it.
    const review=this.review(uri,{contest:true});
    if(review.offer.responseReturn!=='network')throw remoteError('UNAUTHENTICATED','This offer takes its answer on the desktop. Copy the response there.');
    const id=review.response.pairingId,responseDigest=digest(review.response),existing=this.received.get(id);
    if(existing&&(existing.contested||existing.digest!==responseDigest)) {
      existing.contested=true;this.registry.store.db.prepare('DELETE FROM remote_pair_offers WHERE id=?').run(id);
      this.registry.audit({operation:'pair.received',decision:'contested'});
      throw remoteError('UNAUTHENTICATED','Another phone answered this pairing offer. Prepare a new offer on the desktop.');
    }
    const entry:ReceivedResponse=existing||{pairingId:id,response:uri,digest:responseDigest,sas:review.sas,name:review.response.name,deviceId:review.response.deviceId,actionAuthentication:review.offer.actionAuthentication||'biometric',accessRole:deviceRole(review.offer.accessRole),...(review.offer.replacesDeviceId?{replacesDeviceId:review.offer.replacesDeviceId}:{}),receivedAt:Date.now(),expiresAt:review.offer.expiresAt};
    if(!existing){this.received.set(id,entry);this.registry.audit({operation:'pair.received',decision:'received'});}
    return entry;
  }
  /** Whether this public answer already belongs to a live paired device (the desktop confirmed it). */
  confirmedDevice(uri:string) {
    let response;try{response=responseSchema.parse(parsePairing(uri));}catch{return undefined;}
    const device=this.registry.live(response.deviceId);
    return device&&device.connectionKey===response.connectionKey&&device.actionKey===response.actionKey&&response.desktopId===this.identity.id?device:undefined;
  }
  /** What the desktop shows for the live offer: whether an answer arrived, and its six words. */
  status() {
    const window=this.networkWindow();
    if(!window) {
      // A contested offer is gone, but the desktop still says why nothing was paired until it would have expired.
      const contested=[...this.received.values()].find(entry=>entry.contested&&entry.expiresAt>Date.now());
      return contested?{pairingId:contested.pairingId,expiresAt:contested.expiresAt,networkReturn:true,contested:true}:undefined;
    }
    const entry=this.received.get(window.pairingId);
    return {pairingId:window.pairingId,expiresAt:window.expiresAt,networkReturn:true,...(entry?{received:{name:entry.name,sas:entry.sas,actionAuthentication:entry.actionAuthentication,accessRole:entry.accessRole,...(entry.replacesDeviceId?{replacesDeviceId:entry.replacesDeviceId}:{}),receivedAt:entry.receivedAt,contested:entry.contested===true}}:{})};
  }
  /** Ends the live offer (cancelled locally, expired or replaced); returns the pairing IDs ended. */
  end(all=false):string[] {
    const now=Date.now(),ended:string[]=[];
    for(const row of this.registry.store.db.prepare('SELECT id,expires FROM remote_pair_offers').all())if(all||Number(row.expires)<=now)ended.push(String(row.id));
    for(const id of ended)this.registry.store.db.prepare('DELETE FROM remote_pair_offers WHERE id=?').run(id);
    for(const [id,entry] of this.received)if(all||ended.includes(id)||entry.expiresAt<=now){this.received.delete(id);if(!ended.includes(id))ended.push(id);}
    return ended;
  }
  /** received: a validly signed answer may still contest the offer (receive decides); otherwise a contested offer is refused. */
  review(uri:string,{contest=false}={}) {
    const response=responseSchema.parse(parsePairing(uri));
    const received=this.received.get(response.pairingId);
    if(!contest&&received&&(received.contested||received.digest!==digest(response)))throw remoteError('UNAUTHENTICATED','Another phone answered this pairing offer. Prepare a new offer on the desktop.');
    const row=this.registry.store.db.prepare('SELECT data FROM remote_pair_offers WHERE id=? AND expires>?').get(response.pairingId,Date.now());
    if(!row)throw remoteError('AUTH_EXPIRED','Pairing offer expired or already used.');
    const offer=JSON.parse(String(row.data));
    const {connectionProof,actionProof,...body}=response;
    const transcript={domain:'cere.mobile.pair.response.v1',response:body};
    if(response.desktopId!==this.identity.id||response.offerDigest!==digest(offer)||response.nonce!==offer.nonce||response.connectionKey===response.actionKey||!verified(response.connectionKey,transcript,connectionProof)||!verified(response.actionKey,transcript,actionProof))throw remoteError('UNAUTHENTICATED','Pairing signatures do not match this offer.');
    const sas=[...createHash('sha256').update(digest(offer)+'.'+digest(response)).digest().subarray(0,6)].map(v=>words[v]).join(' ');
    return {response,sas,offer,fingerprint:digest({connectionKey:response.connectionKey,actionKey:response.actionKey})};
  }
  confirm(params:unknown):Device {
    // response: the pasted answer; pairingId: the answer the phone sent over the network for that offer.
    const p=z.strictObject({response:z.string().optional(),pairingId:uuid.optional(),sas:z.string(),confirmed:z.literal(true),projectPaths:z.array(z.string()).max(32).default([]),caps:z.array(z.enum(caps)).default(['chat.read','chat.write','approvals.answer']),categories:z.array(z.enum(categories)).default([]),scriptIds:z.array(z.string()).max(100).default([]),apiProviders:z.array(z.enum(apiProviders as [string,...string[]])).max(apiProviders.length).default([]),apiConnections:z.array(uuid).max(128).default([]),compatibleConnectionId:uuid.optional()}).refine(p=>(p.response===undefined)!==(p.pairingId===undefined),'Confirm either a pasted response or a received one').parse(params);
    const uri=p.response??this.received.get(p.pairingId!)?.response;
    if(!uri)throw remoteError('AUTH_EXPIRED','The phone’s answer has not arrived, or the offer ended. Prepare a new offer.');
    const review=this.review(uri);
    if(p.sas!==review.sas)throw remoteError('UNAUTHENTICATED','Compare the six words on both devices.');
    const previous=review.offer.replacesDeviceId?this.registry.live(review.offer.replacesDeviceId):undefined;
    if(review.offer.replacesDeviceId&&!previous)throw new Error('The device being replaced is no longer active. Prepare a new offer.');
    if(JSON.stringify(review.offer.endpoints)!==JSON.stringify(endpoints(this.registry.config()))||review.offer.certificate!==this.identity.material().certificate)throw new Error('Gateway identity changed. Prepare a fresh pairing offer.');
    if(this.registry.devices().filter(d=>this.registry.live(d.id)).length>=5&&!previous)throw new Error('At most five devices may be paired.');
    if(this.registry.device(review.response.deviceId))throw new Error('This device identity already exists; generate fresh phone keys.');
    // The role is the one the desktop signed into the offer: the phone showed it before answering.
    const role=deviceRole(review.offer.accessRole);
    if(role!=='owner'&&!p.projectPaths.length)throw new Error('Choose at least one project this phone may use.');
    const projects:Project[]=[...new Set(p.projectPaths.map(path=>realpathSync(path)))].map(path=>{if(!statSync(path).isDirectory())throw new Error('Choose a project directory');return previous?.projects.find(project=>project.path===path)||{id:randomUUID(),name:basename(path)||path,path};});
    const grants=role==='owner'?ownerGrant():role==='observer'?observerGrant(p.caps):{role:'limited' as const,caps:p.caps,categories:p.categories,scriptIds:p.scriptIds,...apiGrant(this.registry,p.caps,p.apiProviders,p.compatibleConnectionId,p.apiConnections)};
    const device:Device={id:review.response.deviceId,name:review.response.name,connectionKey:review.response.connectionKey,actionKey:review.response.actionKey,keyVersion:1,scopeVersion:'1',actionAuthentication:review.offer.actionAuthentication||'biometric',...(previous?{replacesDeviceId:previous.id,replacementPending:true}:{}),createdAt:Date.now(),...(role==='owner'?{}:{expiresAt:Date.now()+90*86400000}),projects,ollamaHosts:[this.registry.store.settings().ollama.host],...grants};
    const db=this.registry.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if(previous){previous.revokedAt=Date.now();previous.scopeVersion=String(BigInt(previous.scopeVersion)+1n);this.registry.saveDevice(previous);}
      this.registry.saveDevice(device);this.registry.configure({...this.registry.config(),enabled:true});
      db.prepare('DELETE FROM remote_pair_offers WHERE id=?').run(review.response.pairingId);
      this.registry.audit({deviceId:device.id,operation:'pair.confirm',decision:'paired'});db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    this.received.delete(review.response.pairingId);
    return device;
  }
}
