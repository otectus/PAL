/**
 * The Python environment of the optional LiteLLM bridge. The person may point PAL at one of their own
 * (PAL_LITELLM_PYTHON), let PAL keep an isolated one with exact, hash-checked versions, or use a system Python that
 * already has LiteLLM. Nothing is downloaded or removed unless asked for, and nothing outside PAL's own folder changes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../../tools/setup-litellm.py', import.meta.url));
export const bridgeRoot = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'pal/litellm');
export type BridgeRuntimeStatus = { source: 'chosen' | 'managed' | 'system'; python: string; version: string; offered: string; installed: boolean; busy: boolean; stage: string; error: string };

/** The interpreter of PAL's own environment, when the folder is as this PAL made it. */
function managed(root: string): { python: string; version: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), python = join(root, 'venv/bin/python');
    if (value.version !== 1 || resolve(String(value.python)) !== resolve(python) || lstatSync(join(root, 'venv')).isSymbolicLink() || !existsSync(python)) return undefined;
    return { python, version: String(value.litellm || '') };
  } catch { return undefined; }
}
export function bridgePython(env: NodeJS.ProcessEnv = process.env): string { return env.PAL_LITELLM_PYTHON || managed(bridgeRoot(env))?.python || 'python3'; }
const stages: Record<string, string> = { environment: 'Preparing PAL’s own Python environment…', packages: 'Downloading LiteLLM and checking every file…', checking: 'Starting LiteLLM once…' };

export class BridgeRuntime {
  private readonly env: NodeJS.ProcessEnv; private readonly changed: () => void; private readonly stopWorkers: () => void;
  /** Seam for tests: the command that installs or removes. */
  command: [string, string] = ['python3', tool];
  private job?: ChildProcess; private done = Promise.resolve(); private stage = ''; private error = '';
  constructor(changed: () => void, stopWorkers: () => void, env: NodeJS.ProcessEnv = process.env) { this.changed = changed; this.stopWorkers = stopWorkers; this.env = env; }
  private offered() { try { return /^litellm==(\S+)/m.exec(readFileSync(join(tool, '../litellm-lock.txt'), 'utf8'))?.[1] || ''; } catch { return ''; } }
  status(): BridgeRuntimeStatus {
    const own = managed(bridgeRoot(this.env)), chosen = this.env.PAL_LITELLM_PYTHON || '';
    return { source: chosen ? 'chosen' : own ? 'managed' : 'system', python: chosen || own?.python || 'python3', version: own?.version || '', offered: this.offered(), installed: !!own, busy: !!this.job, stage: this.stage, error: this.error };
  }
  install(params: any): BridgeRuntimeStatus { if (params?.confirmed !== true) throw new Error('Confirm downloading LiteLLM into PAL’s own folder'); return this.run('install'); }
  remove(params: any): BridgeRuntimeStatus { if (params?.confirmed !== true) throw new Error('Confirm removing PAL’s LiteLLM environment'); return this.run('remove'); }
  private run(action: 'install' | 'remove') {
    if (this.job) throw new Error('LiteLLM is already being installed or removed');
    const root = bridgeRoot(this.env);
    if (!resolve(root).endsWith(join('pal', 'litellm')) || resolve(root).split(sep).length < 4) throw new Error('PAL’s LiteLLM folder is not usable');
    // A worker keeps the environment's files open and its code loaded.
    this.stopWorkers(); this.error = ''; this.stage = action === 'install' ? stages.environment : 'Removing PAL’s LiteLLM environment…';
    const child = this.job = spawn(this.command[0], ['-I', this.command[1], action, '--root', root], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let buffer = '', finished = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer = (buffer + chunk).slice(-65536);
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const event = JSON.parse(line); if (event.state === 'error') this.error = String(event.message || 'It did not finish.').slice(0, 300); else if (event.state === 'installed' || event.state === 'removed') finished = true; else if (stages[event.stage]) this.stage = stages[event.stage]; } catch { /* Only whole lines of the tool count. */ }
        this.changed();
      }
    });
    this.done = new Promise<void>(end => {
      const settle = (problem?: string) => { if (this.job !== child) return; this.job = undefined; this.stage = ''; if (problem && !this.error) this.error = problem; this.changed(); end(); };
      child.once('error', error => settle((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Python 3 was not found.' : 'The installer could not start.'));
      child.once('close', () => settle(finished ? undefined : 'It did not finish. Nothing was changed.'));
    });
    this.changed(); return this.status();
  }
  async cancel(): Promise<BridgeRuntimeStatus> {
    const child = this.job; if (!child?.pid) return this.status();
    this.error = 'Stopped. Nothing was changed.';
    const signal = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch { /* It has ended. */ } };
    signal('SIGTERM');
    // It clears away what it had downloaded first.
    const timer = setTimeout(() => signal('SIGKILL'), 15_000); timer.unref(); await this.done; clearTimeout(timer);
    return this.status();
  }
  idle() { return this.done; }
  async close() { if (this.job) await this.cancel(); }
}
