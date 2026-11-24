/**
 * The broker's clock: what time it is, in which zone, and how long something took.
 *
 * Four kinds of time are kept apart. Wall time (Unix epoch milliseconds) answers "what time is it" and dates
 * recorded events; it can jump when the host clock is corrected. A process interval (monotonic milliseconds
 * with this broker instance's ID) measures how long something took inside this process and is never compared
 * across a restart. Local calendar fields are always derived from one wall instant in one IANA zone. The order
 * of a conversation is its transcript order, never a comparison of wall times.
 *
 * The clock is the desktop's own. Nothing here contacts a time service, starts a process or writes a file, and
 * `normal` only means that no jump was observed, not that the clock was checked against anything.
 */
import { randomUUID } from 'node:crypto';
import { readlinkSync, realpathSync } from 'node:fs';

export interface Clock {
  wallNowMs(): number;
  monotonicNowMs(): number;
  /** This broker process. Monotonic readings mean nothing in another one. */
  instanceId: string;
}
export const systemClock: Clock = { wallNowMs: () => Date.now(), monotonicNowMs: () => performance.now(), instanceId: randomUUID() };

export const zoneSources = ['conversation', 'fixed-preference', 'message-device', 'broker-system', 'utc-fallback', 'explicit-query', 'schedule'] as const;
export type ZoneSource = typeof zoneSources[number];
export type ClockStatus = 'normal' | 'discontinuity-observed' | 'unknown';

export type TimeSnapshot = {
  schema: 1;
  sampledAtMs: number;
  utcIso: string;
  /** Local date and time with its numeric UTC offset. */
  localIso: string;
  timeZone: string;
  zoneSource: ZoneSource;
  /** Gregorian YYYY-MM-DD in the zone above. */
  localDate: string;
  /** HH:mm:ss, hours 00–23. */
  localTime: string;
  weekday: string;
  /** Positive is east of UTC. */
  offsetSeconds: number;
  clockSource: 'broker-system';
  clockStatus: ClockStatus;
  /** Raised when a jump is seen or the system zone changes; a display anchored to an older value starts over. */
  clockRevision: number;
};
export type ElapsedBasis = 'process-monotonic' | 'wall-clock-estimate' | 'unknown';
export type ElapsedResult = {
  schema: 1;
  status: 'available' | 'unknown' | 'inconsistent';
  anchorKind: string;
  anchorId?: string;
  /** What the anchor is, in words, so its meaning is never guessed. */
  anchor?: string;
  fromMs?: number;
  toMs: number;
  durationMs?: number;
  basis: ElapsedBasis;
  includesInactivity: boolean;
  includesSuspend: boolean | null;
  reason?: string;
};

/** Wall and monotonic time may drift apart by this much between two readings before it counts as a jump. */
export const discontinuityToleranceMs = 2000;
/** How long after a jump later samples keep saying one was seen. */
const discontinuityNoticeMs = 15 * 60_000;
/** A request is never dispatched with a sample older than this. */
export const maximumSampleAgeMs = 5000;
const latestInstant = 253402300799999; // 9999-12-31T23:59:59.999Z

/** Zones the runtime lists under a retired spelling, by the spelling in current use. */
const currentNames: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka', 'Asia/Macao': 'Asia/Macau', 'Asia/Thimbu': 'Asia/Thimphu', 'Asia/Ujung_Pandang': 'Asia/Makassar', 'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Africa/Asmera': 'Africa/Asmara', 'America/Godthab': 'America/Nuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'America/Catamarca': 'America/Argentina/Catamarca', 'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy', 'America/Mendoza': 'America/Argentina/Mendoza', 'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Enderbury': 'Pacific/Kanton',
};

function runtimeZone(name: string): string | undefined {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone; } catch { return undefined; }
}
/**
 * The zone this runtime knows by that name, or undefined. A fixed offset is not a zone. A supported alias is
 * kept as given (Asia/Kathmandu stays Asia/Kathmandu); only its letter case is corrected.
 */
