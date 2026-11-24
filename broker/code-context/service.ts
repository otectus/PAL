/**
 * Code context (A03, opt-in for each project): an index of what a project's code declares, imports and calls, kept on this
 * computer so a person or an assistant can find code by what it does and see what is around it. It reads source files of
 * the project folder only, by the same rules as Workbench files (no hidden, generated, private or credential files, no
 * links), keeps no copy of them, and is deleted when the project is switched off.
 *
 * Nothing in it is a fact about how the program runs: it is what the text states. Every answer is checked against the
 * file as it is now, says which relationships are certain and which are inferred, and proposes no change by itself.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Core } from '../core.ts';
import type { Session } from '../types.ts';
import { ownerControlled } from '../authority.ts';
import { isApiProvider } from '../provider-catalog.ts';
import { routeAllowed, type DestinationPolicy } from '../tools/contracts.ts';
import { credentialName, excludedDirectories, excludedInside, forbiddenRoot } from '../workspace/policy.ts';
import { ignored, parseIgnore, type IgnoreRule } from '../ignore-rules.ts';
import { CodeIndex, type IndexedSymbol, type Relation } from './index.ts';
import { languageNames, languageOf, type Parsed } from './languages.ts';

export const codeServiceLimits = { files: 6000, fileBytes: 768 * 1024, depth: 24, parseMs: 8000, lookMs: 10_000, waitMs: 2500, excerptLines: 120, excerptChars: 12_000, results: 20, projects: 24, links: 200 };
export type CodeProject = { enabled: boolean; allowCloud: boolean };
export type CodeLink = { id: string; decision: string; key: string; name: string; path: string; created: number };
export type CodeJob = { project: string; processed: number; total: number; started: number; done: boolean; error: string; controller: AbortController };
type Place = { path: string; line: number; endLine: number; name: string; container: string; kind: string; id: number };
const place = (symbol: IndexedSymbol): Place => ({ path: symbol.path, line: symbol.line, endLine: symbol.endLine, name: symbol.name, container: symbol.container, kind: symbol.kind, id: symbol.id });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Parses away from the broker's loop; a file that takes too long is given up, not waited for. */
class Parser {
  private worker?: Worker; private next = 1; private waiting = new Map<number, { done: (value: Parsed | undefined) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>();
  parse(path: string, text: string): Promise<Parsed | undefined> {
    const worker = this.worker ||= this.start(), id = this.next++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.waiting.delete(id); this.stop(new Error('It took too long to read')); fail(new Error('It took too long to read')); }, codeServiceLimits.parseMs); timer.unref();
      this.waiting.set(id, { done, fail, timer }); worker.postMessage({ id, path, text });
    });
  }
  private start() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    worker.on('message', ({ id, parsed, error }) => { const entry = this.waiting.get(id); if (!entry) return; this.waiting.delete(id); clearTimeout(entry.timer); if (error) entry.fail(new Error(error)); else entry.done(parsed); });
    worker.on('error', error => this.stop(error)); worker.unref(); return worker;
  }
  stop(reason = new Error('Stopped')) { const worker = this.worker; this.worker = undefined; void worker?.terminate(); for (const entry of this.waiting.values()) { clearTimeout(entry.timer); entry.fail(reason); } this.waiting.clear(); }
}

