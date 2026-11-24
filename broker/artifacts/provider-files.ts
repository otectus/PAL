import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Core } from '../core.ts';
import { routeAllowed } from '../tools/contracts.ts';
import { limitedControlled } from '../authority.ts';
import { resolveProviderEndpoint } from '../provider-registry.ts';
import { responseJson } from '../provider-http.ts';

export const uploadOriginal=z.strictObject({sessionId:z.uuid(),artifactId:z.uuid(),versionId:z.uuid(),acknowledgeUpload:z.literal(true),expectedSessionRevision:z.string().max(128).optional(),expectedConnectionRevision:z.number().int().nonnegative().optional()});
export const lookupOriginal=z.strictObject({sessionId:z.uuid(),id:z.uuid()});
type Provider='google'|'anthropic'|'openai'|'xai';
type Handle={id:string;sessionId:string;artifactId:string;versionId:string;name:string;mime:string;provider:Provider;connectionId?:string;revision:number;credentialRevision:string;state:string;remoteId?:string;uri?:string;expires?:number;cleanupPending?:boolean;created:number};
export class ProviderFiles {
  core:Core;fetch=fetch;
  private pending=new Map<string,Set<Promise<Handle>>>();
  constructor(core:Core){
    this.core=core;
    core.store.db.exec('CREATE TABLE IF NOT EXISTS provider_files(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS provider_files_session ON provider_files(session_id)');
  }
  private save(h:Handle){this.core.store.db.prepare('INSERT INTO provider_files VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(h.id,h.sessionId,JSON.stringify(h));}
  private handle(id:string,sessionId:string):Handle {
    const row=this.core.store.db.prepare('SELECT data FROM provider_files WHERE session_id=? AND id=?').get(sessionId,id);if(!row)throw new Error('Unknown original file for this conversation');return JSON.parse(String(row.data));
  }
  private binding(sessionId:string) {
    const s=this.core.store.session(sessionId),provider=s.provider as Provider;
    if(this.core.deleting?.has(s.id)||s.temporary||limitedControlled(s)||this.core.settingsFor(s.id).paused||!['openai','anthropic','google','xai'].includes(provider))throw new Error('This conversation cannot send original files to a provider');
    return this.accountBinding(provider,s.connectionId);
  }
  private accountBinding(provider:Provider,connectionId?:string) {
    const connection=connectionId?this.core.chatConnections.get(connectionId,provider):undefined;
    if(connection?.variant==='vertex')throw new Error('Google Files uploads require a Gemini Developer account');
    const revision=connection?.revision||0,credentialRevision=this.core.credentials.credentialRevision(connection?'connection:'+connection.id:'provider:'+provider);
    const access=this.core.accountAccess(provider,connectionId),key=access.key();
    if(!key)throw new Error('Configure the provider account before uploading original files');
    const headers:Record<string,string>=provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01','anthropic-beta':'files-api-2025-04-14'}:
      provider==='google'?{'x-goog-api-key':key}:{Authorization:'Bearer '+key};
    const base=resolveProviderEndpoint(provider,access.route?.());
    return {provider,revision,connectionId,credentialRevision,base,headers};
  }
  private check(h:Handle,requireFile=true) {
    const b=this.binding(h.sessionId);
    if(b.provider!==h.provider||b.connectionId!==h.connectionId||b.revision!==h.revision||b.credentialRevision!==h.credentialRevision)throw new Error('The original file belongs to another account revision');
    if(requireFile&&!routeAllowed('cloud',this.core.workbench.artifacts.version(h.sessionId,h.artifactId,h.versionId).policy))throw new Error('This file does not permit cloud processing');
    return b;
  }
  resolve(sessionId:string,ids:string[]){
    return ids.map(id=>{
      const h=this.handle(id,sessionId);this.check(h);
      if(h.state!=='ready'||!h.remoteId||h.expires&&h.expires<Date.now())throw new Error('The selected provider file is unavailable or expired');
      if(h.provider==='google')return {fileData:{mimeType:h.mime,fileUri:h.uri}};
      if(h.provider==='anthropic')return {type:'document',source:{type:'file',file_id:h.remoteId}};
      return {type:'input_file',file_id:h.remoteId};
    });
  }
  // Old, deleted references must not prevent a user from continuing the conversation.
  historyParts(sessionId:string,ids:string[]) {
    return ids.flatMap(id=>{
      try { return this.resolve(sessionId,[id]); }
      catch { return []; }
    });
  }
  private async remove(h:Handle){
    if(h.state==='deleted')return h;
    const account=this.accountBinding(h.provider,h.connectionId);
    if(account.revision!==h.revision || account.credentialRevision!==h.credentialRevision)throw new Error('The provider account changed. Check this file in the original account.');
    if(!h.remoteId)throw new Error('No provider handle was returned. Check the original account before removing this file.');
    const r=await this.fetch(new URL('files/'+encodeURIComponent(h.remoteId),account.base),{method:'DELETE',headers:account.headers,redirect:'error',signal:AbortSignal.timeout(12000)});
    await r.body?.cancel();if(!r.ok&&r.status!==404)throw new Error('The provider did not confirm deletion');
    h.state='deleted';this.save(h);
    if(h.cleanupPending)this.core.store.db.prepare('DELETE FROM provider_files WHERE id=?').run(h.id);
    return h;
  }
  async removeSession(sessionId:string){
    await Promise.allSettled(this.pending.get(sessionId)||[]);
    const rows=this.core.store.db.prepare('SELECT data FROM provider_files WHERE session_id=?').all(sessionId);
    for(const row of rows){
      const h:Handle=JSON.parse(String(row.data));
      if(h.state!=='deleted' && !(h.expires&&h.expires<=Date.now())){
        h.cleanupPending=true;this.save(h);
        try{await this.remove(h);}catch{continue;}
      }
      this.core.store.db.prepare('DELETE FROM provider_files WHERE id=?').run(h.id);
    }
  }
  async rpc(action:string,value:any,authorize?:()=>void){
    authorize?.();
    if(action==='pendingCleanup'){
      z.strictObject({}).parse(value);
      return this.core.store.db.prepare("SELECT data FROM provider_files WHERE json_extract(data,'$.cleanupPending')=1 LIMIT 256").all().map(r=>JSON.parse(String(r.data)));
    }
    if(action==='list'){
      const {sessionId}=z.strictObject({sessionId:z.uuid()}).parse(value);this.core.store.session(sessionId);
      return this.core.store.db.prepare('SELECT data FROM provider_files WHERE session_id=? ORDER BY rowid DESC LIMIT 100').all(sessionId).map(r=>JSON.parse(String(r.data)));
    }
    if(action==='remove'){
      const p=lookupOriginal.parse(value);
      return this.remove(this.handle(p.id,p.sessionId));
    }
    if(action!=='upload')throw new Error('Unknown original-file operation');
    const p=uploadOriginal.parse(value);
    const jobs=this.pending.get(p.sessionId)||new Set<Promise<Handle>>();
    this.pending.set(p.sessionId,jobs);
    const upload=this.upload(p,authorize);jobs.add(upload);
    try{return await upload;}finally{jobs.delete(upload);if(!jobs.size)this.pending.delete(p.sessionId);}
  }
  private async upload(p:z.infer<typeof uploadOriginal>,authorize?:()=>void){
    const b=this.binding(p.sessionId),files=this.core.workbench.artifacts;
    if ((p.expectedSessionRevision !== undefined && p.expectedSessionRevision !== (this.core.store.session(p.sessionId).configRevision || '0')) ||
        (p.expectedConnectionRevision !== undefined && p.expectedConnectionRevision !== b.revision)) throw new Error('The reviewed file destination changed. Review the account again.');
    const version=files.version(p.sessionId,p.artifactId,p.versionId);
    if(version.bytes>16*1024*1024||version.mime!=='application/pdf')throw new Error('Choose a PDF under 16 MiB for original document input');
    const h:Handle={id:randomUUID(),...p,name:version.name,mime:version.mime,provider:b.provider,connectionId:b.connectionId,revision:b.revision,credentialRevision:b.credentialRevision,state:'upload-uncertain',created:Date.now()};
    this.check(h);const {data}=await files.bytes(p.sessionId,p.artifactId,p.versionId);authorize?.();this.check(h);
    if(data.subarray(0,5).toString()!=='%PDF-')throw new Error('Invalid PDF signature');
    this.save(h);
    const signal=AbortSignal.timeout(90000);
    let result:any;
    if(b.provider==='google') {
      const target=new URL('/upload/v1beta/files',b.base);
      const begun=await this.fetch(target,{method:'POST',headers:{...b.headers,'Content-Type':'application/json','X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(data.length),'X-Goog-Upload-Header-Content-Type':version.mime},body:JSON.stringify({file:{display_name:h.name}}),redirect:'error',signal});
      await begun.body?.cancel();
      const destination=begun.headers.get('X-Goog-Upload-URL');
      if(!begun.ok||!destination||new URL(destination).origin!==target.origin)throw new Error('Gemini did not return an upload URL for this account');
      authorize?.();this.check(h);
      result=(await responseJson(await this.fetch(destination,{method:'POST',headers:{...b.headers,'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body:new Uint8Array(data),redirect:'error',signal}))).file;
    }else{
      const form=new FormData();form.append('file',new Blob([new Uint8Array(data)],{type:version.mime}),version.name);
      if(b.provider==='openai')form.append('purpose','user_data');
      result=await responseJson(await this.fetch(new URL('files',b.base),{method:'POST',headers:b.headers,body:form,redirect:'error',signal}));
    }
    const remote=b.provider==='google'?String(result?.name||'').replace(/^files\//,''):result?.id;
    if(typeof remote!=='string'||!/^[A-Za-z0-9_.-]{1,220}$/.test(remote))throw new Error('The provider did not return a valid file ID');
    h.remoteId=remote;h.state='ready';
    if(b.provider==='google')h.uri=new URL('files/'+encodeURIComponent(remote),b.base).href;
    const expires=result.expirationTime?Date.parse(result.expirationTime):Number(result.expires_at)*1000;
    if(Number.isFinite(expires)&&expires>0)h.expires=expires;
    this.save(h);authorize?.();this.check(h);return h;
  }
}
