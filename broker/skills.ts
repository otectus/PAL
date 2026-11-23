/**
 * Portable skills (PAL Everywhere §12): `SKILL.md` packages the owner imports, reviews once and enables.
 *
 * Importing never runs anything. A package comes from a folder on this computer, a ZIP archive or a git
 * repository pinned to the commit it resolved to; it is validated (a SKILL.md at its root, no links, no traversal,
 * bounded files and bytes) and stored by content as a new version waiting for review. The review shows the name,
 * source, every file and which ones are executable; enabling it is the one approval. An update is a new version:
 * the reviewed one stays active until the new one is reviewed, so changed instructions or scripts never slip in.
 *
 * At run time a tool-capable model sees compact metadata of the enabled skills that apply (automatic ones, and
 * explicit ones only when the user names them), loads full instructions on demand and reads package files by
 * path. Skills grant nothing: scripts run only through the same reviewed executors as any other command, and a
 * skill's text is reference material, never a higher-priority instruction.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Core } from './core.ts';
import { listZip, readMember } from './artifacts/zip.ts';
import { remoteError } from './execution.ts';

const run = promisify(execFile);
export const skillLimits = { files: 200, bytes: 20 * 1024 * 1024, fileBytes: 5 * 1024 * 1024, depth: 8, instructions: 128 * 1024, resource: 256 * 1024 };
const executableExtensions = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin|jar|so|dll)$/i;

export type SkillFile = { path: string; sha256: string; mime: string; bytes: number; executable: boolean };
export type SkillVersion = {
  id: string; skillId: string; name: string; description: string; contentHash: string; license?: string;
  source: { kind: 'local' | 'archive' | 'repository'; uri?: string; revision?: string };
  entrypoint: 'SKILL.md'; files: SkillFile[];
  scope: 'personal' | 'project'; project?: string;
  invocation: 'explicit' | 'automatic';
  status: 'review' | 'enabled' | 'disabled' | 'superseded';
  importedAt: number; reviewedAt?: number;
};
type Imported = { path: string; data: Buffer; executable: boolean };

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const mimeOf = (path: string) => /\.md$/i.test(path) ? 'text/markdown' : /\.(txt|json|ya?ml|toml|csv|html?|css|xml|ini|cfg)$/i.test(path) ? 'text/plain' : executableExtensions.test(path) ? 'text/x-script' : 'application/octet-stream';
/** The name, description and license a SKILL.md declares in its front matter (or its first heading and paragraph). */
export function frontMatter(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields: Record<string, string> = {};
  if (match) for (const line of match[1].split(/\r?\n/)) { const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/); if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  const body = match ? text.slice(match[0].length) : text;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const paragraph = body.split(/\r?\n\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith('#'));
  return { name: fields.name || heading || '', description: fields.description || paragraph || '', license: fields.license };
}
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export class Skills {
  core: Core;
  constructor(core: Core) { this.core = core; }
  get directory() { return join(this.core.store.directory, 'skills'); }
  list(): SkillVersion[] { return this.core.store.get<SkillVersion[]>('skills.versions', []); }
  revision() { return this.core.store.get<string>('skills.revision', '0'); }
  private save(versions: SkillVersion[]) {
    this.core.store.transaction(() => { this.core.store.set('skills.versions', versions); this.core.store.set('skills.revision', String(BigInt(this.revision()) + 1n)); });
    this.core.changed();
  }
  version(id: string) { const found = this.list().find(v => v.id === id); if (!found) throw remoteError('INVALID_ARGUMENT', 'That skill version no longer exists.'); return found; }
  private async content(file: SkillFile) {
    const data = await readFile(join(this.directory, 'objects', file.sha256));
    if (sha(data) !== file.sha256) throw new Error(`${file.path} no longer matches what was reviewed`);
    return data;
  }

  /** A folder on this computer: regular files only, no links, bounded. */
  async importFolder(path: string, source: SkillVersion['source'] = { kind: 'local', uri: path }) {
    const files: Imported[] = []; let total = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > skillLimits.depth) throw new Error('The skill folder is nested too deeply');
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        const full = join(dir, entry.name), info = await lstat(full);
        if (info.isSymbolicLink()) throw new Error(`The skill contains a link (${relative(path, full)}); links are not imported`);
        if (info.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!info.isFile()) continue;
        if (files.length >= skillLimits.files) throw new Error(`A skill has at most ${skillLimits.files} files`);
        if (info.size > skillLimits.fileBytes) throw new Error(`${relative(path, full)} is larger than 5 MiB`);
        total += info.size; if (total > skillLimits.bytes) throw new Error('A skill is at most 20 MiB');
        files.push({ path: relative(path, full).split(sep).join('/'), data: await readFile(full), executable: (info.mode & 0o111) !== 0 });
      }
    };
    await walk(path, 0);
    return this.install(files, source);
  }
  /** A ZIP archive: names checked by the archive reader before anything is inflated; one top folder is unwrapped. */
  async importArchive(data: Buffer, uri: string) {
    const entries = listZip(data, { entries: skillLimits.files * 2, members: skillLimits.files, expandedBytes: skillLimits.bytes, memberBytes: skillLimits.fileBytes, ratio: 100 }).filter(entry => !entry.directory);
    if (entries.length > skillLimits.files) throw new Error(`A skill has at most ${skillLimits.files} files`);
    const tops = new Set(entries.map(entry => entry.name.split('/')[0]));
    const strip = tops.size === 1 && entries.every(entry => entry.name.includes('/')) ? [...tops][0] + '/' : '';
    const files: Imported[] = [];
    for (const entry of entries) {
      const path = entry.name.slice(strip.length);
      if (!path || path.split('/').some(part => part === '.git')) continue;
      files.push({ path, data: await readMember(data, entry, skillLimits.fileBytes), executable: false });
    }
    return this.install(files, { kind: 'archive', uri });
  }
  /** A git repository, cloned shallowly over HTTPS and pinned to the commit it resolved to. Hooks never run. */
  async importRepository(url: string, ref?: string) {
    if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 500) throw new Error('Give an https:// git repository address');
    if (ref !== undefined && !/^[A-Za-z0-9._\/-]{1,100}$/.test(ref)) throw new Error('Give a branch or tag name');
    const temporary = await mkdtemp(join(tmpdir(), 'pal-skill-'));
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
      await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'clone', '--depth', '1', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', url, join(temporary, 'repo')], { env, timeout: 120_000 })
        .catch(error => { throw new Error('The repository could not be fetched: ' + String(error?.stderr || error?.message || error).trim().split('\n').slice(-1)[0].slice(0, 200)); });
      const revision = (await run('git', ['-C', join(temporary, 'repo'), 'rev-parse', 'HEAD'], { env })).stdout.trim();
      return await this.importFolder(join(temporary, 'repo'), { kind: 'repository', uri: url, revision });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  private async install(files: Imported[], source: SkillVersion['source']) {
    const entry = files.find(file => file.path === 'SKILL.md');
    if (!entry) throw new Error('A skill needs a SKILL.md at its top level');
    if (entry.data.length > skillLimits.instructions) throw new Error('SKILL.md is larger than 128 KiB');
    const paths = new Set<string>();
    for (const file of files) { if (paths.has(file.path) || file.path.split('/').some(part => part === '..' || part === '')) throw new Error(`Unsafe or duplicate path ${file.path.slice(0, 80)}`); paths.add(file.path); }
    const meta = frontMatter(entry.data.toString('utf8'));
    if (!meta.name) throw new Error('SKILL.md does not name the skill (add name: in its front matter)');
    await mkdir(join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
    const listed: SkillFile[] = [];
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const hash = sha(file.data), target = join(this.directory, 'objects', hash);
      if (!existsSync(target)) await writeFile(target, file.data, { mode: 0o600 });
      const executable = file.executable || executableExtensions.test(file.path) || file.data.subarray(0, 2).toString() === '#!';
      listed.push({ path: file.path, sha256: hash, mime: mimeOf(file.path), bytes: file.data.length, executable });
    }
    const contentHash = sha(listed.map(file => `${file.path}\0${file.sha256}`).join('\n'));
    const versions = this.list(), skillId = slug(meta.name) || 'skill';
    const same = versions.find(v => v.skillId === skillId && v.contentHash === contentHash);
    if (same) return same;
    const version: SkillVersion = { id: randomUUID(), skillId, name: meta.name.slice(0, 80), description: meta.description.replace(/\s+/g, ' ').slice(0, 600), contentHash, ...(meta.license ? { license: meta.license.slice(0, 80) } : {}),
      source, entrypoint: 'SKILL.md', files: listed, scope: 'personal', invocation: 'explicit', status: 'review', importedAt: Date.now() };
    this.save([...versions, version]);
    this.core.store.activity({ action: 'skill.import', skill: version.name, status: 'review' });
    return version;
  }
  /** Everything the owner reviews before enabling: files, executables, and what changed since the active version. */
  async review(id: string) {
    const version = this.version(id), instructions = (await this.content(version.files.find(f => f.path === 'SKILL.md')!)).toString('utf8');
    const previous = this.list().find(v => v.skillId === version.skillId && v.status === 'enabled' && v.id !== version.id);
    const changes = previous ? {
      previousId: previous.id,
      instructionsChanged: previous.files.find(f => f.path === 'SKILL.md')?.sha256 !== version.files.find(f => f.path === 'SKILL.md')?.sha256,
      added: version.files.filter(f => !previous.files.some(p => p.path === f.path)).map(f => f.path),
      removed: previous.files.filter(f => !version.files.some(p => p.path === f.path)).map(f => f.path),
      changed: version.files.filter(f => previous.files.some(p => p.path === f.path && p.sha256 !== f.sha256)).map(f => f.path),
    } : null;
    return { version, instructions, executables: version.files.filter(f => f.executable).map(f => f.path), changes, revision: this.revision() };
  }
  /** The one approval: enabling a reviewed version (and retiring the version it replaces). */
  enable(p: { versionId: string; invocation?: 'explicit' | 'automatic'; scope?: 'personal' | 'project'; project?: string; expectedRevision?: string }) {
    if (p.expectedRevision !== undefined && p.expectedRevision !== this.revision()) throw remoteError('REVISION_CONFLICT', 'Skills changed on another device. Review again.');
    const version = this.version(p.versionId);
    if (p.scope === 'project' && (typeof p.project !== 'string' || !p.project.startsWith('/'))) throw new Error('Choose the project folder this skill applies to');
    const versions = this.list().map(v => v.id === version.id ? { ...v, status: 'enabled' as const, reviewedAt: Date.now(), invocation: p.invocation || v.invocation, scope: p.scope || v.scope, ...(p.scope === 'project' ? { project: p.project } : p.scope === 'personal' ? { project: undefined } : {}) }
      : v.skillId === version.skillId && v.status === 'enabled' ? { ...v, status: 'superseded' as const } : v);
    this.save(versions);
    this.core.store.activity({ action: 'skill.enable', skill: version.name, status: 'enabled' });
    return versions.find(v => v.id === version.id)!;
  }
  disable(id: string) { this.version(id); const versions = this.list().map(v => v.id === id ? { ...v, status: 'disabled' as const } : v); this.save(versions); return versions.find(v => v.id === id)!; }
  async remove(skillId: string) {
    const versions = this.list(), kept = versions.filter(v => v.skillId !== skillId);
    if (kept.length === versions.length) throw new Error('That skill no longer exists');
    this.save(kept);
    const used = new Set(kept.flatMap(v => v.files.map(f => f.sha256)));
    for (const file of versions.filter(v => v.skillId === skillId).flatMap(v => v.files)) if (!used.has(file.sha256)) await rm(join(this.directory, 'objects', file.sha256), { force: true });
    return true;
  }
  /** Enabled skills for this conversation: personal ones and those of its project; explicit ones only when named. */
  applicable(cwd: string, text = '') {
    const lower = text.toLowerCase();
    return this.list().filter(v => v.status === 'enabled' && (v.scope === 'personal' || (v.project && (cwd === v.project || cwd.startsWith(v.project + '/'))))
      && (v.invocation === 'automatic' || lower.includes(v.name.toLowerCase()) || lower.includes('$' + v.skillId) || lower.includes('/' + v.skillId)));
  }
  async instructions(id: string) { const version = this.version(id); return (await this.content(version.files.find(f => f.path === 'SKILL.md')!)).toString('utf8'); }
  /** A file of the package by its path inside the skill, never outside it. */
  async resource(id: string, path: string) {
    const version = this.version(id), file = version.files.find(f => f.path === path);
    if (!file) throw new Error(`${path.slice(0, 120)} is not part of this skill`);
    const data = await this.content(file);
    if (file.bytes > skillLimits.resource || data.includes(0)) return { path, bytes: file.bytes, executable: file.executable, text: null, note: 'This file is binary or larger than 256 KiB; it is not shown as text.' };
    return { path, bytes: file.bytes, executable: file.executable, text: data.toString('utf8') };
  }
}
