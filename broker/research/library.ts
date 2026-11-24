import { deflateSync, inflateSync } from 'node:zlib';
import type { Store } from '../store.ts';
import { busyStates, presets, type ResearchRun } from './evidence.ts';
import { remoteError } from '../execution.ts';
import { dedupeKey } from '../web-plan.ts';

export function defaults() {
  return {
    title: '',
    scope: 'web' as const,
    mode: 'answer' as const,
    sourceIds: [],
    urls: [],
    sites: [],
    siteMode: 'only' as const,
    criteria: [],
    plan: [],
    parallel: false,
    pending: [],
    pendingQueries: [],
    processed: [],
    round: 0,
    planned: false,
    callsUsed: 0,
    pageReads: 0,
    focus: [],
    activity: [],
    progress: '',
    findings: [],
    table: { columns: [], rows: [] },
    changes: [],
    revisions: [],
    stale: false,
    partial: false,
    pinned: false,
    archived: false,
    monitorDays: 0,
    nextRefresh: 0,
  };
}
export function metadata(r: ResearchRun) {
  const {
    id,
    sessionId,
    provider,
    model,
    question,
    title,
    preset,
    state,
    scope,
    mode,
    summary,
    report,
    updated,
    created,
    progress,
    stale,
    partial,
    pinned,
    archived,
    monitorDays,
  } = r;
  return {
    id,
    sessionId,
    provider,
    model,
    question,
    title,
    preset,
    state,
    scope,
    mode,
    summary,
    report,
    updated,
    created,
    progress,
    stale,
    partial,
    pinned,
    archived,
    monitorDays,
  };
}
export class ResearchLibrary {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    const db = store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT, summary TEXT NOT NULL, data TEXT NOT NULL, due INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id,request_id));
      CREATE INDEX IF NOT EXISTS research_due ON research_runs(due);
      CREATE TABLE IF NOT EXISTS research_source_text(run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(run_id,hash));
      CREATE TABLE IF NOT EXISTS research_handoffs(token TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE, version_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS research_versions(run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,version_id));`);
    store.transaction(() => {
      for (const old of store.get<ResearchRun[]>('research.runs', [])) {
        if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(old.sessionId)) continue;
        const r = {
          ...defaults(),
          ...old,
          title: old.title || old.question,
          partial: old.state !== 'completed',
          limits: { ...presets[old.preset], ...old.limits },
        };
        r.evidence = r.evidence.map((e) => ({
          ...e,
          passages: e.excerpt ? [{ id: e.id + '.P1', location: 'Saved excerpt', text: e.excerpt }] : [],
        }));
        if (r.report && !r.revisions.length)
          r.revisions.push({ versionId: r.report.versionId, time: r.updated, summary: r.summary || 'Original report' });
        r.processed = r.evidence.filter((e) => e.url).map((e) => dedupeKey(e.url));
        r.pageReads = r.evidence.length;
        this.put(r);
        if (r.report) this.snapshot(r);
      }
      db.prepare("DELETE FROM meta WHERE key='research.runs'").run();
      for (const m of this.list())
        if (busyStates.includes(m.state)) {
          const r = this.get(m.id);
          this.put({
            ...r,
            state: 'interrupted',
            monitorDays: 0, nextRefresh: 0,
            progress: 'Interrupted by restart',
            partial: true,
            note: 'PAL restarted. Continue from the saved sources and searches.',
          });
        }
    });
  }
  put(r: ResearchRun) {
    this.store.db
      .prepare(
        `INSERT INTO research_runs(id,session_id,request_id,summary,data,due) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,data=excluded.data,due=excluded.due`,
      )
      .run(r.id, r.sessionId, r.requestId || null, JSON.stringify(metadata(r)), JSON.stringify(r), r.nextRefresh);
    return r;
  }
  has(id: string) {
    return !!this.store.db.prepare('SELECT 1 FROM research_runs WHERE id=?').get(id);
  }
  get(id: string): ResearchRun {
    const row = this.store.db.prepare('SELECT data FROM research_runs WHERE id=?').get(id);
    if (!row) throw remoteError('INVALID_ARGUMENT', 'That research run no longer exists.');
    return JSON.parse(String(row.data));
  }
  list(sessionId?: string, project = false): ReturnType<typeof metadata>[] {
    const db = this.store.db;
    const rows =
      sessionId && project
        ? db
            .prepare(
              "SELECT summary FROM research_runs JOIN sessions ON sessions.id=session_id WHERE json_extract(sessions.data,'$.cwd')=?",
            )
            .all(this.store.session(sessionId).cwd)
        : sessionId
          ? db.prepare('SELECT summary FROM research_runs WHERE session_id=?').all(sessionId)
          : db.prepare('SELECT summary FROM research_runs').all();
    return rows.map((row) => JSON.parse(String(row.summary))).sort((a, b) => b.updated - a.updated);
  }
  /** Lightweight, cursor-compatible rows for Runs history; callers supply only already-authorized sessions. */
  history(sessionIds: string[], p: { query?: string; state?: string; kind?: string; since?: number; until?: number; before?: string | number; limit?: number } = {}) {
    if (!sessionIds.length || (p.kind && !['research', 'research.run'].includes(p.kind))) return [];
    const where = ['session_id IN (SELECT value FROM json_each(?))'];
    const args: (string | number)[] = [JSON.stringify(sessionIds)];
    const created = "json_extract(summary,'$.created')";
    if (p.query?.trim()) {
      where.push("instr(lower(coalesce(json_extract(summary,'$.title'),'') || ' ' || json_extract(summary,'$.question')),lower(?))>0");
      args.push(p.query.trim());
    }
    if (p.state) {
      if (p.state === 'running') where.push("json_extract(summary,'$.state') IN ('planning','searching','reading','synthesizing')");
      else { where.push("json_extract(summary,'$.state')=?"); args.push(p.state); }
    }
    if (Number.isFinite(p.since)) { where.push(created + '>=?'); args.push(p.since!); }
    if (Number.isFinite(p.until)) { where.push(created + '<=?'); args.push(p.until!); }
    if (typeof p.before === 'number') { where.push(created + '<?'); args.push(p.before); }
    else if (p.before) {
      const match = /^(\d+):([a-f0-9-]{36})$/.exec(p.before);
      if (!match) throw new Error('Invalid history cursor');
      where.push('(' + created + ',id)<(?,?)'); args.push(Number(match[1]), match[2]);
    }
    const limit = Math.min(100, Math.max(1, Number(p.limit) || 50));
    return this.store.db.prepare('SELECT summary FROM research_runs WHERE ' + where.join(' AND ') + ' ORDER BY ' + created + ' DESC,id DESC LIMIT ?')
      .all(...args, limit).map(entry => {
        const row: ReturnType<typeof metadata> = JSON.parse(String(entry.summary));
        return { id: row.id, operationId: row.id, sessionId: row.sessionId, kind: 'research.run', label: row.title || row.question,
          state: row.state, created: row.created, updated: row.updated, summary: row.summary, researchId: row.id,
          results: row.report ? [row.report] : [], cursor: row.created + ':' + row.id };
      });
  }
  tasks() {
    return this.store.db.prepare(`SELECT summary, json_extract(sessions.data, '$.title') AS owner
      FROM research_runs JOIN sessions ON sessions.id=research_runs.session_id
      ORDER BY json_extract(summary, '$.updated') DESC`).all().map(row => {
      const {id, sessionId, title, state, progress, provider, model, updated, created} = JSON.parse(String(row.summary));
      return {id, sessionId, owner: row.owner, title, state, progress, provider, model, updated, created};
    });
  }
  request(sessionId: string, requestId: string) {
    const row = this.store.db
      .prepare('SELECT id FROM research_runs WHERE session_id=? AND request_id=?')
      .get(sessionId, requestId);
    return row ? this.get(String(row.id)) : undefined;
  }
  keepSource(id: string, hash: string, units: { location: string; text: string }[]) {
    if (this.store.db.prepare('SELECT 1 FROM research_source_text WHERE run_id=? AND hash=?').get(id, hash)) return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO research_source_text VALUES(?,?,?)')
      .run(id, hash, deflateSync(Buffer.from(JSON.stringify(units)), { level: 1 }));
  }
  source(id: string, hash?: string): { location: string; text: string }[] {
    if (!hash) return [];
    const row = this.store.db.prepare('SELECT data FROM research_source_text WHERE run_id=? AND hash=?').get(id, hash);
    return row ? JSON.parse(inflateSync(row.data as Uint8Array).toString()) : [];
  }
  snapshot(r: ResearchRun) {
    if (!r.report) return;
    this.store.db.prepare('INSERT OR REPLACE INTO research_versions VALUES(?,?,?)').run(
      r.id,
      r.report.versionId,
      JSON.stringify({
        text: r.reportText,
        evidence: r.evidence,
        findings: r.findings,
        table: r.table,
        partial: r.partial,
      }),
    );
  }
  snapshotFor(id: string, versionId: string) {
    const row = this.store.db
      .prepare('SELECT data FROM research_versions WHERE run_id=? AND version_id=?')
      .get(id, versionId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
}

/** Run inside the existing erasure transaction. The foreign keys remove old report versions and normalized source text. */
export function eraseResearchCopies(store: Store, sessionId: string, matches: (text: string) => boolean) {
  const db = store.db;
  const removed = new Set<string>();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_runs'").get()) return removed;
  const contains = (value: unknown): boolean =>
    typeof value === 'string' ? matches(value) : !!value && typeof value === 'object' && Object.values(value).some(contains);
  for (const row of db.prepare('SELECT id,data FROM research_runs WHERE session_id=?').all(sessionId)) {
    const id = String(row.id);
    let hit = contains(JSON.parse(String(row.data)));
    if (!hit)
      for (const v of db.prepare('SELECT data FROM research_versions WHERE run_id=?').iterate(id)) {
        if (contains(JSON.parse(String(v.data)))) {
          hit = true;
          break;
        }
      }
    if (!hit)
      for (const v of db.prepare('SELECT data FROM research_source_text WHERE run_id=?').iterate(id)) {
        const units = JSON.parse(inflateSync(v.data as Uint8Array).toString()) as { text: string }[];
        if (contains(units)) {
          hit = true;
          break;
        }
      }
    if (hit) {
      db.prepare('DELETE FROM research_runs WHERE id=?').run(id);
      removed.add(id);
    }
  }
  return removed;
}
