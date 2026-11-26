import './fixtures/memory-environment.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory, memoryScope } from '../broker/memory.ts';
import { Store } from '../broker/store.ts';
import type { Provider, Session, Settings } from '../broker/types.ts';

const signal = () => new AbortController().signal;

function session(provider: Provider, id: string, cwd: string, host?: string): Session {
  return {
    id, provider, nativeId: null, title: provider, cwd, mode: 'managed', status: 'idle',
    created: 1, updated: 1, draft: '', scroll: 0, model: provider === 'ollama' ? 'chat' : `${provider}-model`,
    ...(provider === 'ollama' ? { ollama: { host: host!, tools: true } } : {}),
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-shared-memory-'));
  const server = createServer(async (req, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ model: 'nomic-embed-text:latest', digest: 'embed-v1' }, { model: 'chat', digest: 'chat-v1' }] }));
    else if (req.url === '/api/show') res.end(JSON.stringify(body.model === 'chat' ? { capabilities: ['completion'] } : { capabilities: ['embedding'] }));
    else if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: body.input.map((text: string) => [/orchid/i.test(text) ? 1 : 0, /cedar/i.test(text) ? 1 : 0, 0]) }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new Store(directory);
  let settings: Settings = { ...store.settings(), ollama: { host, model: 'chat' }, memory: { enabled: true, model: 'nomic-embed-text', allowCloudMemory: true, allowCloudExtraction: false } };
  const memory = new Memory(store, () => settings);
  await memory.ready;
  t.after(async () => {
    await memory.close(); store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, host, store, memory, settings: () => settings, update: async (patch: Partial<Settings['memory']>) => {
    settings = { ...settings, memory: { ...settings.memory, ...patch } };
    await memory.configure();
  } };
}

test('Codex, Claude, and Ollama share the existing host/project scope while projects stay isolated', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const claude = session('claude', 'claude-session', project);
  for (const value of [ollama, codex, claude]) f.store.saveSession(value);

  assert.equal(memoryScope(ollama), memoryScope(codex, f.host), 'native providers retain the existing Ollama scope key');
  assert.equal(await f.memory.scope(ollama), await f.memory.scope(codex));
  assert.equal(await f.memory.scope(ollama), await f.memory.scope(claude));

  const legacy = await f.memory.save(ollama, 'The release orchid is violet.');
  assert.ok((await f.memory.list(claude)).rows.some((row: any) => row.id === legacy.id));
  const recalled = await f.memory.recall(codex, 'Which orchid is used for the release?', signal());
  assert.ok(recalled.results.some((row: any) => row.id === legacy.id));

  const otherDirectory = join(f.directory, 'other-project');
  await mkdir(otherDirectory);
  const other = session('codex', 'other-codex-session', otherDirectory);
  f.store.saveSession(other);
  assert.notEqual(await f.memory.scope(other), await f.memory.scope(codex));
  assert.equal((await f.memory.list(other)).total, 0);
});

test('native-provider recall is always cloud-routed and honors explicit cloud-memory consent', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const saved = await f.memory.save(ollama, 'Orchid deployment requires approval.');

  await f.update({ allowCloudMemory: false });
  const denied = await f.memory.recall(codex, 'orchid deployment', signal(), 4000, 'local');
  assert.equal(denied.results.length, 0);
  assert.ok(denied.coverage.includes('cloud_memory_denied'));
  await assert.rejects(f.memory.inspectForModel(codex, saved.id, signal()), (error: any) => error.code === 'POLICY_DENIED');

  await f.update({ allowCloudMemory: true });
  const allowed = await f.memory.recall(codex, 'orchid deployment', signal());
  assert.ok(allowed.results.some((row: any) => /requires approval/u.test(row.text)));
  assert.equal((await f.memory.inspectForModel(codex, saved.id, signal())).record.id, saved.id);

  const localOnly = await f.memory.service.call('observe_text', {
    scope_id: await f.memory.scope(ollama), text: 'Local-only cedar detail.', role: 'user',
    session_id: ollama.id, source_event_id: 'local-only-source', kind: 'saved', sensitivity: 'local_only',
  });
  await assert.rejects(f.memory.inspectForModel(codex, localOnly.id, signal()), (error: any) => error.code === 'POLICY_DENIED');
});

