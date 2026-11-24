// When things happened (PAL_Time_Awareness_Implementation_Handoff.md §13.3): anchors, queues, restarts, erasure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { humanSubmission, Temporal, timingLimits, type TurnTiming } from '../broker/temporal-context.ts';
import { TimeService, type Clock } from '../broker/time.ts';
import { eraseWorkingCopies } from '../broker/working-erasure.ts';
import type { Hooks } from '../broker/providers.ts';

class FakeClock implements Clock {
  wall: number; monotonic = 10_000; instanceId: string;
  constructor(wall: string, instanceId = 'broker-1') { this.wall = Date.parse(wall); this.instanceId = instanceId; }
  wallNowMs() { return this.wall; }
  monotonicNowMs() { return this.monotonic; }
  pass(ms: number) { this.wall += ms; this.monotonic += ms; }
}
const minute = 60_000, hour = 60 * minute;
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
async function fixture(t: any, p: { directory?: string; clock?: FakeClock; refuse?: boolean; accept?: 'now' | 'never'; keep?: boolean } = {}) {
  const directory = p.directory || await mkdtemp(join(tmpdir(), 'pal-timing-')), clock = p.clock || new FakeClock('2026-11-21T16:30:00Z');
  const hooks = new Map<string, Hooks>(), sent: string[] = [];
  const core = new Core(new Store(directory), (s, h) => { hooks.set(s.id, h); return {
    async send(text, _images, options) { if (p.refuse) throw new Error('refused before dispatch'); options?.beforeAccept?.(); options?.onDispatched?.(); sent.push(text); if (p.accept !== 'never') { options?.onAccepted?.(); options?.acknowledged?.(); } },
    async interrupt() { h.event({ type: 'interrupted' }); }, async close() {} }; });
  core.temporal = new Temporal(core, new TimeService(clock, () => 'America/New_York'));
  if (p.directory) for (const s of core.store.sessions()) core.temporal.recover(s.id);
  t.after(async () => { await core.close(); if (!p.keep) await rm(directory, { recursive: true, force: true }); });
  core.capabilities.ollama = { modelsStatus: 'ready', models: [{ id: 'fixture', displayName: 'Fixture', description: '', efforts: [], defaultEffort: '', isDefault: true }] };
  await core.updateSettings({ memory: { enabled: false } });
  const session = p.directory ? core.store.sessions()[0] : await core.create({ provider: 'ollama', cwd: directory, model: 'fixture', tools: false });
  const finish = (reply?: string, id = session.id) => { const h = hooks.get(id)!; if (reply) h.event({ type: 'message', id: 'reply-' + sent.length, text: reply }); h.event({ type: 'complete' }); };
  const elapsed = (anchor: string, messageId?: string, id = session.id) => core.rpc('time.elapsed', { sessionId: id, anchor, ...(messageId ? { messageId } : {}) });
  return { core, clock, directory, hooks, sent, session, finish, elapsed, turn: () => core.temporal.history(session.id).at(-1)!, rows: () => core.store.messages(session.id) };
}

test('E01 “since my last message” measures from the message before the current one', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'first' }); f.clock.pass(2 * minute); f.finish('reply one');
  f.clock.pass(43 * minute);
  await f.core.send({ id: f.session.id, text: 'How long since my last message?' });
  const during = await f.elapsed('previous_user_message');
  assert.deepEqual([during.status, during.durationMs, during.basis, during.includesInactivity], ['available', 45 * minute, 'wall-clock-estimate', true]);
  assert.match(during.anchor, /before the current one/);
  assert.equal(during.anchorId, f.rows().find(m => m.role === 'user')!.id);
  f.clock.pass(minute);
  assert.equal((await f.elapsed('previous_user_message')).durationMs, 46 * minute, 'a live query ends now; the submission gap does not move');
  assert.equal((await f.elapsed('previous_assistant_reply')).durationMs, 44 * minute, 'measured from when that reply finished');
});

