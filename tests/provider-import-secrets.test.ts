import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { ProviderCredentials } from '../broker/credentials.ts';
import { Store } from '../broker/store.ts';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-provider-import-'));
  const core = new Core(new Store(directory), () => ({send:async()=>{}, interrupt:async()=>{}, close:async()=>{}}));
  t.after(async () => { await core.close(); await rm(directory,{recursive:true,force:true}); });
  return {core,directory};
}

test('PyGPT secrets are excluded by default and never appear in import responses or shared storage', async t => {
  const {core} = await fixture(t), secret='default-secret-marker';
  const json=JSON.stringify({__meta__:{'app.version':'2.9.1'},providers:{x_ai:{name:'Work',api_base:'https://api.x.ai/v1',api_key:secret,python:'do_not_execute()'}},'app.env':['XAI_API_KEY=not-imported']});
  const preview:any=await core.rpc('connections.importPreview',{json});
  assert.equal(preview.credentials.available,1);assert.equal(preview.credentials.selected,0);
  assert.equal(preview.credentials.accounts,undefined);assert.doesNotMatch(JSON.stringify(preview),new RegExp(secret));
  assert.match(preview.notices.join(' '),/environment entries are never imported/i);
  const applied:any=await core.rpc('connections.importApply',{json,digest:preview.digest});
  assert.equal(applied.credentialsImported,0);assert.doesNotMatch(JSON.stringify(applied),new RegExp(secret));
  assert.equal(core.accountAccess('xai',applied.created[0]).key(),'');
  const shared=core.store.db.prepare('SELECT data FROM provider_connections UNION ALL SELECT value FROM meta').all().map(row=>String(row.data??row.value)).join('\n');
  assert.doesNotMatch(shared,new RegExp(secret));
});

test('reviewed literal secrets require confirmation and bind to one named account endpoint', async t => {
  const {core} = await fixture(t), secret='literal-compatible-secret';
  const json=JSON.stringify({api_custom_providers:[{id:'private_gateway',name:'Private gateway',api_base:'https://gateway.example/v1',api_key:secret}]});
  const preview:any=await core.rpc('connections.importPreview',{json,includeSecrets:true});
  assert.equal(preview.credentials.available,1);assert.equal(preview.credentials.selected,1);
  assert.deepEqual(preview.credentials.accounts,[{account:'Private gateway',provider:'compatible',label:'API key',source:'private_gateway.api_key',target:'new named account'}]);
  assert.doesNotMatch(JSON.stringify(preview),new RegExp(secret));
  await assert.rejects(core.rpc('connections.importApply',{json,digest:preview.digest,includeSecrets:true}),/Confirm/);
  const applied:any=await core.rpc('connections.importApply',{json,digest:preview.digest,includeSecrets:true,acknowledgeSecrets:true});
  assert.equal(applied.credentialsImported,1);assert.doesNotMatch(JSON.stringify(applied),new RegExp(secret));
  const id=applied.created[0],ref='connection:'+id;
  assert.equal(core.accountAccess('compatible',id).key(),secret);
  assert.equal(core.credentials.key('compatible','https://other.example',ref),'');
  const shared=core.store.db.prepare('SELECT data FROM provider_connections UNION ALL SELECT value FROM meta').all().map(row=>String(row.data??row.value)).join('\n');
  assert.doesNotMatch(shared,new RegExp(secret));
});

test('current and flat PyGPT provider forms import only known literal credentials', async t => {
  const {core} = await fixture(t), xai='xai-chat-secret',management='xai-management-secret';
  const current=JSON.stringify({providers:{x_ai:{name:'xAI account',api_base:'https://api.x.ai/v1',api_key:xai,extra:{management_api_key:management}}}});
  const reviewed:any=await core.rpc('connections.importPreview',{json:current,includeSecrets:true});
  assert.equal(reviewed.credentials.available,2);assert.doesNotMatch(JSON.stringify(reviewed),new RegExp(`${xai}|${management}`));
  const imported:any=await core.rpc('connections.importApply',{json:current,digest:reviewed.digest,includeSecrets:true,acknowledgeSecrets:true});
  const id=imported.created[0];assert.equal(core.accountAccess('xai',id).key(),xai);
  assert.equal(core.credentials.key('xai_management','https://management-api.x.ai','connection:'+id+':xai-management'),management);

  const flatSecret='flat-deepseek-secret';
  const flat=JSON.stringify({__meta__:{'app.version':'2.9.1'},api_key_deepseek:flatSecret,api_endpoint_deepseek:'https://api.deepseek.com',theme:'dark','agent.openai.provider':'openai','llama.idx.embeddings.provider':'openai',layout:{density:'compact'}});
  const preview:any=await core.rpc('connections.importPreview',{json:flat,includeSecrets:true});
  assert.equal(preview.credentials.available,1);assert.deepEqual(preview.unmapped,[]);
  const result:any=await core.rpc('connections.importApply',{json:flat,digest:preview.digest,includeSecrets:true,acknowledgeSecrets:true});
  assert.equal(core.accountAccess('deepseek',result.created[0]).key(),flatSecret);
});

