import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { Core } from './core.ts';
import type { ProviderOptionField } from './provider-registry.ts';
import { limitedControlled } from './authority.ts';
import { responseJson } from './provider-http.ts';

export const xaiManagementCredentialId='xai_management' as const;
export const xaiManagementOrigin='https://management-api.x.ai';
export const xaiCollectionOwnerFeature='provider.collections.v1' as const;
const sessionId=z.uuid(),collectionId=z.string().regex(/^collection_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),originalFileId=z.uuid();
const acknowledgement={acknowledgeCloudStorage:z.literal(true)};
export const xaiCollectionSchemas={
  create:z.strictObject({sessionId,name:z.string().trim().min(1).max(200),description:z.string().trim().max(2000).optional(),...acknowledgement}),
  list:z.strictObject({sessionId}),
  addDocument:z.strictObject({sessionId,collectionId,originalFileId,...acknowledgement}),
  removeDocument:z.strictObject({sessionId,collectionId,originalFileId,acknowledgeRemoval:z.literal(true)}),
  attach:z.strictObject({sessionId,collectionId,maxResults:z.number().int().min(1).max(50).default(10),acknowledgeSearch:z.literal(true)}),
  detach:z.strictObject({sessionId,collectionId}),
  delete:z.strictObject({sessionId,collectionId,acknowledgeDeletion:z.literal(true)}),
} as const;
export const xaiCollectionOptionsSchema=z.strictObject({collectionSearch:z.boolean().optional(),collectionMaxResults:z.number().int().min(1).max(50).optional()});
export const xaiCollectionOptionFields:ProviderOptionField[]=[
  {key:'collectionSearch',label:'Search attached xAI collections',description:'Lets Grok search only the collections explicitly attached to this conversation.',type:'boolean',default:false,operations:['chat']},
  {key:'collectionMaxResults',label:'Collection search results',type:'number',min:1,max:50,integer:true,operations:['chat']},
];
export const xaiCollectionDataLabels={
  create:['collection name','collection description'],list:['collection metadata'],addDocument:['original PDF','provider file ID'],removeDocument:['provider file ID'],
  attach:['conversation ID','collection ID'],detach:['conversation ID','collection ID'],delete:['collection ID'],
} as const;
export const xaiCollectionOwnerOperations={
  'owner.xaiCollections.create':{schema:xaiCollectionSchemas.create,kind:'signed',sensitive:['name','description']},
  'owner.xaiCollections.list':{schema:xaiCollectionSchemas.list,kind:'read'},
  'owner.xaiCollections.addDocument':{schema:xaiCollectionSchemas.addDocument,kind:'signed',sensitive:['originalFileId']},
  'owner.xaiCollections.removeDocument':{schema:xaiCollectionSchemas.removeDocument,kind:'signed'},
  'owner.xaiCollections.attach':{schema:xaiCollectionSchemas.attach,kind:'signed'},
  'owner.xaiCollections.detach':{schema:xaiCollectionSchemas.detach,kind:'mutation'},
  'owner.xaiCollections.delete':{schema:xaiCollectionSchemas.delete,kind:'signed'},
} as const;

export type XaiCollection=Readonly<{id:string;name:string;description?:string;createdAt?:string;documentsCount:number}>;
export type XaiCollectionSearchTool={type:'file_search';vector_store_ids:string[];max_num_results:number};
export type XaiManagementAccess={key:string;revision:string};
export type XaiManagementAccessResolver=(connectionId?:string)=>XaiManagementAccess;
type Binding={connectionId?:string;connectionRevision:number;apiRevision:string;managementRevision:string};
type InferenceBinding=Omit<Binding,'managementRevision'>;
type Attached=Binding&{sessionId:string;collectionId:string;maxResults:number;attachedAt:number};
type DocumentLink=Binding&{sessionId:string;collectionId:string;originalFileId:string;fileId:string;addedAt:number};

