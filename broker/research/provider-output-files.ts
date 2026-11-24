import { Buffer } from 'node:buffer';
import { ownerControlled } from '../authority.ts';
import type { Core } from '../core.ts';
import { mimeFor, safeName, type ArtifactVersion } from '../artifacts/store.ts';
import { resolveProviderEndpoint } from '../provider-registry.ts';
import { responseBytes, responseJson } from '../provider-http.ts';

const idPattern=/^[A-Za-z0-9_-]{1,200}$/;
export const providerOutputLimits={files:16,fileBytes:32*1024*1024,totalBytes:64*1024*1024,listBytes:256*1024,traceBytes:128*1024} as const;

export type ProviderSearchTrace={queries:string[];results:{id:string;url:string;title:string;snippet?:string;date?:string;lastUpdated?:string;source?:string}[]};
export type ProviderFetchTrace={contents:{url:string;title?:string;snippet?:string}[]};
export type ProviderResponseTrace={searches:ProviderSearchTrace[];fetches:ProviderFetchTrace[]};
export type ProviderOutputArtifact={responseId:string;fileId:string;artifactId:string;versionId:string;name:string;mime:string;bytes:number;createdAt:number};
export type ProviderOutputCapture={responseId:string;trace:ProviderResponseTrace;files:ProviderOutputArtifact[];recoveryNotes:string[]};
export type ProviderOutputCaptureInput={sessionId:string;response:unknown;connectionId?:string;accountRevision:number;credentialRevision:string;allowDownload:boolean;turnId?:string;operationId?:string;signal?:AbortSignal};
type ListedFile={id:string;filename:string;bytes:number;createdAt:number};
type Binding={sessionId:string;connectionId?:string;accountRevision:number;credentialRevision:string};
type StoredManifest=Binding&{files:ListedFile[]};
type StoredFile=Binding&{state:'pending'|'completed'|'unavailable';file:ListedFile;artifact?:ProviderOutputArtifact;note?:string};

