// PAL Everywhere §17.1 (SCH-01, SCH-02): routines run on folder changes (coalesced, once per quiet period, never
// during a run), a missed time can run once late when the routine asks for it, and a routine remembers which phone
// authorized it: revoking that phone pauses it and names it, the desktop can take over its authorization first, and
// another owner can resume it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { validWhen } from '../broker/schedules.ts';

async function broker(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'pal-routines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  let finish = true;
  const core = new Core(new Store(join(dir, 'state')), (_session, h) => ({
    async send(text: string) { sent.push(text); if (finish) { setTimeout(() => h.event({ type: 'message', id: 'reply', text: 'Done.' }), 5); setTimeout(() => h.event({ type: 'complete' }), 10); } },
    async interrupt() { h.event({ type: 'interrupted' }); }, async close() {},
  }));
  t.after(() => core.close());
  const project = join(dir, 'project'); await mkdir(join(project, 'inbox'), { recursive: true });
  const source = await core.create({ provider: 'codex', cwd: project, trusted: true });
  const preview = async () => (await core.workflows.dispatch('recipes.prepare', { sessionId: source.id, recipeId: 'review-plan', inputs: { plan: 'Check the new files' } })) as any;
  return { core, dir, project, source, sent, preview, hold: () => { finish = false; }, release: () => { finish = true; } };
}
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

test('a folder routine runs once after changes settle, with the changed names as data, and waits for a running run', async t => {
  const f = await broker(t);
  assert.throws(() => validWhen({ kind: 'folder', path: 'relative' }), /folder to watch/);
  assert.throws(() => validWhen({ kind: 'folder', path: '/x', quietSeconds: 1 }), /5 seconds/);
  await assert.rejects(f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'Home', when: { kind: 'folder', path: homedir() }, unattended: true }), /home folder/);
  await assert.rejects(f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'Elsewhere', when: { kind: 'folder', path: f.dir }, unattended: true }), /project folder/);
  const routine = await f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'New files', when: { kind: 'folder', path: join(f.project, 'inbox'), quietSeconds: 5 }, unattended: true });
  assert.equal(routine.next, undefined); assert.deepEqual(routine.authorizedBy, { kind: 'desktop' });
  // A real change reaches the watcher; repeated events for one name coalesce; ignored folders never trigger.
  await writeFile(join(f.project, 'inbox', 'a.csv'), '1,2\n');
  const start = Date.now();
  for (let i = 0; i < 100 && !f.core.schedules.list()[0].pending; i++) await settle(20);
  f.core.schedules.observe(routine.id, 'a.csv'); f.core.schedules.observe(routine.id, 'b.csv'); f.core.schedules.observe(routine.id, '.git/index');
  assert.deepEqual(f.core.schedules.list()[0].pending!.names, ['a.csv', 'b.csv']);
  await f.core.schedules.tick(start + 1000);
  assert.equal(f.sent.length, 0, 'not before the folder has been quiet for the quiet period');
  await f.core.schedules.tick(Date.now() + 6000);
  await settle(60);
  assert.equal(f.sent.length, 1, JSON.stringify(f.core.schedules.list()[0]));
  assert.match(f.sent[0], /Pinned recipe/); assert.match(f.sent[0], /started by changes in .*inbox/); assert.match(f.sent[0], /- a\.csv\n- b\.csv/);
  assert.equal(f.core.schedules.list()[0].pending, undefined);
  await f.core.schedules.tick(Date.now() + 60_000);
  assert.equal(f.sent.length, 1, 'no change, no run');
  // Changes during a run wait for it and then run once.
  f.hold();
  f.core.schedules.observe(routine.id, 'c.csv');
  await f.core.schedules.tick(Date.now() + 6000); await settle(60);
  assert.equal(f.sent.length, 2);
  f.core.schedules.observe(routine.id, 'd.csv'); f.core.schedules.observe(routine.id, 'e.csv');
  await f.core.schedules.tick(Date.now() + 6000);
  assert.equal(f.sent.length, 2, 'the previous run is still working');
  assert.deepEqual(f.core.schedules.list()[0].pending!.names, ['d.csv', 'e.csv'], 'the changes are kept, not dropped');
  const running = f.core.store.session(f.core.schedules.list()[0].lastRun!.sessionId!);
  f.core.updateSession(running.id, { status: 'idle' });
  await f.core.schedules.tick(Date.now() + 6000); await settle(60);
  assert.equal(f.sent.length, 3); assert.match(f.sent[2], /- d\.csv\n- e\.csv/);
});

