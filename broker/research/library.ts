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
            state: 'paused',
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