test('erasure from one provider removes shared memory and scrubs every managed provider transcript in the same scope', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const ollama = session('ollama', 'ollama-session', project, f.host);
  const codex = session('codex', 'codex-session', project);
  const claude = session('claude', 'claude-session', project);
  for (const value of [ollama, codex, claude]) {
    f.store.saveSession(value);
    f.store.message({ id: `message-${value.id}`, sessionId: value.id, role: 'user', text: 'Shared secret orchid marker.', time: 1 });
  }
  const temporary = { ...session('codex', 'temporary-session', project), temporary: true };
  f.store.saveSession(temporary);
  f.store.set(`ollama:${ollama.id}`, [{ role: 'user', content: 'Shared secret orchid marker.' }]);
  const saved = await f.memory.save(codex, 'Shared secret orchid marker.');

  await f.memory.forget(claude, saved.id);

  for (const value of [ollama, codex, claude]) assert.equal(f.store.messages(value.id)[0].text, '[Content removed by memory erasure]');
  assert.equal(f.store.get<any[]>(`ollama:${ollama.id}`, [])[0].content, '[Content removed by memory erasure]');
  assert.equal((await f.memory.list(ollama)).total, 0);
});

test('retention expiry retires recalled packets without ending live turns; a forget ends them with a clear reason', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  const turn = f.memory.controller.signal, work = f.memory.service.controller.signal, epoch = f.store.get('transcriptEpoch', '');
  f.memory.packets.set(codex.id, { observed: true });
  // The memory worker relays canonical events through this client callback.
  f.memory.service.canonical.notify({ type: 'invalidate', cause: 'expiration' });
  assert.equal(turn.aborted, false, 'a reply in progress survives routine expiry');
  assert.equal(work.aborted, false, 'extraction and projection in flight survive routine expiry');
  assert.equal(f.memory.packets.size, 0, 'recalled packets are retired');
  assert.notEqual(f.store.get('transcriptEpoch', ''), epoch);
  // A real forget crosses the worker with its cause and still ends work that may use the removed content.
  const saved = await f.memory.save(codex, 'Shared secret orchid marker.');
  await f.memory.forget(codex, saved.id);
  assert.equal(turn.aborted, true);
  assert.equal((turn.reason as any).code, 'MEMORY_INVALIDATED');
  assert.match((turn.reason as Error).message, /^Memory changed while PAL was replying\. Send your message again\.$/);
  assert.equal(work.aborted, true);
  assert.equal(f.memory.controller.signal.aborted, false, 'the next turn starts with a fresh signal');
});

test('a turn waits at most the recall deadline for memory; stopping the turn ends the wait at once', async t => {
  const f = await fixture(t), project = join(f.directory, 'deadline');
  await mkdir(project);
  const codex = session('codex', 'codex-deadline', project);
  f.store.saveSession(codex);
  // A memory worker that never answers, as when a long erasure walk held it.
  const call = f.memory.service.call.bind(f.memory.service);
  f.memory.service.call = ((method: string, p?: any, s?: AbortSignal) => method === 'observe_text' ? new Promise(() => {}) : call(method, p, s)) as typeof f.memory.service.call;
  t.after(() => { f.memory.service.call = call; });
  f.memory.recallDeadlineMs = 150;
  const started = Date.now();
  assert.equal(await f.memory.context(codex, 'What did we decide about the orchid release?', signal()), '');
  assert.ok(Date.now() - started < 3000, 'the turn went ahead without recalled context');
  assert.equal(f.memory.summary().state, 'degraded');
  assert.match(f.memory.summary().error, /did not answer in time/);
  assert.equal(f.memory.service.foreground, 0, 'housekeeping resumes after the turn');
  f.memory.recallDeadlineMs = 60000;
  const stop = new AbortController(), waiting = f.memory.context(codex, 'And the cedar launch?', stop.signal);
  setTimeout(() => stop.abort(new Error('Stopped by the user')), 50);
  await assert.rejects(waiting, /Stopped by the user/);
  assert.ok(Date.now() - started < 6000);
});

