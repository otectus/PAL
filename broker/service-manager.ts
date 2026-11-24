/**
 * A07 local services (opt-in): PAL can start a local service the person lets it manage, say whether it answers and who
 * started it, show its log, and stop it again. What PAL starts runs as a transient systemd user unit of its own, so
 * everything it started is in that unit's control group, and only that unit is ever stopped or restarted. Anything else
 * that answers at the address was started by someone else: PAL uses it and never stops, restarts or replaces it.
 *
 * There is no installer here. Ollama is the program on this computer, and the memory databases are the ones
 * tools/memory-dependencies.sh installed; their data stays where they keep it.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ollamaHost } from './ollama.ts';
import { palEnv } from './paths.ts';
import type { Core } from './core.ts';

export const serviceIds = ['ollama', 'memory'] as const;
export type ServiceId = typeof serviceIds[number];
export type LocalServiceSettings = { managed: ServiceId[]; autostart: ServiceId[] };
export type LocalService = {
  id: ServiceId; label: string; addresses: string[];
  /** Why PAL cannot start it here, or nothing. */
  unavailable: string; managed: boolean; autostart: boolean;
  state: 'ready' | 'partial' | 'starting' | 'stopping' | 'failed' | 'stopped'; owner: 'pal' | 'external' | 'none';
  problem: string;
  /** Why it must not be stopped or restarted now, or nothing. */
  blocking: string;
};
type Unit = { load: string; active: string; result: string; group: string; transient: boolean };
type Ran = { code: number; stdout: string; stderr: string };
type Endpoint = { name: string; host: string; port: number };