const same=(left:Binding,right:Binding)=>left.connectionId===right.connectionId&&left.connectionRevision===right.connectionRevision&&left.apiRevision===right.apiRevision&&left.managementRevision===right.managementRevision;
const sameInference=(left:InferenceBinding,right:InferenceBinding)=>left.connectionId===right.connectionId&&left.connectionRevision===right.connectionRevision&&left.apiRevision===right.apiRevision;
const rowData=(row:any)=>JSON.parse(String(row.data));
const collection=(value:any):XaiCollection=>{
  const parsed=collectionId.safeParse(value?.collection_id);if(!parsed.success||typeof value?.collection_name!=='string'||!value.collection_name.trim()||value.collection_name.length>200)throw new Error('xAI returned invalid collection metadata');
  const count=Number(value.documents_count??0);if(!Number.isSafeInteger(count)||count<0)throw new Error('xAI returned an invalid collection document count');
  return{id:parsed.data,name:value.collection_name.trim(),documentsCount:count,...(typeof value.collection_description==='string'&&value.collection_description?{description:value.collection_description.slice(0,2000)}:{}),...(typeof value.created_at==='string'?{createdAt:value.created_at.slice(0,80)}:{})};
};

/** Broker-owned xAI collection lifecycle. Management keys never share an access object or destination with inference keys. */
export class XaiCollections {
  fetch:typeof fetch=fetch;
  private readonly authority=new AsyncLocalStorage<()=>void>();
  readonly core:Core;readonly managementAccess:XaiManagementAccessResolver;
  constructor(core:Core,managementAccess:XaiManagementAccessResolver){
    this.core=core;this.managementAccess=managementAccess;
    core.store.db.exec(`CREATE TABLE IF NOT EXISTS xai_collection_sessions(session_id TEXT NOT NULL,collection_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,collection_id));
      CREATE TABLE IF NOT EXISTS xai_collection_documents(session_id TEXT NOT NULL,collection_id TEXT NOT NULL,original_file_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,collection_id,original_file_id));`);
  }
  private inference(id:string){
    this.authority.getStore()?.();
    const session=this.core.store.session(id);
    if(session.provider!=='xai'||session.temporary||limitedControlled(session)||this.core.settingsFor(id).paused)throw new Error('Choose an active owner-controlled xAI conversation');
    const account=session.connectionId?this.core.chatConnections.get(session.connectionId,'xai'):undefined;
    const access=this.core.accountAccess('xai',session.connectionId),apiKey=access.key();if(!apiKey)throw new Error('Configure the xAI API key for this named account');
    const apiRef=account?'connection:'+account.id:'provider:xai',apiRevision=this.core.credentials.credentialRevision(apiRef);
    return{session,apiKey,connectionId:account?.id,binding:{...(account?{connectionId:account.id}:{}),connectionRevision:account?.revision||0,apiRevision} satisfies InferenceBinding};
  }
  private binding(id:string){
    const base=this.inference(id),management=this.managementAccess(base.connectionId);if(!management.key)throw new Error('Configure a separate xAI Management API key for this named account');
    return{...base,managementKey:management.key,binding:{...base.binding,managementRevision:management.revision} satisfies Binding};
  }
  private recheck(sessionId:string,expected:Binding){const current=this.binding(sessionId);if(!same(current.binding,expected))throw new Error('The xAI account or Management key changed. Review the collection and retry.');return current;}
  private headers(key:string,json=false){return{Authorization:'Bearer '+key,...(json?{'Content-Type':'application/json'}:{})};}
  private url(path='collections'){return new URL('/v1/'+path,xaiManagementOrigin);}
  private async metadata(sessionId:string,id:string,expected:Binding){const current=this.recheck(sessionId,expected),data=await responseJson(await this.fetch(this.url('collections/'+encodeURIComponent(id)),{headers:this.headers(current.managementKey),redirect:'error',signal:AbortSignal.timeout(15000)}));this.recheck(sessionId,expected);return collection(data);}
  private async approve(sessionId:string,title:string,detail:string){const answer=await this.core.approval(sessionId,{kind:'provider',title,detail,choices:['allow','deny']});if(answer?.choice!=='allow')throw new Error('The xAI collection change was declined');}
  private async empty(response:Response){const data=await responseJson(response,64*1024);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('xAI returned an invalid collection response');}
  private saveAttachment(value:Attached){this.core.store.db.prepare('INSERT INTO xai_collection_sessions VALUES(?,?,?) ON CONFLICT(session_id,collection_id) DO UPDATE SET data=excluded.data').run(value.sessionId,value.collectionId,JSON.stringify(value));this.core.changed();}
  private forgetCollection(id:string,binding:Binding){
    for(const table of ['xai_collection_sessions','xai_collection_documents'])for(const row of this.core.store.db.prepare(`SELECT rowid,data FROM ${table} WHERE collection_id=?`).all(id))if(same(rowData(row),binding))this.core.store.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid);
  }
  async create(value:unknown){
    const p=xaiCollectionSchemas.create.parse(value),initial=this.binding(p.sessionId);
    await this.approve(p.sessionId,'Create a persistent xAI collection?',`xAI will store “${p.name}” in the selected named account until you delete it.`);
    const current=this.recheck(p.sessionId,initial.binding),data=await responseJson(await this.fetch(this.url(),{method:'POST',headers:this.headers(current.managementKey,true),body:JSON.stringify({collection_name:p.name,...(p.description?{collection_description:p.description}:{})}),redirect:'error',signal:AbortSignal.timeout(15000)}));
    this.recheck(p.sessionId,initial.binding);return collection(data);
  }
  async list(value:unknown){
    const p=xaiCollectionSchemas.list.parse(value),initial=this.binding(p.sessionId),items:XaiCollection[]=[];let token='';
    for(let page=0;page<10;page++){
      const current=this.recheck(p.sessionId,initial.binding),url=this.url();url.searchParams.set('limit','100');if(token)url.searchParams.set('pagination_token',token);
      const data=await responseJson(await this.fetch(url,{headers:this.headers(current.managementKey),redirect:'error',signal:AbortSignal.timeout(15000)}));this.recheck(p.sessionId,initial.binding);
      if(!Array.isArray(data?.collections)||data.collections.length>100)throw new Error('xAI returned an invalid collection list');items.push(...data.collections.map(collection));
      token=typeof data.pagination_token==='string'?data.pagination_token:'';if(!token||data.collections.length<100)break;if(page===9)throw new Error('xAI returned too many collection pages');
    }
    return items;
  }
  private original(sessionId:string,id:string){
    const parts=this.core.providerFiles.resolve(sessionId,[id]);const part=parts[0] as any,fileId=part?.type==='input_file'?part.file_id:'';
    if(typeof fileId!=='string'||!/^file_[A-Za-z0-9._-]{1,220}$/.test(fileId))throw new Error('Choose an uploaded xAI PDF handle from this conversation');return fileId;
  }
  async addDocument(value:unknown){
    const p=xaiCollectionSchemas.addDocument.parse(value),initial=this.binding(p.sessionId),fileId=this.original(p.sessionId,p.originalFileId);await this.metadata(p.sessionId,p.collectionId,initial.binding);
    await this.approve(p.sessionId,'Add this PDF to the xAI collection?',`xAI will persist and index provider file ${fileId} in ${p.collectionId}.`);
    if(this.original(p.sessionId,p.originalFileId)!==fileId)throw new Error('The uploaded PDF handle changed. Review it and retry.');const current=this.recheck(p.sessionId,initial.binding);
    await this.empty(await this.fetch(this.url(`collections/${encodeURIComponent(p.collectionId)}/documents/${encodeURIComponent(fileId)}`),{method:'POST',headers:this.headers(current.managementKey,true),body:'{}',redirect:'error',signal:AbortSignal.timeout(30000)}));this.recheck(p.sessionId,initial.binding);
    const link:DocumentLink={...initial.binding,...p,fileId,addedAt:Date.now()};this.core.store.db.prepare('INSERT INTO xai_collection_documents VALUES(?,?,?,?) ON CONFLICT(session_id,collection_id,original_file_id) DO UPDATE SET data=excluded.data').run(p.sessionId,p.collectionId,p.originalFileId,JSON.stringify(link));this.core.changed();return link;
  }
  async removeDocument(value:unknown){
    const p=xaiCollectionSchemas.removeDocument.parse(value),row=this.core.store.db.prepare('SELECT data FROM xai_collection_documents WHERE session_id=? AND collection_id=? AND original_file_id=?').get(p.sessionId,p.collectionId,p.originalFileId);if(!row)throw new Error('This PDF is not recorded in that xAI collection');
    const link=rowData(row) as DocumentLink,current=this.binding(p.sessionId);if(!same(link,current.binding))throw new Error('The collection document belongs to another xAI account revision');
    await this.approve(p.sessionId,'Remove this PDF from the xAI collection?',`This removes ${link.fileId} from ${p.collectionId}; it does not delete the original provider file.`);const checked=this.recheck(p.sessionId,link);
    const response=await this.fetch(this.url(`collections/${encodeURIComponent(p.collectionId)}/documents/${encodeURIComponent(link.fileId)}`),{method:'DELETE',headers:this.headers(checked.managementKey),redirect:'error',signal:AbortSignal.timeout(15000)});if(response.status!==404)await this.empty(response);else await response.body?.cancel();this.recheck(p.sessionId,link);
    this.core.store.db.prepare('DELETE FROM xai_collection_documents WHERE session_id=? AND collection_id=? AND original_file_id=?').run(p.sessionId,p.collectionId,p.originalFileId);this.core.changed();return{removed:true};
  }
  async attach(value:unknown){
    const p=xaiCollectionSchemas.attach.parse(value),initial=this.binding(p.sessionId),remote=await this.metadata(p.sessionId,p.collectionId,initial.binding);
    await this.approve(p.sessionId,'Let Grok search this collection?',`Future turns in this conversation may send queries to “${remote.name}” and retrieve up to ${p.maxResults} matches.`);this.recheck(p.sessionId,initial.binding);
    const attached:Attached={...initial.binding,sessionId:p.sessionId,collectionId:p.collectionId,maxResults:p.maxResults,attachedAt:Date.now()};this.saveAttachment(attached);return attached;
  }
  detach(value:unknown){const p=xaiCollectionSchemas.detach.parse(value);this.inference(p.sessionId);this.core.store.db.prepare('DELETE FROM xai_collection_sessions WHERE session_id=? AND collection_id=?').run(p.sessionId,p.collectionId);this.core.changed();return{detached:true};}
  tools(sessionId:string,options:unknown):XaiCollectionSearchTool[]{
    const configured=xaiCollectionOptionsSchema.parse(options||{});if(configured.collectionSearch!==true)return[];const current=this.inference(sessionId);
    const rows=this.core.store.db.prepare('SELECT data FROM xai_collection_sessions WHERE session_id=? ORDER BY rowid LIMIT 9').all(sessionId).map(rowData) as Attached[];if(!rows.length)return[];if(rows.length>8||rows.some(row=>!sameInference(row,current.binding)))throw new Error('An attached xAI collection belongs to another account revision');
    return[{type:'file_search',vector_store_ids:rows.map(row=>row.collectionId),max_num_results:configured.collectionMaxResults||Math.min(...rows.map(row=>row.maxResults))}];
  }
  async delete(value:unknown){
    const p=xaiCollectionSchemas.delete.parse(value),initial=this.binding(p.sessionId),remote=await this.metadata(p.sessionId,p.collectionId,initial.binding);
    await this.approve(p.sessionId,'Delete this xAI collection?',`This permanently deletes “${remote.name}” and its index from the selected xAI account.`);const current=this.recheck(p.sessionId,initial.binding);
    const response=await this.fetch(this.url('collections/'+encodeURIComponent(p.collectionId)),{method:'DELETE',headers:this.headers(current.managementKey),redirect:'error',signal:AbortSignal.timeout(15000)});if(response.status!==404)await this.empty(response);else await response.body?.cancel();this.recheck(p.sessionId,initial.binding);
    this.forgetCollection(p.collectionId,initial.binding);this.core.changed();return{deleted:true};
  }
  forgetSession(sessionId:string){
    for(const table of ['xai_collection_sessions','xai_collection_documents'])this.core.store.db.prepare('DELETE FROM '+table+' WHERE session_id=?').run(sessionId);
  }
  async rpc(action:string,value:unknown,authorize?:()=>void):Promise<unknown>{
    if(!Object.hasOwn(xaiCollectionSchemas,action))throw new Error('Unknown xAI collection operation');
    if(authorize)return this.authority.run(authorize,()=>this.rpc(action,value));
    return action==='create'?this.create(value):action==='list'?this.list(value):action==='addDocument'?this.addDocument(value):action==='removeDocument'?this.removeDocument(value):action==='attach'?this.attach(value):action==='detach'?this.detach(value):this.delete(value);}
}
