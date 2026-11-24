import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Core } from '../core.ts';
import { resolveProviderEndpoint } from '../provider-registry.ts';
import { routeAllowed } from '../tools/contracts.ts';
import { responseJson } from '../provider-http.ts';
import { OperationStore, type Operation } from '../operations/store.ts';
import { downloadMediaBytes } from './download.ts';
import { limitedControlled } from '../authority.ts';

const ref=z.strictObject({artifactId:z.uuid(),versionId:z.uuid()});
export const timedMediaInput=z.strictObject({sessionId:z.uuid(),provider:z.enum(['xai','google','edenai']),connectionId:z.uuid().optional(),
  model:z.string().trim().min(1).max(160),kind:z.enum(['video.generate','music.generate']),prompt:z.string().trim().min(1).max(8000),
  references:z.array(ref).max(3).optional(),duration:z.number().int().min(3).max(15).optional(),
  resolution:z.enum(['480p','720p','1080p']).optional(),aspectRatio:z.enum(['16:9','9:16','1:1']).optional()});
type Request = z.infer<typeof timedMediaInput>;
export const timedMediaLookup=z.strictObject({sessionId:z.uuid(),id:z.uuid()});
const isTimed=(op:Operation)=>op.kind==='video.generate'||op.kind==='music.generate';

