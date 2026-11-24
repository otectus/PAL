import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { palEnv } from '../../paths.ts';
import { responseJson } from '../../provider-http.ts';
import type { VectorArtifact, VectorQuery, VectorArtifactMetadata, VectorHit, VectorRepository } from './contracts.ts';
import { artifactPointId } from './qdrant.ts';

export interface VectorProjection extends VectorRepository {
  initialize(signal?:AbortSignal):Promise<void>;
  deleteByArtifacts(ids:readonly string[],epoch:number,signal?:AbortSignal):Promise<void>;
}
type Engine='simple'|'chroma'|'elasticsearch'|'pinecone'|'redis';
export type VectorConfig={engine:Engine;endpoint:string;tenant:string;database:string;namespace:string;external:boolean};
export function vectorConfig():VectorConfig|undefined {
  const engine=palEnv('VECTOR_BACKEND')||'qdrant';
  if(engine==='qdrant')return;
  if(!['simple','chroma','elasticsearch','pinecone','redis'].includes(engine))throw new Error('Unknown vector store');
  const endpoint=palEnv('VECTOR_URL')||({chroma:'http://127.0.0.1:8000',elasticsearch:'http://127.0.0.1:9200',redis:'redis://127.0.0.1:6379'} as Record<string,string>)[engine]||'';
  const url=engine==='simple'?undefined:new URL(endpoint);
  const external=!!url && !['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url && (url.username||url.password||url.search||url.hash||!(engine==='redis'?['redis:','rediss:']:['http:','https:']).includes(url.protocol)))throw new Error('Invalid vector service URL');
  if(external && (palEnv('VECTOR_CLOUD')!=='1'||!['https:','rediss:'].includes(url!.protocol)))throw new Error('External vector storage requires TLS and PAL_VECTOR_CLOUD=1');
  return {engine:engine as Engine,endpoint:endpoint.replace(/\/$/,''),external,tenant:palEnv('VECTOR_TENANT')||'default_tenant',database:palEnv('VECTOR_DATABASE')||'default_database',namespace:palEnv('VECTOR_NAMESPACE')||'pal'};
}
export function vectorConfigId(config:VectorConfig) {return createHash('sha256').update(JSON.stringify(config)).digest('hex');}
export function allowedHit(m:VectorArtifactMetadata,q:VectorQuery) {
  return m?.ownerId===q.ownerId && q.scopeIds.includes(m.scopeId) && m.embeddingFingerprint===q.embeddingFingerprint && m.generation===q.generation &&
    m.erasureEpoch<=q.currentErasureEpoch && (m.expiresAtUs===null||m.expiresAtUs>q.nowUs) && (!q.artifactKinds?.length||q.artifactKinds.includes(m.artifactKind));
}
function validVector(v:readonly number[],d:number) {
  if(v.length!==d || v.some(n=>!Number.isFinite(n)) || !v.some(n=>n!==0))throw new Error('Invalid vector for this embedding space');
}
type LocalRow={id:string;meta:string;vec:Uint8Array};
export class ServiceVectorRepository implements VectorProjection {
  config:VectorConfig;dim:number;space:string;name:string;key:string;db:DatabaseSync; collection=''; redis?:import('@redis/client').RedisClientType;
  constructor(config:VectorConfig,space:string,dim:number,directory:string,key:string) {
    if(!/^[a-f0-9]{64}$/.test(space))throw new Error('Invalid vector fingerprint');
    this.config=config;this.dim=dim;this.space=space;this.key=key;
    this.name='pal_'+createHash('sha256').update(config.namespace+'\0'+space).digest('hex').slice(0,32);
    this.db=new DatabaseSync(join(directory,'provider-vector-points.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS points(space TEXT,id TEXT,meta TEXT,vec BLOB,PRIMARY KEY(space,id));CREATE INDEX IF NOT EXISTS points_artifact ON points(space,json_extract(meta,\'$.artifactId\'));');
  }
  private async rest(path:string,method='GET',body?:unknown,signal?:AbortSignal) {
    const headers:Record<string,string>={'Content-Type':'application/json'};
    if(this.config.engine==='pinecone')headers['X-Pinecone-Api-Version']='2025-10';
    if(this.key){if(this.config.engine==='pinecone')headers['Api-Key']=this.key;else if(this.config.engine==='chroma')headers['x-chroma-token']=this.key;else headers.Authorization='ApiKey '+this.key;}
    const r=await fetch(this.config.endpoint+path,{method,headers,redirect:'error',body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});
    if(!r.ok){await r.body?.cancel();throw Object.assign(new Error(this.config.engine+' vector service returned HTTP '+r.status),{status:r.status});}
    return r.status===204?{}:responseJson(r,8*1024*1024);
  }
  async initialize(signal?:AbortSignal){
    const c=this.config;
    if(c.engine==='chroma'){
      const base='/api/v2/tenants/'+encodeURIComponent(c.tenant)+'/databases/'+encodeURIComponent(c.database)+'/collections';
      const item=await this.rest(base,'POST',{name:this.name,get_or_create:true,configuration:{hnsw:{space:'cosine'}}},signal);
      if(typeof item.id!=='string'||item.dimension && item.dimension!==this.dim)throw new Error('Incompatible Chroma collection');
      this.collection=base+'/'+encodeURIComponent(item.id);
    } else if(c.engine==='elasticsearch'){
      try{const info=await this.rest('/'+this.name+'/_mapping','GET',undefined,signal);
        const vector=info[this.name]?.mappings?.properties?.vector;if(vector?.dims!==this.dim||vector.similarity!=='cosine')throw new Error('Incompatible Elasticsearch index');
      }catch(e:any){if(e.status!==404)throw e;
        await this.rest('/'+this.name,'PUT',{mappings:{properties:{vector:{type:'dense_vector',dims:this.dim,index:true,similarity:'cosine'},ownerId:{type:'keyword'},scopeId:{type:'keyword'},embeddingFingerprint:{type:'keyword'},generation:{type:'long'}}}},signal);}
    } else if(c.engine==='pinecone'){
      const info=await this.rest('/describe_index_stats','POST',{},signal);
      if(info.dimension!==this.dim || info.metric!=='cosine' || info.vectorType && info.vectorType!=='dense')throw new Error('Choose a dense Pinecone cosine index with the configured embedding dimension');
    } else if(c.engine==='redis'){
      const {createClient}=await import('@redis/client');
      this.redis=createClient({url:c.endpoint,password:this.key||undefined,socket:{reconnectStrategy:false,connectTimeout:3000},disableOfflineQueue:true});
      this.redis.on('error',()=>{});await this.redis.connect();
      try {await this.redis.sendCommand(['FT.CREATE',this.name,'ON','HASH','PREFIX','1',this.name+':','SCHEMA','owner','TAG','scope','TAG','generation','NUMERIC','vector','VECTOR','FLAT','6','TYPE','FLOAT32','DIM',String(this.dim),'DISTANCE_METRIC','COSINE']);}
      catch(e:any){
        if(!/Index already exists/i.test(e.message))throw e;
        const pairs=(v:unknown)=>{if(!Array.isArray(v))return {};const out:Record<string,unknown>={};for(let i=0;i+1<v.length;i+=2)out[String(v[i]).toLowerCase()]=v[i+1];return out;};
        const info=pairs(await this.redis.sendCommand(['FT.INFO',this.name])),fields=Array.isArray(info.attributes)?info.attributes.map(pairs):[];
        const vector=fields.find(field=>field.identifier==='vector'),definition=pairs(info.index_definition),prefixes=definition.prefixes;
        if(!vector||String(vector.data_type).toUpperCase()!=='FLOAT32'||Number(vector.dim)!==this.dim||String(vector.distance_metric).toUpperCase()!=='COSINE'
          ||!Array.isArray(prefixes)||prefixes.length!==1||prefixes[0]!==this.name+':')throw new Error('Existing Redis vector index has an incompatible schema or prefix');
      }
    }
  }
  async publish(a:VectorArtifact){
    validVector(a.vector,this.dim);
    if(a.pointId!==artifactPointId(a.metadata)||a.metadata.embeddingFingerprint!==this.space)throw new Error('Invalid immutable vector identity');
    if(this.config.external && a.metadata.sensitivity!=='cloud_allowed')return;
    // Persist the identity before remote dispatch so a later erase also covers an uncertain write.
    const vec=Buffer.from(Float32Array.from(a.vector).buffer), meta=JSON.stringify(a.metadata);
    this.db.prepare('INSERT OR REPLACE INTO points VALUES(?,?,?,?)').run(this.name,a.pointId,meta,this.config.engine==='simple'?vec:null);
    const m={ownerId:a.metadata.ownerId,scopeId:a.metadata.scopeId,generation:a.metadata.generation};
    switch(this.config.engine){
      case 'chroma':await this.rest(this.collection+'/upsert','POST',{ids:[a.pointId],embeddings:[a.vector],metadatas:[m]});break;
      case 'pinecone':await this.rest('/vectors/upsert','POST',{namespace:this.name,vectors:[{id:a.pointId,values:a.vector,metadata:m}]});break;
      case 'elasticsearch':await this.rest('/'+this.name+'/_doc/'+a.pointId,'PUT',{...m,vector:a.vector});break;
      case 'redis':await this.redis!.hSet(this.name+':'+a.pointId,{owner:this.tag(m.ownerId),scope:this.tag(m.scopeId),generation:String(m.generation),vector:vec});break;
    }
  }
  private tag(s:string){return createHash('sha256').update(s).digest('hex');}
  async query(q:VectorQuery):Promise<VectorHit[]> {
    validVector(q.vector,this.dim);q.deadline?.throwIfAborted();if(!q.scopeIds.length||q.embeddingFingerprint!==this.space)return [];
    const limit=Math.min(120,Math.max(1,q.limit??40)), filter={$and:[{ownerId:{$eq:q.ownerId}},{scopeId:{$in:q.scopeIds}},{generation:{$eq:q.generation}}]};
    const rows:{id:string;score:number}[]=[];
    switch(this.config.engine){
      case 'chroma':{const r=await this.rest(this.collection+'/query','POST',{query_embeddings:[q.vector],where:filter,n_results:limit,include:['distances']},q.deadline);(r.ids[0]||[]).forEach((id:string,i:number)=>rows.push({id,score:1-r.distances[0][i]}));break;}
      case 'pinecone':{const r=await this.rest('/query','POST',{namespace:this.name,vector:q.vector,topK:limit,filter},q.deadline);rows.push(...r.matches.map((m:any)=>({id:m.id,score:m.score})));break;}
      case 'elasticsearch':{const r=await this.rest('/'+this.name+'/_search','POST',{size:limit,_source:false,knn:{field:'vector',query_vector:q.vector,k:limit,num_candidates:limit*4,filter:[{term:{ownerId:q.ownerId}},{terms:{scopeId:q.scopeIds}},{term:{generation:q.generation}}]}},q.deadline);rows.push(...r.hits.hits.map((h:any)=>({id:h._id,score:2*h._score-1})));break;}
      case 'redis':{const expr='(@owner:{'+this.tag(q.ownerId)+'} @scope:{'+q.scopeIds.map(s=>this.tag(s)).join('|')+'} @generation:['+q.generation+' '+q.generation+'])=>[KNN '+limit+' @vector $vec AS dist]';
        const r=await this.redis!.sendCommand(['FT.SEARCH',this.name,expr,'PARAMS','2','vec',Buffer.from(Float32Array.from(q.vector).buffer),'SORTBY','dist','RETURN','1','dist','LIMIT','0',String(limit),'DIALECT','2']) as any[];
        for(let i=1;i<r.length;i+=2)rows.push({id:String(r[i]).slice(this.name.length+1),score:1-Number(r[i+1][1])});break;}
      case 'simple':{
        const norm=Math.hypot(...q.vector);
        for(const item of this.db.prepare('SELECT id,meta,vec FROM points WHERE space=? ORDER BY id').iterate(this.name)){
          q.deadline?.throwIfAborted();const row=item as unknown as LocalRow;
          if(!allowedHit(JSON.parse(row.meta),q))continue;
          const v=new Float32Array(Uint8Array.from(row.vec).buffer);
          const score=v.reduce((sum,n,i)=>sum+n*q.vector[i],0)/(Math.hypot(...v)*norm);
          rows.push({id:row.id,score});rows.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));if(rows.length>limit)rows.pop();
        }break;
      }
    }
    const read=this.db.prepare('SELECT meta FROM points WHERE space=? AND id=?');
    return rows.flatMap(({id,score})=>{const row=read.get(this.name,id),metadata=row&&JSON.parse(String(row.meta));return metadata && Number.isFinite(score) && allowedHit(metadata,q)?[{pointId:id,score,metadata}]:[];}).slice(0,limit);
  }
  async retire(ids:readonly string[]) {
    if(!ids.length)return;
    switch(this.config.engine){
      case 'chroma':await this.rest(this.collection+'/delete','POST',{ids});break;
      case 'pinecone':{
        await this.rest('/vectors/delete','POST',{namespace:this.name,ids});
        const params=new URLSearchParams({namespace:this.name});for(const id of ids)params.append('ids',id);
        for(let attempt=0;;attempt++){
          const result=await this.rest('/vectors/fetch?'+params.toString());
          if(result.vectors && ids.every(id=>!Object.hasOwn(result.vectors,id)))break;
          if(attempt===3)throw new Error('Pinecone deletion has not been confirmed. Retry the pending erase.');
          await new Promise(r=>setTimeout(r,100*(2**attempt)));
        }
        break;
      }
      case 'elasticsearch':{
        const result=await this.rest('/'+this.name+'/_delete_by_query?refresh=true','POST',{query:{ids:{values:ids}}});
        if(result.timed_out || result.version_conflicts || result.failures?.length)throw new Error('Elasticsearch deletion has not been confirmed');
        break;
      }
      case 'redis':await this.redis!.del(ids.map(id=>this.name+':'+id));break;
    }
    const del=this.db.prepare('DELETE FROM points WHERE space=? AND id=?');for(const id of ids)del.run(this.name,id);
  }
  async deleteByArtifact(id:string,max=Number.MAX_SAFE_INTEGER){await this.deleteByArtifacts([id],max);}
  async deleteByArtifacts(ids:readonly string[],epoch:number,signal?:AbortSignal){
    const rows=this.db.prepare("SELECT id FROM points WHERE space=? AND json_extract(meta,'$.artifactId')=? AND json_extract(meta,'$.erasureEpoch')<=? LIMIT 128");
    for(const id of ids){for(;;){signal?.throwIfAborted();const chunk=rows.all(this.name,id,epoch);if(!chunk.length)break;await this.retire(chunk.map(row=>String(row.id)));}}
  }
  async health(){return {ok:true,detail:this.config.engine+' vector projection initialized'};}
  async close(){this.db.close();if(this.redis?.isOpen)await this.redis.close();}
}
