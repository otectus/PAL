/**
 * Workspace history (opt-in): what was worked on inside the folders the owner approved, kept for a number of days they
 * chose. A record names a folder, a file or a kind of work, with how often and for how long. No title, command, text or
 * anything outside those folders is ever written. Records merge while the same work goes on, expire by themselves, leave
 * at once with a folder that is no longer approved, and can be erased at any time.
 */
import { isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { LiveObservation } from './graph-memory/adapters/contracts.ts';

export const historyLimits = { rows: 5000, mergeMs: 15 * 60_000, focusGapMs: 15_000, page: 200 };
export type HistoryKind = 'document' | 'command' | 'file' | 'focus';
export type HistoryRow = { id: string; project: string; kind: HistoryKind; item: string; source: string; started: number; at: number; count: number; seconds: number; failed: number };
/** Generated and private folders are not work; the same names the folder routines skip, and version control. */
const skipped = /(^|\/)(\.git|\.hg|\.svn|node_modules|\.cache|__pycache__|\.venv|venv|target|build|dist|\.direnv)(\/|$)/;

export class WorkspaceHistory {
  core: Core; now = () => Date.now();
  private lastFocus?: { key: string; at: number };
  private roots: string[] = []; private enabled = false; private days = 7;
  constructor(core: Core) {
    this.core = core;
    core.store.db.exec('CREATE TABLE IF NOT EXISTS workspace_history(id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, source TEXT NOT NULL, started INTEGER NOT NULL, at INTEGER NOT NULL, count INTEGER NOT NULL, seconds INTEGER NOT NULL, failed INTEGER NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS workspace_history_at ON workspace_history(at);');
  }
  /**
   * The policy in force. A folder that is no longer approved takes its records with it; one that cannot be read just now
   * (an unplugged disk) keeps them.
   */
  configure(p: { enabled: boolean; approved: { root: string; real: string }[]; days: number }) {
    const known = this.core.store.get<Record<string, string>>('workspaceHistoryRoots', {}), next = Object.fromEntries(p.approved.map(item => [item.root, item.real || known[item.root] || '']));
    if (JSON.stringify(next) !== JSON.stringify(known)) this.core.store.set('workspaceHistoryRoots', next);
    this.enabled = p.enabled; this.roots = p.approved.map(item => item.real).filter(Boolean); this.days = p.days; this.lastFocus = undefined;
    const keep = [...new Set(Object.values(next).filter(Boolean))];
    if (keep.length) this.core.store.db.prepare(`DELETE FROM workspace_history WHERE project NOT IN (${keep.map(() => '?').join(',')})`).run(...keep); else this.core.store.db.exec('DELETE FROM workspace_history');
    this.core.store.db.prepare('UPDATE workspace_history SET expires=at+?').run(p.days * 86400_000);
    this.prune();
  }
  private place(path: unknown): { project: string; item: string } | undefined {
    if (typeof path !== 'string') return undefined;
    const root = this.roots.filter(root => { const delta = relative(root, path); return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)); }).sort((a, b) => b.length - a.length)[0];
    if (!root) return undefined;
    const item = relative(root, path); return skipped.test(item) ? undefined : { project: root, item };
  }
  /** One observation, already filtered by policy. What does not name work in an approved folder is dropped. */
  observe(o: LiveObservation, current: { cwd?: unknown; document?: { properties?: Record<string, unknown> } | null } | undefined) {
    if (!this.enabled || o.freshness !== 'fresh') return;
    const p = o.properties as Record<string, any>;
    if (o.source === 'editor' && /^DOCUMENT_(OPENED|SAVED)$/.test(o.kind)) this.write('document', this.place(p.path), o.source, { count: o.kind === 'DOCUMENT_SAVED' ? 1 : 0 });
    else if (o.source === 'fish' && (p.event === 'postexec' || p.event === 'posterror')) this.write('command', this.place(p.cwd), o.source, { count: 1, seconds: Math.min(86400, Math.round((Number(p.durationMs) || 0) / 1000)), failed: Number(p.status) ? 1 : 0 });
    else if (o.source === 'filesystem' && p.kind === 'file' && p.exists && p.eventType === 'change') this.write('file', this.place(p.path), o.source, { count: 1 });
    else if (o.source === 'hyprland' && o.kind === 'WINDOW_FOCUS') {
      // Time counts for the folder the focused window is verified to be in, between two looks that agree.
      const place = this.place(current?.document?.properties?.path) || this.place(current?.cwd), key = place ? `${place.project}\n${place.item}` : '', at = this.now();
      if (place && this.lastFocus?.key === key && at - this.lastFocus.at <= historyLimits.focusGapMs) this.write('focus', place, o.source, { seconds: Math.round((at - this.lastFocus.at) / 1000) });
      this.lastFocus = { key, at };
    }
  }
  private write(kind: HistoryKind, place: { project: string; item: string } | undefined, source: string, add: { count?: number; seconds?: number; failed?: number }) {
    if (!place) return;
    const db = this.core.store.db, at = this.now(), expires = at + this.days * 86400_000;
    const last = db.prepare('SELECT id FROM workspace_history WHERE project=? AND kind=? AND item=? AND at>=? ORDER BY at DESC LIMIT 1').get(place.project, kind, place.item, at - historyLimits.mergeMs);
    if (last) db.prepare('UPDATE workspace_history SET at=?,expires=?,count=count+?,seconds=seconds+?,failed=failed+? WHERE id=?').run(at, expires, add.count || 0, add.seconds || 0, add.failed || 0, String(last.id));
    else { db.prepare('INSERT INTO workspace_history VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), place.project, kind, place.item, source, at, at, add.count || 0, add.seconds || 0, add.failed || 0, expires); this.prune(); }
  }
  prune() {
    const db = this.core.store.db; db.prepare('DELETE FROM workspace_history WHERE expires<?').run(this.now());
    db.prepare('DELETE FROM workspace_history WHERE id NOT IN (SELECT id FROM workspace_history ORDER BY at DESC LIMIT ?)').run(historyLimits.rows);
  }
  status() { this.prune(); const row = this.core.store.db.prepare('SELECT COUNT(*) AS n, MIN(started) AS first, MAX(at) AS last FROM workspace_history').get()!; return { enabled: this.enabled, days: this.days, folders: this.roots, records: Number(row.n), ...(row.first ? { first: Number(row.first), last: Number(row.last) } : {}) }; }
  list(p: { project?: unknown; from?: unknown; to?: unknown; kind?: unknown; before?: unknown; limit?: unknown } = {}) {
    this.prune();
    const limit = Math.max(1, Math.min(historyLimits.page, Number(p.limit) || 100)), where: string[] = [], args: (string | number)[] = [];
    if (typeof p.project === 'string') { where.push('project=?'); args.push(p.project); }
    if (typeof p.kind === 'string') { where.push('kind=?'); args.push(p.kind); }
    if (Number.isFinite(p.from)) { where.push('at>=?'); args.push(Number(p.from)); }
    if (Number.isFinite(p.to)) { where.push('started<=?'); args.push(Number(p.to)); }
    if (Number.isFinite(p.before)) { where.push('at<?'); args.push(Number(p.before)); }
    const rows = this.core.store.db.prepare(`SELECT id,project,kind,item,source,started,at,count,seconds,failed FROM workspace_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`).all(...args, limit + 1) as unknown as HistoryRow[];
    return { items: rows.slice(0, limit), ...(rows.length > limit ? { before: rows[limit - 1].at } : {}), ...this.status() };
  }
  /** Erases everything, one folder's records, or those of a time. Returns how many are gone. */
  erase(p: { all?: unknown; project?: unknown; from?: unknown; to?: unknown }) {
    const where: string[] = [], args: (string | number)[] = [];
    if (typeof p.project === 'string') { where.push('project=?'); args.push(p.project); }
    if (Number.isFinite(p.from)) { where.push('at>=?'); args.push(Number(p.from)); }
    if (Number.isFinite(p.to)) { where.push('started<=?'); args.push(Number(p.to)); }
    if (!where.length && p.all !== true) throw new Error('Choose what to erase');
    const removed = Number(this.core.store.db.prepare(`DELETE FROM workspace_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).run(...args).changes);
    this.lastFocus = undefined; this.core.store.activity({ action: 'workspace.historyErase', status: 'completed', count: removed }); this.core.changed();
    return { removed, ...this.status() };
  }
  /** For an assistant: this conversation's project only, most recent first, as counts and times. */
  forProject(cwd: string, days: number) {
    const root = this.roots.filter(root => { const delta = relative(root, cwd); return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)); }).sort((a, b) => b.length - a.length)[0];
    if (!root) return undefined;
    const inside = relative(root, cwd), rows = this.list({ project: root, from: this.now() - days * 86400_000, limit: historyLimits.page }).items.filter(row => !inside || row.item === inside || row.item.startsWith(inside + '/'));
    return rows.map(row => ({ kind: row.kind, item: row.item || '.', from: new Date(row.started).toISOString(), to: new Date(row.at).toISOString(), ...(row.count ? { count: row.count } : {}), ...(row.seconds ? { minutes: Math.max(1, Math.round(row.seconds / 60)) } : {}), ...(row.failed ? { failed: row.failed } : {}) }));
  }
  covers(cwd: string) { return this.enabled && this.roots.some(root => { const delta = relative(root, cwd); return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)); }); }
}
