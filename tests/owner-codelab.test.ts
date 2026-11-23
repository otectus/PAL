import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isolation } from '../broker/execution/runner.ts';
import { OwnerOps } from '../broker/remote/owner.ts';
import { workbenchFixture, until } from './fixtures/workbench.ts';

const availability = await isolation();
const opts = { skip: availability.available ? false : availability.problem };

test('owner Code Lab launch, open, save and load remain scoped to the authorized conversation', opts, async t => {
  const f = await workbenchFixture(t);
  await f.core.updateSettings({ workbench: { codeLab: { enabled: true } } });
  const { session } = await f.session(undefined, { capabilities: { analysis: true } });
  const other = await f.core.create({ provider: 'ollama', model: 'text-tools:latest', cwd: f.project, capabilities: { analysis: true } });
  const allowed = new Set([session.id]);
  const router: any = {
    core: f.core, owner: () => true,
    session: (_device: any, id: string) => { if (!allowed.has(id)) throw new Error('Session is not available'); return f.core.store.session(id); },
    projectFor: (_device: any, cwd: string) => ({ id: 'project-id', path: cwd }),
  };
  const ops = new OwnerOps(router), device: any = { id: randomUUID() };
  const launched: any = await ops.dispatch(device, 'workbench.codelab.run', { sessionId: session.id, code: 'print("owner")', purpose: 'owner fixture', language: 'python', inputs: [] });
  const operationId = launched.operationId;
  assert.ok(operationId);
  await until(() => ['completed','failed'].includes(f.core.workbench.operations.get(operationId).state), 30000);
  const operation = f.core.workbench.operations.get(operationId);
  assert.equal(operation.sessionId, session.id);
  assert.equal(operation.state, 'completed', operation.error?.message);
  const opened: any = await ops.dispatch(device, 'workbench.codelab.open', { sessionId: session.id, operationId });
  assert.equal(opened.code, 'print("owner")');
  const saved: any = await ops.dispatch(device, 'workbench.codelab.save', { sessionId: session.id, operationId, name: 'owner fixture' });
  const loaded: any = await ops.dispatch(device, 'workbench.codelab.load', { sessionId: session.id, id: saved.id });
  assert.equal(loaded.code, 'print("owner")');
  await assert.rejects(() => ops.dispatch(device, 'workbench.codelab.open', { sessionId: other.id, operationId }), /Session is not available/);
  await assert.rejects(() => ops.dispatch(device, 'workbench.codelab.load', { sessionId: other.id, id: saved.id }), /Session is not available/);
  allowed.clear(); allowed.add(other.id);
  for (const method of ['preflight', 'assist', 'run']) {
    await assert.rejects(() => ops.dispatch(device, 'workbench.codelab.' + method, { sessionId: other.id, analysisId: saved.id, code: 'print(1)', inputs: [] }), /Session is not available/);
  }
  assert.deepEqual(await ops.dispatch(device, 'workbench.operations.history', { sessionId: other.id, project: 'project-id' }), []);
});