test('unknown providers and non-literal key expressions are reported but never imported', async t => {
  const {core} = await fixture(t), unknown='unknown-provider-secret';
  const json=JSON.stringify({providers:{mystery_cloud:{name:'Mystery',api_base:'https://mystery.example/v1',api_key:unknown},openai:{name:'Placeholder',api_key:'${OPENAI_API_KEY}'}}});
  const preview:any=await core.rpc('connections.importPreview',{json,includeSecrets:true});
  assert.ok(preview.unmapped.includes('mystery_cloud'));assert.equal(preview.credentials.available,0);
  assert.equal(preview.credentials.skipped.length,2);assert.doesNotMatch(JSON.stringify(preview),new RegExp(unknown));
  const result:any=await core.rpc('connections.importApply',{json,digest:preview.digest,includeSecrets:true,acknowledgeSecrets:true});
  assert.equal(result.credentialsImported,0);assert.equal(result.created.length,1);
  assert.equal(core.accountAccess('openai',result.created[0]).key(),'');
});

test('connection and credential imports roll back together when applying fails', async t => {
  const {core,directory} = await fixture(t), secret='rolled-back-secret';
  const json=JSON.stringify({providers:{openai:{name:'Rollback',api_key:secret}}});
  const preview:any=await core.rpc('connections.importPreview',{json,includeSecrets:true});
  const original=core.store.transaction.bind(core.store);
  core.store.transaction=((work:()=>unknown)=>original(()=>{work();throw new Error('fixture commit failure');})) as typeof core.store.transaction;
  await assert.rejects(core.rpc('connections.importApply',{json,digest:preview.digest,includeSecrets:true,acknowledgeSecrets:true}),/fixture commit failure/);
  assert.equal(core.chatConnections.list().some(row=>row.name==='Rollback'),false);
  assert.doesNotMatch(await readFile(join(directory,'credentials','provider-credentials.json'),'utf8'),new RegExp(secret));
});

test('credential reference rollback restores the previous private value', async t => {
  const directory=await mkdtemp(join(tmpdir(),'pal-credential-import-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const credentials=new ProviderCredentials(directory),ref='connection:rollback-fixture',origin='https://api.example';
  credentials.importReferences([{provider:'compatible',credentialRef:ref,origin,key:'previous-secret'}]);
  const rollback=credentials.importReferences([{provider:'compatible',credentialRef:ref,origin,key:'replacement-secret'}]);
  assert.equal(credentials.key('compatible',origin,ref),'replacement-secret');rollback();
  assert.equal(credentials.key('compatible',origin,ref),'previous-secret');
});

test('retired model selections persist as reviewed metadata without selecting or calling a replacement', async t => {
  const {core}=await fixture(t);
  const json=JSON.stringify({providers:{perplexity:{name:'Historical',settings:{model:'sonar-deep-research',api_key:'$PPLX_API_KEY'}}},model:'sonar-pro'});
  const preview=await core.rpc('connections.importPreview',{json,includeSecrets:true});
  assert.deepEqual(preview.migrations.map((m:any)=>[m.originalModel,m.suggestedPreset]),[['sonar-deep-research','high'],['sonar-pro','fast']]);
  assert.match(preview.notices.join(' '),/sonar-deep-research.*high/);
  assert.equal(preview.credentials.available,0);
  const applied=await core.rpc('connections.importApply',{json,digest:preview.digest,includeSecrets:true});
  assert.equal(applied.created.length,1);
  assert.deepEqual(await core.rpc('connections.importMigrations',{}),preview.migrations);
  const again=await core.rpc('connections.importPreview',{json});
  await core.rpc('connections.importApply',{json,digest:again.digest});
  assert.deepEqual(await core.rpc('connections.importMigrations',{}),preview.migrations);
  assert.equal(core.store.sessions().length,0);
});
