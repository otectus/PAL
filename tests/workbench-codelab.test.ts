import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { zipFilesAsync } from '../broker/artifacts/zip.ts';
import { OperationStore } from '../broker/operations/store.ts';
import { isolation } from '../broker/execution/runner.ts';
import { call, until, workbenchFixture } from './fixtures/workbench.ts';

const status = await isolation();
const opts = { skip: status.available ? false : `isolation unavailable here: ${status.problem}` };
async function lab(t: any, steps?: any[], contextWindow?: number) {
  const f = await workbenchFixture(t, steps, {contextWindow});
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  const session = await f.core.create({ provider: 'ollama', model: 'text-tools:latest', cwd: f.project, capabilities: { analysis: true, images: true } });
  return { f, session };
}
async function input(f: any, sessionId: string, name: string, text: string) {
  const path = join(f.directory, name); await writeFile(path, text);
  return f.core.rpc('artifacts.import', { sessionId, path });
}
const ran = async (f: any, sessionId: string) => { await until(() => f.core.workbench.operations.list(sessionId).some((op: any) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(op.state)), 30000); return f.core.workbench.operations.list(sessionId)[0]; };

test('Code Lab is off until the user turns it on, and refuses to run unconfined', opts, async t => {
  const f = await workbenchFixture(t);
  const session = await f.core.create({ provider: 'ollama', model: 'text-tools:latest', cwd: f.project, capabilities: { analysis: true } });
  await assert.rejects(f.core.workbench.execution.run(session.id, { code: 'print(1)', origin: 'user', approval: 'user' }), /turned off/);
  assert.ok(!f.core.toolsFor(session.id).some(tool => tool.function.name === 'codelab_run'));
});

test('DA07 code cannot read host credentials, PAL’s data or the network, and sees no inherited environment', opts, async t => {
  const { f, session } = await lab(t);
  process.env.PAL_TEST_SECRET = 'leaked-if-visible';
  await mkdir(join(f.directory, 'fake-ssh'), { recursive: true }); await writeFile(join(f.directory, 'fake-ssh', 'id_ed25519'), 'PRIVATE KEY');
  const code = `import os, socket, json\nr = {}\nfor p in [${JSON.stringify(join(f.directory, 'fake-ssh'))}, ${JSON.stringify(f.state)}, ${JSON.stringify(f.project)}, os.path.expanduser('~'), '/run/user']:\n    try: r[p] = os.listdir(p)\n    except Exception as e: r[p] = type(e).__name__\ntry:\n    socket.create_connection(('1.1.1.1', 443), timeout=3); r['network'] = 'reached'\nexcept Exception as e: r['network'] = type(e).__name__\nr['secret'] = os.environ.get('PAL_TEST_SECRET', 'absent')\nr['keys'] = sorted(k for k in os.environ if 'KEY' in k or 'TOKEN' in k)\nprint(json.dumps(r))\n`;
  await f.core.workbench.execution.run(session.id, { code, origin: 'user', approval: 'user' });
  const operation = await ran(f, session.id);
  assert.equal(operation.state, 'completed', operation.error?.message);
  const report = JSON.parse(String(operation.details!.stdout).trim());
  for (const path of [join(f.directory, 'fake-ssh'), f.state, f.project, '/run/user']) assert.match(String(report[path]), /Error/, path + ' must not be visible');
  assert.notEqual(report.network, 'reached'); assert.equal(report.secret, 'absent'); assert.deepEqual(report.keys, []);
  delete process.env.PAL_TEST_SECRET;
});