test('E02 answers, tool results, deltas, notices and settings are not messages from the person', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'first' }); f.clock.pass(10 * minute);
  const asked = f.core.approval(f.session.id, { kind: 'question', title: 'Which?', detail: '', choices: ['answer'], questions: [{ id: 'q', question: 'Which?', allowOther: true }] });
  f.core.answer({ id: [...f.core.approvals.keys()][0], choice: 'answer', answers: { q: { answers: ['the second'] } } }); await asked;
  f.hooks.get(f.session.id)!.event({ type: 'tool', id: 'tool', text: 'read' }); f.hooks.get(f.session.id)!.event({ type: 'delta', id: 'd', text: 'part' });
  await f.core.updateSettings({ quiet: true }); f.core.panel('ui', true); f.core.panel('ui', false); f.core.draft(f.session.id, 'half a thought');
  f.finish('done'); f.clock.pass(5 * minute);
  await f.core.send({ id: f.session.id, text: 'second' });
  assert.equal((await f.elapsed('previous_user_message')).durationMs, 15 * minute);
  for (const message of f.rows()) if (message.kind === 'answer') assert.equal(humanSubmission(message), false);
});

test('E03 a delegation update and a scheduled run get a fresh time, their own origin, and change no human anchor', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'person' }); f.finish('reply'); f.clock.pass(30 * minute);
  await f.core.sendTurn({ id: f.session.id, text: 'update body', turnId: crypto.randomUUID(), delegation: { pingIds: [], summary: 'Codex finished' } });
  const update = f.rows().find(m => m.kind === 'delegation')!;
  assert.equal(update.timing!.origin, 'broker'); assert.equal(humanSubmission(update), false);
  const since = await f.elapsed('previous_user_message');
  assert.equal(since.durationMs, 30 * minute); assert.match(since.anchor, /automatic turn/);
  f.finish('reported'); f.clock.pass(10 * minute);
  await f.core.send({ id: f.session.id, text: 'routine prompt' }, { schedule: 'Asia/Tokyo' });
  const routine = f.rows().filter(m => m.role === 'user').at(-1)!;
  assert.deepEqual([routine.timing!.origin, routine.timing!.referenceTimeZone, routine.timing!.zoneSource], ['broker', 'Asia/Tokyo', 'schedule']);
  f.finish('ran'); f.clock.pass(minute);
  await f.core.send({ id: f.session.id, text: 'person again' });
  assert.equal((await f.elapsed('previous_user_message')).durationMs, 41 * minute, 'measured from the person, past both automatic turns');
});

test('E03 a client cannot pass its own reception time, origin or automatic marker', async t => {
  const f = await fixture(t);
  await f.core.rpc('session.send', { id: f.session.id, text: 'forged', timing: { receivedAtMs: 1, referenceTimeZone: 'UTC', zoneSource: 'schedule', origin: 'broker', timestampKind: 'broker-received' }, clientContext: { timeZone: 'Asia/Tokyo' } });
  const row = f.rows().find(m => m.role === 'user')!;
  assert.deepEqual([row.timing!.receivedAtMs, row.timing!.origin, row.timing!.referenceTimeZone], [f.clock.wall, 'human-desktop', 'America/New_York']);
});

test('E04 a message queued before midnight keeps its own “tomorrow” when it runs after', async t => {
  const f = await fixture(t, { clock: new FakeClock('2026-11-22T04:57:00Z') });
  await f.core.send({ id: f.session.id, text: 'first' }); f.clock.pass(minute);
  assert.equal((await f.core.send({ id: f.session.id, text: 'tomorrow morning, please' }) as any).queued, true);
  f.clock.pass(5 * minute); f.finish('reply'); await tick();
  assert.deepEqual(f.sent.length, 2);
  const request = f.core.temporal.request(f.session.id)!;
  assert.match(request.text, /message_received_at_utc: 2026-11-22T04:58:00\.000Z/); assert.match(request.text, /message_reference_date: 2026-11-21/);
  assert.match(request.text, /local_datetime: 2026-11-22T00:03:00-05:00/, 'now is told as now');
  const row = f.rows().find(m => m.text === 'tomorrow morning, please')!;
  assert.equal(row.timing!.receivedAtMs, Date.parse('2026-11-22T04:58:00Z'));
});

