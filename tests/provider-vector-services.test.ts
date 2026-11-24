import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceVectorRepository,type VectorConfig } from '../broker/graph-memory/adapters/vector-services.ts';
import { artifactPointId } from '../broker/graph-memory/adapters/qdrant.ts';
import type { VectorArtifactMetadata } from '../broker/graph-memory/adapters/contracts.ts';

const space='a'.repeat(64);
const metadata={ownerId:'owner',scopeId:'folder',artifactKind:'assertion',artifactId:'record',contentRevision:2,embeddingFingerprint:space,generation:1,sensitivity:'cloud_allowed',validFromUs:null,validToUs:null,sourceGeneration:0,erasureEpoch:5,expiresAtUs:null} satisfies VectorArtifactMetadata;
const id=artifactPointId(metadata);
const query={vector:[1,0],ownerId:'owner',scopeIds:['folder'],embeddingFingerprint:space,generation:1,currentErasureEpoch:5,nowUs:10};
const bulk=(s:string)=>'$'+Buffer.byteLength(s)+'\r\n'+s+'\r\n';
function command(buffer:Buffer):{args:Buffer[];bytes:number}|undefined{
  let cursor=buffer.indexOf('\r\n');if(cursor<0)return;
  const count=Number(buffer.toString('ascii',1,cursor)),args=[];cursor+=2;
  for(let i=0;i<count;i++){
    const end=buffer.indexOf('\r\n',cursor);if(end<0)return;
    const length=Number(buffer.toString('ascii',cursor+1,end));if(end+length+4>buffer.length)return;
    args.push(buffer.subarray(end+2,end+2+length));cursor=end+4+length;
  }
  return {args,bytes:cursor};
}
for(const engine of ['chroma','pinecone','elasticsearch','redis'] as const)test(engine+' vector protocol scopes search and acknowledges erasure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pal-vector-server-'));let published=false,deleted=false,filtered=false,confirmed=false;
  const server=engine==='redis'?tcpServer(socket=>{
    let buf=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buf=Buffer.concat([buf,chunk]);
      for(let m=command(buf);m;m=command(buf)){
        buf=buf.subarray(m.bytes);const s=m.args.map(v=>v.toString());
        if(s[0]==='HSET'){published=true;assert.equal(m.args.at(-1)?.length,8);socket.write(':1\r\n');}
        else if(s[0]==='FT.SEARCH'){filtered=s[2].includes('@scope:')&&s[2].includes('@owner:');socket.write('*3\r\n:1\r\n'+bulk(s[1]+':'+id)+'*2\r\n'+bulk('dist')+bulk('0'));}
        else if(s[0]==='DEL'){deleted=true;socket.write(':1\r\n');}
        else socket.write('+OK\r\n');
      }
    });
  }):createServer(async (req,res)=>{
    let text='';for await(const part of req)text+=part;
    const body=text?JSON.parse(text):undefined,url=req.url||'',respond=(data:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(engine==='pinecone'){
      assert.equal(req.headers['api-key'],'fixture');
      if(url==='/describe_index_stats')return respond({dimension:2,metric:'cosine',vectorType:'dense'});
      if(url==='/vectors/upsert'){published=body.vectors[0].id===id;return respond({upsertedCount:1});}
      if(url==='/query'){filtered=body.filter.$and.length===3;return respond({matches:[{id,score:1},{id:'alien',score:1}]});}
      if(url==='/vectors/delete'){deleted=body.ids.includes(id);return respond({});}
      if(url.startsWith('/vectors/fetch?')){confirmed=true;return respond({vectors:{}});}
    }else if(engine==='chroma'){
      assert.equal(req.headers['x-chroma-token'],'fixture');
      if(url.endsWith('/collections'))return respond({id:'fixture-collection',dimension:2});
      if(url.endsWith('/upsert')){published=body.ids[0]===id;return respond({});}
      if(url.endsWith('/query')){filtered=body.where.$and.length===3;return respond({ids:[[id,'alien']],distances:[[0,0]]});}
      if(url.endsWith('/delete')){deleted=body.ids.includes(id);return respond({});}
    }else{
      assert.equal(req.headers.authorization,'ApiKey fixture');
      if(url.endsWith('/_mapping'))return respond({},404);
      if(req.method==='PUT'&&body.mappings)return respond({acknowledged:true});
      if(url.includes('/_doc/')){published=body.scopeId==='folder';return respond({result:'created'});}
      if(url.endsWith('/_search')){filtered=body.knn.filter.length===3;return respond({hits:{hits:[{_id:id,_score:1},{_id:'alien',_score:1}]}});}
      if(url.includes('_delete_by_query')){deleted=body.query.ids.values.includes(id);return respond({deleted:1,failures:[]});}
    }
    respond({},400);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address() as {port:number};
  const config:VectorConfig={engine,external:false,endpoint:(engine==='redis'?'redis':'http')+'://127.0.0.1:'+addr.port,namespace:'pal',tenant:'test',database:'fixture'};
  const repo=new ServiceVectorRepository(config,space,2,dir,'fixture');
  t.after(async()=>{await repo.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
  await repo.initialize();await repo.publish({pointId:id,vector:[1,0],metadata});
  assert.ok(published);
  assert.deepEqual((await repo.query(query)).map(row=>row.pointId),[id]);assert.ok(filtered);
  assert.deepEqual(await repo.query({...query,scopeIds:['other']}),[]);
  await repo.deleteByArtifacts(['record'],5);assert.ok(deleted);
  assert.deepEqual(await repo.query(query),[]);if(engine==='pinecone')assert.ok(confirmed);
});
