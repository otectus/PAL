import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchFixture } from './fixtures/workbench.ts';
import { presets } from '../broker/research/evidence.ts';
import { defaults } from '../broker/research/library.ts';

test('research history is scoped, filtered and cursor bounded', async t => {
  const f=await workbenchFixture(t), {session}=await f.session(), other=await f.session();
  const put=(id:string,sessionId:string,title:string,updated:number)=>f.core.research.library.put({ ...defaults(), id,sessionId,question:title,title,preset:'quick',state:'completed',scope:'web',mode:'answer',summary:'done',updated,created:updated,limits: presets.quick,queries:[],evidence:[],checkpoints:0 });
  put('00000000-0000-4000-8000-000000000001',session.id,'Visible alpha',2);
  put('00000000-0000-4000-8000-000000000002',other.session.id,'Hidden beta',3);
  const rows=f.core.research.library.history([session.id],{query:'alpha',limit:10});
  put('00000000-0000-4000-8000-000000000003',session.id,'Visible alpha two',2);
  const page = await f.core.rpc('operations.history', {sessionId:session.id,limit:1});
  const older = await f.core.rpc('operations.history', {sessionId:session.id,limit:1,before:page[0].cursor});
  assert.equal(older[0].id, rows[0].id); assert.notEqual(page[0].id, older[0].id);
  assert.deepEqual(await f.core.rpc('operations.history',{sessionId:session.id,kind:'command'}),[]);
  assert.equal(rows.length,1); assert.equal(rows[0].kind,'research.run'); assert.equal(rows[0].sessionId,session.id);
});