export function knownZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name || name.length > 128 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return undefined;
  const resolved = runtimeZone(name);
  if (!resolved) return undefined;
  if (name.toUpperCase() === 'UTC') return 'UTC';
  if (resolved.toLowerCase() === name.toLowerCase()) return resolved;
  if (name !== name.toLowerCase()) return name;
  const cased = name.replace(/(^|[/_-])([a-z])/g, (_match, mark: string, letter: string) => mark + letter.toUpperCase());
  return runtimeZone(cased) ? cased : name;
}
/** A zone a person or a model chose. Throws a message that can be shown as it is. */
export function requireZone(value: unknown): string {
  const zone = knownZone(value);
  if (!zone) throw new Error('Choose a time zone by its name, such as America/New_York or Asia/Tokyo');
  return zone;
}
/**
 * The zone the operating system is set to now. The runtime's own answer is fixed when the process starts, so a
 * change made while PAL runs is read from the system instead; TZ, when set for the broker, still decides.
 */
export function detectSystemZone(): string | undefined {
  if (process.env.TZ) { const fixed = knownZone(process.env.TZ.replace(/^:/, '')); if (fixed) return fixed; }
  for (const read of [() => readlinkSync('/etc/localtime'), () => realpathSync('/etc/localtime')]) {
    try {
      const path = read(), at = path.lastIndexOf('zoneinfo/');
      const zone = at < 0 ? undefined : knownZone(path.slice(at + 9).replace(/^(?:posix|right)\//, ''));
      if (zone) return zone;
    } catch { /* Not a link here; the runtime's own answer is next. */ }
  }
  return knownZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
/** Every selectable zone, in current spelling, with UTC first. */
export function zoneNames(): string[] {
  const names = new Set(Intl.supportedValuesOf('timeZone').map(name => currentNames[name] || name));
  names.delete('UTC');
  return ['UTC', ...[...names].sort((a, b) => a.localeCompare(b))];
}

let listed: { slot: number; zones: { id: string; offsetSeconds: number }[] } | undefined;
/** Every selectable zone with its offset now. Offsets change on quarter hours, so a list is kept for one at most. */
export function zoneList(nowMs: number): { id: string; offsetSeconds: number }[] {
  const slot = Math.floor(nowMs / 900_000);
  if (listed?.slot !== slot) listed = { slot, zones: zoneNames().map(id => ({ id, offsetSeconds: localTime(nowMs, id).offsetSeconds })) };
  return listed.zones;
}

// Formatters are kept per zone, never with a time, so a change of zone or clock is seen by the next sample.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, found);
  }
  return found;
}
export function validInstant(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 && ms <= latestInstant;
}
const two = (value: number) => String(value).padStart(2, '0');
export type LocalTime = { date: string; time: string; weekday: string; offsetSeconds: number; iso: string };
/** Every calendar field of one instant in one zone. All of them come from that instant, so midnight cannot split them. */
export function localTime(ms: number, zone: string): LocalTime {
  if (!validInstant(ms)) throw new Error('The clock reported a time PAL cannot use');
  const part: Record<string, string> = {};
  for (const { type, value } of formatter(zone).formatToParts(ms)) part[type] = value;
  const [year, month, day, hour, minute, second] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(type => Number(part[type]));
  const offsetSeconds = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000) / 1000);
  const date = `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`, time = `${two(hour)}:${two(minute)}:${two(second)}`;
  const size = Math.abs(offsetSeconds), seconds = size % 60;
  return { date, time, weekday: part.weekday, offsetSeconds,
    iso: `${date}T${time}${offsetSeconds < 0 ? '-' : '+'}${two(Math.floor(size / 3600))}:${two(Math.floor(size / 60) % 60)}${seconds ? ':' + two(seconds) : ''}` };
}
export const offsetLabel = (seconds: number) => {
  const size = Math.abs(seconds);
  return `UTC${seconds < 0 ? '−' : '+'}${two(Math.floor(size / 3600))}:${two(Math.floor(size / 60) % 60)}`;
};

