// The clock service (PAL_Time_Awareness_Implementation_Handoff.md §13.1). Wall and monotonic clocks are
// fake and move independently; nothing here waits, reads the network or changes the process's own zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTimeSettings, detectSystemZone, knownZone, localTime, msToUs, offsetLabel, storedTimeSettings, TimeService, usToMs, validTimeSettings, zoneNames, type Clock, type TimeSettings } from '../broker/time.ts';

class FakeClock implements Clock {
  wall: number; monotonic = 5_000; instanceId: string; reads = 0;
  constructor(wall: string | number, instanceId = 'broker-1') { this.wall = typeof wall === 'number' ? wall : Date.parse(wall); this.instanceId = instanceId; }
  wallNowMs() { this.reads++; return this.wall; }
  monotonicNowMs() { return this.monotonic; }
  pass(ms: number) { this.wall += ms; this.monotonic += ms; }
}
const automatic: TimeSettings = { ...defaultTimeSettings };
const service = (clock: Clock, zone: string | undefined = 'America/New_York') => new TimeService(clock, () => zone);
const iso = (value: string) => Date.parse(value);

test('C01–C04 one instant in four zones, including a date line and a 45-minute offset', () => {
  const winter = localTime(iso('2026-11-21T16:30:00Z'), 'America/New_York');
  assert.deepEqual([winter.weekday, winter.date, winter.time, winter.offsetSeconds, winter.iso], ['Saturday', '2026-11-21', '11:30:00', -18000, '2026-11-21T11:30:00-05:00']);
  assert.equal(localTime(iso('2026-11-22T02:30:00Z'), 'America/New_York').date, '2026-11-21', 'UTC is already tomorrow; the local date is not');
  const nepal = localTime(iso('2026-11-21T16:30:00Z'), 'Asia/Kathmandu');
  assert.deepEqual([nepal.time, nepal.offsetSeconds], ['22:15:00', 20700]);
  const kiribati = localTime(iso('2026-11-21T16:30:00Z'), 'Pacific/Kiritimati');
  assert.deepEqual([kiribati.weekday, kiribati.iso], ['Sunday', '2026-11-22T06:30:00+14:00']);
});

test('C05–C06 daylight saving: the skipped hour and the repeated one keep their own offsets and true lengths', () => {
  const before = iso('2026-03-08T06:59:59Z'), after = iso('2026-03-08T07:00:00Z');
  assert.equal(localTime(before, 'America/New_York').iso, '2026-03-08T01:59:59-05:00');
  assert.equal(localTime(after, 'America/New_York').iso, '2026-03-08T03:00:00-04:00');
  assert.equal(after - before, 1000);
  const first = iso('2026-11-01T05:30:00Z'), second = iso('2026-11-01T06:30:00Z');
  assert.deepEqual([localTime(first, 'America/New_York'), localTime(second, 'America/New_York')].map(local => [local.time, local.offsetSeconds]), [['01:30:00', -14400], ['01:30:00', -18000]]);
  const clock = new FakeClock(second), elapsed = service(clock).sinceWall('message', first);
  assert.equal(elapsed.durationMs, 3600_000, 'the repeated wall-clock hour is one hour long');
});

test('C07 every field of a snapshot comes from one captured instant, even at midnight', () => {
  const clock = new FakeClock('2026-11-22T04:59:59.999Z');
  // A clock that ticks over midnight on every read would mix two days if fields were read separately.
  clock.wallNowMs = () => { const value = clock.wall; clock.wall += 1; clock.reads++; return value; };
  const made = service(clock); clock.reads = 0;
  const snapshot = made.snapshot({ zone: 'America/New_York', source: 'broker-system' });
  assert.equal(clock.reads, 1);
  assert.deepEqual([snapshot.localDate, snapshot.weekday, snapshot.localTime], snapshot.sampledAtMs < iso('2026-11-22T05:00:00Z') ? ['2026-11-21', 'Saturday', '23:59:59'] : ['2026-11-22', 'Sunday', '00:00:00']);
  assert.equal(snapshot.utcIso, new Date(snapshot.sampledAtMs).toISOString());
  assert.equal(snapshot.localIso.slice(0, 10), snapshot.localDate);
});