test('DA08 loops, process floods and output floods are stopped by enforced limits; cancelling is observable', opts, async t => {
  const { f, session } = await lab(t);
  await f.core.workbench.execution.run(session.id, { code: 'while True: pass', origin: 'user', approval: 'user', timeoutSeconds: 2 });
  let operation = await ran(f, session.id);
  assert.equal(operation.state, 'failed'); assert.match(operation.error!.message, /time limit/);
  await f.core.workbench.execution.run(session.id, { code: 'import sys\nfor i in range(5_000_000): sys.stdout.write("flood " * 20 + "\\n")', origin: 'user', approval: 'user', timeoutSeconds: 20 });
  operation = f.core.workbench.operations.list(session.id)[0];
  assert.equal(operation.details!.truncated, true); assert.ok(String(operation.details!.stdout).length <= 256 * 1024);
  // The run's children re-exec with a random marker, so a check finds only processes of this run.
  const marker = 'pal-run-' + crypto.randomUUID();
  const running = f.core.workbench.execution.run(session.id, { code: `import os, sys, time\nfor i in range(8):\n    if os.fork() == 0:\n        os.execv(sys.executable, [sys.executable, '-c', 'import time; time.sleep(120)', '${marker}'])\ntime.sleep(120)`, origin: 'user', approval: 'user', timeoutSeconds: 100 });
  await until(() => f.core.workbench.operations.list(session.id)[0].state === 'running' && f.core.workbench.operations.list(session.id)[0].details?.timeLimitSeconds === 100);
  const { execFileSync } = await import('node:child_process');
  const survivors = () => { try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  await until(() => survivors().split('\n').filter(Boolean).length >= 1, 10000);
  const id = f.core.workbench.operations.list(session.id)[0].id, started = Date.now();
  await f.core.rpc('operations.cancel', { id });
  await running.catch(() => {});
  assert.ok(Date.now() - started < 10000, 'cancellation is prompt');
  assert.equal(f.core.workbench.operations.get(id).state, 'cancelled');
  await until(() => survivors() === '', 5000).catch(() => {});
  assert.equal(survivors(), '', 'no process of the run survives');
  const limits = f.core.workbench.operations.get(id).details!.limits as any;
  assert.match(limits.memory, /enforced|address-space|not enforced/); assert.match(limits.processes, /enforced|not enforced/);
});

test('DA09 a chart is drawn from the selected data by stored code, and its provenance links both', opts, async t => {
  const { f, session } = await lab(t);
  const data = await input(f, session.id, 'sales.csv', 'month,sales\n1,10\n2,30\n3,20\n');
  await f.core.workbench.execution.run(session.id, { code: (await f.core.rpc('codelab.status', {})).recipes.find((r: any) => r.id === 'plot').code, inputs: [{ artifactId: data.artifactId, versionId: data.versionId }], purpose: 'Plot sales', origin: 'user', approval: 'user' });
  const operation = await ran(f, session.id);
  assert.equal(operation.state, 'completed', String(operation.details?.stderr)); assert.equal(operation.details!.exitCode, 0);
  assert.equal(operation.results.length, 2);
  const chart = f.core.workbench.artifacts.version(session.id, operation.results.find((r: any) => r.purpose === 'plot')!.artifactId);
  assert.ok(operation.results.some((r: any) => f.core.workbench.artifacts.version(session.id, r.artifactId).name === 'plot-data.csv'));
  assert.equal(chart.kind, 'image'); assert.ok((await sharp((await f.core.workbench.artifacts.bytes(session.id, chart.artifactId)).data).metadata()).width! > 100);
  assert.deepEqual(chart.parents.map(parent => parent.relation).sort(), ['analysis-code', 'analysis-input']);
  assert.equal(chart.parents.find(parent => parent.relation === 'analysis-input')!.versionId, data.versionId);
  const code = chart.parents.find(parent => parent.relation === 'analysis-code')!;
  assert.match((await f.core.workbench.artifacts.bytes(session.id, code.artifactId, code.versionId)).data.toString(), /plt\.savefig/);
  assert.match(String(operation.details!.stdout), /Plotted 3 rows from sales\.csv/);
});

test('a model’s Code Lab run waits for review, then reports the exit status and files without claiming verification', opts, async t => {
  const reviewed = '# method details\n'.repeat(500) + 'open("/work/output/answer.txt","w").write(str(6*7)); print("final review line")';
  const { f, session } = await lab(t, [() => call('codelab_run', { code: reviewed, purpose: 'Compute the answer' }), () => ({ content: 'The run finished.' })], 32768);
  f.core.store.saveSession({...session,modelOptions:{...session.modelOptions,contextTokens:32768}});
  await f.core.send({ id: session.id, text: 'Compute it' });
  await until(() => [...f.core.approvals.values()].some(item => item.value.kind === 'execution'));
  const approval = [...f.core.approvals.values()].find(item => item.value.kind === 'execution')!.value;
  assert.match(approval.detail, /final review line/); assert.match(approval.detail, /6\*7/); assert.match(approval.detail, /no network/);
  f.core.answer({ id: approval.id, choice: 'allow' });
  await f.finished(session.id);
  const toolReply = f.toolResults().find((r: any) => r.name === 'codelab_run');
  assert.ok(toolReply, f.core.store.session(session.id).error);
  const result = toolReply.value;
  assert.equal(result.status, 'completed'); assert.match(result.summary, /not proof that its conclusion is right/);
  assert.equal(result.data.exitCode, 0); assert.equal(result.artifacts.length, 1);
  assert.equal((await f.core.workbench.artifacts.bytes(session.id, result.artifacts[0].artifactId)).data.toString(), '42');
});

test('a Code Lab output import failure completes the operation with an error', opts, async t => {
  const { f, session } = await lab(t);
  await f.core.workbench.execution.run(session.id, {
    code: "open('/work/output/chart.png', 'wb').write(bytes.fromhex('89504e470d0a1a0a'))\nopen('/work/output/data.txt', 'w').write('some output')",
    origin: 'user', approval: 'user',
  });
  const operation = f.core.workbench.operations.list(session.id)[0];
  assert.equal(operation.state, 'failed');
  assert.match(operation.error?.message || '', /image/i);
  assert.equal(operation.results.length, 1, 'readable output remains available');
});

test('closing PAL during a Code Lab run stops it and still records the run as interrupted', opts, async t => {
  const f = await workbenchFixture(t);
  const { session } = await f.session(null as any);
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  const launched = await f.core.rpc('codelab.run', { sessionId: session.id, code: 'import time\ntime.sleep(60)\n', purpose: 'Slow run' });
  assert.equal(f.core.workbench.operations.get(launched.operationId).sessionId, session.id);
  await until(() => f.core.workbench.operations.list(session.id).some(op => op.state === 'running'));
  const id = f.core.workbench.operations.list(session.id)[0].id;
  await f.core.close();
  const { Store } = await import('../broker/store.ts');
  const reopened = new Store(f.state);
  try {
    const row: any = reopened.db.prepare('SELECT state FROM operations WHERE id=?').get(id);
    assert.equal(row.state, 'interrupted', 'the run was stopped and its outcome written before the database closed');
  } finally { reopened.close(); }
});

test('the desktop launch returns validation errors and live, inspectable failure with partial files', opts, async t => {
  const { f, session } = await lab(t), sessionId = session.id;
  await assert.rejects(f.core.rpc('codelab.run', { sessionId, code: ' ' }), /code/);
  await assert.rejects(f.core.rpc('codelab.run', { sessionId, code: 'print(1)', inputs: [{artifactId:crypto.randomUUID()}] }));
  assert.equal(f.core.workbench.operations.list(sessionId).length, 0);
  const start = await f.core.rpc('codelab.run', { sessionId, code: 'import time\nprint("started")\ntime.sleep(1)\nopen("/work/output/partial.txt","w").write("partial")\nraise ValueError("missing customer")' });
  const op = () => f.core.workbench.operations.get(start.operationId);
  await until(() => op().state === 'running' && op().details?.stdout === 'started\n');
  await until(() => op().state === 'failed');
  const result = await f.core.rpc('operations.get', { id: start.operationId });
  assert.equal(result.details.exitCode, 1);
  assert.match(result.error, /missing customer/);
  assert.equal(result.results.length, 1);
  assert.ok(result.events.some((e: any) => e.state === 'running'));
});

test('compare by key, inspect a record, save the analysis, substitute a month, and compare runs', opts, async t => {
  const { f, session } = await lab(t), sessionId = session.id;
  const rpc = (name: string, args: object = {}) => f.core.rpc(name, {sessionId, ...args});
  const source = async (name: string, text: string) => {
    const v = await input(f, sessionId, name, text); return { artifactId: v.artifactId, versionId: v.versionId };
  };
  const months = await Promise.all([
    source('january.csv', 'customer,revenue\nB,20\nA,10\nD,4\n'),
    source('february.csv', 'customer,revenue\nA,10\nB,23\nC,6\n'),
    source('march.csv', 'customer,revenue\nD,4\nA,10\nB,30\n'),
  ]);
  const code = (await rpc('codelab.status')).recipes.find((r: any) => r.id === 'compare').code;
  async function run(p: object) {
    const { operationId } = await rpc('codelab.run', p);
    await until(() => ['completed','failed'].includes(f.core.workbench.operations.get(operationId).state), 10000);
    const op = f.core.workbench.operations.get(operationId);
    assert.equal(op.state, 'completed', op.error?.message); return op;
  }
  const first = await run({code,purpose:'Monthly revenue', inputs:months.slice(0,2),parameters:{key:'customer'}});
  const table = first.results[0], view = await rpc('codelab.table',{...table,sort:'change'});
  assert.deepEqual(view.rows.map((r:any) => r.values[0]), ['added','modified','removed']);
  const selected = await rpc('codelab.exportRows',{...table,query:'modified',rows:[view.rows[1].row]});
  assert.match((await f.core.workbench.artifacts.bytes(sessionId,selected.artifactId)).data.toString(), /modified/);
  const entry = await rpc('codelab.save',{operationId:first.id,name:'Revenue differences'});
  const loaded = await rpc('codelab.load',{id:entry.id});
  assert.equal(loaded.slots[0].name,'january.csv'); assert.deepEqual(loaded.parameters,{key:'customer'});
  const next = await run({...loaded,analysisId:entry.id,inputs:[months[0],months[2]]});
  assert.equal(next.parentId,first.id);
  const compare = await rpc('operations.compare',{left:first.id,right:next.id});
  assert.ok(compare.differences.some((d:any) => d.field === 'inputs'));
  assert.ok(!compare.differences.some((d:any) => d.field === 'code'));
  const page = await rpc('operations.history',{project:true,query:'january.csv',limit:1});
  assert.equal(page.length,1); const older = await rpc('operations.history',{project:true,query:'january.csv',before:page[0].cursor,limit:1});
  assert.notEqual(older[0].operationId,page[0].operationId);
  const bundle = await rpc('codelab.export',{operationId:next.id});
  const {listZip} = await import('../broker/artifacts/zip.ts');
  const members = listZip((await f.core.workbench.artifacts.bytes(sessionId,bundle.artifactId)).data);
  assert.ok(members.some(m => m.name === 'manifest.json')); assert.ok(members.some(m => m.name.endsWith('changes.csv')));
  const peer = await f.core.create({provider:'ollama',model:'text-tools:latest',cwd:f.project});
  const fromPeer = await f.core.rpc('codelab.load',{sessionId:peer.id,id:entry.id});
  assert.deepEqual(fromPeer.inputs,[]); assert.equal(fromPeer.slots.length,2); assert.equal(fromPeer.parentId,undefined);
  await assert.rejects(f.core.rpc('codelab.open',{sessionId:peer.id,operationId:first.id}),/this conversation/);
  await rpc('codelab.schedule',{id:entry.id,days:1});
  await f.core.workbench.analyses.tick(Date.now()+2*86400000);
  assert.equal(f.core.workbench.operations.list(sessionId)[0].origin,'schedule');
  await rpc('codelab.remove',{id:entry.id}); assert.deepEqual(await rpc('codelab.library'),[]);
});

test('SQL notebook uses prior cell files and reuses only unchanged upstream results', opts, async t => {
  const {f,session} = await lab(t), sessionId = session.id;
  const steps = [{name:'Source',language:'python',code:'open("/work/output/records.csv","w").write("value\\n6\\n7\\n")'},
    {name:'Total',language:'sql',code:'SELECT SUM(CAST(value AS integer)) AS total FROM step1_1'}];
  const base = { origin:'user' as const, approval:'user' as const, steps };
  const run = await f.core.workbench.execution.run(sessionId,base);
  assert.equal(run.state,'completed',run.error?.message);
  assert.match((await f.core.workbench.artifacts.bytes(sessionId,run.results[1].artifactId)).data.toString(),/13/);
  const revised = await f.core.workbench.execution.run(sessionId,{...base,parentId:run.id,reuseSteps:true,steps:[steps[0],{...steps[1],code:'SELECT count(*) AS n FROM step1_1'}]});
  assert.equal(revised.state,'completed',revised.error?.message);
  assert.equal((revised.details!.cells as any[])[0].cached,true);
  assert.equal((revised.details!.cells as any[])[1].cached,undefined);
  assert.equal(revised.results[0].versionId,run.results[0].versionId);
  const reset = await f.core.workbench.execution.run(sessionId,{...base,parentId:revised.id,reuseSteps:true,parameters:{note:'changed'}});
  assert.equal((reset.details!.cells as any[])[0].cached,undefined);
  assert.notEqual(reset.results[0].versionId,run.results[0].versionId);
});

test('shared Python notebooks preserve variables within a run, replay cleanly, keep files on failure and show the failed cell', opts, async t => {
  const { f, session } = await lab(t);
  const steps = [
    {name:'Prepare',language:'python',code:"assert 'amount' not in globals()\namount = 7\nfrom lab_data import write_table\nwrite_table('first.csv',['x'],[{'x':amount}])"},
    {name:'Calculate',language:'python',code:"print(amount * 6)\nopen('answer.txt','w').write(str(amount * 6))"},
  ];
  const run = (cells: typeof steps) => f.core.workbench.execution.run(session.id,{steps:cells,sharedPython:true,origin:'user',approval:'user'});
  for (let i=0;i<2;i++) {
    const result = await run(steps);
    assert.equal(result.state,'completed',result.error?.message);
    assert.equal(result.results.length,2);
    assert.match(String(result.details?.stdout),/42/);
    assert.ok((result.details?.cells as any[]).every(c=>c.state==='completed'));
    const replay = await f.core.workbench.analyses.open(session.id,result.id);
    assert.equal(replay.sharedPython,true);
  }
  const failed = await run([steps[0],{...steps[1],code:"raise ValueError('bad value')"},steps[1]]);
  assert.equal(failed.state,'failed');
  assert.equal(failed.results.length,1);
  assert.deepEqual((failed.details?.cells as any[]).map(c=>c.state),['completed','failed','pending']);
});

test('the conversation model proposes an exact diff against the draft without executing it', async t => {
  const next = 'print(42)';
  const { f, session } = await lab(t,[() => ({content:JSON.stringify({explanation:'Print the result',code:next,plan:['Compute the total']})})]);
  const reply = await f.core.rpc('codelab.assist',{sessionId:session.id,request:'Print the computed answer',mode:'revise',language:'python',code:'print(7)',inputs:[]});
  assert.equal(reply.code,next);
  assert.match(reply.diff,/\+print\(42\)/);
  assert.equal(f.core.workbench.operations.list(session.id).length,0);
  assert.ok(f.requests.some(r=>r.messages?.[0]?.content?.includes('Print the computed answer')));
});

test('exported notebook runs in its own sandbox, verifies input hashes and preserves step outputs', opts, async t => {
  const { f, session } = await lab(t), sessionId = session.id;
  const file = await input(f, sessionId, 'counts.csv', 'amount\n3\n4\n');
  const steps = [
    {name:'Sum',language:'sql',code:'SELECT sum(CAST(amount AS INTEGER)) AS total FROM input1'},
    {name:'Present',language:'python',code:"from pathlib import Path\nPath('/work/output/summary.txt').write_text(Path('/work/steps/1/result.csv').read_text())"},
  ];
  const op = await f.core.workbench.execution.run(sessionId,{steps,inputs:[{artifactId:file.artifactId}],origin:'user',approval:'user'});
  assert.equal(op.state,'completed',op.error?.message);
  const zip = await f.core.workbench.analyses.export(sessionId,op.id);
  const bundle = join(f.directory,'export'), path = join(f.directory,'analysis.zip'), result = join(f.directory,'result');
  await writeFile(path,(await f.core.workbench.artifacts.bytes(sessionId,zip.artifactId)).data);
  const exec = promisify(execFile);
  await exec('python3',['-m','zipfile','-e',path,bundle]);
  const replay = join(bundle,'replay.mjs');
  await exec(process.execPath,[replay,'--output',result,'--',join(f.directory,'counts.csv')],{cwd:f.directory,timeout:30000});
  assert.equal((await readFile(join(result,'cell-2','summary.txt'),'utf8')).trim(),'total\n7');
  await writeFile(join(f.directory,'counts.csv'),'amount\n9\n');
  await assert.rejects(exec(process.execPath,[replay,'--',join(f.directory,'counts.csv')],{cwd:f.directory}),/Hash differs/);
});

test('existing process records use their recorded failure status without resubmission', async t => {
  const {f,session} = await lab(t);
  const ops=f.core.workbench.operations;
  const op=ops.create({sessionId:session.id,kind:'codelab.run',origin:'user',label:'Historical calculation',
    payloadDigest:'fixture',witness:{},inputs:[],details:{exitCode:2},state:'completed'});
  const restored = new OperationStore(f.core.store);
  assert.equal(restored.get(op.id).state,'failed');
  assert.match(restored.get(op.id).error!.message,/status 2/);
  assert.equal(restored.get(op.id).created,op.created);
  assert.equal(new OperationStore(f.core.store).get(op.id).revision,op.revision+1);
});

test('two period workbooks explain revenue changes by customer and link the ranked group to actual records', opts, async t => {
  const { f, session } = await lab(t), sessionId = session.id;
  async function month(name: string, values: string[][]) {
    const grid = [['customer','revenue'],...values].map((row,i) => '<row r="'+(i+1)+'">'+row.map((v,c) =>
      '<c r="'+(c===0?'A':'B')+(i+1)+'" t="inlineStr"><is><t>'+v+'</t></is></c>').join('')+'</row>').join('');
    const files = {
      '[Content_Types].xml':'<Types/>',
      'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+grid+'</sheetData></worksheet>',
    };
    const bytes=await zipFilesAsync(Object.entries(files).map(([name,xml])=>({name,data:Buffer.from(xml)})));
    const v=await f.core.workbench.artifacts.install({sessionId,name,bytes,source:'user-import',provenance:{kind:'fixture'}});
    return {artifactId:v.artifactId,versionId:v.versionId};
  }
  const inputs=await Promise.all([month('before.xlsx',[['North','15'],['South','9']]),month('after.xlsx',[['South','10'],['North','8']])]);
  const code=(await f.core.workbench.execution.status()).recipes.find(r=>r.id==='contributions')!.code;
  const parameters={key:'customer',metric:'revenue',sheet:'Revenue'};
  const review=await f.core.workbench.analyses.preflight(sessionId,{inputs,code,parameters});
  assert.deepEqual(review.slots[0].columns,['customer','revenue']);
  const op=await f.core.workbench.execution.run(sessionId,{inputs,parameters,code,origin:'user',approval:'user'});
  assert.equal(op.state,'completed',op.error?.message);
  const output = async (name:string) => {
    const ref=op.results.find(r=>f.core.workbench.artifacts.version(sessionId,r.artifactId,r.versionId).name===name)!;
    return f.core.rpc('codelab.table',{sessionId,...ref});
  };
  const ranked=await output('contributions.csv'), sources=await output('contributing-records.csv');
  assert.equal(ranked.rows[0].values[0],'North');
  assert.equal(Number(ranked.rows[0].values[3]),-7);
  assert.ok(sources.rows.some((r:any)=>r.values.slice(0,3).join('/')==='North/after/2'));
  assert.match(String(op.details?.stdout),/Net change in revenue: -6/);
});
