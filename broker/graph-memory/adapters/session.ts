/**
 * Lock and suspend (opt-in). While this computer is locked, or has just woken, what PAL last saw of the desktop is not
 * known to hold any more: it says so until each source is verified again. Nothing about the person or the screen is read,
 * only whether the session is locked.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveCollector, LiveObservation } from './contracts.ts';
import { LiveObservationFactory } from './live.ts';

const run = promisify(execFile);
export type SessionProbe = () => Promise<{ locked?: boolean }>;

/** What the login manager and the compositor say; either may be missing, and then nothing is claimed. */
export const probeSession: SessionProbe = async () => {
  const answers: boolean[] = [];
  const uid = process.getuid?.();
  const login = async () => {
    const shown = (await run('loginctl', ['show-user', String(uid), '-p', 'Display', '--value'], { timeout: 2000 })).stdout.trim();
    const id = process.env.XDG_SESSION_ID || shown; if (!/^[A-Za-z0-9]+$/.test(id)) return;
    const hint = (await run('loginctl', ['show-session', id, '-p', 'LockedHint', '--value'], { timeout: 2000 })).stdout.trim();
    if (hint === 'yes' || hint === 'no') answers.push(hint === 'yes');
  };
  const compositor = async () => {
    if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
    const value = JSON.parse((await run('hyprctl', ['-j', 'locked'], { timeout: 2000 })).stdout); if (typeof value?.locked === 'boolean') answers.push(value.locked);
  };
  await Promise.allSettled([login(), compositor()]);
  return answers.length ? { locked: answers.some(Boolean) } : {};
};

export class SessionCollector implements LiveCollector {
  private emit?: (observation: LiveObservation) => void;
  private timer?: NodeJS.Timeout; private stopped = false; private running?: Promise<void>;
  private factory = new LiveObservationFactory('session', 20_000);
  private probe: SessionProbe; private changed: (locked: boolean) => void; private intervalMs: number; private locked?: boolean;
  constructor(config: { changed: (locked: boolean) => void; probe?: SessionProbe; intervalMs?: number }) { this.changed = config.changed; this.probe = config.probe || probeSession; this.intervalMs = config.intervalMs ?? 5000; }
  async start(emit: (observation: LiveObservation) => void) {
    this.emit = emit; await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, this.intervalMs); this.timer.unref();
  }
  reconcile(): Promise<void> { return this.running ??= this.check().finally(() => { this.running = undefined; }); }
  private async check() {
    const state = await this.probe().catch(() => ({} as { locked?: boolean }));
    if (this.stopped || !this.emit) return;
    if (state.locked === undefined) { this.emit(this.factory.unknown('session', this.factory.sourceEpoch, 'unavailable')); return; }
    this.emit(this.factory.observation('session', this.factory.sourceEpoch, 'SESSION_STATE', { locked: state.locked }));
    if (state.locked !== this.locked) { const first = this.locked === undefined; this.locked = state.locked; if (!first || state.locked) this.changed(state.locked); }
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.emit = undefined; }
}

/**
 * Notices that the computer slept: wall time went on while the monotonic clock stood still. A clock set forward looks the
 * same and is treated the same, because either way the last observation is older than it seems.
 */
export class SuspendWatch {
  private wall: number; private monotonic: number; private timer?: NodeJS.Timeout;
  private clock: { wall: () => number; monotonic: () => number }; private resumed: (gapMs: number) => void;
  static gapMs = 5000;
  constructor(resumed: (gapMs: number) => void, clock = { wall: () => Date.now(), monotonic: () => performance.now() }) { this.resumed = resumed; this.clock = clock; this.wall = clock.wall(); this.monotonic = clock.monotonic(); }
  start(intervalMs = 2000) { this.timer = setInterval(() => this.check(), intervalMs); this.timer.unref(); }
  check() {
    const wall = this.clock.wall(), monotonic = this.clock.monotonic(), gap = wall - this.wall - (monotonic - this.monotonic);
    this.wall = wall; this.monotonic = monotonic;
    if (gap > SuspendWatch.gapMs) this.resumed(gap);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}