test('a forget bound to its preview completes when other memory commits between its source lookup and the deletion', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  f.store.message({ id: 'message-codex', sessionId: codex.id, role: 'user', text: 'The deployment hint is aquamarine falcon.', time: 1 });
  const note = await f.memory.save(codex, 'The deployment hint is aquamarine falcon.');
  const preview = await f.memory.graph(codex, 'forget_preview', { id: note.id });
  // Another conversation's reply is recorded after the erasure has read its sources and scrubbed the
  // transcripts, and before the canonical deletion runs.
  const scope_id = await f.memory.scope(codex), canonical = f.memory.service.canonical, call = canonical.call.bind(canonical);
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'forget') await call('observe_text', { scope_id, text: 'An unrelated reply about the build cache.', role: 'assistant', session_id: 'other-session' });
    return call(method, params, signal);
  };
  const receipt = await f.memory.graph(codex, 'forget', { id: note.id, expected_revision: preview.revision, selection: preview.selection });
  canonical.call = call;
  assert.equal(receipt.suppressed, true);
  assert.equal(f.store.messages(codex.id)[0].text, '[Content removed by memory erasure]');
  assert.equal((await f.memory.list(codex)).total, 0, 'the forgotten note is gone, not left recallable after the transcripts were scrubbed');
  assert.ok(!(await f.memory.recall(codex, 'aquamarine falcon deployment hint', signal())).items.some((item: any) => /aquamarine/.test(item.text)));
  assert.deepEqual(f.store.get<any[]>('memory-pending-erasure', []), []);
  // A preview made before a change the person did not see is still refused, before anything is scrubbed.
  f.store.message({ id: 'message-later', sessionId: codex.id, role: 'user', text: 'The staging hint is copper heron.', time: 2 });
  const later = await f.memory.save(codex, 'The staging hint is copper heron.');
  const stale = await f.memory.graph(codex, 'forget_preview', { id: later.id });
  await f.memory.save(codex, 'Another note saved after the preview.');
  await assert.rejects(f.memory.graph(codex, 'forget', { id: later.id, expected_revision: stale.revision, selection: stale.selection }), { code: 'REVISION_CONFLICT' });
  assert.equal(f.store.messages(codex.id).find(message => message.id === 'message-later')!.text, 'The staging hint is copper heron.');
  assert.ok((await f.memory.list(codex)).rows.some((row: any) => row.text === 'The staging hint is copper heron.'));
  assert.deepEqual(f.store.get<any[]>('memory-pending-erasure', []), []);
});