export class CodeContext {
  core: Core; job?: CodeJob; now = () => Date.now();
  private opened?: CodeIndex; private parser = new Parser(); private looked = new Map<string, number>(); private running = new Map<string, Promise<void>>(); private closed = false;
  constructor(core: Core) { this.core = core; }
  get index() { if (this.closed) throw new Error('PAL is closing'); return this.opened ||= new CodeIndex(join(this.core.store.directory, 'code-index.sqlite')); }
  private projects() { return this.core.store.get<Record<string, CodeProject>>('codeContext', {}); }
  private saveProjects(value: Record<string, CodeProject>) { this.core.store.set('codeContext', value); this.core.changed(); }
  enabled(cwd: string) { return this.projects()[cwd]?.enabled === true; }
  destinations(cwd: string): DestinationPolicy { const cloud = this.projects()[cwd]?.allowCloud === true; return { remote: cloud, cloud }; }
  /** Why a folder cannot be indexed, or nothing. */
  async refused(cwd: string): Promise<string> {
    const real = await realpath(cwd).catch(() => ''); if (!real) return 'This project’s folder is not there.';
    if (real !== cwd) return 'This project’s folder is a link. Open the folder it points to.';
    if (real === homedir()) return 'The whole home folder is not a project. Choose the project’s own folder.';
    return forbiddenRoot(real);
  }
  /** Whether a conversation may be offered the code tools now, or why not. */
  offered(session: Session): string {
    if (session.temporary || !ownerControlled(session)) return 'Code is not available in this conversation';
    if (!this.enabled(session.cwd)) return 'This project’s code is not indexed (Context › Code in this project)';
    return routeAllowed(this.core.workbench.knownRoute(session.id), this.destinations(session.cwd)) ? '' : 'This project’s code may be read only by models on this computer';
  }
  async configure(p: { sessionId: string; enabled?: unknown; allowCloud?: unknown }) {
    const session = this.core.store.session(p.sessionId), cwd = session.cwd, all = this.projects(), current = all[cwd] || { enabled: false, allowCloud: false };
    if (session.temporary) throw new Error('A temporary conversation keeps nothing, so its project is not indexed from here');
    if ([p.enabled, p.allowCloud].some(value => value !== undefined && typeof value !== 'boolean')) throw new Error('Invalid code context settings');
    const next = { enabled: p.enabled === undefined ? current.enabled : p.enabled as boolean, allowCloud: p.allowCloud === undefined ? current.allowCloud : p.allowCloud as boolean };
    if (next.enabled && !current.enabled) { const refused = await this.refused(cwd); if (refused) throw new Error(refused); if (Object.values(all).filter(item => item.enabled).length >= codeServiceLimits.projects) throw new Error(`Up to ${codeServiceLimits.projects} projects can be indexed. Switch one off first.`); }
    if (!next.enabled) {
      // Off means gone: the index, and the links that point into it.
      if (this.job?.project === cwd && !this.job.done) this.job.controller.abort(new Error('Switched off'));
      await this.running.get(cwd)?.catch(() => {});
      const { [cwd]: _gone, ...rest } = this.projects(); this.saveProjects(rest); this.index.removeProject(cwd); this.saveLinks(cwd, []); this.looked.delete(cwd);
    } else { this.saveProjects({ ...this.projects(), [cwd]: next }); if (!current.enabled) void this.refresh(cwd, true).catch(() => {}); }
    this.core.store.activity({ action: 'code.configure', enabled: next.enabled, allowCloud: next.allowCloud, status: 'completed' });
    return this.status({ sessionId: p.sessionId });
  }
  async status(p: { sessionId: string }) {
    const session = this.core.store.session(p.sessionId), cwd = session.cwd, project = this.projects()[cwd] || { enabled: false, allowCloud: false };
    const job = this.job && this.job.project === cwd && !this.job.done ? { processed: this.job.processed, total: this.job.total } : null;
    if (!project.enabled) return { project: cwd, enabled: false, allowCloud: false, refused: session.temporary ? 'A temporary conversation keeps nothing, so its project is not indexed from here.' : await this.refused(cwd), files: 0, symbols: 0, languages: [] as string[], problems: 0, indexed: 0, job: null, offered: '', links: [] as unknown[] };
    const counts = this.index.counts(cwd);
    return { project: cwd, enabled: true, allowCloud: project.allowCloud, refused: '', files: counts.files, symbols: counts.symbols, languages: counts.languages.map(language => languageNames[language]), problems: counts.problems, indexed: this.looked.get(cwd) || 0, job, offered: session.provider === 'ollama' || isApiProvider(session.provider) ? this.offered(session) : 'Codex, Claude Code and other command-line providers read the project themselves.', links: this.links(cwd).map(link => ({ ...link, missing: !this.index.byKey(cwd, link.key) })) };
  }
  private async rules(cwd: string): Promise<IgnoreRule[]> {
    const rules: IgnoreRule[] = [];
    for (const name of ['.gitignore', '.palignore']) try { const info = await lstat(join(cwd, name)); if (info.isFile()) { const parsed = parseIgnore(await readFile(join(cwd, name), 'utf8')); if (parsed) rules.push(...parsed); else if (name === '.palignore') throw new Error('unreadable'); } } catch (error: any) { if (error?.code !== 'ENOENT' && name === '.palignore') throw new Error('This project’s .palignore could not be read, so none of its code is indexed.'); }
    return rules;
  }
  /** Source files of the project: never hidden, generated, ignored, private, or a link. */
  private async enumerate(cwd: string, signal: AbortSignal) {
    const rules = await this.rules(cwd), priv = excludedInside(cwd), found: string[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      if (depth > codeServiceLimits.depth) return;
      for (const entry of (await readdir(join(cwd, folder), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
        signal.throwIfAborted();
        if (found.length >= codeServiceLimits.files) return;
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || credentialName(entry.name)) continue;
        const path = folder ? folder + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { if (!excludedDirectories.includes(entry.name) && !priv.some(item => path === item || path.startsWith(item + '/')) && !ignored(rules, path, true)) await walk(path, depth + 1); }
        else if (entry.isFile() && languageOf(path) && !ignored(rules, path, false)) found.push(path);
      }
    };
    await walk('', 0); return found;
  }
  /** A file's text as it is now, when it is still an ordinary file inside the project. */
  private async read(cwd: string, path: string): Promise<{ text: string; sha256: string; size: number; mtime: number; problem: string }> {
    const full = join(cwd, path);
    if (await realpath(full) !== full) throw Object.assign(new Error('It is now a link'), { code: 'ENOENT' });
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile()) throw Object.assign(new Error('It is no longer a file'), { code: 'ENOENT' });
      const base = { size: info.size, mtime: info.mtimeMs };
      if (info.size > codeServiceLimits.fileBytes) return { text: '', sha256: '', ...base, problem: `Larger than ${codeServiceLimits.fileBytes / 1024} KB` };
      const bytes = await handle.readFile(); if (bytes.includes(0)) return { text: '', sha256: digest(bytes.toString('latin1')), ...base, problem: 'Not a text file' };
      return { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex'), ...base, problem: '' };
    } finally { await handle.close(); }
  }
  /** Brings one file up to date. Answers whether anything about it changed. */
  private async update(cwd: string, path: string, known = this.index.files(cwd).get(path)): Promise<boolean> {
    let now; try { now = await this.read(cwd, path); } catch (error: any) { if (known) this.index.remove(cwd, path); return !!known; }
    if (known && known.size === now.size && known.sha256 === now.sha256 && known.problem === now.problem) { if (known.mtime !== now.mtime) this.index.touch(cwd, path, now.size, now.mtime); return false; }
    let parsed: Parsed | undefined, problem = now.problem;
    if (!problem) try { parsed = await this.parser.parse(path, now.text); if (parsed?.truncated) problem = 'Only its first part was read'; } catch (error: any) { problem = String(error?.message || 'It could not be read').slice(0, 120); }
    if (this.closed || !this.enabled(cwd)) return false;
    this.index.replace(cwd, { path, language: languageOf(path)!, sha256: now.sha256, size: now.size, mtime: now.mtime, problem }, parsed);
    return true;
  }
  /** Looks over the whole project. One at a time for a project; it steps aside while a reply is being written. */
  refresh(cwd: string, background = false): Promise<void> {
    const running = this.running.get(cwd); if (running) return running;
    const job: CodeJob = { project: cwd, processed: 0, total: 0, started: this.now(), done: false, error: '', controller: new AbortController() }, signal = job.controller.signal;
    const task = (async () => {
      const listed = this.core.jobs.add('code-index', 'Reading code in ' + cwd.split('/').at(-1), () => job.controller.abort(new Error('Stopped')), () => ({ done: job.processed, total: job.total }));
      this.job = job; this.core.changed();
      try {
        const paths = await this.enumerate(cwd, signal), known = this.index.files(cwd); job.total = paths.length;
        for (const path of paths) {
          signal.throwIfAborted(); if (background) await this.core.jobs.yieldToForeground(signal);
          const old = known.get(path); known.delete(path); let same = false;
          if (old) try { const info = await stat(join(cwd, path)); same = info.size === old.size && info.mtimeMs === old.mtime; } catch { /* Gone: update() removes it. */ }
          if (!same) await this.update(cwd, path, old);
          job.processed++; if (job.processed % 200 === 0) this.core.changed();
        }
        signal.throwIfAborted();
        for (const path of known.keys()) this.index.remove(cwd, path);
        this.looked.set(cwd, this.now());
      } catch (error: any) { job.error = signal.aborted ? '' : String(error?.message || error).slice(0, 300); if (/palignore/.test(job.error)) this.index.removeProject(cwd); throw error; }
      finally { job.done = true; listed(); this.running.delete(cwd); this.parser.stop(); if (!this.closed) this.core.changed(); }
    })();
    this.running.set(cwd, task); void task.catch(() => {}); return task;
  }
  /** Recent enough to answer from: looks again after a while, and answers with what there is when that takes long. */
  private async fresh(cwd: string): Promise<{ indexing: boolean }> {
    if (this.now() - (this.looked.get(cwd) || 0) < codeServiceLimits.lookMs && !this.running.has(cwd)) return { indexing: false };
    const task = this.refresh(cwd); let timer: NodeJS.Timeout | undefined;
    const late = await Promise.race([task.then(() => false, () => false), new Promise<boolean>(done => { timer = setTimeout(() => done(true), codeServiceLimits.waitMs); timer.unref(); })]);
    clearTimeout(timer); return { indexing: late };
  }
  /** Files an answer rests on, read again when they changed since. Answers whether any did. */
  private async verify(cwd: string, paths: Iterable<string>): Promise<boolean> {
    const known = this.index.files(cwd); let changed = false;
    for (const path of [...new Set(paths)].slice(0, 60)) {
      const old = known.get(path); let same = false;
      try { const info = await stat(join(cwd, path)); same = !!old && info.size === old.size && info.mtimeMs === old.mtime; } catch { /* Gone. */ }
      if (!same && await this.update(cwd, path, old)) changed = true;
    }
    return changed;
  }
  private project(sessionId: string) {
    const session = this.core.store.session(sessionId);
    if (!this.enabled(session.cwd)) throw new Error('This project’s code is not indexed');
    return session.cwd;
  }
  async find(p: { sessionId: string; query: unknown; limit?: unknown }) {
    const cwd = this.project(p.sessionId);
    if (typeof p.query !== 'string' || p.query.trim().length < 2 || p.query.length > 500) throw new Error('Ask with 2–500 characters');
    const limit = Math.max(1, Math.min(codeServiceLimits.results, Number(p.limit) || 10)), { indexing } = await this.fresh(cwd);
    let found = this.index.find(cwd, p.query, limit);
    if (await this.verify(cwd, found.map(item => item.symbol.path))) found = this.index.find(cwd, p.query, limit);
    return { query: p.query, indexing, results: found.map(({ symbol, why }) => ({ ...place(symbol), signature: symbol.signature, about: symbol.doc, declaration: symbol.declaration, confidence: symbol.confidence, why })) };
  }
  /** One symbol and what is around it, as the files are now. */
  async around(p: { sessionId: string; id?: unknown; name?: unknown; path?: unknown }) {
    const cwd = this.project(p.sessionId), { indexing } = await this.fresh(cwd);
    const pick = () => {
      if (Number.isInteger(p.id)) return this.index.symbol(cwd, p.id as number);
      if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('Name a symbol, or give its ID from a search');
      const pieces = p.name.trim().split(/\.|::/), rows = this.index.named(cwd, pieces.at(-1)!).filter(row => (pieces.length < 2 || row.container === pieces.at(-2)) && (typeof p.path !== 'string' || row.path === p.path || row.path.endsWith('/' + p.path)));
      return rows.length > 1 ? rows : rows[0];
    };
    let target = pick();
    if (target && await this.verify(cwd, (Array.isArray(target) ? target : [target]).map(row => row.path))) {
      // The file moved on: the same thing is looked for by what it is, not by where it was.
      const was = Array.isArray(target) ? undefined : target.key; target = was ? this.index.byKey(cwd, was) : pick();
    }
    if (!target) throw Object.assign(new Error('Nothing in this project has that name now. Search for it again.'), { code: 'NOT_FOUND' });
    if (Array.isArray(target)) return { several: target.slice(0, 20).map(row => ({ ...place(row), signature: row.signature })), indexing };
    let users = this.index.users(cwd, target), uses = this.index.uses(cwd, target);
    if (await this.verify(cwd, [...users.used, ...users.tests].map(item => item.path))) { const again = this.index.byKey(cwd, target.key); if (again) target = again; users = this.index.users(cwd, target); uses = this.index.uses(cwd, target); }
    const files = this.index.files(cwd), now = await this.read(cwd, target.path), lines = now.text.split('\n').slice(target.line - 1, target.endLine);
    const excerpt = lines.slice(0, codeServiceLimits.excerptLines).join('\n').slice(0, codeServiceLimits.excerptChars);
    const related = (item: Relation) => ({ name: item.name, path: item.path, line: item.line, how: item.how, certainty: item.certainty, ...(item.symbol ? { symbol: place(item.symbol) } : {}), ...(item.candidates ? { candidates: item.candidates } : {}) });
    const key = target.key, linked = this.links(cwd).filter(link => link.key === key);
    return { symbol: { ...place(target), key, signature: target.signature, about: target.doc, declaration: target.declaration, exported: target.exported, confidence: target.confidence }, indexing,
      source: excerpt, sourceCut: excerpt.length < lines.join('\n').length, sha256: now.sha256,
      usedBy: users.used.map(related), tests: users.tests.map(related), uses: uses.uses.map(related), outside: uses.outside, more: users.more,
      imports: this.index.imports(cwd, target.path).slice(0, 60).map(entry => ({ module: entry.module, line: entry.line, path: this.index.resolve(files, target.path, entry.module) || '' })),
      importedBy: this.index.importers(cwd, target.path, files).slice(0, 60).map(item => ({ path: item.path, line: item.line })),
      decisions: linked.map(link => ({ id: link.id, text: this.decision(cwd, link.decision) })) };
  }
  // Accepted decisions of the project, tied to the code they are about. A link holds no text of either: the decision is
  // read from the project capsule when it is shown, and a decision that left the capsule takes its links with it.
  private decisions(cwd: string) { const capsule = this.core.store.get<any>('capsule:' + cwd, null); return [...(capsule?.decisions || []).map((text: string) => ({ kind: 'decision', text })), ...(capsule?.constraints || []).map((text: string) => ({ kind: 'constraint', text }))] as { kind: string; text: string }[]; }
  private decision(cwd: string, hash: string) { return this.decisions(cwd).find(item => digest(item.text) === hash)?.text || ''; }
  private saveLinks(cwd: string, links: CodeLink[]) { const { [cwd]: _old, ...rest } = this.core.store.get<Record<string, CodeLink[]>>('codeLinks', {}); this.core.store.set('codeLinks', links.length ? { ...rest, [cwd]: links } : rest); }
  links(cwd: string): CodeLink[] {
    const all = this.core.store.get<Record<string, CodeLink[]>>('codeLinks', {})[cwd] || [], kept = all.filter(link => this.decision(cwd, link.decision));
    if (kept.length !== all.length) this.saveLinks(cwd, kept);
    return kept;
  }
  linkable(p: { sessionId: string }) { const cwd = this.project(p.sessionId); return { decisions: this.decisions(cwd).map(item => ({ ...item, hash: digest(item.text) })) }; }
  link(p: { sessionId: string; key: unknown; decision: unknown }) {
    const cwd = this.project(p.sessionId), symbol = typeof p.key === 'string' ? this.index.byKey(cwd, p.key) : undefined;
    if (!symbol) throw new Error('That code is no longer in the index'); if (typeof p.decision !== 'string' || !this.decision(cwd, p.decision)) throw new Error('That decision is no longer in the project');
    const links = this.links(cwd), same = links.find(link => link.key === symbol.key && link.decision === p.decision); if (same) return { id: same.id };
    if (links.length >= codeServiceLimits.links) throw new Error(`A project can have up to ${codeServiceLimits.links} links`);
    const id = digest(`${symbol.key}\n${p.decision}`).slice(0, 16); this.saveLinks(cwd, [...links, { id, decision: p.decision, key: symbol.key, name: symbol.name, path: symbol.path, created: this.now() }]); this.core.changed(); return { id };
  }
  unlink(p: { sessionId: string; id: unknown }) { const cwd = this.project(p.sessionId), links = this.links(cwd); this.saveLinks(cwd, links.filter(link => link.id !== p.id)); this.core.changed(); return { removed: links.some(link => link.id === p.id) }; }
  async close() { this.closed = true; this.job?.controller.abort(new Error('Closing')); await Promise.allSettled([...this.running.values()]); this.parser.stop(); this.opened?.close(); this.opened = undefined; }
}
