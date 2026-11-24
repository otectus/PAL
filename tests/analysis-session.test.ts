// PAL Everywhere §15.2: an analysis session keeps Python state between cells inside Code Lab's boundary, and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolation, pythonRuntime } from '../broker/execution/runner.ts';
import { kernelLimits } from '../broker/execution/kernels.ts';
import { call, skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';

const boundary = await isolation(), runtime = await pythonRuntime();
const skip = skipWithoutHelper || (!boundary.available || runtime.python === 'unavailable' ? 'needs Bubblewrap and Python' : false);
async function lab(t: any, steps?: any) {
  const f = await workbenchFixture(t, steps, { contextWindow: 32768 }), { session } = await f.session({ write: false }, { model: 'text-tools:latest', capabilities: { files: true, analysis: true } });
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  const rpc = (method: string, p: any = {}) => f.core.rpc('codelab.' + method, { sessionId: session.id, ...p });
  const cell = async (code: string, p: any = {}) => {
    const started = await rpc('sessionRun', { code, ...p });
    await until(() => !['queued', 'running', 'cancel_requested'].includes(f.core.workbench.operations.get(started.operationId).state), 40_000);
    return f.core.workbench.operations.get(started.operationId);
  };
  return { f, session, rpc, cell };
}

test('variables stay between cells, are listed, and every result says what it depends on', { skip }, async t => {
  const { f, session, rpc, cell } = await lab(t);
  assert.equal((await rpc('session')).session, null);
  await assert.rejects(rpc('sessionRun', { code: '1' }), /No analysis session is running/);
  const started = await rpc('sessionStart'); assert.equal(started.session.state, 'idle');
  await assert.rejects(rpc('sessionStart'), /already has an analysis session/);
  const first = await cell('total = 40\nnames = ["a", "b"]\nclass Odd:\n    def __repr__(self): raise RuntimeError("no")\nodd = Odd()', { purpose: 'Load' });
  assert.equal(first.state, 'completed', JSON.stringify(first.error) + first.details!.stderr);
  const second = await cell('total += 2\ntotal');
  assert.equal(second.state, 'completed'); assert.equal(String(second.details!.stdout).trim(), '42', 'the last expression is shown');
  assert.deepEqual((second.details!.sessionKernel as any).sequence, 2); assert.equal((second.details!.sessionKernel as any).earlier, 1);
  const { session: now } = await rpc('session');
  assert.deepEqual(now.variables.filter((v: any) => v.name !== 'Odd').map((v: any) => [v.name, v.type, v.detail]), [['total', 'int', '42'], ['names', 'list', '2 items'], ['odd', 'Odd', '']], 'nothing of the cell’s own is run to describe a value');
  assert.deepEqual(now.cells.map((item: any) => [item.number, item.state, item.purpose]), [[1, 'completed', 'Load'], [2, 'completed', '']]);
  await assert.rejects(rpc('save', { operationId: second.id, name: 'x' }), /may depend on earlier cells/); await assert.rejects(rpc('export', { operationId: second.id }), /cannot be exported for replay/);
  // A failing cell keeps the session; its traceback names the cell.
  const failed = await cell('total / 0'); assert.equal(failed.state, 'failed'); assert.match(String(failed.details!.stderr), /<cell 3>[\s\S]*ZeroDivisionError/); assert.match(failed.error!.message, /ZeroDivisionError/);
  assert.equal((await cell('raise SystemExit(3)')).state, 'failed'); assert.equal((await rpc('session')).session.state, 'idle');
  // Clear forgets; a restart begins with the same inputs; a notebook starts clean every time.
  await rpc('sessionClear'); assert.deepEqual((await rpc('session')).session.variables, []);
  assert.equal((await cell('total')).state, 'failed');
  const fresh = await cell('x = 1'); assert.equal((fresh.details!.sessionKernel as any).earlier, 1, 'the place counts from the last clear');
  const notebook = await rpc('sessionNotebook'); assert.deepEqual(notebook.steps.map((step: any) => step.name), ['Load', 'Cell 2', 'Cell 3']); assert.equal(notebook.skipped, 3); assert.equal(notebook.sharedPython, true);
  const stopped = await rpc('sessionStop'); assert.equal(stopped.session, null); assert.match(stopped.ended.reason, /not kept/); assert.equal(stopped.ended.cells, 6);
  assert.equal(f.core.workbench.operations.list(session.id).length, 6);
});

test('a session reads only what it was given, has no network, and its files become results of the cell that made them', { skip }, async t => {
  const { f, session, rpc, cell } = await lab(t);
  await writeFile(join(f.project, 'a.csv'), 'n\n1\n2\n'); await writeFile(join(f.project, 'b.csv'), 'n\n9\n');
  const a = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'a.csv') }), b = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'b.csv'), destinations: { cloud: true } });
  const started = await rpc('sessionStart', { inputs: [{ artifactId: a.artifactId }] });
  assert.deepEqual(started.session.inputs.map((input: any) => input.path), ['/work/input/a.csv']);
  const first = await cell('rows = inputs[0].read_text().split()[1:]\nopen("out.txt", "w").write(",".join(rows))\nimport os; os.mkdir("sub"); open("sub/two.csv","w").write("x\\n1\\n")');
  assert.equal(first.state, 'completed', String(first.details!.stderr));
  const names = first.results.map(ref => f.core.workbench.artifacts.version(session.id, ref.artifactId, ref.versionId)); assert.deepEqual(names.map(version => [version.name, version.provenance.path]), [['out.txt', 'out.txt'], ['two.csv', 'sub/two.csv']]);
  assert.deepEqual(names[0].policy, { remote: false, cloud: false }, 'a result is as restricted as everything the session read'); assert.equal((names[0].provenance.sessionKernel as any).sequence, 1);
  const second = await cell('[str(p) for p in inputs]', { inputs: [{ artifactId: b.artifactId }] }); assert.match(String(second.details!.stdout), /a\.csv.*b\.csv/, 'a file can be added while it runs'); assert.equal(second.results.length, 0, 'earlier files are not reported again');
  const walls = await cell('import socket, os\nresults = []\nfor probe in (lambda: socket.create_connection(("1.1.1.1", 53), 2), lambda: open("/work/input/a.csv", "a"), lambda: open(os.path.expanduser("~") + "/../../home"), lambda: os.listdir("/home")):\n    try: probe(); results.append("open")\n    except Exception as error: results.append(type(error).__name__)\nresults');
  assert.ok(!String(walls.details!.stdout).includes('open'), String(walls.details!.stdout));
  const huge = await cell('open("big.bin","wb").write(b"0" * (33 * 1024 * 1024))\nNone'); assert.equal(huge.results.length, 0); assert.match(String(huge.details!.outputNote), /32 MB/);
});