const bounded=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'';
const validUrl=(value:unknown)=>{if(typeof value!=='string'||value.length>4096)return '';try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
const safeDate=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:undefined;
const traceJson=(value:ProviderResponseTrace)=>{
  if(Buffer.byteLength(JSON.stringify(value))<=providerOutputLimits.traceBytes)return value;
  const compact:ProviderResponseTrace={
    searches:value.searches.slice(0,2).map(s=>({queries:s.queries.slice(0,8).map(q=>q.slice(0,200)),results:s.results.slice(0,5).map(r=>({...r,url:r.url.slice(0,1000),title:r.title.slice(0,200),snippet:r.snippet?.slice(0,200)}))})),
    fetches:value.fetches.slice(0,2).map(f=>({contents:f.contents.slice(0,5).map(c=>({...c,url:c.url.slice(0,1000),title:c.title?.slice(0,200),snippet:c.snippet?.slice(0,200)}))})),
  };
  return Buffer.byteLength(JSON.stringify(compact))<=providerOutputLimits.traceBytes?compact:{searches:[],fetches:[]};
};

/** Exact structured tool results; prose and guessed citation markers are deliberately ignored. */
export function perplexityResponseTrace(response:unknown):ProviderResponseTrace {
  const output=Array.isArray((response as any)?.output)?(response as any).output.slice(0,128):[],searches:ProviderSearchTrace[]=[],fetches:ProviderFetchTrace[]=[];
  for(const item of output){
    if(!item||typeof item!=='object')continue;
    if(item.type==='search_results'&&Array.isArray(item.results)&&searches.length<32){
      const queries=Array.isArray(item.queries)?item.queries.flatMap((q:unknown)=>typeof q==='string'&&q.trim()?[q.trim().slice(0,500)]:[]).slice(0,32):[];
      const results=item.results.flatMap((r:any)=>{const url=validUrl(r?.url),rawId=r?.id;if(!url||!(typeof rawId==='string'||Number.isSafeInteger(rawId)))return[];const parsed=new URL(url);return[{id:String(rawId).slice(0,200),url,title:bounded(r.title,500).trim()||parsed.hostname,...(bounded(r.snippet,4000)?{snippet:bounded(r.snippet,4000)}:{}),...(safeDate(r.date)?{date:safeDate(r.date)}:{}),...(safeDate(r.last_updated)?{lastUpdated:safeDate(r.last_updated)}:{}),...(bounded(r.source,100)?{source:bounded(r.source,100)}:{})}];}).slice(0,100);
      searches.push({queries,results});
    }else if(item.type==='fetch_url_results'&&Array.isArray(item.contents)&&fetches.length<32){
      const contents=item.contents.flatMap((c:any)=>{const url=validUrl(c?.url);if(!url)return[];return[{url,...(bounded(c.title,500)?{title:bounded(c.title,500)}:{}),...(bounded(c.snippet,4000)?{snippet:bounded(c.snippet,4000)}:{})}];}).slice(0,50);
      fetches.push({contents});
    }
  }
  return traceJson({searches,fetches});
}

const hasSharedFile=(response:any)=>Array.isArray(response?.output)&&response.output.some((item:any)=>item&&typeof item==='object'&&item.type==='share_file');
const outputArtifact=(responseId:string,fileId:string,version:ArtifactVersion):ProviderOutputArtifact=>({responseId,fileId,artifactId:version.artifactId,versionId:version.versionId,name:version.name,mime:version.mime,bytes:version.bytes,createdAt:version.createdAt});
const dispositionName=(value:string|null)=>{
  if(!value||!/^attachment(?:;|$)/i.test(value.trim()))throw new Error('Provider file is missing a safe attachment disposition');
  const encoded=/filename\*=UTF-8''([^;]+)/i.exec(value)?.[1],quoted=/filename="([^"]*)"/i.exec(value)?.[1],plain=/filename=([^;]+)/i.exec(value)?.[1]?.trim();
  try{return decodeURIComponent(encoded||'')||quoted||plain||'';}catch{throw new Error('Provider returned an invalid attachment filename');}
};
const contentMime=(value:string|null,name:string,bytes:Buffer)=>{
  const declared=(value||'').split(';',1)[0].trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(declared))throw new Error('Provider returned an invalid file content type');
  if(bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))||bytes.subarray(0,2).toString('ascii')==='MZ')throw new Error('Executable provider files are not imported');
  if((declared.startsWith('text/')||['application/json','application/xml'].includes(declared))&&bytes.includes(0))throw new Error('Provider text file contains binary data');
  const inferred=mimeFor(name,bytes);
  const extension=name.toLowerCase().split('.').pop()||'',expected:Record<string,string>={csv:'text/csv',tsv:'text/tab-separated-values',json:'application/json',xml:'application/xml',html:'text/html',htm:'text/html',md:'text/markdown',markdown:'text/markdown',txt:'text/plain',pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',zip:'application/zip',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  if(expected[extension]&&inferred!==expected[extension]&&!(expected[extension].startsWith('text/')&&inferred.startsWith('text/')))throw new Error('Provider file type does not match its filename');
  if(declared==='application/octet-stream')return inferred;
  if(inferred!=='application/octet-stream'&&inferred!==declared&&!(declared.startsWith('text/')&&inferred.startsWith('text/')))throw new Error('Provider file type does not match its bytes and filename');
  return declared;
};

