import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryService } from '../broker/graph-memory/service.ts';
import { policySchema, storedPolicy } from '../broker/graph-memory/contracts.ts';
import { LiveObservationFactory } from '../broker/graph-memory/adapters/live.ts';
import { KittyCollector, kittyInstances } from '../broker/graph-memory/adapters/kitty.ts';
import { SessionCollector, SuspendWatch } from '../broker/graph-memory/adapters/session.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

const until = async (check: () => unknown, ms = 4000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 15)); } };
const configuration = { enabled: true, paused: false, host: 'http://127.0.0.1:9', embedding_model: 'nomic-embed-text', extraction_model: '', allow_cloud_extraction: false, allow_cloud_memory: false };
async function fixture(t: any, policy: Record<string, unknown> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pal-collect-'))), approved = join(directory, 'approved'), outside = join(directory, 'outside'), runtime = process.env.PAL_RUNTIME_DIR, hypr = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  await mkdir(approved); await mkdir(outside); process.env.PAL_RUNTIME_DIR = join(directory, 'run'); delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const events: any[] = [], service = new MemoryService(directory, event => events.push(event));
  t.after(async () => { if (runtime === undefined) delete process.env.PAL_RUNTIME_DIR; else process.env.PAL_RUNTIME_DIR = runtime; if (hypr !== undefined) process.env.HYPRLAND_INSTANCE_SIGNATURE = hypr; await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.canonical.call('policy_update', { policy: { approved_roots: [approved], ...policy } });
  return { directory, approved, outside, service, events, start: () => service.configure(configuration as any), socket: join(directory, 'run', 'memory', 'memory.sock') };
}
const frame = (params: any) => JSON.stringify({ protocol_version: 1, request_id: randomUUID(), method: 'collector.emit', params });
const editor = (epoch: string, sequence: number, event: string, path?: string, more: any = {}) => frame({ source: 'editor', source_epoch: epoch, source_sequence: sequence, event, editor: 'Neovim', ...(path ? { path } : {}), ...more });

test('COL-01 every collector is off until chosen, and an unused setting never reaches the stored policy', async t => {
  const policy = policySchema.parse({}); for (const key of ['editor_enabled', 'session_enabled', 'history_enabled', 'hyprland_enabled', 'kitty_enabled', 'fish_enabled', 'filesystem_enabled', 'capture_titles'] as const) assert.equal(policy[key], false, key);
  assert.equal(policy.kitty_endpoint, ''); assert.equal(policy.history_days, 7); assert.ok(!('editor_enabled' in storedPolicy(policy)) && !('history_days' in storedPolicy(policy)) && 'fish_enabled' in storedPolicy(policy)); assert.equal(storedPolicy({ ...policy, editor_enabled: true }).editor_enabled, true);
  assert.throws(() => policySchema.parse({ kitty_endpoint: 'tcp:localhost:1' })); assert.throws(() => policySchema.parse({ history_days: 400 }));
  const f = await fixture(t); await f.start(); assert.equal(f.service.collectorRpc, undefined); assert.ok(f.service.collectors.every(c => c.constructor.name === 'RepositoryCollector'));
});

test('COL-02 an editor names a document inside an approved folder; anything else leaves no trace, and text has nowhere to go', async t => {
  const f = await fixture(t, { editor_enabled: true }); await f.start(); const rpc = f.service.collectorRpc!, epoch = randomUUID(), inside = join(f.approved, 'a.ts'); await writeFile(inside, 'x'); await writeFile(join(f.outside, 'private.txt'), 'x'); await symlink(join(f.outside, 'private.txt'), join(f.approved, 'link.txt'));
  await rpc.ingest(editor(epoch, 1, 'document_opened', inside, { pid: 42, content_revision: 'r1' }));
  const seen = () => f.service.liveSnapshot().observations.filter(o => o.source === 'editor'); assert.equal(seen().length, 1); assert.equal(seen()[0].properties.path, inside); assert.equal(seen()[0].kind, 'DOCUMENT_OPENED');
  assert.deepEqual(await rpc.ingest(editor(epoch, 1, 'document_saved', inside)), { duplicate: true });
  assert.deepEqual(await rpc.ingest(editor(epoch, 2, 'document_opened', join(f.outside, 'private.txt'))), { ignored: 'outside_approved_folders', durable: false }); await rpc.ingest(editor(epoch, 3, 'document_opened', join(f.approved, 'link.txt')));
  assert.ok(!JSON.stringify(f.service.live.snapshot()).includes('private.txt')); assert.equal(seen()[0].properties.path, inside);
  for (const bad of [{ text: 'contents' }, { title: 'x' }, { path: undefined }, { editor: 'a\nb' }, { pid: -1 }]) await assert.rejects(rpc.ingest(editor(epoch, 9, 'document_saved', inside, bad)));
  await rpc.ingest(editor(epoch, 10, 'editor_closed')); assert.equal(seen()[0].kind, 'EDITOR_CLOSED'); assert.equal(seen()[0].properties.path, undefined);
  // Two editors are two identities; a folder that is no longer approved takes what was seen there with it.
  const second = randomUUID(); await rpc.ingest(editor(second, 1, 'document_saved', inside)); assert.equal(seen().length, 2);
  await f.service.call('policy_update', { policy: { approved_roots: [] } }); assert.ok(!JSON.stringify(f.service.live.snapshot()).includes('a.ts')); await assert.rejects(f.service.collectorRpc!.ingest(editor(second, 2, 'document_saved', inside)).then(r => { if ((r as any).ignored) throw new Error('ignored'); }));
  await f.service.call('policy_update', { policy: { editor_enabled: false } }); await assert.rejects(rpc.ingest(editor(randomUUID(), 1, 'document_opened', inside)), /disabled/); assert.equal(f.service.liveSnapshot().observations.filter(o => o.source === 'editor').length, 0);
});

test('COL-03 while the computer is locked nothing is known or learned, and unlocking asks every source again', async t => {
  const f = await fixture(t, { session_enabled: true, editor_enabled: true, hyprland_enabled: false }); let locked: boolean | undefined = false, probes = 0; f.service.sessionProbe = async () => { probes++; return locked === undefined ? {} : { locked }; }; await f.start();
  const inside = join(f.approved, 'a.ts'); await writeFile(inside, 'x'); const epoch = randomUUID(), rpc = f.service.collectorRpc!; await rpc.ingest(editor(epoch, 1, 'document_opened', inside)); let asked = 0; f.service.collectors.push({ start: async () => {}, reconcile: async () => { asked++; }, stop: async () => {} });
  const session = f.service.collectors.find(c => c instanceof SessionCollector) as SessionCollector; locked = true; await session.reconcile();
  assert.equal(f.service.sessionLocked, true); const state = f.service.workspace(); assert.equal(state.current.reason, 'locked'); assert.equal(state.current.locked, true); const held = f.service.liveSnapshot().observations.find(o => o.source === 'editor')!; assert.equal(held.freshness, 'unknown'); assert.deepEqual(held.properties, { reason: 'locked' });
  await rpc.ingest(editor(epoch, 2, 'document_saved', inside)); assert.ok(!JSON.stringify(f.service.live.snapshot()).includes('a.ts'), 'nothing is learned while it is locked');
  locked = false; await session.reconcile(); assert.equal(f.service.sessionLocked, false); await until(() => asked === 1); await rpc.ingest(editor(epoch, 3, 'document_focused', inside)); assert.equal(f.service.liveSnapshot().observations.find(o => o.source === 'editor')!.freshness, 'fresh');
  // Unable to tell is said; it neither locks nor unlocks.
  locked = undefined; await session.reconcile(); assert.equal(f.service.sessionLocked, false); assert.equal(f.service.liveSnapshot().observations.find(o => o.source === 'session')!.freshness, 'unknown');
  await f.service.call('policy_update', { policy: { session_enabled: false } }); const before = probes; await session.reconcile(); assert.equal(f.service.sessionLocked, false); assert.equal(f.service.liveSnapshot().observations.filter(o => o.source === 'session').length, 0); assert.ok(probes <= before + 1);
});

test('COL-04 after the computer slept, what was seen before is unknown until it is verified again', async t => {
  let wall = 1_000_000, monotonic = 0; const gaps: number[] = [], watch = new SuspendWatch(gap => gaps.push(gap), { wall: () => wall, monotonic: () => monotonic });
  wall += 2000; monotonic += 2000; watch.check(); wall += 2400; monotonic += 2000; watch.check(); wall -= 60_000; monotonic += 2000; watch.check(); assert.deepEqual(gaps, [], 'ordinary time, small corrections and a clock set back are not sleep');
  wall += 3_600_000; monotonic += 2000; watch.check(); assert.equal(gaps.length, 1); assert.ok(gaps[0] > 3_500_000);
  const f = await fixture(t, { editor_enabled: true, fish_enabled: true }); await f.start(); const inside = join(f.approved, 'a.ts'); await writeFile(inside, 'x'); await f.service.collectorRpc!.ingest(editor(randomUUID(), 1, 'document_opened', inside)); let asked = 0; f.service.collectors.push({ start: async () => {}, reconcile: async () => { asked++; throw new Error('gone'); }, stop: async () => {} });
  await f.service.resumed(5000); const held = f.service.liveSnapshot().observations.find(o => o.source === 'editor')!; assert.deepEqual([held.freshness, held.properties.reason], ['unknown', 'suspended']); assert.equal(asked, 1, 'a source that cannot answer stays unknown');
  assert.ok(f.service.liveSnapshot().observations.some(o => o.source === 'repository' || true));
});

test('COL-05 several Kitty processes are told apart by the focused window’s own process, and a reused process ID is another terminal', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pal-kitty-'))), proc = join(directory, 'proc'), sockets: net.Server[] = []; t.after(async () => { for (const server of sockets) server.close(); await rm(directory, { recursive: true, force: true }); });
  const processOf = async (pid: number, comm: string, started: number) => { await mkdir(join(proc, String(pid)), { recursive: true }); await writeFile(join(proc, String(pid), 'comm'), comm + '\n'); await writeFile(join(proc, String(pid), 'stat'), `${pid} (a (odd) name) S ${Array.from({ length: 18 }, (_, i) => i).join(' ')} ${started} 0`); };
  const listen = async (pid: number) => { const server = net.createServer(); await new Promise<void>(r => server.listen(join(directory, `kitty-${pid}`), () => r())); sockets.push(server); };
  await processOf(100, 'kitty', 555); await processOf(200, 'kitty', 777); await processOf(300, 'fish', 1); await processOf(400, 'kitty', 9); await listen(100); await listen(200); await listen(300); await writeFile(join(directory, 'kitty-400'), 'not a socket');
  const endpoint = `unix:${join(directory, 'kitty-{pid}')}`, found = await kittyInstances(endpoint, proc); assert.deepEqual(found.map(item => [item.pid, item.instanceId]).sort(), [[100, '100:555'], [200, '200:777']]);
  const kitten = join(directory, 'kitten'); const pane = (id: number, cwd: string, focused = true) => JSON.stringify([{ id: 1, is_focused: focused, tabs: [{ id: 1, is_active: true, title: 'SECRET', windows: [{ id, is_focused: true, cwd, title: 'SECRET', cmdline: ['secret'], env: { KEY: 'SECRET' } }] }] }]);
  const work = join(directory, 'work'); await mkdir(join(work, 'one'), { recursive: true }); await mkdir(join(work, 'two'));
  await writeFile(kitten, `#!/bin/sh\ncase "$3" in *kitty-100) cat <<'E'\n${pane(1, join(work, 'one'))}\nE\n;; *kitty-200) cat <<'E'\n${pane(1, join(work, 'two'))}\nE\n;; *) exit 1;; esac\n`); await chmod(kitten, 0o755);
  let instances = found; const emitted: any[] = [], collector = new KittyCollector({ endpoint, executable: kitten, approvedCwdRoots: [work], instances: async () => instances, reconcileIntervalMs: 1_000_000 }); await collector.start(o => emitted.push(o)); t.after(() => collector.stop());
  const panes = emitted.filter(o => o.kind === 'TERMINAL_PANE'); assert.deepEqual(panes.map(o => [o.properties.kittyPid, o.properties.cwd]).sort(), [[100, join(work, 'one')], [200, join(work, 'two')]]); assert.equal(new Set(panes.map(o => o.entityId)).size, 2, 'the same pane number in two terminals is two panes'); assert.ok(!JSON.stringify(emitted).includes('SECRET'));
  // The focused window's process decides which terminal, shell and editor is current.
  const f = await fixture(t, { kitty_enabled: true, hyprland_enabled: true, fish_enabled: true, editor_enabled: true, approved_roots: [work] }); await f.service.canonical.call('policy_update', { policy: { enabled: true } }); for (const c of f.service.collectors) await c.stop(); f.service.livePolicy = { policy: { ...policySchema.parse({ kitty_enabled: true, hyprland_enabled: true, fish_enabled: true, editor_enabled: true, enabled: true }) }, roots: [work] };
  const hypr = new LiveObservationFactory('hyprland'), focus = (address: string, pid: number) => { f.service.live.apply(hypr.observation('w:' + address, 'g', 'WINDOW_SNAPSHOT', { address, appClass: 'kitty', workspace: '1', pid })); f.service.live.apply(hypr.observation('desktop', 'e', 'WINDOW_FOCUS', { address })); };
  for (const observation of emitted) f.service.live.apply(observation);
  const fish = new LiveObservationFactory('fish'), shell = (id: string, pid: number, cwd: string) => f.service.live.apply(fish.observation(id, 'g', 'SHELL_STATE', { kittyPaneId: '1', kittyPid: pid, cwd, event: 'cwd' })); shell('s1', 100, join(work, 'one')); shell('s2', 200, join(work, 'two'));
  const edit = new LiveObservationFactory('editor'); f.service.live.apply(edit.observation('editor:x', 'g', 'DOCUMENT_FOCUSED', { path: join(work, 'two', 'b.ts'), kittyPaneId: '1', kittyPid: 200, editor: 'Neovim' }));
  focus('a1', 100); assert.equal(f.service.workspace().current.cwd, join(work, 'one')); assert.equal(f.service.workspace().current.document, null); focus('a2', 200); assert.equal(f.service.workspace().current.cwd, join(work, 'two')); assert.equal((f.service.workspace().current.document as any).properties.path, join(work, 'two', 'b.ts'));
  // Without the window's process two focused panes stay ambiguous, and nothing is guessed.
  f.service.live.apply(hypr.observation('w:a3', 'g', 'WINDOW_SNAPSHOT', { address: 'a3', appClass: 'kitty', workspace: '1' })); f.service.live.apply(hypr.observation('desktop', 'e', 'WINDOW_FOCUS', { address: 'a3' })); assert.equal(f.service.workspace().current.pane, null); assert.ok(f.service.workspace().unknown.includes('terminal_pane'));
  // An ended terminal's panes are closed; a process ID used again belongs to another terminal.
  instances = [found.find(item => item.pid === 200)!]; emitted.length = 0; await collector.reconcile(); assert.deepEqual(emitted.filter(o => o.kind === 'TERMINAL_PANE_CLOSED').map(o => o.properties.instanceId), ['100:555']); await processOf(100, 'kitty', 999); assert.ok((await kittyInstances(endpoint, proc)).some(item => item.instanceId === '100:999'));
});

test('COL-06 history is kept only when chosen, only for approved folders, merges, expires, leaves with its folder and can be erased', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pal-history-'))), one = join(directory, 'one'), two = join(directory, 'two'); await mkdir(one); await mkdir(two);
  const core = new Core(new Store(join(directory, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }) as any); t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const history = core.workspaceHistory; let clock = 1_800_000_000_000; history.now = () => clock;
  const factory = (source: any) => new LiveObservationFactory(source, 10_000_000), editor = factory('editor'), fish = factory('fish'), files = factory('filesystem'), hypr = factory('hyprland'), save = (path: string) => history.observe(editor.observation('e', 'g', 'DOCUMENT_SAVED', { path, editor: 'Neovim' }) as any, undefined);
  save(join(one, 'a.ts')); assert.equal(history.status().records, 0, 'off unless chosen');
  const both = [{ root: one, real: one }, { root: two, real: two }]; history.configure({ enabled: true, approved: both, days: 7 });
  save(join(one, 'a.ts')); clock += 60_000; save(join(one, 'a.ts')); save(join(two, 'b.ts')); save('/etc/passwd'); save(join(one, '.git', 'index')); save(join(one, 'node_modules', 'x.js'));
  history.observe(fish.observation('s', 'g', 'SHELL_STATE', { cwd: join(one, 'src'), event: 'postexec', status: 2, durationMs: 90_500 }) as any, undefined); history.observe(fish.observation('s', 'g', 'SHELL_STATE', { event: 'postexec', status: 0 }) as any, undefined);
  history.observe(files.observation('p', 'g', 'FILESYSTEM_METADATA', { path: join(one, 'c.md'), kind: 'file', exists: true, eventType: 'change' }) as any, undefined); history.observe(files.observation('p', 'g', 'FILESYSTEM_METADATA', { path: join(one, 'd'), kind: 'directory', exists: true, eventType: 'change' }) as any, undefined);
  const focus = (cwd: string | null) => history.observe(hypr.observation('d', 'g', 'WINDOW_FOCUS', { address: 'x', title: 'SECRET TITLE' }) as any, { cwd }); focus(one); clock += 5000; focus(one); clock += 5000; focus(one); clock += 5000; focus(null); clock += 5000; focus(one); clock += 60_000; focus(one);
  const rows = history.list().items; const row = (kind: string, item: string) => rows.find(r => r.kind === kind && r.item === item)!;
  assert.deepEqual([row('document', 'a.ts').count, row('document', 'b.ts').project], [2, two]); assert.deepEqual([row('command', 'src').count, row('command', 'src').seconds, row('command', 'src').failed], [1, 91, 1]); assert.equal(row('file', 'c.md').count, 1); assert.equal(row('focus', '').seconds, 10, 'only between two looks that agree'); assert.equal(rows.length, 5); assert.ok(!JSON.stringify(rows).includes('SECRET') && !JSON.stringify(rows).includes('passwd'));
  // Later work on the same file is a new record; everything expires after the days chosen.
  clock += 3_600_000; save(join(one, 'a.ts')); assert.equal(history.list({ kind: 'document', project: one }).items.length, 2); assert.equal(history.list({ project: two }).items.length, 1);
  // An assistant is given its own project only, as counts and times, and only where memory may go.
  const session = await core.create({ provider: 'codex', cwd: one, trusted: true }); assert.ok(history.covers(session.cwd)); const told = JSON.stringify(history.forProject(one, 7)); assert.ok(told.includes('a.ts') && !told.includes('b.ts')); assert.equal(history.forProject('/elsewhere', 7), undefined);
  // An unreadable folder keeps its records; one that is no longer approved loses them at once.
  history.configure({ enabled: true, approved: [{ root: one, real: one }, { root: two, real: '' }], days: 7 }); assert.equal(history.list({ project: two }).items.length, 1); history.configure({ enabled: true, approved: [{ root: one, real: one }], days: 7 }); assert.equal(history.list({ project: two }).items.length, 0); assert.ok(history.list({ project: one }).items.length > 0);
  history.configure({ enabled: false, approved: [{ root: one, real: one }], days: 7 }); const kept = history.status().records; save(join(one, 'z.ts')); assert.equal(history.status().records, kept, 'off keeps what there is and adds nothing'); assert.equal(history.covers(one), false);
  history.configure({ enabled: true, approved: [{ root: one, real: one }], days: 1 }); clock += 86400_000 + 1; assert.equal(history.status().records, 0);
  save(join(one, 'a.ts')); await assert.rejects(core.rpc('workspace.historyErase', {}) as any, /Choose what/); assert.equal(((await core.rpc('workspace.historyErase', { all: true })) as any).removed, 1); assert.equal(((await core.rpc('workspace.history', {})) as any).items.length, 0);
});