test('E05 several queued messages: each turn’s predecessor is its own, never a later one', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'one' }); f.clock.pass(minute); await f.core.send({ id: f.session.id, text: 'two' }); f.clock.pass(minute); await f.core.send({ id: f.session.id, text: 'three' }); f.clock.pass(minute);
  f.finish('reply one'); await tick();
  const text = (id: string) => f.rows().find(m => m.id === id)!.text;
  let running = await f.elapsed('previous_user_message');
  assert.equal(text(running.anchorId), 'one'); assert.equal(running.durationMs, 3 * minute);
  f.clock.pass(minute); f.finish('reply two'); await tick();
  running = await f.elapsed('previous_user_message');
  assert.equal(text(running.anchorId), 'two'); assert.equal(running.durationMs, 3 * minute);
  const replied = await f.elapsed('previous_assistant_reply');
  assert.equal(text(replied.anchorId), 'reply two'); assert.equal(replied.durationMs, 0);
});

test('E06 refusals, uncertain turns and cancelled queue entries claim nothing that did not happen', async t => {
  const refused = await fixture(t, { refuse: true });
  await assert.rejects(refused.core.send({ id: refused.session.id, text: 'never leaves' }));
  const turn = refused.turn();
  assert.deepEqual([turn.outcome, turn.firstDispatchedAtMs, turn.providerAcceptedAtMs, turn.completedAtMs], ['failed', undefined, undefined, undefined]);
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'first' }); f.clock.pass(minute); await f.core.send({ id: f.session.id, text: 'cancel me' });
  await f.core.stop(f.session.id); await tick();
  assert.equal(f.turn().outcome, 'interrupted'); assert.equal(f.turn().completedAtMs, undefined);
  f.clock.pass(10 * minute); await f.core.send({ id: f.session.id, text: 'after' });
  const since = await f.elapsed('previous_user_message');
  assert.equal(f.rows().find(m => m.id === since.anchorId)!.text, 'first', 'a cancelled message is not the last interaction');
  // A submission that fails validation never becomes one either.
  f.finish('ok'); const before = f.rows().length;
  await assert.rejects(f.core.send({ id: f.session.id, text: '' })); await assert.rejects(f.core.send({ id: f.session.id, text: 'x', posture: 'posture:unknown' }));
  assert.equal(f.rows().length, before); assert.equal(f.turn().outcome, 'completed');
});

test('E07 a streamed reply’s finish is not its first words, and an older reply says its finish is unknown', async t => {
  const f = await fixture(t);
  f.core.store.message({ id: 'legacy', sessionId: f.session.id, role: 'assistant', text: 'From before time was recorded.', time: f.clock.wall - hour });
  const legacy = await f.elapsed('previous_assistant_reply');
  assert.deepEqual([legacy.status, legacy.durationMs], ['available', hour]); assert.match(legacy.anchor, /When it finished was not recorded/);
  await f.core.send({ id: f.session.id, text: 'go' }); f.clock.pass(3_000);
  f.hooks.get(f.session.id)!.event({ type: 'delta', id: 'r', text: 'Starting' }); f.clock.pass(4 * minute);
  f.hooks.get(f.session.id)!.event({ type: 'message', id: 'r', text: 'Starting … done' }); f.hooks.get(f.session.id)!.event({ type: 'complete' });
  const turn = f.turn();
  assert.deepEqual([turn.firstOutputAtMs! - turn.receivedAtMs, turn.completedAtMs! - turn.firstOutputAtMs!], [3_000, 4 * minute]);
  f.clock.pass(minute); assert.equal((await f.elapsed('previous_assistant_reply')).durationMs, minute);
  const live = await f.elapsed('message', f.rows().at(-1)!.id);
  assert.match(live.anchor, /finishing time was not recorded/, 'a reply row’s own time is when it began');
});

test('the current turn is timed from its first dispatch, excludes the queue, and is unknown before it leaves', async t => {
  const f = await fixture(t);
  assert.equal((await f.elapsed('current_turn')).status, 'unknown');
  await f.core.send({ id: f.session.id, text: 'first' }); f.clock.pass(2 * minute);
  const running = await f.elapsed('current_turn');
  assert.deepEqual([running.durationMs, running.basis, running.includesSuspend], [2 * minute, 'process-monotonic', null]);
  await f.core.send({ id: f.session.id, text: 'queued' }); f.clock.pass(hour); f.finish('r'); await tick(); f.clock.pass(30_000);
  assert.equal((await f.elapsed('current_turn')).durationMs, 30_000);
});

