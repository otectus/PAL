import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LiveCollector, LiveObservation } from './contracts.ts';
import { LiveObservationFactory } from './live.ts';

const execFileAsync = promisify(execFile);

export interface KittyPaneSnapshot {
  osWindowId: string;
  tabId: string;
  paneId: string;
  osWindowFocused: boolean;
  tabActive: boolean;
  paneFocused: boolean;
  cwd?: string;
}

export function parseKittySnapshot(value: unknown, includeCwd = true): KittyPaneSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError('Kitty snapshot must be an array');
  const panes: KittyPaneSnapshot[] = [];
  for (const osWindow of value) {
    if (!osWindow || typeof osWindow !== 'object' || !Array.isArray((osWindow as any).tabs)) continue;
    for (const tab of (osWindow as any).tabs) {
      if (!tab || typeof tab !== 'object' || !Array.isArray(tab.windows)) continue;
      for (const pane of tab.windows) {
        if (!pane || typeof pane !== 'object' || pane.id === undefined) continue;
        panes.push({
          osWindowId: String((osWindow as any).id), tabId: String(tab.id), paneId: String(pane.id),
          osWindowFocused: Boolean((osWindow as any).is_focused), tabActive: Boolean(tab.is_active), paneFocused: Boolean(pane.is_focused),
          ...(includeCwd && typeof pane.cwd === 'string' ? { cwd: pane.cwd } : {}),
        });
      }
    }
  }
  return panes;
}

function validEndpoint(value: string): string {
  if (!value.startsWith('unix:') || /[\0\r\n]/u.test(value)) throw new TypeError('Kitty inspection endpoint must be a Unix socket');
  return value;
}

/** A running Kitty: its process, and an identity that a reused process ID cannot take over. */
export type KittyInstance = { pid: number; endpoint: string; instanceId: string };
const socketPath = (endpoint: string) => endpoint.slice('unix:'.length);
/** Kitty processes of this user whose inspection socket exists, from an endpoint that names each by {pid}. */
export async function kittyInstances(endpoint: string, proc = '/proc'): Promise<KittyInstance[]> {
  const uid = process.getuid?.(), found: KittyInstance[] = [];
  for (const name of await readdir(proc)) {
    if (found.length >= 16 || !/^[1-9][0-9]{0,9}$/.test(name)) continue;
    try {
      if ((await readFile(`${proc}/${name}/comm`, 'utf8')).trim() !== 'kitty') continue;
      if ((await lstat(`${proc}/${name}`)).uid !== uid) continue;
      const stat = await readFile(`${proc}/${name}/stat`, 'utf8'), started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], at = endpoint.replaceAll('{pid}', name), socket = await lstat(socketPath(at));
      if (!socket.isSocket() || socket.uid !== uid) continue;
      found.push({ pid: Number(name), endpoint: at, instanceId: `${name}:${started}` });
    } catch { /* it ended, belongs to someone else, or takes no questions */ }
  }
  return found;
}

export interface KittyCollectorConfig {
  endpoint: string;
  /** Ignored when the endpoint names instances by {pid}. */
  instanceId?: string;
  instances?: () => Promise<KittyInstance[]>;
  executable?: string;
  ttlMs?: number;
  reconcileIntervalMs?: number;
  approvedCwdRoots?: string[];
}

export class KittyCollector implements LiveCollector {
  readonly config: KittyCollectorConfig;
  private factory: LiveObservationFactory;
  private emit?: (observation: LiveObservation) => void;
  private timer?: NodeJS.Timeout;
  /** Panes seen, by instance and pane, with their generation. */
  private generations = new Map<string, { generation: string; instanceId: string; paneId: string }>();
  private endpoint: string;
  private roots: string[] = [];
  private stopped = false;
  private get many() { return this.config.endpoint.includes('{pid}'); }
  constructor(config: KittyCollectorConfig) {
    this.config = config;
    this.endpoint = validEndpoint(config.endpoint);
    if (!config.instanceId && !this.many) throw new TypeError('Kitty instance identity is required');
    this.factory = new LiveObservationFactory('kitty', config.ttlMs ?? 10_000);
  }

  async start(emit: (observation: LiveObservation) => void): Promise<void> {
    this.emit = emit;
    this.roots = await Promise.all((this.config.approvedCwdRoots ?? []).map(root => realpath(root)));
    await this.reconcile().catch(() => this.unknown('initial_reconcile_failed'));
    this.timer = setInterval(() => { void this.reconcile().catch(() => this.unknown('reconcile_failed')); }, this.config.reconcileIntervalMs ?? 5_000);
    this.timer.unref();
  }

  private async allowedCwd(cwd: string | undefined): Promise<string | undefined> {
    if (!cwd || !isAbsolute(cwd) || !this.roots.length) return undefined;
    try {
      const canonical = await realpath(resolve(cwd));
      return this.roots.some(root => { const child = relative(root, canonical); return child === '' || (!child.startsWith('..') && !isAbsolute(child)); }) ? canonical : undefined;
    } catch { return undefined; }
  }

  private async instances(): Promise<(KittyInstance | { pid?: undefined; endpoint: string; instanceId: string })[]> {
    if (this.many) return this.config.instances ? this.config.instances() : kittyInstances(this.endpoint);
    return [{ endpoint: this.endpoint, instanceId: this.config.instanceId! }];
  }
  async reconcile(): Promise<void> {
    if (!this.emit) return;
    const seen = new Set<string>(), instances = await this.instances(); let failed: unknown;
    for (const instance of instances) {
      // Only the read-only `ls` action is ever sent. No Kitty titles, command lines, process environment, or terminal text survive parsing.
      let panes: KittyPaneSnapshot[];
      try { panes = parseKittySnapshot(JSON.parse((await execFileAsync(this.config.executable ?? 'kitten', ['@', '--to', instance.endpoint, 'ls'], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })).stdout), true); }
      catch (error) { failed = error; continue; }
      for (const pane of panes) {
        const key = `${instance.instanceId}\n${pane.paneId}`; seen.add(key);
        const known = this.generations.get(key) ?? { generation: randomUUID(), instanceId: instance.instanceId, paneId: pane.paneId }; this.generations.set(key, known);
        const cwd = await this.allowedCwd(pane.cwd);
        // Reconciliation finishing after stop() must not reinsert revoked state.
        if (this.stopped || !this.emit) return;
        this.emit(this.factory.observation(`kitty:${instance.instanceId}:pane:${pane.paneId}`, known.generation, 'TERMINAL_PANE', {
          instanceId: instance.instanceId, ...(instance.pid ? { kittyPid: instance.pid } : {}), osWindowId: pane.osWindowId, tabId: pane.tabId, paneId: pane.paneId,
          osWindowFocused: pane.osWindowFocused, tabActive: pane.tabActive, paneFocused: pane.paneFocused, ...(cwd ? { cwd } : {}),
        }));
      }
    }
    if (this.stopped || !this.emit) return;
    for (const [key, known] of this.generations) if (!seen.has(key)) {
      this.emit(this.factory.observation(`kitty:${known.instanceId}:pane:${known.paneId}`, known.generation, 'TERMINAL_PANE_CLOSED', { instanceId: known.instanceId, paneId: known.paneId }));
      this.generations.delete(key);
    }
    // One instance that does not answer leaves the others known; none answering is unknown.
    if (failed && !seen.size) throw failed;
  }

  private unknown(reason: string) { this.emit?.(this.factory.unknown(`kitty:${this.config.instanceId ?? 'instances'}`, this.factory.sourceEpoch, reason)); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.unknown('collector_stopped'); this.emit = undefined; }
}