export const serviceLimits = { logBytes: 64 * 1024, readyMs: { ollama: 30_000, memory: 150_000 }, probeMs: 1200 };
const labels: Record<ServiceId, string> = { ollama: 'Ollama', memory: 'Memory databases (Neo4j and Qdrant)' };
const script = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'tools/memory-dependencies.sh');
const loopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const clean = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export function validateLocalServices(value: any, current: LocalServiceSettings): LocalServiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['managed', 'autostart'].includes(key))) throw new Error('Invalid local service settings');
  const pick = (list: unknown, fallback: ServiceId[]) => {
    if (list === undefined) return fallback;
    if (!Array.isArray(list) || list.some(id => !serviceIds.includes(id))) throw new Error('Invalid local service settings');
    return serviceIds.filter(id => list.includes(id));
  };
  const managed = pick(value.managed, current.managed);
  // Only what PAL may manage can start with it.
  return { managed, autostart: pick(value.autostart, current.autostart).filter(id => managed.includes(id)) };
}
export const runCommand = (file: string, args: string[], timeout = 10_000) => new Promise<Ran>(done => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (error: any, stdout, stderr) => done({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout: String(stdout), stderr: String(stderr) || (error && !stdout ? String(error.message) : '') }));
});
const answersAt = (host: string, port: number) => new Promise<boolean>(done => {
  const socket = connect({ host: host.replace(/^\[|\]$/g, ''), port }), finish = (value: boolean) => { socket.destroy(); done(value); };
  socket.setTimeout(serviceLimits.probeMs, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
});
function program(name: string) {
  for (const directory of (process.env.PATH || '').split(delimiter)) { if (!directory) continue; const path = join(directory, name); try { accessSync(path, constants.X_OK); return path; } catch { /* The next one. */ } }
  return '';
}

export class ServiceManager {
  core: Core;
  /** Seams for tests: the commands, and whether something answers. */
  run: (file: string, args: string[], timeout?: number) => Promise<Ran> = runCommand;
  answers: (host: string, port: number) => Promise<boolean> = answersAt;
  private busy = new Map<ServiceId, 'starting' | 'stopping'>(); private problems = new Map<ServiceId, string>(); private closed = false;
  private timers = new Set<NodeJS.Timeout>();
  /** A service that was started and has not answered or failed yet. */
  settling = new Map<ServiceId, Promise<void>>();
  constructor(core: Core) { this.core = core; }
  /** A profile's own units: another PAL profile of the same person never touches them. */
  unitName(id: ServiceId) { return `pal-${createHash('sha256').update(resolve(this.core.store.directory)).digest('hex').slice(0, 10)}-${id}.service`; }
  private endpoints(id: ServiceId): Endpoint[] {
    if (id === 'ollama') { const url = new URL(ollamaHost(this.core.settings.ollama.host)); return url.protocol === 'http:' ? [{ name: 'Ollama', host: url.hostname, port: Number(url.port) || 80 }] : []; }
    const graph = new URL(palEnv('NEO4J_URI') || 'bolt://127.0.0.1:7687'), vectors = new URL(palEnv('QDRANT_URL') || 'http://127.0.0.1:6333');
    return [{ name: 'Neo4j', host: graph.hostname, port: Number(graph.port) || 7687 }, { name: 'Qdrant', host: vectors.hostname, port: Number(vectors.port) || 6333 }];
  }
  private async unit(id: ServiceId): Promise<Unit | undefined> {
    const result = await this.run('systemctl', ['--user', 'show', this.unitName(id), '-p', 'LoadState,ActiveState,Result,ControlGroup,Transient'], 5000);
    if (result.code !== 0) return undefined;
    const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(result.stdout)?.[1] || '';
    return { load: value('LoadState'), active: value('ActiveState'), result: value('Result'), group: value('ControlGroup'), transient: value('Transient') === 'yes' };
  }
  /** A unit PAL started and that still holds processes. A unit file someone wrote under this name is not PAL's. */
  private running(unit: Unit | undefined) { return !!unit && unit.transient && ['active', 'activating', 'deactivating', 'reloading'].includes(unit.active); }
  /** Whether a process of this control group holds the listening port: an answer from anything else is not PAL's. */
  async listens(group: string, port: number): Promise<boolean> {
    if (!/^\/[\w@.:/\\-]+$/.test(group) || group.includes('..')) return false;
    const inodes = new Set<string>();
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of (await readFile(table, 'utf8').catch(() => '')).split('\n').slice(1)) { const part = line.trim().split(/\s+/); if (part[3] === '0A' && parseInt(part[1]?.split(':')[1] || '', 16) === port) inodes.add(part[9]); }
    for (const pid of (await readFile(`/sys/fs/cgroup${group}/cgroup.procs`, 'utf8').catch(() => '')).split('\n').filter(line => /^\d+$/.test(line)))
      for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) { const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''), inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]; if (inode && inodes.has(inode)) return true; }
    return false;
  }
  private async unavailable(id: ServiceId): Promise<string> {
    const endpoints = this.endpoints(id);
    if (!endpoints.length || endpoints.some(item => !loopback(item.host))) return 'It is set up at another address, so PAL does not run it.';
    if (id === 'ollama') return program('ollama') ? '' : 'The ollama program is not installed.';
    if (/["'%$\\\s]/.test(script)) return 'PAL is installed in a folder whose name it cannot pass on safely.';
    const state = await this.run('bash', [script, 'local-state'], 5000);
    if (state.code !== 0) return 'The memory database tools are not part of this installation.';
    if (!/^installed=yes$/m.test(state.stdout)) return 'The databases are not installed. Run tools/memory-dependencies.sh local-install first.';
    return /^configured=yes$/m.test(state.stdout) ? '' : 'The databases have no private settings file yet (see docs/memory/operations.md).';
  }
  private blocking(id: ServiceId) {
    if (id !== 'ollama') return '';
    if (this.core.localModels.job && !this.core.localModels.job.done) return 'A model is being downloaded.';
    return this.core.store.sessions().some(session => session.provider === 'ollama' && ['starting', 'working', 'waiting', 'stopping'].includes(session.status)) ? 'A conversation is using it right now.' : '';
  }
  private async state(id: ServiceId): Promise<{ service: LocalService; unit: Unit | undefined; mine: boolean }> {
    const endpoints = this.endpoints(id), settings = this.core.settings.localServices;
    const [unit, answering, unavailable] = await Promise.all([this.unit(id), Promise.all(endpoints.map(item => this.answers(item.host, item.port))), this.unavailable(id)]);
    const mine = this.running(unit), up = answering.filter(Boolean).length, all = endpoints.length > 0 && up === endpoints.length;
    let owner: LocalService['owner'] = mine ? 'pal' : 'none';
    if (up) owner = mine && (await Promise.all(endpoints.map((item, index) => answering[index] ? this.listens(unit!.group, item.port) : true))).every(Boolean) ? 'pal' : 'external';
    const state: LocalService['state'] = this.busy.get(id) === 'stopping' ? 'stopping' : all ? 'ready' : this.busy.has(id) || this.settling.has(id) || mine && unit!.active === 'activating' ? 'starting' : up ? 'partial' : unit?.transient && unit.active === 'failed' ? 'failed' : mine ? 'partial' : 'stopped';
    const silent = endpoints.filter((_item, index) => !answering[index]).map(item => item.name);
    return { unit, mine, service: { id, label: labels[id], addresses: endpoints.map(item => `${item.host}:${item.port}`), unavailable, managed: settings.managed.includes(id), autostart: settings.autostart.includes(id), state, owner,
      problem: state === 'ready' || state === 'starting' || state === 'stopping' ? '' : state === 'failed' ? this.problems.get(id) || 'It stopped with an error. Its log says why.' : state === 'partial' ? `${silent.join(' and ')} ${silent.length > 1 ? 'do' : 'does'} not answer.` : this.problems.get(id) || '', blocking: mine ? this.blocking(id) : '' } };
  }
  async list(): Promise<{ supported: boolean; services: LocalService[] }> {
    const manager = await this.run('systemctl', ['--user', 'show', '-p', 'Version'], 5000);
    return { supported: manager.code === 0, services: (await Promise.all(serviceIds.map(id => this.state(id)))).map(item => item.service) };
  }
  private id(value: unknown): ServiceId { if (!serviceIds.includes(value as ServiceId)) throw new Error('Unknown local service'); return value as ServiceId; }
  /** One change at a time for each service. */
  private async exclusive<T>(id: ServiceId, what: 'starting' | 'stopping', task: () => Promise<T>) {
    if (this.busy.has(id)) throw new Error(`${labels[id]} is already being started or stopped`);
    this.busy.set(id, what);
    try { return await task(); } finally { this.busy.delete(id); }
  }
  async start(value: unknown) {
    const id = this.id(value);
    await this.exclusive(id, 'starting', async () => {
      if (!this.core.settings.localServices.managed.includes(id)) throw new Error(`Let PAL run ${labels[id]} first`);
      const { service, mine, unit } = await this.state(id);
      if (!unit) throw new Error('PAL runs local services only in a systemd user session');
      if (service.owner === 'external') throw new Error(`${service.addresses.join(' and ')}: something PAL did not start already answers there. PAL uses it and leaves it alone.`);
      if (mine) throw new Error(`${labels[id]} is already running`);
      if (unit.load === 'loaded' && !unit.transient) throw new Error('A unit of this name that PAL did not create exists. PAL leaves it alone.');
      if (service.unavailable) throw new Error(service.unavailable);
      this.problems.delete(id);
      await this.run('systemctl', ['--user', 'reset-failed', this.unitName(id)], 5000);
      const endpoint = this.endpoints(id)[0];
      const shared = ['--user', '--quiet', `--unit=${this.unitName(id)}`, `--description=${labels[id]}, started by PAL`, '-p', 'UMask=0077', '-p', 'TimeoutStopSec=30',
        ...['PAL_MEMORY_DEPS_HOME', 'CERE_MEMORY_DEPS_HOME', 'PAL_MEMORY_ENV_FILE', 'CERE_MEMORY_ENV_FILE', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'JAVA_HOME', 'OLLAMA_MODELS'].flatMap(name => process.env[name] ? [`--setenv=${name}=${process.env[name]}`] : [])];
      const args = id === 'ollama'
        // Recovery is bounded: three failures within two minutes and it stays stopped.
        ? [...shared, '-p', 'Type=exec', '-p', 'Restart=on-failure', '-p', 'RestartSec=2', '-p', 'StartLimitIntervalSec=120', '-p', 'StartLimitBurst=3', `--setenv=OLLAMA_HOST=${endpoint.host}:${endpoint.port}`, '--', program('ollama'), 'serve']
        : [...shared, '-p', 'Type=oneshot', '-p', 'RemainAfterExit=yes', '-p', 'TimeoutStartSec=150', '-p', `ExecStop=/usr/bin/env bash ${script} local-stop`, '--no-block', '--', '/usr/bin/env', 'bash', script, 'local-start'];
      const started = await this.run('systemd-run', args, 20_000);
      if (started.code !== 0) { const problem = 'It could not be started: ' + (clean(started.stderr).trim().split('\n')[0] || 'systemd refused it').slice(0, 300); this.problems.set(id, problem); throw new Error(problem); }
      this.core.store.activity({ action: 'services.start', service: id, status: 'completed' });
    });
    const settled = this.settle(id).finally(() => this.settling.delete(id)); this.settling.set(id, settled); void settled.catch(() => {});
    return this.list();
  }
  /** Waits until it answers, fails, or takes too long; then whatever depends on it looks again. */
  private async settle(id: ServiceId) {
    const until = Date.now() + serviceLimits.readyMs[id];
    while (!this.closed && Date.now() < until) {
      const endpoints = this.endpoints(id), answering = await Promise.all(endpoints.map(item => this.answers(item.host, item.port)));
      if (answering.every(Boolean)) break;
      const unit = await this.unit(id);
      if (!this.running(unit)) { this.problems.set(id, unit?.active === 'failed' ? 'It stopped with an error. Its log says why.' : 'It stopped by itself.'); break; }
      await new Promise<void>(done => { const timer = setTimeout(() => { this.timers.delete(timer); done(); }, 400); this.timers.add(timer); });
    }
    if (this.closed) return;
    this.settling.delete(id);
    if (id === 'ollama') void this.core.refreshProviderModels('ollama').catch(() => {}); else if (this.core.settings.memory.enabled) void this.core.memory.check().catch(() => {});
    this.core.changed();
  }
  async stop(value: unknown) {
    const id = this.id(value);
    await this.exclusive(id, 'stopping', async () => {
      const { mine, service } = await this.state(id);
      if (!mine) throw new Error(`PAL did not start ${labels[id]}. Stop it where it was started.`);
      if (service.blocking) throw new Error(service.blocking);
      const stopped = await this.run('systemctl', ['--user', 'stop', this.unitName(id)], 60_000);
      if (stopped.code !== 0) throw new Error('It could not be stopped: ' + (clean(stopped.stderr).trim().split('\n')[0] || 'systemd refused it').slice(0, 300));
      this.problems.delete(id); this.core.store.activity({ action: 'services.stop', service: id, status: 'completed' });
    });
    if (id === 'ollama') void this.core.refreshProviderModels('ollama').catch(() => {});
    this.core.changed(); return this.list();
  }
  async restart(value: unknown) { const id = this.id(value); if (!this.core.settings.localServices.managed.includes(id)) throw new Error(`Let PAL run ${labels[id]} first`); await this.stop(id); return this.start(id); }
  /** The latest lines of what PAL's own unit wrote. It is shown to the person and goes nowhere else. */
  async log(value: unknown): Promise<{ id: ServiceId; text: string }> {
    const id = this.id(value), parts = [(await this.run('journalctl', ['--user', '-u', this.unitName(id), '-n', '200', '-o', 'short-iso', '--no-pager', '-q'], 10_000)).stdout];
    if (id === 'memory') parts.push((await this.run('bash', [script, 'local-logs'], 10_000)).stdout);
    return { id, text: clean(parts.map(part => part.trim()).filter(Boolean).join('\n\n')).slice(-serviceLimits.logBytes) };
  }
  /** What the person chose to start with PAL, when nothing answers there already. A failure is a notice in its row. */
  async autostart() {
    for (const id of this.core.settings.localServices.autostart) {
      if (this.closed) return;
      try { const { service, mine } = await this.state(id); if (service.state === 'stopped' && !mine && service.owner === 'none') await this.start(id); }
      catch (error: any) { this.problems.set(id, String(error?.message || error).slice(0, 300)); }
    }
  }
  /** Nothing is stopped with PAL: a service that was started for the person stays until they stop it. */
  close() { this.closed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}