test('E08 a temporary conversation leaves no timing behind', async t => {
  const f = await fixture(t), temporary = await f.core.create({ provider: 'ollama', cwd: f.directory, model: 'fixture', tools: false, temporary: true });
  await f.core.send({ id: temporary.id, text: 'secret' }); f.finish('reply', temporary.id);
  assert.equal(f.core.temporal.history(temporary.id).length, 1);
  assert.equal(Number(f.core.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'temporal%'").get()!.n), 0, 'nothing reached the saved database');
  await f.core.rpc('session.discardTemporary', { id: temporary.id });
  assert.equal(f.core.store.get('temporal:' + temporary.id, null), null); assert.equal(Number(f.core.store.volatile.prepare('SELECT count(*) AS n FROM meta').get()!.n), 0);
});

test('E09 a branch begins its own conversation; its history is not freshly received', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'old' }); f.finish('reply'); f.clock.pass(3 * hour);
  const branch = await f.core.rpc('session.branch', { id: f.session.id, text: 'Reviewed context', provider: 'ollama', model: 'fixture' });
  assert.equal((await f.elapsed('previous_user_message', undefined, branch.id)).status, 'unknown');
  assert.equal(f.core.temporal.history(branch.id).length, 0);
  f.core.store.message({ id: 'imported', sessionId: branch.id, role: 'user', text: 'From elsewhere', time: 0 });
  const imported = await f.elapsed('previous_user_message', undefined, branch.id);
  assert.match(imported.anchor + imported.status, /available|unknown|inconsistent/);
  assert.equal(f.core.store.messageById('imported')!.timing, undefined, 'no reception time is invented for an imported row');
});

test('E10 forgetting a message, or deleting its conversation, takes its times at once', async t => {
  const f = await fixture(t);
  await f.core.send({ id: f.session.id, text: 'a private plan' }); f.finish('noted'); f.clock.pass(hour);
  await f.core.send({ id: f.session.id, text: 'something else' });
  const first = (await f.elapsed('previous_user_message')).anchorId;
  // What an erasure does inside its transaction: scrub the row, drop its time, and tell the clock.
  const row = f.core.store.messageById(first)!; row.text = '[Content removed by memory erasure]'; delete row.timing; f.core.store.message(row);
  eraseWorkingCopies(f.core.store, f.core.store.session(f.session.id), Object.assign((text: string) => text.includes('a private plan'), { identifies: (id: unknown) => id === first }));
  f.core.temporal.erase(f.session.id, new Set([first]));
  assert.equal((await f.elapsed('previous_user_message')).status, 'unknown'); assert.equal((await f.elapsed('message', first)).status, 'unknown');
  assert.doesNotMatch(f.core.temporal.request(f.session.id)!.text, /previous_human_message/);
  assert.ok(f.core.temporal.history(f.session.id).every(turn => turn.userMessageId !== first && turn.previousHumanMessageId !== first));
  f.finish('ok');
  await f.core.rpc('session.delete', { id: f.session.id, confirmed: true });
  for (const key of ['temporal:', 'temporal-active:']) assert.equal(f.core.store.get(key + f.session.id, null), null);
  await assert.rejects(f.elapsed('session_created'));
});

test('E11 after a restart recorded times remain, process readings do not, and a running turn’s end stays unknown', async t => {
  const first = await fixture(t, { keep: true });
  await first.core.send({ id: first.session.id, text: 'one' }); first.finish('reply'); first.clock.pass(minute);
  await first.core.send({ id: first.session.id, text: 'two' });
  first.core.store.db.exec('PRAGMA wal_checkpoint(FULL)');
  const clock = new FakeClock('2026-11-21T18:31:00Z', 'broker-2'); clock.monotonic = 12;
  const second = await fixture(t, { directory: first.directory, clock });
  const history = second.core.temporal.history(second.session.id);
  assert.deepEqual(history.map(turn => turn.outcome), ['completed', 'uncertain']); assert.equal(history[1].completedAtMs, undefined);
  assert.equal(second.sent.length, 0, 'nothing is sent again');
  const since = await second.elapsed('previous_assistant_reply');
  assert.deepEqual([since.basis, since.durationMs], ['wall-clock-estimate', 2 * hour + minute]);
  assert.doesNotMatch(JSON.stringify(second.core.store.db.prepare("SELECT value FROM meta WHERE key LIKE 'temporal%'").all()), /monotonic|instanceId|broker-1/);
});