test('C08 zones and instants are validated by the runtime; an unusable automatic zone is labelled UTC, not local', () => {
  for (const bad of ['', 'Nowhere/Bad', '+05:30', 'UTC+5', 'America/New York', 'x'.repeat(200), 'a\u0000b', 42, null, undefined, {}]) assert.equal(knownZone(bad), undefined, String(bad));
  assert.equal(knownZone('america/new_york'), 'America/New_York');
  assert.equal(knownZone('utc'), 'UTC');
  assert.equal(knownZone('Asia/Kathmandu'), 'Asia/Kathmandu', 'a supported alias keeps its current spelling');
  assert.equal(knownZone('asia/kathmandu'), 'Asia/Kathmandu');
  for (const bad of [Number.NaN, Infinity, -1, 1.5, 8.65e15, 253402300800000]) assert.throws(() => localTime(bad, 'UTC'));
  const made = new TimeService(new FakeClock('2026-11-21T16:30:00Z'), () => undefined);
  assert.deepEqual(made.zone({ settings: automatic }), { zone: 'UTC', source: 'utc-fallback', reason: 'system_zone_unavailable' });
  const local = service(new FakeClock('2026-11-21T16:30:00Z'));
  assert.deepEqual(local.zone({ settings: automatic, device: 'Mars/Olympus' }), { zone: 'America/New_York', source: 'broker-system', reason: 'device_zone_unsupported' });
  assert.throws(() => validTimeSettings({ zoneMode: 'fixed', fixedZone: 'Nowhere/Bad' }, automatic), /Choose a time zone by its name/);
  assert.throws(() => validTimeSettings({ zoneMode: 'fixed' }, automatic), /Choose the fixed time zone/);
  assert.throws(() => validTimeSettings({ enabled: 'yes' }, automatic)); assert.throws(() => validTimeSettings({ zone: 'UTC' }, automatic)); assert.throws(() => validTimeSettings([], automatic));
  assert.equal(validTimeSettings({ zoneMode: 'fixed', fixedZone: 'utc' }, automatic).fixedZone, 'UTC');
});

test('settings from any earlier or partly written profile get independent defaults, and an unusable fixed zone becomes automatic', () => {
  assert.deepEqual(storedTimeSettings(undefined), defaultTimeSettings);
  assert.deepEqual(storedTimeSettings({ conversationTiming: false }), { ...defaultTimeSettings, conversationTiming: false });
  assert.deepEqual(storedTimeSettings({ enabled: 'yes', zoneMode: 'fixed', fixedZone: 'Nowhere/Bad', clockFormat: '13h' }), defaultTimeSettings);
  assert.deepEqual(storedTimeSettings('corrupt'), defaultTimeSettings);
});

test('C09 a system zone change is seen at the next read without touching the process zone', () => {
  const clock = new FakeClock('2026-11-21T16:30:00Z'); let zone = 'America/New_York';
  const made = new TimeService(clock, () => zone), tz = process.env.TZ, runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(made.zone({ settings: automatic }).zone, 'America/New_York');
  const revision = made.clockRevision; zone = 'Asia/Tokyo';
  assert.deepEqual(made.zone({ settings: automatic }), { zone: 'Asia/Tokyo', source: 'broker-system' });
  assert.ok(made.clockRevision > revision, 'a display anchored to the old zone starts over');
  assert.equal(process.env.TZ, tz); assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, runtime);
  assert.ok(knownZone(detectSystemZone()), 'this computer’s own zone is a zone');
});

test('C10 a backward correction is visible and never becomes a positive duration', () => {
  const clock = new FakeClock('2026-11-21T16:30:00Z'), made = service(clock);
  const choice = { zone: 'UTC', source: 'broker-system' as const };
  const anchor = made.snapshot(choice).sampledAtMs, revision = made.clockRevision;
  const at = { instanceId: clock.instanceId, monotonic: clock.monotonic };
  clock.pass(60_000); clock.wall -= 3600_000;
  const after = made.snapshot(choice);
  assert.equal(after.clockStatus, 'discontinuity-observed'); assert.equal(made.clockRevision, revision + 1);
  assert.equal(made.sinceWall('message', anchor, { at }).status, 'inconsistent');
  // Long after, when wall time has passed the anchor again, the difference still means nothing.
  clock.pass(2 * 3600_000);
  const later = made.sinceWall('message', anchor, { at });
  assert.deepEqual([later.status, later.reason, later.durationMs], ['inconsistent', 'clock_moved_backward', undefined]);
  // Something recorded after the correction is fine, by its process reading and once its wall time is past the repeat.
  const fresh = made.read(), freshAt = { instanceId: clock.instanceId, monotonic: fresh.monotonic };
  clock.pass(90_000);
  assert.deepEqual([made.sinceWall('message', fresh.wall, { at: freshAt }).durationMs, made.sinceWall('message', fresh.wall).status], [90_000, 'available']);
  clock.pass(16 * 60_000);
  assert.equal(made.snapshot(choice).clockStatus, 'normal', 'the notice does not stay for ever');
});

test('C11 a process reading from an earlier broker is never used as a clock', () => {
  const clock = new FakeClock('2026-11-21T16:30:00Z', 'broker-2'), made = service(clock);
  const elapsed = made.sinceMonotonic('current_turn', { instanceId: 'broker-1', monotonic: 4_999, wall: clock.wall - 120_000 });
  assert.deepEqual([elapsed.basis, elapsed.durationMs], ['wall-clock-estimate', 120_000]);
  const same = made.sinceMonotonic('current_turn', { instanceId: 'broker-2', monotonic: clock.monotonic - 1500, wall: clock.wall - 1500 });
  assert.deepEqual([same.basis, same.durationMs, same.includesSuspend], ['process-monotonic', 1500, null]);
  assert.equal(made.sinceMonotonic('current_turn', { instanceId: 'broker-2', monotonic: clock.monotonic + 10, wall: 0 }).status, 'inconsistent');
});

