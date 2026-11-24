import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiAdapter, apiModels, apiTextRequest } from '../broker/api-providers.ts';
import { Core } from '../broker/core.ts';
import { hostedEmbeddings } from '../broker/graph-memory/hosted-embeddings.ts';
import { TaskConnectionResolver } from '../broker/graph-memory/task-router.ts';
import { taskProviderAdapters } from '../broker/graph-memory/task-providers.ts';
import { Store } from '../broker/store.ts';
import type { OllamaMessage, OllamaTool } from '../broker/ollama.ts';

const idle=()=>({send:async()=>{},interrupt:async()=>{},close:async()=>{}});
const endpoint={baseUrl:'https://gateway.example/v1',label:'Gateway',requiresKey:true,tools:true,images:false,streaming:true,usage:false,contextLength:0,maxOutputTokens:0,processing:'cloud',authHeader:'X-API-Key'} as const;
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'pal-compatible-auth-')),core=new Core(new Store(directory),idle);
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  return {core,directory};
}
const sse=(values:unknown[])=>new Response(values.map(value=>'data: '+JSON.stringify(value)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});

test('compatible custom authentication validates before dispatch and never enters shared state',async t=>{
  const {core}=await fixture(t);let dispatched=0;
  for(const authHeader of ['Authorization','Proxy-Authorization','Host','Content-Length','Forwarded','X-Forwarded-For','X-Remote-User','X-User-Key','X-Tenant-User-API-Key','X-Oidc-API-Key','Traceparent'])
    await assert.rejects(core.rpc('connections.save',{kind:'compatible',name:'Rejected',endpoint:{...endpoint,authHeader}}),/safe API-key header/);
  await assert.rejects(core.rpc('connections.save',{kind:'compatible',name:'Headers map',endpoint:{...endpoint,headers:{'x-api-key':'must-not-enter-state'}}}),/Unknown compatible endpoint setting: headers/);
  await assert.rejects(apiTextRequest('compatible',{key:()=> 'private-secret',endpoint:()=>({...endpoint,authHeader:'X-Forwarded-For'}),fetch:async()=>{dispatched++;return Response.json({});}},
    {model:'m',input:'never send'},AbortSignal.timeout(1000)),/safe API-key header/);
  assert.equal(dispatched,0,'an unsafe header is rejected before fetch');

  const account:any=await core.rpc('connections.save',{kind:'compatible',name:'Approved gateway',endpoint});
  const secret='literal-private-compatible-secret';
  const status=await core.rpc('provider.credentials',{provider:'compatible',connectionId:account.id,key:secret});
  assert.equal(status.configured,true);assert.doesNotMatch(JSON.stringify(status),new RegExp(secret));
  const snapshot:any[]=await core.rpc('connections.list',{});
  assert.equal(snapshot.find(row=>row.id===account.id).endpoint.authHeader,'x-api-key');
  assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(core.store.db.prepare('SELECT data FROM provider_connections').all()),new RegExp(secret));

  const changed:any=await core.rpc('connections.save',{id:account.id,expectedRevision:account.revision,name:account.name,endpoint:{authHeader:'X-Tenant-API-Key'}});
  assert.equal(changed.compatible.authHeader,'x-tenant-api-key');
  assert.equal(core.accountAccess('compatible',account.id).key(),'','changing the header invalidates the old scoped secret');
});

test('compatible custom authentication reaches catalog, helper, embeddings, chat tools, and memory tasks',async t=>{
  const {core,directory}=await fixture(t),secret='wire-secret';
  const account:any=await core.rpc('connections.save',{kind:'compatible',name:'Wire gateway',endpoint});
  await core.rpc('provider.credentials',{provider:'compatible',connectionId:account.id,key:secret});
  const requests:{url:string;headers:Headers;body:any}[]=[];
  const wire=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined,headers=new Headers(init?.headers);requests.push({url,headers,body});
    assert.equal(headers.get('x-api-key'),secret);assert.equal(headers.get('authorization'),null);
    if(!body)return Response.json({data:[{id:'wire-model'}]});
    if(url.endsWith('/embeddings'))return Response.json({data:[{index:0,embedding:[1,2]}]});
    if(body.stream===false)return Response.json({model:'wire-model',choices:[{finish_reason:'stop',message:{content:'helper result'}}]});
    const hasToolResult=body.messages?.some((message:any)=>message.role==='tool');
    return hasToolResult?sse([{choices:[{delta:{content:'tool complete'},finish_reason:'stop'}]}]):sse([{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'check',arguments:'{"value":"yes"}'}}]},finish_reason:'tool_calls'}]}]);
  };
  const access={...core.accountAccess('compatible',account.id),fetch:wire as typeof fetch};
  assert.equal((await apiModels('compatible',access))[0].id,'wire-model');
  const helper:any=await apiTextRequest('compatible',access,{model:'wire-model',input:'help'},AbortSignal.timeout(1000));
  assert.equal(helper.choices[0].message.content,'helper result');
  assert.deepEqual(await hostedEmbeddings('compatible',access,'wire-embed',['text'],'document',AbortSignal.timeout(1000)),[[1,2]]);

  const session=await core.create({provider:'compatible',model:'wire-model',cwd:directory,connectionId:account.id,trusted:true,tools:true});
  const tool:OllamaTool={type:'function',function:{name:'check',description:'Check',parameters:{type:'object',properties:{value:{type:'string'}}}}};
  let history:OllamaMessage[]=[],called:any;
  const adapter=new ApiAdapter(session,{token:'fixture',native(){},event(){},approve:async()=>({choice:'deny'}),personality:()=>''},{load:()=>history,save:value=>{history=structuredClone(value);},tools:()=>[tool],call:async(name,args)=>{called={name,args};return {ok:true};}},access);
  t.after(()=>adapter.close());await adapter.send('Use the tool');await adapter.task;
  assert.deepEqual(called,{name:'check',args:{value:'yes'}});

  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async(input,init)=>wire(input,init);
  const compatible=taskProviderAdapters().find(row=>row.id==='compatible')!;
  const resolver=new TaskConnectionResolver({credentials:core.credentials,readConnection:id=>core.chatConnections.get(id),defaultOllamaHost:()=>''});
  const route=resolver.resolve({connectionRef:'connection:'+account.id,modelId:'wire-model'},(_id,processing)=>compatible.describe({processing}));
  const task=await compatible.generate(route as any,{system:'Return JSON',input:'data',maxOutputTokens:100,jsonSchema:{type:'object'},schemaName:'fixture'} as any,'json_schema',false,AbortSignal.timeout(1000),async()=>{});
  assert.equal(task.text,'helper result');
  assert.equal(requests.length,6);assert.ok(requests.every(request=>request.headers.get('x-api-key')===secret));
});