test('E12 the record is bounded, keeps the newest, and never reorders the transcript', async t => {
  const f = await fixture(t), old: TurnTiming[] = Array.from({ length: timingLimits.turns }, (_, index) => ({ schema: 1, sessionId: f.session.id, turnId: 'turn-' + index, origin: 'human-desktop', receivedAtMs: index, referenceTimeZone: 'UTC', zoneSource: 'broker-system', outcome: 'completed' }));
  f.core.store.set('temporal:' + f.session.id, { schema: 1, turns: old });
  const before = f.rows().map(m => m.id);
  await f.core.send({ id: f.session.id, text: 'newest' }); f.finish('r');
  const history = f.core.temporal.history(f.session.id);
  assert.equal(history.length, timingLimits.turns); assert.equal(history[0].turnId, 'turn-1'); assert.equal(history.at(-1)!.outcome, 'completed');
  assert.deepEqual(f.rows().map(m => m.id).slice(0, before.length), before);
  f.core.store.set('temporal:' + f.session.id, { schema: 99, turns: 'unreadable' });
  assert.deepEqual(f.core.temporal.history(f.session.id), [], 'a record from a newer build is ignored, not an error');
  await f.core.send({ id: f.session.id, text: 'still works' });
});

test('E14 timing needs no diagnostics, and off means no new detailed record while messages keep their date', async t => {
  const f = await fixture(t);
  assert.equal(f.core.spans.enabled, false);
  await f.core.updateSettings({ time: { conversationTiming: false } });
  await f.core.send({ id: f.session.id, text: 'quietly' }); 
  assert.match(f.core.temporal.request(f.session.id)!.text, /message_reference_date: 2026-11-21/, '“tomorrow” can still be read');
  f.finish('r'); f.clock.pass(minute); await f.core.send({ id: f.session.id, text: 'again' });
  assert.doesNotMatch(f.core.temporal.request(f.session.id)!.text, /previous_human|gap_between/);
  assert.equal(f.core.store.get('temporal:' + f.session.id, null), null); assert.equal(f.core.store.get('temporal-active:' + f.session.id, null), null);
  f.finish('r2'); await f.core.updateSettings({ time: { enabled: false } });
  await f.core.send({ id: f.session.id, text: 'no clock' });
  assert.equal(f.rows().find(m => m.text === 'no clock')!.timing, undefined); assert.equal(f.core.temporal.request(f.session.id), undefined);
});

test('a conversation of another project is never acknowledged through a message anchor', async t => {
  const f = await fixture(t), other = await f.core.create({ provider: 'ollama', cwd: f.directory, model: 'fixture', tools: false });
  await f.core.send({ id: other.id, text: 'elsewhere' });
  const id = f.core.store.messages(other.id)[0].id, foreign = await f.elapsed('message', id), missing = await f.elapsed('message', 'no-such-message');
  for (const result of [foreign, missing]) { assert.equal(result.status, 'unknown'); assert.equal(result.fromMs, undefined); }
  assert.deepEqual({ ...foreign, toMs: 0 }, { ...missing, toMs: 0 }, 'indistinguishable from a message that does not exist');
});

test('existing profiles: no time settings, no timing, no zone — nothing is backfilled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-time-old-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  store.set('settings', { quiet: true });
  store.saveSession({ id: 'old', provider: 'codex', nativeId: 'native', title: 'Old', cwd: directory, mode: 'managed', status: 'idle', created: 5, updated: 5, draft: '', scroll: 0, model: '' });
  store.message({ id: 'm', sessionId: 'old', role: 'user', text: 'hello', time: 7 });
  const raw = JSON.stringify(store.db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(store.db.prepare('SELECT * FROM messages').all());
  assert.deepEqual(store.settings().time, { enabled: true, zoneMode: 'automatic', fixedZone: null, conversationTiming: true, clockFormat: 'system' });
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(store.db.prepare('SELECT * FROM messages').all()), raw); store.close();
});