test('C12 a suspend-like jump is disclosed, with no claim about sleep or active work', () => {
  const clock = new FakeClock('2026-11-21T16:30:00Z'), made = service(clock), anchor = made.read().wall;
  clock.wall += 8 * 3600_000; clock.monotonic += 1_000;
  const elapsed = made.sinceWall('previous_user_message', anchor);
  assert.deepEqual([elapsed.status, elapsed.basis, elapsed.durationMs, elapsed.includesInactivity, elapsed.includesSuspend, elapsed.reason],
    ['available', 'wall-clock-estimate', 8 * 3600_000, true, null, 'clock_jump_or_sleep_during_interval']);
  // Ordinary scheduling jitter is not a jump.
  clock.wall += 11_500; clock.monotonic += 10_000; const revision = made.clockRevision;
  made.read(); assert.equal(made.clockRevision, revision);
});

test('unknown, future and unusable anchors say so instead of returning zero', () => {
  const clock = new FakeClock('2026-11-21T16:30:00Z'), made = service(clock);
  for (const from of [undefined, Number.NaN, -5]) assert.deepEqual([made.sinceWall('message', from as any).status, made.sinceWall('message', from as any).durationMs], ['unknown', undefined]);
  const ahead = made.sinceWall('message', clock.wall + 600_000);
  assert.deepEqual([ahead.status, ahead.reason, ahead.durationMs], ['inconsistent', 'anchor_after_now', undefined]);
  assert.equal(made.sinceWall('message', clock.wall + 500).durationMs, 0, 'a sub-tolerance difference is not an inconsistency');
});

test('C13 model-facing fields stay Gregorian and unambiguous whatever the locale', () => {
  const locale = process.env.LC_ALL; process.env.LC_ALL = 'ar_EG.UTF-8';
  try {
    const midnight = localTime(iso('2026-11-22T05:00:00Z'), 'America/New_York');
    assert.deepEqual([midnight.time, midnight.date, midnight.weekday], ['00:00:00', '2026-11-22', 'Sunday'], 'midnight is hour 00, never 24');
  } finally { if (locale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = locale; }
  assert.equal(offsetLabel(-18000), 'UTC−05:00'); assert.equal(offsetLabel(20700), 'UTC+05:45');
});

test('C14 the zone order is conversation, fixed preference, sending device, this computer', () => {
  const made = service(new FakeClock('2026-11-21T16:30:00Z')), fixed: TimeSettings = { ...automatic, zoneMode: 'fixed', fixedZone: 'Europe/Berlin' };
  assert.equal(made.zone({ conversation: 'Asia/Tokyo', settings: fixed, device: 'America/Denver' }).source, 'conversation');
  assert.deepEqual(made.zone({ settings: fixed, device: 'America/Denver' }), { zone: 'Europe/Berlin', source: 'fixed-preference' });
  assert.deepEqual(made.zone({ settings: automatic, device: 'America/Denver' }), { zone: 'America/Denver', source: 'message-device' });
  assert.deepEqual(made.zone({ settings: automatic }), { zone: 'America/New_York', source: 'broker-system' });
  assert.deepEqual(made.zone({ settings: fixed, conversation: 'Asia/Tokyo', schedule: 'Australia/Sydney' }), { zone: 'Australia/Sydney', source: 'schedule' });
});

test('the zone list is current and each entry works', () => {
  const names = zoneNames();
  assert.equal(names[0], 'UTC'); assert.ok(names.length > 300); assert.equal(new Set(names).size, names.length);
  for (const name of ['America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Europe/Kyiv']) assert.ok(names.includes(name), name);
  for (const name of ['Asia/Calcutta', 'Europe/Kiev']) assert.ok(!names.includes(name), name);
  assert.ok(names.every(name => knownZone(name) === name));
});

test('E13 milliseconds and graph memory’s microseconds meet through named conversions', () => {
  const instant = iso('2026-11-21T16:30:00.123Z');
  assert.equal(msToUs(instant), 1795278600123000); assert.equal(usToMs(msToUs(instant)), instant);
});

test('a warm snapshot costs well under a few milliseconds', () => {
  const made = service(new FakeClock('2026-11-21T16:30:00Z')), choice = { zone: 'America/New_York', source: 'broker-system' as const };
  made.snapshot(choice);
  const from = performance.now(); for (let index = 0; index < 500; index++) made.snapshot(choice);
  assert.ok((performance.now() - from) / 500 < 5);
});