export class ProviderOutputFiles {
  fetch=fetch;
  private busy=new Set<string>();
  readonly core:Core;
  constructor(core:Core){
    this.core=core;
    core.store.db.exec(`CREATE TABLE IF NOT EXISTS provider_output_manifests(response_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_output_files(response_id TEXT NOT NULL,file_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,data TEXT NOT NULL,PRIMARY KEY(response_id,file_id));`);
  }
  private check(binding:Binding){
    const session=this.core.store.session(binding.sessionId);
    if(session.provider!=='perplexity'||session.temporary)throw new Error('Generated files require a saved Perplexity conversation');
    if(!ownerControlled(session))throw new Error('Generated files stay unavailable during restricted remote turns');
    if((session.connectionId||undefined)!==binding.connectionId)throw new Error('The account used for this provider response changed');
    const account=binding.connectionId?this.core.chatConnections.get(binding.connectionId,'perplexity'):undefined;
    if((account?.revision||0)!==binding.accountRevision||this.core.credentials.credentialRevision(account?'connection:'+account.id:'provider:perplexity')!==binding.credentialRevision)throw new Error('The account used for this provider response changed');
    return account;
  }
  private same(stored:Binding,binding:Binding){return stored.sessionId===binding.sessionId&&stored.connectionId===binding.connectionId&&stored.accountRevision===binding.accountRevision&&stored.credentialRevision===binding.credentialRevision;}
  private storedManifest(responseId:string,binding:Binding):ListedFile[]|undefined{
    const row=this.core.store.db.prepare('SELECT data FROM provider_output_manifests WHERE response_id=?').get(responseId);if(!row)return;
    const value=JSON.parse(String(row.data)) as StoredManifest;if(!this.same(value,binding))throw new Error('That provider response is already bound to another session or account');return value.files;
  }
  private saveManifest(responseId:string,binding:Binding,files:ListedFile[]){
    const data:StoredManifest={...binding,files};this.core.store.db.prepare('INSERT OR IGNORE INTO provider_output_manifests VALUES(?,?,?)').run(responseId,binding.sessionId,JSON.stringify(data));
    this.storedManifest(responseId,binding);
  }
  private storedFile(responseId:string,fileId:string,binding:Binding):StoredFile|undefined{
    const row=this.core.store.db.prepare('SELECT data FROM provider_output_files WHERE response_id=? AND file_id=?').get(responseId,fileId);if(!row)return;
    const value=JSON.parse(String(row.data)) as StoredFile;if(!this.same(value,binding))throw new Error('That provider file is already bound to another session or account');return value;
  }
  private saveFile(responseId:string,binding:Binding,value:StoredFile){
    this.core.store.db.prepare('INSERT INTO provider_output_files VALUES(?,?,?,?) ON CONFLICT(response_id,file_id) DO UPDATE SET data=excluded.data').run(responseId,value.file.id,binding.sessionId,JSON.stringify(value));
  }
  private recovered(responseId:string,file:ListedFile,binding:Binding){
    const row=this.core.store.db.prepare("SELECT data FROM artifact_versions WHERE json_extract(data,'$.sessionId')=? AND json_extract(data,'$.provenance.kind')='perplexity-generated-file' AND json_extract(data,'$.provenance.responseId')=? AND json_extract(data,'$.provenance.fileId')=? ORDER BY created LIMIT 1").get(binding.sessionId,responseId,file.id);
    if(!row)return;
    const version=JSON.parse(String(row.data)) as ArtifactVersion;if(!this.core.workbench.artifacts.authorized(binding.sessionId,version.artifactId))return;
    const artifact=outputArtifact(responseId,file.id,version),stored:StoredFile={...binding,state:'completed',file,artifact};this.saveFile(responseId,binding,stored);return artifact;
  }
  private async list(responseId:string,binding:Binding,key:string,endpoint:string,signal:AbortSignal,recoveryNotes:string[]){
    const saved=this.storedManifest(responseId,binding);if(saved)return saved;
    const result=await this.fetch(endpoint+'/'+encodeURIComponent(responseId)+'/files',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal});
    if(result.status===404){await result.body?.cancel().catch(()=>{});recoveryNotes.push('Generated files are no longer available from Perplexity. The text response and citations were kept.');return[];}
    const body=await responseJson(result,providerOutputLimits.listBytes);if(body?.object!=='list'||!Array.isArray(body.data)||body.data.length>providerOutputLimits.files)throw new Error('Provider returned an invalid generated-file list');
    const ids=new Set<string>(),files:ListedFile[]=body.data.map((item:any)=>{
      if(item?.object!=='file'||!idPattern.test(item.id)||ids.has(item.id)||typeof item.filename!=='string'||!item.filename||Buffer.byteLength(item.filename)>1024||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>providerOutputLimits.fileBytes||!Number.isSafeInteger(item.created_at)||item.created_at<0)throw new Error('Provider returned invalid generated-file metadata');
      if(item.created_at>Number.MAX_SAFE_INTEGER/1000)throw new Error('Provider returned invalid generated-file metadata');
      ids.add(item.id);return{id:item.id,filename:safeName(item.filename,'generated file'),bytes:item.bytes,createdAt:item.created_at*1000};
    });
    if(files.reduce((n,file)=>n+file.bytes,0)>providerOutputLimits.totalBytes)throw new Error('Provider generated files exceed the 64 MiB import limit');
    this.check(binding);this.saveManifest(responseId,binding,files);return files;
  }
  private async download(responseId:string,file:ListedFile,binding:Binding,key:string,endpoint:string,input:ProviderOutputCaptureInput,signal:AbortSignal,recoveryNotes:string[]){
    const prior=this.storedFile(responseId,file.id,binding);if(prior?.state==='completed'&&prior.artifact){this.core.workbench.artifacts.version(binding.sessionId,prior.artifact.artifactId,prior.artifact.versionId);return prior.artifact;}
    if(prior?.state==='unavailable'){if(prior.note)recoveryNotes.push(prior.note);return;}
    const recovered=this.recovered(responseId,file,binding);if(recovered)return recovered;
    this.saveFile(responseId,binding,{...binding,state:'pending',file});
    const result=await this.fetch(endpoint+'/'+encodeURIComponent(responseId)+'/files/'+encodeURIComponent(file.id)+'/content',{headers:{Authorization:'Bearer '+key,Accept:'*/*'},redirect:'error',signal});
    if(result.status===404){await result.body?.cancel().catch(()=>{});const note=`${file.filename} expired before PAL could keep it. The text response and citations were preserved.`;this.saveFile(responseId,binding,{...binding,state:'unavailable',file,note});recoveryNotes.push(note);return;}
    const length=result.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==file.bytes))throw new Error('Provider file size does not match its listing');
    const headerName=safeName(dispositionName(result.headers.get('content-disposition')),'generated file');if(headerName!==file.filename)throw new Error('Provider attachment filename does not match its listing');
    const bytes=await responseBytes(result,Math.min(providerOutputLimits.fileBytes,file.bytes+1));if(bytes.length!==file.bytes)throw new Error('Provider file size does not match its listing');
    const mime=contentMime(result.headers.get('content-type'),file.filename,bytes);this.check(binding);input.signal?.throwIfAborted();
    const version=await this.core.workbench.artifacts.install({sessionId:binding.sessionId,bytes,name:file.filename,mime,source:'model-generation',turnId:input.turnId,operationId:input.operationId,
      provenance:{kind:'perplexity-generated-file',provider:'perplexity',responseId,fileId:file.id,providerCreatedAt:file.createdAt,...(binding.connectionId?{connectionId:binding.connectionId}:{})}});
    const artifact=outputArtifact(responseId,file.id,version);this.saveFile(responseId,binding,{...binding,state:'completed',file,artifact});return artifact;
  }
  async capture(input:ProviderOutputCaptureInput):Promise<ProviderOutputCapture>{
    const response=input.response as any,responseId=typeof response?.id==='string'?response.id:typeof response?.response_id==='string'?response.response_id:'';
    if(!idPattern.test(responseId))throw new Error('Invalid provider response ID');
    const trace=perplexityResponseTrace(response),recoveryNotes:string[]=[],empty=()=>({responseId,trace,files:[],recoveryNotes});
    if(!hasSharedFile(response))return empty();
    const session=this.core.store.session(input.sessionId);if(!input.allowDownload||!ownerControlled(session)){recoveryNotes.push('Generated files were not downloaded during this restricted remote turn.');return empty();}
    if(session.temporary){recoveryNotes.push('Generated files are not retained for temporary conversations.');return empty();}
    const binding:Binding={sessionId:input.sessionId,connectionId:input.connectionId,accountRevision:input.accountRevision,credentialRevision:input.credentialRevision};
    const account=this.check(binding),access=this.core.accountAccess('perplexity',account?.id),key=access.key();if(!key)throw new Error('Add a Perplexity account key');
    const endpoint=resolveProviderEndpoint('perplexity',access.route?.()).replace(/\/+$/,'').replace(/\/v1$/,'')+'/v1/agent',signal=AbortSignal.any([input.signal||new AbortController().signal,AbortSignal.timeout(60_000)]);
    const lock=binding.sessionId+'\0'+responseId;if(this.busy.has(lock))throw new Error('Generated files are already being imported');this.busy.add(lock);
    try{const listed=await this.list(responseId,binding,key,endpoint,signal,recoveryNotes),files:ProviderOutputArtifact[]=[];for(const file of listed){this.check(binding);const value=await this.download(responseId,file,binding,key,endpoint,input,signal,recoveryNotes);if(value)files.push(value);}return{responseId,trace,files,recoveryNotes};}
    finally{this.busy.delete(lock);}
  }
}
