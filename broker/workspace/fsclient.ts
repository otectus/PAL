/**
 * The broker's side of pal-workspacefs. Every Workbench file operation runs in that helper, which
 * resolves paths beneath an open root without following links (native/workspacefs.cpp). When the
 * helper is missing or the kernel cannot confine paths, file tools are unavailable: there is no
 * fallback to ordinary host paths.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class WorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
/** A root as the helper sees it: its canonical path and the identity recorded when it was chosen. */
export type RootHandle = { path: string; dev: string; ino: string };
export type HelperStat = { type: 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'device' | 'other' | 'unavailable'; size: number; mtimeMs: number; mode: number; nlink: number; dev: string; ino: string };

let located: string | null | undefined;
/** The helper's location: an explicit override, the installed copy beside the broker, or the development build. */
export function helperPath(): string | null {
  const configured = process.env.PAL_WORKSPACEFS || process.env.CERE_WORKSPACEFS;
  if (configured) return existsSync(configured) ? configured : null;
  if (located !== undefined) return located;
  const candidates = ['../../native/pal-workspacefs', '../../build/pal-workspacefs'].map(path => fileURLToPath(new URL(path, import.meta.url)));
  located = candidates.find(path => { try { const info = statSync(path); return info.isFile() && (info.mode & 0o111) !== 0; } catch { return false; } }) || null;
  return located;
}
/** Re-resolve the helper on the next call (tests and installs that add it later). */
export function resetHelperPath() { located = undefined; }

let probed: Promise<string> | undefined;
/** Empty when confinement works on this system, otherwise why file access is unavailable. */
export function confinementProblem(): Promise<string> {
  if (!helperPath()) return Promise.resolve('PAL’s workspace helper (pal-workspacefs) is not installed. Rebuild or reinstall PAL to browse and edit files.');
  probed ||= run(['probe'], { timeoutMs: 5000 }).then(() => '', (error: any) => { probed = undefined; return error?.message || 'File confinement is unavailable on this system'; });
  return probed;
}

export type RunOptions = { input?: Buffer; timeoutMs?: number; signal?: AbortSignal; maxOutput?: number };
/** Runs one helper operation. Expected failures become WorkspaceError with the helper's code. */
export function run<T = any>(args: string[], options: RunOptions = {}): Promise<T> {
  const helper = helperPath();
  if (!helper) return Promise.reject(new WorkspaceError('unavailable', 'PAL’s workspace helper (pal-workspacefs) is not installed. Rebuild or reinstall PAL to use file tools.'));
  options.signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    // The helper gets no broker environment: no keys, no tokens, no session variables.
    const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const chunks: Buffer[] = []; let size = 0, settled = false, errorText = '';
    const limit = options.maxOutput ?? 32 * 1024 * 1024;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) { if (child.exitCode === null) child.kill('SIGKILL'); reject(error); } else resolve(value as T);
    };
    const abort = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Stopped'));
    const timer = setTimeout(() => finish(new WorkspaceError('timeout', 'The file operation took too long and was stopped')), options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) finish(new WorkspaceError('too-large', 'The file operation returned more data than allowed')); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (errorText.length < 2000) errorText += chunk.toString(); });
    child.on('error', error => finish(new WorkspaceError('unavailable', 'PAL’s workspace helper could not start: ' + error.message)));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new WorkspaceError('helper-failed', 'PAL’s workspace helper failed' + (errorText ? ': ' + errorText.trim().slice(0, 300) : '')));
      let value: any;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new WorkspaceError('helper-failed', 'PAL’s workspace helper returned an unreadable result')); }
      if (value?.ok !== true) return finish(new WorkspaceError(String(value?.code || 'failed'), String(value?.message || 'The file operation failed')));
      finish(null, value);
    });
    child.stdin.end(options.input || Buffer.alloc(0));
  });
}
export const rootArgs = (root: RootHandle) => [root.path, root.dev, root.ino];
export const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');
