import type { ChildProcess } from 'node:child_process';
import { getPriority, setPriority } from 'node:os';

/** Lower CPU priority for background processes, so replies and the window stay responsive. */
export const backgroundNice = 10;
export function background(child: ChildProcess) {
  // Never raise priority: if the broker already runs nicer than this (a system tuner may renice it), keep that.
  child.once('spawn', () => { try { if (child.pid) setPriority(child.pid, Math.max(backgroundNice, getPriority())); } catch { /* Priority is a courtesy, not a requirement. */ } });
}
export function waitForClose(process: ChildProcess): Promise<number | null> {
  return new Promise((resolveClose, reject) => {
    let spawnError: Error | undefined;
    process.once('error', error => { spawnError = error; });
    process.once('close', code => spawnError ? reject(spawnError) : resolveClose(code));
  });
}
