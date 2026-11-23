// PAL Everywhere §7.5: a model asks to run a command on the computer as the desktop account. The tool exists only
// when the conversation turned on Host commands, every run is a reviewed CLI permission request, the output is real
// and bounded, and Stop ends the whole process group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';

const opts = { skip: skipWithoutHelper };

test('host_run is offered only with Host commands on, asks as a CLI command and returns the real result', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('host_run', { command: 'printf "%s\\n" "a b" | tr a-z A-Z; echo pwd=$(pwd); echo marker > made-by-host.txt', purpose: 'Check the pipeline' }),
    () => ({ content: 'Done.' }),
  ]);
  const { session } = await f.session();
  // Without the family the tool is not offered at all.
  assert.ok(!f.core.workbench.tools(session.id).some(tool => tool.function.name === 'host_run'));
  f.core.rpc('session.capabilities', { id: session.id, capabilities: { files: true, host: true } });
  assert.ok(f.core.workbench.tools(session.id).some(tool => tool.function.name === 'host_run'));
  const approvals: any[] = [];
  f.core.on('state', () => { for (const { value } of f.core.approvals.values()) if (!approvals.some(a => a.id === value.id)) { approvals.push(value); f.core.answer({ id: value.id, choice: 'allow' }); } });
  await f.core.rpc('session.send', { id: session.id, text: 'Run the pipeline', expectedDraftRevision: session.draftRevision });
  await f.finished(session.id);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'cli');
  assert.match(approvals[0].detail, /not isolated/);
  const result = f.toolResults().find((r: any) => r.name === 'host_run')!.value;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.data.stdout, /A B/);
  assert.match(result.data.stdout, new RegExp('pwd=' + f.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.data.exitCode, 0);
  assert.equal((await readFile(join(f.project, 'made-by-host.txt'), 'utf8')).trim(), 'marker', 'a host command really runs as the desktop account');
  const operation = f.core.workbench.operations.list(session.id, {}).find((op: any) => op.kind === 'command.host')!;
  assert.equal(operation.state, 'completed');
});

test('a declined host command never runs, and automatic approval follows the desktop switch', opts, async t => {
  const f = await workbenchFixture(t, [
    () => call('host_run', { command: 'echo ran > declined.txt', purpose: 'Should not run' }),
    () => ({ content: 'Understood.' }),
    () => call('host_run', { command: 'echo auto > auto.txt', purpose: 'Runs automatically' }),
    () => ({ content: 'Done.' }),
  ]);
  const { session } = await f.session();
  f.core.rpc('session.capabilities', { id: session.id, capabilities: { files: true, host: true } });
  f.core.on('state', () => { for (const { value } of f.core.approvals.values()) f.core.answer({ id: value.id, choice: 'deny' }); });
  await f.core.rpc('session.send', { id: session.id, text: 'Try it', expectedDraftRevision: session.draftRevision });
  await f.finished(session.id);
  await assert.rejects(readFile(join(f.project, 'declined.txt')));
  assert.equal(f.toolResults().find((r: any) => r.name === 'host_run')!.value.status, 'declined');
  // With automatic CLI approval on, the same request runs without a question.
  await f.core.updateSettings({ bypassCliPermissions: true });
  f.core.removeAllListeners('state');
  await f.core.rpc('session.send', { id: session.id, text: 'Again', expectedDraftRevision: f.core.store.session(session.id).draftRevision });
  await f.finished(session.id);
  assert.equal((await readFile(join(f.project, 'auto.txt'), 'utf8')).trim(), 'auto');
});

test('Stop ends a host command and its children; the outcome is recorded, never invented', opts, async t => {
  const f = await workbenchFixture(t);
  const { session, root } = await f.session();
  await writeFile(join(f.project, 'spawn.sh'), 'sleep 60 & sleep 60\n');
  const running = f.core.workbench.execution.hostCommand(session.id, root, { program: { kind: 'shell', shell: 'bash', command: 'bash spawn.sh' }, origin: 'user', timeoutSeconds: 120 });
  await until(() => f.core.workbench.operations.list(session.id, {}).some((op: any) => op.kind === 'command.host' && op.state === 'running'));
  const operation = f.core.workbench.operations.list(session.id, {}).find((op: any) => op.kind === 'command.host')!;
  await f.core.workbench.cancelRun(operation.id);
  const finished = await running;
  assert.equal(finished.state, 'cancelled');
  assert.equal(finished.details?.survivors, 0, 'the whole process group stopped');
  // A time limit is reported as such.
  const timed = await f.core.workbench.execution.hostCommand(session.id, root, { program: { kind: 'shell', shell: 'bash', command: 'sleep 30' }, origin: 'user', timeoutSeconds: 5 });
  assert.equal(timed.state, 'failed'); assert.equal(timed.error?.code, 'timeout');
});