export async function inspectTimedMedia(bytes:Buffer, music:boolean):Promise<Record<string,string|number>> {
  if(music ? bytes.length<4 || !(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)
    : bytes.length<12 || bytes.toString('ascii',4,8)!=='ftyp')throw new Error('The provider returned an invalid media container');
  const streams:any[]=await new Promise((resolve,reject)=>{
    const child=execFile('ffprobe',['-v','error','-protocol_whitelist','pipe','-f',music?'mp3':'mov','-show_entries','stream=codec_type,codec_name,width,height,sample_rate,channels,duration:format=duration','-of','json','pipe:0'],
      {timeout:12000,maxBuffer:32768},(err,out)=>{if(err)return reject(new Error('ffprobe could not validate the generated media'));try{const meta=JSON.parse(out);resolve(meta.streams.map((s:any)=>({...s,duration:s.duration||meta.format?.duration})));}catch{reject(new Error('Invalid media metadata'));}});
    child.stdin?.on('error',()=>{});child.stdin?.end(bytes);
  });
  const s=streams.find(s=>s.codec_type===(music?'audio':'video'));if(!s)throw new Error('Generated file has no expected media stream');
  return {...(typeof s.codec_name==='string'?{codec:s.codec_name}:{}),...Object.fromEntries(Object.entries({width:s.width,height:s.height,sampleRate:s.sample_rate,channels:s.channels,duration:s.duration})
    .filter(([,v])=>v!==undefined&&Number.isFinite(Number(v))).map(([k,v])=>[k,Number(v)]))};
}
export class TimedMedia {
  core:Core;
  fetch=fetch;
  constructor(core:Core){this.core=core;}
  private controllers=new Map<string,AbortController>();
  private tasks=new Map<string,Promise<void>>();
  private get ops(){return this.core.workbench.operations;}
  private get files(){return this.core.workbench.artifacts;}
  private authorize(p:Request) {
    const session=this.core.store.session(p.sessionId);
    if(session.temporary || limitedControlled(session) || this.core.settingsFor(session.id).paused)throw new Error('Choose an active saved conversation with owner access');
    if(p.connectionId)this.core.chatConnections.get(p.connectionId,p.provider);
    const access=this.core.accountAccess(p.provider,p.connectionId);
    if(!access.key())throw new Error('Add a key for the selected media account');
    if(access.route?.().variant==='vertex')throw new Error('This operation uses the Gemini Developer Interactions endpoint');
    const refs=(p.references||[]).map(r=>this.files.version(session.id,r.artifactId,r.versionId));
    if(refs.some(r=>!routeAllowed('cloud',r.policy)))throw new Error('Allow cloud processing for each selected file before generating media');
    return {access,refs,revision:p.connectionId?this.core.chatConnections.get(p.connectionId,p.provider).revision:0,
      credentialRevision:this.core.credentials.credentialRevision(p.connectionId?'connection:'+p.connectionId:'provider:'+p.provider)};
  }
  prepare(value:unknown){
    const p=timedMediaInput.parse(value);
    if(p.kind==='music.generate' && (p.provider!=='google'||p.resolution||p.duration||p.aspectRatio))throw new Error('Choose Google music and describe the timing in the prompt');
    if(/^(sora|veo-3\.1.*preview)/i.test(p.model))throw new Error('This video model was retired. Select a current video model.');
    if(p.provider==='edenai' && (!/^video\/generation_async\/[\w.-]+(?:\/[\w.-]+)?$/.test(p.model)||p.references?.length))throw new Error('Choose an Eden video/generation_async/provider/model text-to-video route');
    if(p.provider==='xai'&&(p.references?.length||0)>1)throw new Error('Choose one starting image for this Grok video route');
    const {revision,credentialRevision,refs}=this.authorize(p);
    if(refs.some(r=>r.bytes>12*1024*1024||!(r.mime.startsWith('image/')||['google','xai'].includes(p.provider)&&p.kind==='video.generate'&&r.mime==='video/mp4')))throw new Error('Choose an eligible image or video under 12 MiB');
    const edit=p.provider==='xai'&&refs.some(r=>r.mime==='video/mp4');
    if(edit&&(p.duration||p.resolution||p.aspectRatio))throw new Error('Grok video edits inherit duration, resolution and aspect ratio from their source');
    const digest=OperationStore.digest({p,revision,credentialRevision});
    return this.ops.findPrepared(p.sessionId,digest) || this.ops.create({sessionId:p.sessionId,kind:p.kind,origin:'user',label:p.kind==='music.generate'?'Generate music':edit?'Edit video':'Generate video',
      payloadDigest:digest,witness:{credentialRevision},inputs:(p.references||[]).map(r=>({...r,purpose:"generation-reference"})),details:{request:p},
      backend:{kind:p.provider,connectionId:p.connectionId||'provider:'+p.provider,model:p.model,route:'cloud',revision}});
  }
  private task(id:string,work:()=>Promise<void>){
    if(this.tasks.has(id))return;
    const task=work().finally(()=>{this.tasks.delete(id);this.controllers.delete(id);});
    this.tasks.set(id,task);void task.catch(()=>{});
  }
  async rpc(action:string,value:any,authority?:()=>void){
    authority?.();
    if(action==='prepare')return this.prepare(value);
    const p=timedMediaLookup.parse(value),op=this.ops.get(p.id);
    if(!isTimed(op)||op.sessionId!==p.sessionId)throw new Error('Unknown media operation for this conversation');
    if(action==='status')return op;
    if(action==='cancel'){
      if(op.state==='prepared')return this.ops.transition(op.id,'cancelled');
      if(!['dispatching','running'].includes(op.state))return op;
      this.controllers.get(op.id)?.abort();
      return this.ops.transition(op.id,'unknown',{cancellation:{requested:Date.now(),confirmed:false,note:'PAL stopped waiting. The provider may finish or bill the request.'}});
    }
    if(action==='start'){
      if(op.state!=='prepared')return op;
      this.authorize(op.details!.request as Request);this.core.usage.assertWithinBudget(op.backend!.kind);
      this.ops.transition(op.id,'queued');this.ops.transition(op.id,'dispatching');
      this.task(op.id,()=>this.run(op.id,true,authority));
    } else if(action==='poll'){
      if(!op.remoteId||!['running','unknown'].includes(op.state))return op;
      this.task(op.id,()=>this.run(op.id,false,authority));
    } else throw new Error('Unknown media operation');
    return this.ops.get(op.id);
  }
  private async run(id:string,submit:boolean,authority?:()=>void){
    const op=this.ops.get(id),p=op.details!.request as Request,controller=new AbortController();
    this.controllers.set(id,controller);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(240000)]);
    try{
      const check=()=>{authority?.();signal.throwIfAborted();const binding=this.authorize(p);
        if(binding.revision!==op.backend!.revision||binding.credentialRevision!==op.witness.credentialRevision)throw new Error('The media account changed');
        return binding;};
      const {access,refs}=check(),google=p.provider==='google',eden=p.provider==='edenai',music=p.kind==='music.generate';
      const base=resolveProviderEndpoint(p.provider,access.route?.()),headers:Record<string,string>={'Content-Type':'application/json'};
      const data=[];
      if(submit)for(const r of refs){const {data:bytes}=await this.files.bytes(p.sessionId,r.artifactId,r.versionId);
        if(p.provider==='xai'&&r.mime==='video/mp4'){
          const meta=await inspectTimedMedia(bytes,false);
          if(!['h264','hevc','av1'].includes(String(meta.codec))||!(Number(meta.duration)>0 && Number(meta.duration)<=8.7))throw new Error('Choose an H.264, H.265 or AV1 MP4 up to 8.7 seconds for editing');
        }
        data.push({type:r.mime.startsWith('image/')?'image':'video',mime_type:r.mime,data:bytes.toString('base64')});}
      check();const key=access.key();
      if(google){headers['x-goog-api-key']=key;headers['Api-Revision']='2026-05-20';}else headers.Authorization='Bearer '+key;
      const dimensions:Record<string,[number,number]>={'480p':[854,480],'720p':[1280,720],'1080p':[1920,1080]};
      const [w,h]=dimensions[p.resolution||'720p'],dimension=p.aspectRatio==='9:16'?h+'x'+w:p.aspectRatio==='1:1'?h+'x'+h:w+'x'+h;
      const body=eden?{model:p.model,input:{text:p.prompt,duration:p.duration,...(p.resolution||p.aspectRatio?{dimension}:{})}}:google?{model:p.model,...(!music?{background:true,store:true}:{}),input:data.length?[{type:'text',text:p.prompt},...data]:p.prompt,response_format:{type:music?'audio':'video',aspect_ratio:p.aspectRatio,resolution:p.resolution,duration:p.duration?p.duration+'s':undefined}}
        :{model:p.model,prompt:p.prompt,duration:p.duration,aspect_ratio:p.aspectRatio,resolution:p.resolution,...(data.length?{[data[0].type]:{url:'data:'+data[0].mime_type+';base64,'+data[0].data}}:{})};
      const path=eden?'universal-ai/async'+(submit?'':'/'+encodeURIComponent(op.remoteId!)):google?'interactions'+(submit?'':'/'+encodeURIComponent(op.remoteId!)):submit?(data[0]?.type==='video'?'videos/edits':'videos/generations'):'videos/'+encodeURIComponent(op.remoteId!);
      const res=await this.fetch(new URL(path,base),{method:submit?'POST':'GET',headers,body:submit?JSON.stringify(body):undefined,redirect:'error',signal});
      if(!res.ok && submit && res.status>=400 && res.status<500 && res.status!==408){await res.body?.cancel();this.ops.transition(id,'failed',{error:{code:'provider_rejected',message:'Media provider returned HTTP '+res.status}});return;}
      const result=await responseJson(res,google?85*1024*1024:512*1024);
      const remoteId=google?result.id:eden?(result.public_id||op.remoteId):(result.request_id||op.remoteId);
      if(typeof remoteId!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(remoteId)||op.remoteId&&remoteId!==op.remoteId)throw new Error('Invalid media job handle');
      this.ops.update(id,{remoteId});check();
      if(['fail','failed','expired','cancelled'].includes(result.status)){this.ops.transition(id,'failed',{error:{code:result.status,message:'Provider reported '+result.status}});return;}
      if(!google&&submit||['pending','queued','in_progress','processing'].includes(result.status)){
        if(this.ops.get(id).state==='dispatching')this.ops.transition(id,'running');
        return;
      }
      const out=(result.steps||[]).filter((step:any)=>step.type==='model_output').flatMap((step:any)=>step.content||[]);
      const media=(music?result.output_audio:result.output_video)||out.find((entry:any)=>entry.type===(music?'audio':'video'));
      const bytes=media?.data?Buffer.from(media.data,'base64'):await downloadMediaBytes(google?media?.uri:eden?result.output?.video_resource_url||result.output?.video:result.video?.url,{origin:new URL(base).origin,headers,fetch:this.fetch,maxBytes:64*1024*1024},signal);
      const meta=await inspectTimedMedia(bytes,music);check();
      const saved=this.core.store.db.prepare("SELECT data FROM artifact_versions WHERE json_extract(data,'$.operationId')=? LIMIT 1").get(id);
      const artifact=saved?JSON.parse(String(saved.data)):await this.files.install({sessionId:p.sessionId,operationId:id,bytes,name:(music?'music.mp3':'video.mp4'),mime:music?'audio/mpeg':'video/mp4',source:'model-generation',
        policy:this.files.inherit(p.sessionId,p.references||[]),parents:(p.references||[]).map(r=>({...r,relation:'generation-reference'})),
        provenance:{kind:p.kind,model:p.model,provider:p.provider,connection:op.backend!.connectionId,...(eden?{upstream:String(result.provider||p.model.split('/')[2]).slice(0,160)}:{}),remoteId,prompt:p.prompt,media:meta,
          lyrics:out.filter((e:any)=>e.type==='text').map((e:any)=>String(e.text||'')).join('\n').slice(0,4096)}});
      this.ops.transition(id,'completed',{results:[{artifactId:artifact.artifactId,versionId:artifact.versionId,purpose:"result"}],details:{...op.details,metadata:meta},usage:{calls:1}});
      this.core.store.db.prepare('INSERT OR IGNORE INTO usage_records VALUES(?,?,?,?,?)').run(id,p.sessionId,id,Date.now(),JSON.stringify({calls:1,source:p.provider,model:p.model,kind:p.kind}));
    }catch(e:any){
      const current=this.ops.get(id);
      if(['dispatching','running','unknown'].includes(current.state))this.ops.transition(id,'unknown',{error:{code:'media_outcome_unknown',message:String(e.message).slice(0,300)},recovery:current.remoteId?'Poll the existing handle to recover the result.':'Check the provider account before starting another generation.'});
    }
  }
  tick(){
    for(const op of this.ops.active())if(isTimed(op)&&op.remoteId&&op.state==='running'&&op.updated<Date.now()-10000)this.task(op.id,()=>this.run(op.id,false));
  }
  async close(){for(const c of this.controllers.values())c.abort();await Promise.allSettled(this.tasks.values());}
}