test('an erasure interrupted after its transcripts were scrubbed is finished when memory restarts; one with nothing left to delete does not stop memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-pending-erasure-')), project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = (store: Store): Settings => ({ ...store.settings(), ollama: { host: 'http://127.0.0.1:9', model: 'chat' }, memory: { enabled: true, model: 'nomic-embed-text', allowCloudMemory: true, allowCloudExtraction: false } });
  const codex = session('codex', 'codex-session', project);
  let store = new Store(directory), memory = new Memory(store, () => settings(store));
  await memory.ready;
  store.saveSession(codex);
  const scope_id = await memory.scope(codex);
  const kept = await memory.save(codex, 'The rollback window is two hours.');
  const interrupted = await memory.save(codex, 'The vault passphrase hint is lilac otter.');
  // The canonical deletion never ran: the worker stopped after the intent was recorded.
  const canonical = memory.service.canonical, call = canonical.call.bind(canonical);
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'forget') throw Object.assign(new Error('Memory stopped a request that ran too long and restarted'), { code: 'BACKEND_UNAVAILABLE' });
    return call(method, params, signal);
  };
  await assert.rejects(memory.forget(codex, interrupted.id), { code: 'OUTCOME_UNKNOWN' });
  canonical.call = call;
  assert.equal(store.get<any[]>('memory-pending-erasure', []).length, 1);
  await memory.close(); store.close();
  // One more intent names a record that no longer exists, as after compaction or restoring an older store.
  store = new Store(directory);
  store.set('memory-pending-erasure', [...store.get<any[]>('memory-pending-erasure', []), { intentId: 'gone', scope_id, id: '00000000-0000-4000-8000-000000000000' }]);
  memory = new Memory(store, () => settings(store));
  t.after(async () => { await memory.close(); store.close(); });
  await memory.ready;
  assert.deepEqual(store.get<any[]>('memory-pending-erasure', []), []);
  const rows = (await memory.list(codex)).rows.map((row: any) => row.text);
  assert.deepEqual(rows, ['The rollback window is two hours.'], 'the interrupted erasure finished before memory served');
  assert.ok((await memory.save(codex, 'Memory still accepts notes.')).id);
  assert.ok(kept.id);
});

test('a forget the stopped memory worker never ran is finished when the worker restarts', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  const note = await f.memory.save(codex, 'The recovery code hint is saffron lynx.');
  const canonical = f.memory.service.canonical, call = canonical.call.bind(canonical);
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'forget') throw Object.assign(new Error('Memory stopped a request that ran too long and restarted'), { code: 'BACKEND_UNAVAILABLE' });
    return call(method, params, signal);
  };
  await assert.rejects(f.memory.forget(codex, note.id), { code: 'OUTCOME_UNKNOWN' });
  canonical.call = call;
  assert.equal((await f.memory.list(codex)).total, 1);
  canonical.notify({ type: 'worker_restarted', method: 'forget' });
  for (let tries = 0; tries < 100 && f.store.get<any[]>('memory-pending-erasure', []).length; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.store.get<any[]>('memory-pending-erasure', []), []);
  assert.equal((await f.memory.list(codex)).total, 0);
});

test('a scrubbed conversation passage leaves no copy in the conversation database or its log', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  const token = 'zqxjpomegranatezz';
  // Long enough to need overflow pages, which a scrub frees rather than rewrites.
  f.store.message({ id: 'message-long', sessionId: codex.id, role: 'user', text: `My locker pin is ${token}. ` + 'Context for the request. '.repeat(1200), time: 1 });
  const note = await f.memory.save(codex, `My locker pin is ${token}.`);
  f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const onDisk = () => ['pal.sqlite', 'pal.sqlite-wal'].filter(name => existsSync(join(f.directory, name)) && readFileSync(join(f.directory, name)).includes(Buffer.from(token)));
  assert.deepEqual(onDisk(), ['pal.sqlite']);
  await f.memory.forget(codex, note.id);
  assert.equal(f.store.messages(codex.id)[0].text, '[Content removed by memory erasure]');
  assert.deepEqual(onDisk(), [], 'neither freed pages nor earlier log frames keep the scrubbed text');
});

test('a message recorded after its turn stopped waiting for memory is recorded once', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  await f.memory.scope(codex);
  f.memory.recallDeadlineMs = 100;
  const canonical = f.memory.service.canonical, call = canonical.call.bind(canonical);
  // A busy worker accepts the message's write, which commits after the turn went ahead without memory.
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'observe_text' && params.role === 'user') { const written = call(method, params); await new Promise(resolve => setTimeout(resolve, 300)); return written; }
    return call(method, params, signal);
  };
  const text = 'Which cedar release notes did we publish?';
  assert.equal(await f.memory.context(codex, text, signal()), '');
  canonical.call = call;
  assert.equal((await f.memory.capture(codex, text, 'The cedar notes went out Monday.')).outcome, 'captured');
  const database = new DatabaseSync(join(f.directory, 'graph-memory', 'memory.sqlite'), { readOnly: true });
  try {
    const count = (database.prepare("SELECT COUNT(*) AS n FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.role='user' AND p.body=?").get(text) as { n: number }).n;
    assert.equal(count, 1, 'one message is one source, not two independent ones');
  } finally { database.close(); }
});

