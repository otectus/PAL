import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

test('Core provider inference mount binds account and revisions and persists provenance',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-inference-core-')),core=new Core(new Store(directory));
  const previous=globalThis.fetch,requests:any[]=[];globalThis.fetch=async(url,init)=>{requests.push([String(url),JSON.parse(String(init?.body))]);return Response.json([{label:'POSITIVE',score:.99}]);};
  t.after(async()=>{globalThis.fetch=previous;await core.close();await rm(directory,{recursive:true,force:true});});
  const account:any=await core.rpc('connections.save',{kind:'huggingface',name:'Inference fixture'});
  await core.rpc('provider.credentials',{provider:'huggingface',connectionId:account.id,key:'hf-fixture'});
  await core.rpc('provider.credentials',{provider:'openai',key:'openai-fixture'});
  const session=await core.create({provider:'openai',cwd:directory,model:'fixture'}),project=core.projects.list().find(row=>row.cwd===session.cwd);
  const request={sessionId:session.id,expectedSessionRevision:session.configRevision||'0',expectedProjectRevision:project?.revision||'0',connectionId:account.id,connectionRevision:account.revision,
    task:'text-classification',model:'org/model',inputs:{kind:'text',value:'PAL is useful'}};
  const output:any=await core.rpc('providerInference.run',request);
  assert.equal(output.result.kind,'json');assert.match(requests[0][0],/router\.huggingface\.co\/hf-inference\/models\/org\/model$/);
  const artifact:any=await core.rpc('artifacts.get',{sessionId:session.id,artifactId:output.artifact.artifactId});
  assert.equal(artifact.versions[0].provenance.kind,'provider-inference');assert.equal(artifact.versions[0].provenance.connectionId,account.id);
  await assert.rejects(core.rpc('providerInference.run',{...request,connectionRevision:account.revision+1}),/changed/);
});