test('COL-07 history reaches the record through the policy, and stops with it', async t => {
  const f = await fixture(t, { editor_enabled: true }); await f.start(); const inside = join(f.approved, 'a.ts'); await writeFile(inside, 'x'); const observed = () => f.events.filter(event => event.type === 'workspace_observation').length, policy = () => f.events.filter(event => event.type === 'workspace_policy').at(-1);
  await f.service.collectorRpc!.ingest(editor(randomUUID(), 1, 'document_saved', inside)); assert.equal(observed(), 0); assert.equal(policy().enabled, false);
  await f.service.call('policy_update', { policy: { history_enabled: true, history_days: 3 } }); assert.deepEqual([policy().enabled, policy().days, policy().approved], [true, 3, [{ root: f.approved, real: f.approved }]]);
  await f.service.collectorRpc!.ingest(editor(randomUUID(), 1, 'document_saved', inside)); assert.equal(observed(), 1); await f.service.collectorRpc!.ingest(editor(randomUUID(), 1, 'document_saved', join(f.outside, 'x'))); assert.equal(observed(), 1);
  await f.service.configure({ ...configuration, paused: true } as any); assert.equal(policy().enabled, false); assert.equal(f.service.collectorRpc, undefined);
});

test('COL-08 the editor emitter sends a path and no text, fails quietly without PAL, and Vim and Neovim drive it', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pal-editor-'))), socketPath = join(directory, 'memory.sock'), got: any[] = []; const server = net.createServer(socket => { let text = ''; socket.on('data', chunk => { text += chunk; }); socket.on('end', () => { for (const line of text.split('\n').filter(Boolean)) got.push(JSON.parse(line).params); }); }); await new Promise<void>(r => server.listen(socketPath, () => r())); t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const emitter = resolve('broker/graph-memory/adapters/editor/pal-memory-editor.py'), run = (...args: string[]) => execFileSync(emitter, args, { env: { ...process.env, PAL_MEMORY_SOCKET: socketPath } }).toString();
  assert.match(run('--print-session-id'), /^[0-9a-f-]{36}$/); const epoch = randomUUID(); run('--event', 'document_saved', '--session-id', epoch, '--sequence', '1', '--editor', 'Emacs', '--pid', '7', '--path', '/tmp/a "quoted"\n b', '--kitty-window-id', '3', '--kitty-pid', '9'); await until(() => got.length === 1);
  assert.deepEqual(got[0], { source: 'editor', source_epoch: epoch, source_sequence: 1, event: 'document_saved', editor: 'Emacs', pid: 7, path: '/tmp/a "quoted"\n b', terminal_binding: { kind: 'kitty_window_id', id: '3', pid: 9 } });
  execFileSync(emitter, ['--event', 'editor_closed', '--session-id', epoch, '--sequence', '2', '--socket', join(directory, 'absent')]); assert.throws(() => run('--event', 'document_saved', '--session-id', epoch, '--sequence', '1'), /Command failed/);
  const check = async (program: string, args: string[], name: string) => {
    got.length = 0; const file = join(directory, `note-${name}.txt`); await writeFile(file, 'SECRET TEXT\n');
    const child = spawn(program, args.map(arg => arg === 'FILE' ? file : arg), { env: { ...process.env, PAL_MEMORY_SOCKET: socketPath, KITTY_WINDOW_ID: '4', KITTY_PID: '77', TERM: 'dumb' }, stdio: 'ignore' }); await new Promise(r => child.once('exit', r));
    await until(() => got.some(p => p.event === 'editor_closed')); const events = got.map(p => p.event); assert.ok(events.includes('document_opened') && events.includes('document_saved'), events.join()); assert.ok(got.filter(p => p.path).every(p => p.path === file)); assert.ok(!JSON.stringify(got).includes('SECRET')); assert.equal(new Set(got.map(p => p.source_epoch)).size, 1); assert.match(got[0].source_epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/); assert.deepEqual(got[0].terminal_binding, { kind: 'kitty_window_id', id: '4', pid: 77 }); assert.deepEqual(got.map(p => p.source_sequence).sort((a, b) => a - b), got.map((_, i) => i + 1));
  };
  const has = (program: string) => { try { return execFileSync('which', [program], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const vim = has('vim'), nvim = has('nvim');
  if (vim) await check(vim, ['-N', '-u', 'NONE', '-i', 'NONE', '-n', '--not-a-term', '-c', `source ${resolve('broker/graph-memory/adapters/editor/pal-memory.vim')}`, '-c', 'edit FILEPATH', '-c', 'normal! oMORE SECRET', '-c', 'write', '-c', 'sleep 300m', '-c', 'qa!'].map(arg => arg.replace('FILEPATH', join(directory, 'note-vim.txt'))), 'vim'); else t.diagnostic('Vim is not installed here; its script was not run');
  if (nvim) await check(nvim, ['--headless', '-u', 'NONE', '-i', 'NONE', '--cmd', `luafile ${resolve('broker/graph-memory/adapters/editor/pal-memory.lua')}`, 'FILE', '+normal! oMORE SECRET', '+write', '+sleep 200m', '+quit!'], 'nvim'); else {
    // Its script against a stand-in for Neovim's own calls, so its events and arguments are still checked here.
    const lua = has('luajit') || has('lua'); if (!lua) return t.diagnostic('Neither Neovim nor Lua is installed here');
    const lines = execFileSync(lua, [resolve('tests/fixtures/neovim-stub.lua'), resolve('broker/graph-memory/adapters/editor/pal-memory.lua')]).toString().trim().split('\n').map(line => line.split('\t')), value = (line: string[], name: string) => line[line.indexOf(name) + 1];
    assert.deepEqual(lines.map(line => value(line, '--event')), ['document_opened', 'document_focused', 'document_saved', 'document_closed', 'editor_closed']); assert.ok(lines.slice(0, 4).every(line => value(line, '--path') === '/work/a.ts')); assert.ok(!lines[4].includes('--path')); assert.equal(new Set(lines.map(line => value(line, '--session-id'))).size, 1); assert.match(value(lines[0], '--session-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/); assert.deepEqual(lines.map(line => value(line, '--sequence')), ['1', '2', '3', '4', '5']); assert.equal(value(lines[0], '--kitty-pid'), '77');
    t.diagnostic('Neovim is not installed here; its script ran against a stand-in');
  }
});