test('a cell that runs on is interrupted and keeps the session; one that will not stop takes the session with it', { skip }, async t => {
  const { f, rpc, cell } = await lab(t);
  await rpc('sessionStart'); await cell('kept = 1');
  const slow = await rpc('sessionRun', { code: 'import time\nwhile True: time.sleep(0.05)' });
  await until(() => f.core.workbench.operations.get(slow.operationId).state === 'running');
  await assert.rejects(rpc('sessionRun', { code: '1' }), /busy/); await assert.rejects(rpc('sessionClear'), /Stop the running cell first/);
  await new Promise(resolve => setTimeout(resolve, 300)); await rpc('sessionInterrupt');
  await until(() => f.core.workbench.operations.get(slow.operationId).state === 'cancelled', 8000);
  assert.equal(String((await cell('kept')).details!.stdout).trim(), '1');
  const limited = await cell('import time\nwhile True: time.sleep(0.05)', { timeoutSeconds: 1 }); assert.equal(limited.state, 'failed'); assert.match(limited.error!.message, /time limit/);
  assert.equal(String((await cell('kept')).details!.stdout).trim(), '1');
  const stuck = await rpc('sessionRun', { code: 'import time\nwhile True:\n    try:\n        time.sleep(0.05)\n    except KeyboardInterrupt:\n        pass' });
  await new Promise(resolve => setTimeout(resolve, 300)); await rpc('sessionInterrupt');
  await until(() => f.core.workbench.kernels.status(f.core.workbench.operations.get(stuck.operationId).sessionId).session === null, kernelLimits.interruptMs + 6000);
  assert.match((await rpc('session')).ended.reason, /did not stop/);
  // A process that dies is reported, never restarted behind the person's back.
  await rpc('sessionStart'); await assert.doesNotReject(cell('1'));
  const dead = await rpc('sessionRun', { code: 'import os; os._exit(9)' });
  await until(() => f.core.workbench.operations.get(dead.operationId).state === 'failed', 8000);
  assert.match((await rpc('session')).ended.reason, /ended unexpectedly/); await assert.rejects(rpc('sessionRun', { code: '1' }), /ended unexpectedly/);
});

test('sessions are limited, listed as running work, and end with their conversation and with PAL', { skip }, async t => {
  const { f, session, rpc } = await lab(t);
  await rpc('sessionStart');
  const second = await f.session({ write: false }), third = await f.session({ write: false });
  await f.core.rpc('codelab.sessionStart', { sessionId: second.session.id }); await assert.rejects(f.core.rpc('codelab.sessionStart', { sessionId: third.session.id }), /Up to 2 analysis sessions/);
  assert.equal(f.core.jobs.snapshot().filter((job: any) => job.label === 'Analysis session').length, 2);
  await f.core.rpc('session.delete', { id: second.session.id, confirmed: true }).catch(() => f.core.workbench.removeSession(second.session.id));
  await until(() => f.core.workbench.kernels.running().length === 1, 8000);
  await f.core.updateSettings({ workbench: { codeLab: { enabled: false } } });
  await assert.rejects(rpc('sessionRun', { code: '1' }), /turned off/);
  await f.core.workbench.kernels.close(); assert.equal(f.core.workbench.kernels.running().length, 0); assert.match(f.core.workbench.kernels.status(session.id).ended!.reason, /PAL closed/);
});

test('a model runs a cell only with approval, and only where everything the session holds may go', { skip }, async t => {
  const { f, session, rpc, cell } = await lab(t, [
    () => call('pal_tools', { add: ['codelab_session'] }),
    () => call('codelab_session', { code: 'value * 2', purpose: 'Double it' }),
    () => ({ content: 'It is 42.' }),
  ]);
  assert.equal(f.core.workbench.kernels.status(session.id).session, null);
  await rpc('sessionStart'); await cell('value = 21');
  const turn = f.core.send({ id: session.id, text: 'Double the value' });
  await until(() => [...f.core.approvals.values()].some((item: any) => /analysis session/.test(item.value.title)), 15_000);
  const approval = [...f.core.approvals.values()].find((item: any) => /analysis session/.test(item.value.title))!.value as any;
  assert.match(approval.detail, /1 cells so far|1 cell/); assert.match(approval.detail, /1 {2}value \* 2/);
  await f.core.answer({ id: approval.id, choice: 'allow', digest: approval.fields?.digest });
  await turn; await f.finished(session.id);
  const result = f.toolResults().find((item: any) => item.name === 'codelab_session')?.value;
  assert.equal(result?.status, 'completed', JSON.stringify(result).slice(0, 400)); assert.match(result.data.stdout, /42/); assert.equal(result.data.sessionState.cell, 2);
  assert.equal(f.core.workbench.operations.get(result.operationId).origin, 'model');
});
