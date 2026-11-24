// A05 task binding (prompts/PAL-PyPersona-Next-Stage-Plan.md §6.3): a conversation works on one open task of its project
// because the person said so. Its memories are threaded by the task and rank first for it; nothing is hidden from the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'pal-task-')), project = join(root, 'project'), elsewhere = join(root, 'elsewhere'), state = join(root, 'state');
  await mkdir(project); await mkdir(elsewhere);
  const start = async () => {
    const core = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }));
    await core.updateSettings({ ollama: { host: 'http://127.0.0.1:9' }, memory: { enabled: true, allowCloudMemory: true } });
    await core.memory.ready; return core;
  };
  const f = { core: await start(), project, elsewhere, root, state, async restart() { await f.core.close(); f.core = await start(); } };
  t.after(async () => { await f.core.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
const signal = () => new AbortController().signal;
const tasks = async (core: Core, sessionId: string, ...texts: string[]) => {
  const out: string[] = [];
  for (const text of texts) { const capsule: any = await core.rpc('capsules.get', { sessionId }); out.push((await core.rpc('capsules.task', { sessionId, expectedRevision: capsule.revision, op: 'add', text })).task); }
  return out;
};
const move = async (core: Core, sessionId: string, taskId: string, state: string) => { const capsule: any = await core.rpc('capsules.get', { sessionId }); return core.rpc('capsules.task', { sessionId, expectedRevision: capsule.revision, op: 'transition', taskId, state, ...(state === 'done' ? { completion: { kind: 'user-decision', note: 'Finished' } } : {}) }); };
/** Events as the store holds them, read from the file itself. */
function events(state: string) {
  for (const path of [join(state, 'memory', 'memory.sqlite'), join(state, 'graph-memory', 'memory.sqlite'), join(state, 'memory.sqlite')]) if (existsSync(path)) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT e.task_id AS task, e.thread_id AS thread, e.actor AS actor, p.body AS body FROM events e JOIN payloads p ON p.id=e.payload_id').all() as any[]; } finally { db.close(); } }
  throw new Error('no memory store');
}

test('a conversation is bound only by the person, only to an open task of its own project, and to one at a time', async t => {
  const f = await fixture(t), { core } = f;
  const session = await core.create({ provider: 'codex', cwd: f.project, trusted: true }), other = await core.create({ provider: 'codex', cwd: f.elsewhere, trusted: true });
  const [first, second] = await tasks(core, session.id, 'Fix the importer', 'Write the guide'), [foreign] = await tasks(core, other.id, 'Somewhere else');
  assert.deepEqual(await core.rpc('capsules.openTasks', { sessionId: session.id }), { current: '', tasks: [{ id: first, text: 'Fix the importer', state: 'accepted' }, { id: second, text: 'Write the guide', state: 'accepted' }] });
  await assert.rejects(core.rpc('capsules.workOn', { sessionId: session.id, taskId: foreign }), /no longer exists in this conversation’s project/);
  await core.rpc('capsules.workOn', { sessionId: session.id, taskId: first }); assert.equal(core.store.session(session.id).task?.text, 'Fix the importer');
  await core.rpc('capsules.workOn', { sessionId: session.id, taskId: second }); assert.equal((await core.rpc('capsules.openTasks', { sessionId: session.id })).current, second);
  await core.rpc('capsules.workOn', { sessionId: session.id, taskId: null }); assert.equal(core.store.session(session.id).task, undefined);
  await move(core, session.id, first, 'dropped'); await assert.rejects(core.rpc('capsules.workOn', { sessionId: session.id, taskId: first }), /task is closed/);
});

test('what is said in a bound conversation carries the task; nothing after it ends does; the binding survives a restart', async t => {
  const f = await fixture(t);
  const session = await f.core.create({ provider: 'codex', cwd: f.project, trusted: true }), free = await f.core.create({ provider: 'codex', cwd: f.project, trusted: true });
  const [task] = await tasks(f.core, session.id, 'Fix the importer');
  await f.core.memory.capture(f.core.store.session(session.id), 'Before binding nothing is threaded by a task.', 'Understood.');
  await f.core.rpc('capsules.workOn', { sessionId: session.id, taskId: task });
  await f.core.memory.capture(f.core.store.session(session.id), 'The importer fails on zero length archives.', 'I will check the archive reader.');
  await f.core.memory.capture(f.core.store.session(free.id), 'Unbound conversations stay as they were.', 'Yes.');
  await f.restart();
  assert.equal(f.core.store.session(session.id).task?.id, task, 'the binding survives a restart');
  await f.core.memory.capture(f.core.store.session(session.id), 'The fix is to reject empty members.', 'Done.');
  await move(f.core, session.id, task, 'done'); assert.equal(f.core.store.session(session.id).task, undefined, 'a finished task releases its conversation');
  await f.core.memory.capture(f.core.store.session(session.id), 'Afterwards nothing carries it.', 'Right.');
  const rows = events(f.state), of = (text: string) => rows.find(row => String(row.body).includes(text))!;
  const id = of('zero length archives').task; assert.match(id, /^[0-9a-f-]{36}$/); assert.equal(of('archive reader').task, id, 'the reply too'); assert.equal(of('zero length archives').thread, id); assert.equal(of('reject empty members').task, id, 'one mirror, kept across the restart');
  for (const text of ['Before binding', 'Unbound conversations', 'Afterwards nothing']) assert.equal(of(text).task, null, text);
});

test('memories of the task rank first for the bound conversation and are unchanged for others; another project’s task is refused', async t => {
  const f = await fixture(t), { core } = f;
  const local = (cwd: string) => core.create({ provider: 'codex', cwd, trusted: true });
  const session = await local(f.project), free = await local(f.project), other = await local(f.elsewhere);
  const [task] = await tasks(core, session.id, 'Fix the importer');
  for (let i = 0; i < 6; i++) await core.memory.capture(core.store.session(free.id), `Archive reader note ${i}: the archive reader handles compressed members number ${i} well.`, 'Noted.');
  await core.rpc('capsules.workOn', { sessionId: session.id, taskId: task });
  await core.memory.capture(core.store.session(session.id), 'In this task the archive reader must reject empty members.', 'Agreed.');
  for (let i = 6; i < 12; i++) await core.memory.capture(core.store.session(free.id), `Archive reader note ${i}: the archive reader handles compressed members number ${i} well.`, 'Noted.');
  const recall = async (id: string) => (await core.memory.recall(core.store.session(id), 'archive reader members', signal(), 4000, 'cloud', { exclude_observation_ids: [] })).items.map((item: any) => String(item.text));
  // The recall of a fresh bound conversation, so its own recent exchange is not left out.
  const bound = await local(f.project); await core.rpc('capsules.workOn', { sessionId: bound.id, taskId: task });
  const first = await recall(bound.id), plain = await recall(free.id), again = await recall(free.id);
  assert.match(first[0], /must reject empty members/, first.slice(0, 2).join(' | ')); assert.ok(plain.length >= 2);
  assert.ok(!/must reject empty members/.test(plain[0]) || plain.length === 1, 'an unbound conversation keeps its own order'); assert.deepEqual(plain, again);
  // The same records reach both: the task only orders what matched.
  assert.ok(first.every((text: string) => /rchive reader/.test(text)));
  const scope = await core.memory.scope(core.store.session(session.id)), away = await core.memory.scope(core.store.session(other.id));
  const mirrored = await core.memory.service.call('task_ensure', { scope_id: scope, binding: 'capsule:' + 'a'.repeat(32) + ':' + task, status: 'active' });
  await assert.rejects(core.memory.service.call('retrieve', { scope_id: away, text: 'archive', task_id: mirrored.id }), /not in this scope/);
  await assert.rejects(core.memory.service.call('observe_text', { scope_id: away, text: 'x archive', role: 'user', session_id: other.id, task_id: mirrored.id }), /Task binding is not in/);
  await assert.rejects(core.memory.service.call('task_ensure', { scope_id: scope, binding: 'anything', status: 'active' }), /Unknown task binding/);
  const same = await core.memory.service.call('task_ensure', { scope_id: scope, binding: 'capsule:' + 'a'.repeat(32) + ':' + task, status: 'active' }); assert.equal(same.revision, mirrored.revision, 'an unchanged mirror writes nothing');
});

test('identity decisions are listed with their witness, take effect, and can be undone', async t => {
  const f = await fixture(t), { core } = f, session = await core.create({ provider: 'codex', cwd: f.project, trusted: true });
  const scope = await core.memory.scope(core.store.session(session.id));
  const observe = (text: string) => core.memory.service.call('observe_text', { scope_id: scope, text, role: 'user', session_id: session.id });
  const ids: string[] = [];
  for (const name of ['Orchid', 'orchid-cli']) {
    const text = `${name} uses SQLite.`, observation = await observe(text);
    const saved = await core.memory.service.call('remember', { scope_id: scope, claim: { subject: { type: 'Project', name }, predicate: 'USES_TOOL', object: { type: 'Tool', name: 'SQLite' } }, witness: { observation_id: observation.id, quote: text } }).catch((error: Error) => ({ error: error.message }));
    assert.ok(!(saved as any).error, (saved as any).error);
  }
  const listed = await core.memory.service.call('list', { scope_id: scope, kind: 'entities' }).catch(() => null);
  for (const name of ['Orchid', 'orchid-cli']) { const row = (listed?.rows || listed?.items || []).find((item: any) => (item.text || item.name) === name); if (row) ids.push(row.id); }
  if (ids.length < 2) { const db = new DatabaseSync(join(f.state, 'memory', 'memory.sqlite'), { readOnly: true }); try { ids.length = 0; for (const name of ['Orchid', 'orchid-cli']) ids.push(String((db.prepare('SELECT id FROM entities WHERE name=?').get(name) as any)?.id)); } finally { db.close(); } }
  const decided = await core.memory.userGraph(core.store.session(session.id), 'identity', { left_id: ids[0], right_id: ids[1], decision: 'same', statement: 'Orchid and orchid-cli are the same project.' });
  assert.equal(decided.applied, true);
  const { decisions } = await core.memory.service.call('identity_list', { scope_id: scope });
  assert.equal(decisions.length, 1); assert.deepEqual([decisions[0].left.name, decisions[0].right.name, decisions[0].decision, decisions[0].effective, decisions[0].reverted], ['Orchid', 'orchid-cli', 'same', true, false]); assert.match(JSON.stringify(decisions[0].witness), /same project/);
  await assert.rejects(core.memory.service.call('identity', { scope_id: scope, revert_id: decisions[0].id, expected_revision: decisions[0].revision + 1 }), /changed/);
  await core.memory.service.call('identity', { scope_id: scope, revert_id: decisions[0].id, expected_revision: decisions[0].revision });
  const after = (await core.memory.service.call('identity_list', { scope_id: scope, entity_id: ids[1] })).decisions; assert.deepEqual([after[0].reverted, after[0].effective], [true, false], 'the decision and its undoing both stay in the record');
});