test('clearing memory removes every record it scrubbed even when the wall clock stepped back', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  await f.memory.save(codex, 'The cedar build cache lives on the second disk.');
  await f.memory.save(codex, 'The orchid deploy runs on Fridays.');
  assert.equal((await f.memory.list(codex)).total, 2);
  // The broker's clock is an hour behind the times the store recorded (the store's own clock never goes back).
  const real = Date.now;
  t.mock.method(Date, 'now', () => real() - 3_600_000);
  await f.memory.clear(codex);
  t.mock.restoreAll();
  assert.equal((await f.memory.list(codex)).total, 0);
  assert.deepEqual(f.store.get<any[]>('memory-pending-erasure', []), []);
});

test('a busy memory worker delays recall but does not fail it: keyword matches are still found, and coverage says the rest was cut short', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await mkdir(project);
  const codex = session('codex', 'codex-session', project);
  f.store.saveSession(codex);
  await f.memory.save(codex, 'The aquamarine deploy key rotates every quarter.');
  const canonical = f.memory.service.canonical, call = canonical.call.bind(canonical);
  // The worker reaches the scope lookup only after the 500 ms retrieval deadline, as when housekeeping
  // runs ahead of it; a caller that gives up first is answered at once.
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'effective_scopes') await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 700);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return call(method, params, signal);
  };
  const found = await f.memory.recall(codex, 'aquamarine deploy key', signal());
  assert.ok(found.items.some((item: any) => /aquamarine deploy key/.test(item.text)), 'an explicit search still finds the keyword match');
  assert.ok(found.coverage.includes('deadline_partial'), 'and reports that the optional routes were cut short');
  const packet = await f.memory.context(codex, 'Which aquamarine deploy key schedule applies here?', signal());
  canonical.call = call;
  assert.match(packet, /aquamarine deploy key rotates every quarter/, 'a turn is still given the keyword match');
  assert.equal(f.memory.outcomes(codex.id)[0].outcome, 'included');
});

test('a Clear interrupted while the wall clock was behind is finished on restart up to what the store had recorded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-clear-replay-')), project = join(directory, 'project');
  await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = (store: Store): Settings => ({ ...store.settings(), ollama: { host: 'http://127.0.0.1:9', model: 'chat' }, memory: { enabled: true, model: 'nomic-embed-text', allowCloudMemory: true, allowCloudExtraction: false } });
  const codex = session('codex', 'codex-session', project);
  let store = new Store(directory), memory = new Memory(store, () => settings(store));
  await memory.ready;
  store.saveSession(codex);
  await memory.save(codex, 'The cedar build cache lives on the second disk.');
  await memory.save(codex, 'The orchid deploy runs on Fridays.');
  // The broker's clock is an hour behind the times the store recorded, and the deletion never runs.
  const real = Date.now;
  t.mock.method(Date, 'now', () => real() - 3_600_000);
  const canonical = memory.service.canonical, call = canonical.call.bind(canonical);
  canonical.call = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    if (method === 'forget') throw Object.assign(new Error('Memory stopped a request that ran too long and restarted'), { code: 'BACKEND_UNAVAILABLE' });
    return call(method, params, signal);
  };
  await assert.rejects(memory.clear(codex), { code: 'OUTCOME_UNKNOWN' });
  t.mock.restoreAll();
  canonical.call = call;
  await memory.close(); store.close();
  store = new Store(directory); memory = new Memory(store, () => settings(store));
  t.after(async () => { await memory.close(); store.close(); });
  await memory.ready;
  assert.deepEqual(store.get<any[]>('memory-pending-erasure', []), []);
  assert.equal((await memory.list(codex)).total, 0, 'the replay reached every record the Clear was asked for');
});
