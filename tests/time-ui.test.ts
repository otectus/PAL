import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TimeService, localTime, zoneList, zoneNames, zoneSources, type Clock } from '../broker/time.ts';

// qml/TimeText.js words the broker's clock readings; qml/ContextExplain.js words the Context drawer.
const load = (name: string, locale = { timeFormat: () => 'h:mm AP', dateFormat: () => 'dddd, MMMM d, yyyy', amText: 'AM', pmText: 'PM' }): any => {
  const context: any = vm.createContext({ Qt: { locale: () => locale } });
  vm.runInContext(readFileSync(new URL('../qml/' + name, import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), context);
  return context;
};
const text = load('TimeText.js'), explain = load('ContextExplain.js');
const fixed = (iso: string): Clock => ({ wallNowMs: () => Date.parse(iso), monotonicNowMs: () => 1000, instanceId: 'test' });
const sample = (iso: string, zone: string) => new TimeService(fixed(iso), () => zone).snapshot({ zone, source: 'broker-system' });

test('C13 the display choice changes the shown clock and nothing the reading holds', () => {
  const morning = sample('2026-11-21T16:30:00Z', 'America/New_York');
  assert.equal(text.clock(morning, '24h'), '11:30');
  assert.equal(text.clock(morning, '12h'), '11:30 AM');
  assert.equal(text.clock(morning, 'system'), '11:30 AM');
  assert.equal(load('TimeText.js', { timeFormat: () => 'HH:mm', dateFormat: () => 'dddd d MMMM yyyy', amText: 'a. m.', pmText: 'p. m.' }).clock(morning, 'system'), '11:30');
  assert.equal(morning.localTime, '11:30:00');
  // Midnight is 12 in the morning, or 00, and never 24.
  const midnight = sample('2026-11-21T05:00:00Z', 'America/New_York');
  assert.equal(text.clock(midnight, '12h'), '12:00 AM');
  assert.equal(text.clock(midnight, '24h'), '00:00');
  assert.equal(text.clock(sample('2026-11-21T17:05:00Z', 'America/New_York'), '12h'), '12:05 PM');
  assert.equal(text.clock(null, '12h'), '');
});
test('zones are named in full with their offset, including quarter hours', () => {
  assert.equal(text.zone(sample('2026-11-21T16:30:00Z', 'Asia/Kathmandu')), 'Asia/Kathmandu (UTC+05:45)');
  assert.equal(text.zone(sample('2026-11-21T16:30:00Z', 'America/New_York')), 'America/New_York (UTC−05:00)');
  for (const source of zoneSources) assert.ok(text.knownZoneSources().includes(source), `${source} has words`);
});
test('lengths are worded to the minute and unknown or inconsistent times are never a number', () => {
  for (const [ms, words] of [[0, 'less than a minute'], [59_999, 'less than a minute'], [60_000, '1 minute'], [45 * 60_000, '45 minutes'], [2 * 3600_000, '2 hours'], [2 * 3600_000 + 61_000, '2 hours 1 minute'], [72 * 3600_000 + 3600_000, '3 days 1 hour']] as const)
    assert.equal(text.duration(ms), words);
  assert.equal(text.duration(-1), '');
  assert.equal(text.elapsed({ status: 'available', durationMs: 45 * 60_000 }), 'About 45 minutes ago');
  assert.equal(text.elapsed({ status: 'available', durationMs: 5 }), 'Less than a minute ago');
  assert.match(text.elapsed({ status: 'available', durationMs: 3600_000, reason: 'clock_jump_or_sleep_during_interval' }), /^About 1 hour ago\. The clock jumped or the computer slept/);
  assert.match(text.elapsed({ status: 'inconsistent', reason: 'clock_moved_backward' }), /cannot be measured/);
  assert.equal(text.elapsed({ status: 'unknown', reason: 'anchor_unavailable' }), 'Not recorded');
  assert.equal(text.elapsed(undefined), 'Not recorded');
});
test('the zone list offers every zone once, with its offset at that moment', () => {
  const winter = zoneList(Date.parse('2026-01-15T12:00:00Z')), summer = zoneList(Date.parse('2026-07-15T12:00:00Z'));
  assert.deepEqual(winter.map(zone => zone.id), zoneNames());
  const at = (list: typeof winter, id: string) => list.find(zone => zone.id === id)!.offsetSeconds;
  assert.equal(at(winter, 'America/New_York'), -18000);
  assert.equal(at(summer, 'America/New_York'), -14400);
  assert.equal(at(summer, 'UTC'), 0);
  assert.equal(localTime(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kathmandu').offsetSeconds, at(summer, 'Asia/Kathmandu'));
});
test('the Context drawer says what the next message is told and how the last request was told it', () => {
  assert.equal(explain.timeLine({ enabled: true, zone: 'Asia/Tokyo' }, 'this computer’s time zone'), 'The next message is told the time in Asia/Tokyo (this computer’s time zone).');
  assert.match(explain.timeLine({ enabled: false, zone: 'Asia/Tokyo' }, ''), /off in Settings/);
  assert.equal(explain.timeDetail({ enabled: false }), '');
  const layer = { id: 'temporal-context', label: 'Current date and time', trust: 'pal', tokens: 120, included: true, detail: { timezone: 'Asia/Tokyo', timezoneSource: 'conversation', local: '2026-11-21T11:30:00+09:00', channel: 'system message', refresh: 'every request', elapsed: 'wall-clock-estimate', clock: 'normal' } };
  const words = explain.planRows({ layers: [layer] }, text.zoneSource)[0].status;
  assert.match(words, /read at 2026-11-21 11:30:00\+09:00/);
  assert.match(words, /Asia\/Tokyo \(set for this conversation\)/);
  assert.match(words, /sent in the system message · renewed every request · time since your previous message estimated/);
  assert.doesNotMatch(words, /clock had jumped/);
  assert.match(explain.planRows({ layers: [{ ...layer, detail: { ...layer.detail, clock: 'discontinuity-observed' } }] }, text.zoneSource)[0].status, /the clock had jumped/);
  for (const reason of ['setting_off', 'time_unavailable', 'not_sent_yet', 'not_supplied']) assert.notEqual(explain.planRows({ layers: [{ ...layer, included: false, reason, detail: undefined }] })[0].status, reason);
});