test('a missed time is reported, or run once late when the routine asks for it', async t => {
  const f = await broker(t);
  const skip = await f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'Skip', when: { kind: 'daily', time: '08:00' }, unattended: true });
  const late = await f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'Late', when: { kind: 'daily', time: '08:00' }, unattended: true, missed: 'once' });
  await assert.rejects(f.core.rpc('schedules.create', { previewToken: (await f.preview()).token, label: 'Bad', when: { kind: 'daily', time: '08:00' }, unattended: true, missed: 'always' }), /missed run/);
  // Three days later: one late run, not three.
  await f.core.schedules.tick(late.next + 3 * 86_400_000 + 60_000); await settle(60);
  const rows = f.core.schedules.list();
  assert.equal(rows.find(row => row.id === skip.id)!.lastRun!.outcome, 'missed');
  const caught = rows.find(row => row.id === late.id)!;
  assert.equal(caught.lastRun!.outcome, 'started'); assert.equal(caught.lastRun!.caughtUp, true);
  assert.equal(f.sent.length, 1);
  assert.ok(caught.next! > late.next + 3 * 86_400_000, 'the next run is after now');
});

test('revoking the phone that authorized a routine pauses it and names it; the desktop can take it over or resume it', async t => {
  const f = await broker(t);
  const phone = { kind: 'device' as const, deviceId: '6a0f3c52-2c55-4a77-9f0e-0b8d1f1f2a10', name: 'Pixel' };
  const first = f.core.schedules.create({ previewToken: (await f.preview()).token, label: 'From phone', when: { kind: 'daily', time: '08:00' }, unattended: true }, phone);
  const adopted = f.core.schedules.create({ previewToken: (await f.preview()).token, label: 'Adopted', when: { kind: 'daily', time: '09:00' }, unattended: true }, phone);
  const local = f.core.schedules.create({ previewToken: (await f.preview()).token, label: 'Desktop', when: { kind: 'daily', time: '10:00' }, unattended: true });
  await f.core.rpc('schedules.adopt', { id: adopted.id });
  // An ordinary disconnection changes nothing; revocation pauses only what that phone still authorizes.
  const paused = f.core.schedules.deviceRevoked(phone.deviceId);
  assert.deepEqual(paused, [{ id: first.id, label: 'From phone' }]);
  const rows = Object.fromEntries(f.core.schedules.list().map(row => [row.id, row]));
  assert.equal(rows[first.id].enabled, false); assert.equal(rows[first.id].pausedFor, 'authorizer-revoked'); assert.match(rows[first.id].lastRun!.reason!, /Pixel.*removed/);
  assert.equal(rows[adopted.id].enabled, true); assert.equal(rows[local.id].enabled, true);
  await assert.rejects(f.core.rpc('schedules.adopt', { id: first.id }), /Resume this schedule/);
  // The desktop (another authorized owner) reviews and resumes it, and becomes its authorizer.
  const resumed = await f.core.rpc('schedules.setEnabled', { id: first.id, enabled: true });
  assert.equal(resumed.enabled, true); assert.deepEqual(resumed.authorizedBy, { kind: 'desktop' }); assert.equal(resumed.pausedFor, undefined);
  // A schedule paused because its definition changed still needs a new review.
  f.core.schedules.deviceRevoked(phone.deviceId);
  await f.core.updateSettings({ bypassCliPermissions: !f.core.settings.bypassCliPermissions });
  await f.core.schedules.tick(rows[local.id].next! + 1000);
  const changed = f.core.schedules.list().find(row => row.id === local.id)!;
  assert.equal(changed.lastRun!.outcome, 'paused');
  await assert.rejects(f.core.rpc('schedules.setEnabled', { id: local.id, enabled: true }), /Review the recipe again/);
});
