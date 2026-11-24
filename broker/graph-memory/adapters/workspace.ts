import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch, type FSWatcher } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { LiveCollector, LiveObservation } from './contracts.ts';
import { LiveObservationFactory } from './live.ts';

const execFileAsync = promisify(execFile);

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export interface FilesystemCollectorConfig {
  approvedRoots: string[];
  excludes?: RegExp[];
  ttlMs?: number;
}

export class FilesystemMetadataCollector implements LiveCollector {
  readonly config: FilesystemCollectorConfig;
  private roots: string[] = [];
  private watchers: FSWatcher[] = [];
  private emit?: (observation: LiveObservation) => void;
  private factory: LiveObservationFactory;
  private identities = new Map<string, { generation: string; device: number; inode: number; exists: boolean }>();
  private stopped = false;
  constructor(config: FilesystemCollectorConfig) { this.config = config; this.factory = new LiveObservationFactory('filesystem', config.ttlMs ?? 10_000); }
  async start(emit: (observation: LiveObservation) => void): Promise<void> {
    this.emit = emit; this.roots = await Promise.all(this.config.approvedRoots.map(root => realpath(root)));
    for (const root of this.roots) this.watchers.push(watch(root, { recursive: true }, (eventType, filename) => {
      if (filename === null) return;
      void this.observe(root, String(filename), eventType).catch(() => {});
    }));
  }
  private async observe(root: string, filename: string, eventType: string) {
    const lexical = resolve(root, filename);
    if (!inside(root, lexical) || this.config.excludes?.some(pattern => pattern.test(relative(root, lexical)))) return;
    let canonical = lexical, fileStat: Awaited<ReturnType<typeof stat>> | undefined;
    try { canonical = await realpath(lexical); if (!inside(root, canonical)) return; fileStat = await stat(canonical); } catch { /* deletion metadata uses the verified lexical root */ }
    // A watch callback completing after stop() must not reinsert revoked metadata.
    if (this.stopped) return;
    const identityKey = `${root}:${relative(root, lexical)}`, prior = this.identities.get(identityKey);
    const device = fileStat ? Number(fileStat.dev) : prior?.device ?? 0, inode = fileStat ? Number(fileStat.ino) : prior?.inode ?? 0;
    const sameObject = Boolean(fileStat && prior?.exists && prior.device === device && prior.inode === inode);
    const generation = sameObject ? prior!.generation : fileStat ? randomUUID() : prior?.generation ?? randomUUID();
    this.identities.set(identityKey, { generation, device, inode, exists: Boolean(fileStat) });
    this.emit?.(this.factory.observation(`path:${root}:${relative(root, canonical)}`, generation, 'FILESYSTEM_METADATA', {
      eventType, root, path: canonical, exists: Boolean(fileStat), ...(fileStat ? {
        kind: fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : 'other', size: Number(fileStat.size),
        modifiedAtMs: Math.trunc(Number(fileStat.mtimeMs)), device, inode,
      } : {}),
    }));
  }
  async reconcile(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; for (const watcher of this.watchers) watcher.close(); this.watchers = []; this.emit = undefined; }
}

function redactRemote(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.toString(); }
  catch { return value.replace(/^[^@\s]+@/u, ''); }
}

export interface CheckoutMetadata {
  checkoutId: string;
  checkoutRoot: string;
  gitDirectory: string;
  commonDirectory: string;
  branch: string | null;
  remote: string | null;
}

const checkoutIds = new Map<string, string>();

export async function inspectGitCheckout(path: string, git = 'git'): Promise<CheckoutMetadata> {
  // Git reports relative metadata paths against the -C directory, not the checkout root.
  // Request absolute paths, and resolve any relative fallback against the -C directory.
  const base = await realpath(path);
  const rootResult = await execFileAsync(git, ['-C', base, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { timeout: 3_000, maxBuffer: 256 * 1024 });
  const [rootText, gitDirectoryText, commonDirectoryText] = rootResult.stdout.trim().split('\n');
  if (!rootText || !gitDirectoryText || !commonDirectoryText) throw new Error('Git returned incomplete checkout metadata');
  const checkoutRoot = await realpath(resolve(base, rootText)), gitDirectory = await realpath(resolve(base, gitDirectoryText)), commonDirectory = await realpath(resolve(base, commonDirectoryText));
  const rootStat = await stat(checkoutRoot);
  const identityKey = JSON.stringify([Number(rootStat.dev), Number(rootStat.ino), checkoutRoot, gitDirectory]);
  let checkoutId = checkoutIds.get(identityKey);
  if (!checkoutId) { checkoutId = randomUUID(); checkoutIds.set(identityKey, checkoutId); }
  const branchResult = await execFileAsync(git, ['-C', checkoutRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 3_000, maxBuffer: 64 * 1024 }).catch(() => undefined);
  const remoteResult = await execFileAsync(git, ['-C', checkoutRoot, 'remote', 'get-url', 'origin'], { timeout: 3_000, maxBuffer: 64 * 1024 }).catch(() => undefined);
  return {
    checkoutId, checkoutRoot, gitDirectory, commonDirectory, branch: branchResult?.stdout.trim() || null,
    remote: remoteResult?.stdout.trim() ? redactRemote(remoteResult.stdout.trim()) : null,
  };
}

export class RepositoryCollector implements LiveCollector {
  readonly roots: string[];
  private emit?: (observation: LiveObservation) => void;
  private factory = new LiveObservationFactory('repository', 60_000);
  constructor(roots: string[]) { this.roots = roots; }
  async start(emit: (observation: LiveObservation) => void): Promise<void> { this.emit = emit; await this.reconcile(); }
  async reconcile(): Promise<void> {
    for (const path of this.roots) try {
      const checkout = await inspectGitCheckout(path);
      this.emit?.(this.factory.observation(`checkout:${checkout.checkoutId}`, checkout.checkoutId, 'CHECKOUT_METADATA', { ...checkout }));
    } catch { /* an unavailable root is an optional collector capability */ }
  }
  async stop(): Promise<void> { this.emit = undefined; }
}