export type ClockFormat = 'system' | '12h' | '24h';
export type TimeSettings = {
  /** Give models the current date and time, and the two clock tools. */
  enabled: boolean;
  zoneMode: 'automatic' | 'fixed';
  fixedZone: string | null;
  /** Include how long it has been since earlier messages, and the elapsed-time tool. */
  conversationTiming: boolean;
  /** How PAL shows times. It never changes what is stored or what a model reads. */
  clockFormat: ClockFormat;
};
export const defaultTimeSettings: TimeSettings = { enabled: true, zoneMode: 'automatic', fixedZone: null, conversationTiming: true, clockFormat: 'system' };
/** Settings as stored, with every field that is missing or unusable put back to its default. */
export function storedTimeSettings(value: unknown): TimeSettings {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const fixedZone = knownZone(saved.fixedZone) ?? null;
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaultTimeSettings.enabled,
    // A fixed zone this runtime does not know falls back to automatic, rather than to a wrong local time.
    zoneMode: saved.zoneMode === 'fixed' && fixedZone ? 'fixed' : 'automatic',
    fixedZone,
    conversationTiming: typeof saved.conversationTiming === 'boolean' ? saved.conversationTiming : defaultTimeSettings.conversationTiming,
    clockFormat: saved.clockFormat === '12h' || saved.clockFormat === '24h' ? saved.clockFormat : 'system',
  };
}
/** A settings change, merged onto the current choices. The previous choices stay when anything in it is invalid. */
export function validTimeSettings(patch: unknown, current: TimeSettings): TimeSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid time settings');
  const p = patch as Record<string, unknown>;
  if (Object.keys(p).some(key => !(key in defaultTimeSettings))) throw new Error('Unknown time setting');
  for (const key of ['enabled', 'conversationTiming'] as const) if (key in p && typeof p[key] !== 'boolean') throw new Error('Time settings are on or off');
  if ('zoneMode' in p && p.zoneMode !== 'automatic' && p.zoneMode !== 'fixed') throw new Error('Choose an automatic or fixed time zone');
  if ('clockFormat' in p && !['system', '12h', '24h'].includes(p.clockFormat as string)) throw new Error('Choose a time display');
  const next = { ...current, ...p } as TimeSettings;
  next.fixedZone = next.fixedZone === null ? null : requireZone(next.fixedZone);
  if (next.zoneMode === 'fixed' && !next.fixedZone) throw new Error('Choose the fixed time zone');
  return next;
}

export type ZoneChoice = { zone: string; source: ZoneSource; /** Why a suggested zone was not used. */ reason?: string };
type Reading = { wall: number; monotonic: number };
type Jump = { wall: number; monotonic: number; shiftMs: number };

/** Samples one clock, notices when it jumps, and resolves which zone "now" is told in. */
export class TimeService {
  readonly clock: Clock;
  private systemZone: () => string | undefined;
  private last?: Reading;
  private lastZone?: string;
  private jumps: Jump[] = [];
  private revision = 1;
  private started: number;
  constructor(clock: Clock = systemClock, systemZone: () => string | undefined = detectSystemZone) {
    this.clock = clock; this.systemZone = systemZone; this.started = Math.trunc(clock.wallNowMs());
  }

