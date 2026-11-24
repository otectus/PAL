import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { XaiCollections,xaiCollectionOptionFields,xaiCollectionOwnerOperations,xaiCollectionSchemas,xaiManagementCredentialId } from '../broker/xai-collections.ts';

const sessionId='11111111-1111-4111-8111-111111111111',originalFileId='22222222-2222-4222-8222-222222222222';
const collectionId='collection_80100614-300c-4609-959b-a138fa90f542',fileId='file_94847856-a56f-4b1e-82dd-7fe0b3af43d9';
const metadata={collection_id:collectionId,collection_name:'PAL papers',created_at:'2026-11-23T00:00:00Z',documents_count:1,collection_description:'Reviewed PDFs'};
function fixture(){
  const db=new DatabaseSync(':memory:'),session:any={id:sessionId,provider:'xai',connectionId:'account-1',temporary:false},requests:any[]=[],approvals:any[]=[];let managementKey='management-key',managementRevision='management-1',apiRevision='api-1',connectionRevision=1,resolves=0;
  const core:any={store:{db,session:(id:string)=>{if(id!==sessionId)throw new Error('Unknown session');return session;}},settingsFor:()=>({paused:false}),
    chatConnections:{get:(id:string,provider:string)=>{assert.equal(id,'account-1');assert.equal(provider,'xai');return{id,kind:'xai',revision:connectionRevision};}},
    accountAccess:()=>({key:()=> 'inference-key'}),credentials:{credentialRevision:()=>apiRevision},providerFiles:{resolve:(id:string,handles:string[])=>{assert.equal(id,sessionId);assert.deepEqual(handles,[originalFileId]);resolves++;return[{type:'input_file',file_id:fileId}];}},
    approval:async(id:string,value:any)=>{assert.equal(id,sessionId);approvals.push(value);return{choice:'allow'};},changed:()=>{}};
  const service=new XaiCollections(core,()=>({key:managementKey,revision:managementRevision}));
  service.fetch=async(input,init:RequestInit={})=>{const url=new URL(String(input)),method=init.method||'GET',body=typeof init.body==='string'?init.body:'';requests.push({url:url.href,method,body,headers:Object.fromEntries(new Headers(init.headers))});
    if(method==='POST'&&url.pathname==='/v1/collections')return Response.json(metadata);
    if(method==='GET'&&url.pathname==='/v1/collections')return Response.json({collections:[metadata]});
    if(method==='GET'&&url.pathname===`/v1/collections/${collectionId}`)return Response.json(metadata);
    if(method==='POST'&&url.pathname.endsWith(`/documents/${fileId}`))return Response.json({});
    if(method==='DELETE')return Response.json({});
    throw new Error('Unexpected '+method+' '+url.href);
  };
  return{service,core,session,requests,approvals,get resolves(){return resolves;},setManagementKey:(value:string)=>managementKey=value,setManagementRevision:(value:string)=>managementRevision=value,setApiRevision:(value:string)=>apiRevision=value,setConnectionRevision:(value:number)=>connectionRevision=value};
}

test('xAI collection lifecycle keeps management and inference credentials distinct and emits explicit file_search',async()=>{
  const f=fixture();
  assert.equal(xaiManagementCredentialId,'xai_management');assert.ok(xaiCollectionOptionFields.some(field=>field.key==='collectionSearch'));assert.ok(xaiCollectionOwnerOperations['owner.xaiCollections.addDocument'].sensitive.includes('originalFileId'));
  const created=await f.service.create({sessionId,name:'PAL papers',description:'Reviewed PDFs',acknowledgeCloudStorage:true});assert.equal(created.id,collectionId);
  assert.deepEqual(await f.service.list({sessionId}),[{id:collectionId,name:'PAL papers',documentsCount:1,description:'Reviewed PDFs',createdAt:'2026-11-23T00:00:00Z'}]);
  const added=await f.service.addDocument({sessionId,collectionId,originalFileId,acknowledgeCloudStorage:true});assert.equal(added.fileId,fileId);assert.equal(f.resolves,2);
  await f.service.attach({sessionId,collectionId,maxResults:7,acknowledgeSearch:true});
  assert.deepEqual(f.service.tools(sessionId,{collectionSearch:true}),[{type:'file_search',vector_store_ids:[collectionId],max_num_results:7}]);assert.deepEqual(f.service.tools(sessionId,{collectionSearch:false}),[]);
  await f.service.removeDocument({sessionId,collectionId,originalFileId,acknowledgeRemoval:true});await f.service.delete({sessionId,collectionId,acknowledgeDeletion:true});assert.deepEqual(f.service.tools(sessionId,{collectionSearch:true}),[]);
  assert.ok(f.approvals.length>=5);assert.ok(f.requests.every(request=>request.headers.authorization==='Bearer management-key'));assert.ok(f.requests.every(request=>!JSON.stringify(request).includes('inference-key')));
  const create=f.requests.find(request=>request.method==='POST'&&new URL(request.url).pathname==='/v1/collections');assert.deepEqual(JSON.parse(create.body),{collection_name:'PAL papers',collection_description:'Reviewed PDFs'});
  const add=f.requests.find(request=>request.method==='POST'&&request.url.includes('/documents/'));assert.equal(add.body,'{}');assert.ok(f.requests.some(request=>request.method==='DELETE'&&request.url.endsWith(`/documents/${fileId}`)));
});

test('xAI collections reject stale named-account authority, unscoped handles, and non-owner sessions',async()=>{
  const f=fixture();
  const originalApproval=f.core.approval;f.core.approval=async(...args:any[])=>{const answer=await originalApproval(...args);f.setManagementRevision('management-2');return answer;};
  await assert.rejects(f.service.addDocument({sessionId,collectionId,originalFileId,acknowledgeCloudStorage:true}),/Management key changed/);assert.equal(f.requests.filter(request=>request.method==='POST'&&request.url.includes('/documents/')).length,0);
  assert.throws(()=>xaiCollectionSchemas.create.parse({sessionId,name:'No acknowledgement'}));
  f.setManagementRevision('management-1');f.core.providerFiles.resolve=()=>[{type:'input_file',file_id:'another-provider-id'}];await assert.rejects(f.service.addDocument({sessionId,collectionId,originalFileId,acknowledgeCloudStorage:true}),/uploaded xAI PDF handle/);
  f.session.remote={role:'limited'};await assert.rejects(f.service.list({sessionId}),/owner-controlled/);
});

test('attached searches are invalidated by API-key and connection revisions',async()=>{
  const f=fixture();await f.service.attach({sessionId,collectionId,acknowledgeSearch:true});assert.equal(f.service.tools(sessionId,{collectionSearch:true})[0].max_num_results,10);
  f.setManagementKey('');assert.equal(f.service.tools(sessionId,{collectionSearch:true})[0].vector_store_ids[0],collectionId);await assert.rejects(f.service.list({sessionId}),/Management API key/);f.setManagementKey('management-key');
  f.setApiRevision('api-2');assert.throws(()=>f.service.tools(sessionId,{collectionSearch:true}),/another account revision/);
  f.setApiRevision('api-1');f.setConnectionRevision(2);assert.throws(()=>f.service.tools(sessionId,{collectionSearch:true}),/another account revision/);
});