  /** One reading of both clocks, compared with the previous one. */
  read(): Reading {
    const reading = { wall: Math.trunc(this.clock.wallNowMs()), monotonic: this.clock.monotonicNowMs() }, before = this.last;
    this.last = reading;
    if (before) {
      const shiftMs = (reading.wall - before.wall) - (reading.monotonic - before.monotonic);
      if (Math.abs(shiftMs) > discontinuityToleranceMs) {
        this.jumps.push({ wall: reading.wall, monotonic: reading.monotonic, shiftMs });
        if (this.jumps.length > 16) this.jumps.shift();
        this.revision++;
      }
    }
    return reading;
  }
  get clockRevision() { return this.revision; }
  private status(reading: Reading): ClockStatus {
    if (!validInstant(reading.wall)) return 'unknown';
    const jump = this.jumps.at(-1);
    return jump && reading.monotonic - jump.monotonic < discontinuityNoticeMs ? 'discontinuity-observed' : 'normal';
  }
  /** The zone a request is told in: conversation, fixed preference, the sending device, this computer, then UTC. */
  zone(p: { conversation?: string; settings: TimeSettings; device?: string; schedule?: string }): ZoneChoice {
    // An unattended run keeps the zone its routine was reviewed in.
    const schedule = knownZone(p.schedule);
    if (schedule) return { zone: schedule, source: 'schedule' };
    const conversation = knownZone(p.conversation);
    if (conversation) return { zone: conversation, source: 'conversation' };
    if (p.settings.zoneMode === 'fixed' && p.settings.fixedZone) { const fixed = knownZone(p.settings.fixedZone); if (fixed) return { zone: fixed, source: 'fixed-preference' }; }
    const device = knownZone(p.device);
    if (device) return { zone: device, source: 'message-device' };
    const reason = p.device !== undefined ? 'device_zone_unsupported' : undefined;
    const system = this.currentSystemZone();
    if (system) return { zone: system, source: 'broker-system', ...(reason ? { reason } : {}) };
    return { zone: 'UTC', source: 'utc-fallback', reason: reason || 'system_zone_unavailable' };
  }
  /** The system zone now. A change raises the clock revision so open displays start over; nothing running is rebound. */
  currentSystemZone(): string | undefined {
    let zone: string | undefined;
    try { zone = knownZone(this.systemZone()); } catch { zone = undefined; }
    if (this.lastZone !== undefined && zone !== this.lastZone) this.revision++;
    this.lastZone = zone;
    return zone;
  }
  snapshot(choice: ZoneChoice): TimeSnapshot {
    const reading = this.read(), local = localTime(reading.wall, choice.zone);
    return { schema: 1, sampledAtMs: reading.wall, utcIso: new Date(reading.wall).toISOString(), localIso: local.iso, timeZone: choice.zone, zoneSource: choice.source,
      localDate: local.date, localTime: local.time, weekday: local.weekday, offsetSeconds: local.offsetSeconds,
      clockSource: 'broker-system', clockStatus: this.status(reading), clockRevision: this.revision };
  }
  /** Time since a process-relative reading of this broker. Suspend is neither promised nor ruled out. */
  sinceMonotonic(anchorKind: string, from: { instanceId: string; monotonic: number; wall: number }, anchor?: string): ElapsedResult {
    const reading = this.read();
    if (from.instanceId !== this.clock.instanceId) return this.sinceWall(anchorKind, from.wall, { anchor });
    const durationMs = Math.round(reading.monotonic - from.monotonic);
    if (durationMs < 0) return { schema: 1, status: 'inconsistent', anchorKind, ...(anchor ? { anchor } : {}), toMs: reading.wall, basis: 'unknown', includesInactivity: true, includesSuspend: null, reason: 'anchor_after_now' };
    return { schema: 1, status: 'available', anchorKind, ...(anchor ? { anchor } : {}), fromMs: from.wall, toMs: reading.wall, durationMs, basis: 'process-monotonic', includesInactivity: true, includesSuspend: null };
  }
  /**
   * Time since a recorded wall-clock event: an estimate that includes every pause, and that says when it cannot be
   * one. `at` is the event's process reading, when this broker recorded it, and orders it against any clock jump.
   */
  sinceWall(anchorKind: string, fromMs: number | undefined, p: { anchorId?: string; anchor?: string; reason?: string; at?: { instanceId: string; monotonic: number } } = {}): ElapsedResult {
    const reading = this.read();
    const base = { schema: 1 as const, anchorKind, ...(p.anchorId ? { anchorId: p.anchorId } : {}), ...(p.anchor ? { anchor: p.anchor } : {}), toMs: reading.wall, includesInactivity: true, includesSuspend: null };
    if (!validInstant(fromMs) || !validInstant(reading.wall)) return { ...base, status: 'unknown', basis: 'unknown', reason: p.reason || 'anchor_unavailable' };
    const durationMs = reading.wall - fromMs;
    if (durationMs < -discontinuityToleranceMs) return { ...base, status: 'inconsistent', fromMs, basis: 'unknown', reason: 'anchor_after_now' };
    const recorded = p.at && p.at.instanceId === this.clock.instanceId ? p.at.monotonic : undefined;
    const since = this.jumps.filter(jump => recorded !== undefined ? jump.monotonic > recorded
      // Recorded before this process began, so before every jump it has seen.
      : fromMs < this.started ? true
      // A backward correction repeats a stretch of wall time; an event inside it could be from either pass.
      : jump.shiftMs < 0 ? fromMs <= jump.wall - jump.shiftMs : fromMs < jump.wall);
    if (since.some(jump => jump.shiftMs < 0)) return { ...base, status: 'inconsistent', fromMs, basis: 'unknown', reason: 'clock_moved_backward' };
    return { ...base, status: 'available', fromMs, durationMs: Math.max(0, durationMs), basis: 'wall-clock-estimate', ...(since.length ? { reason: 'clock_jump_or_sleep_during_interval' } : {}) };
  }
}

/** Graph memory counts microseconds and this service milliseconds; a conversion is always spelled out. */
export const msToUs = (ms: number) => Math.trunc(ms) * 1000;
export const usToMs = (us: number) => Math.trunc(us / 1000);
