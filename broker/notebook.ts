/**
 * Desktop-owned notes and the Daybook (PAL Everywhere §17.3).
 *
 * Historical project scratchpads remain at their original storage keys and are projected into the
 * same library as independently titled notes. Every note is revisioned, so an edit made elsewhere
 * is a conflict to resolve rather than a silent overwrite. Notes are never memory and reach a model
 * only when the person deliberately inserts them into a conversation.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Core } from './core.ts';
import { remoteError } from './execution.ts';

type NoteKind = 'scratchpad' | 'note';
type Revision = { revision: string; text: string; updated: number };
type Note = {
  id: string;
  kind: NoteKind;
  project: string;
  title: string;
  text: string;
  revision: string;
  created: number;
  updated: number;
  device?: string;
  history: Revision[];
};
type StoredScratch = Partial<Note> & { project: string; revision: string; deleted?: boolean };
export const notebookLimits = { text: 200_000, title: 120, history: 20 };

export class Notebook {
  core: Core;
  constructor(core: Core) { this.core = core; }

  private scratchKey(project: string) { return 'scratchpad:' + project; }
  private noteKey(id: string) { return 'notebook-note:' + id; }
  private projectId(project: string) { return 'project:' + Buffer.from(project).toString('base64url'); }
  private projectFromId(id: string) {
    if (!id.startsWith('project:')) return '';
    try {
      const project = Buffer.from(id.slice(8), 'base64url').toString();
      return this.projectId(project) === id ? project : '';
    } catch { return ''; }
  }
  private project(project: unknown) {
    if (typeof project !== 'string' || !project.startsWith('/')) throw new Error('Choose a project folder');
    return project;
  }
  private title(title: unknown) {
    if (typeof title !== 'string') throw new Error('Enter a note title');
    const value = title.trim();
    if (!value) throw new Error('Enter a note title');
    if (value.length > notebookLimits.title) throw new Error('A note title holds up to 120 characters');
    if (/\p{Cc}/u.test(value)) throw new Error('A note title cannot contain control characters');
    return value;
  }
  private defaultTitle(project: string) { return (basename(project) || project) + ' scratchpad'; }
  private normalizeScratch(project: string, value?: StoredScratch | null): Note {
    if (value?.deleted) return { id: this.projectId(project), kind: 'scratchpad', project,
      title: this.defaultTitle(project), text: '', revision: value.revision || '0', created: 0, updated: 0, history: [] };
    return {
      id: this.projectId(project), kind: 'scratchpad', project,
      title: value?.title || this.defaultTitle(project), text: value?.text || '', revision: value?.revision || '0',
      created: Number(value?.created) || Number(value?.updated) || 0, updated: Number(value?.updated) || 0,
      ...(value?.device ? { device: value.device } : {}), history: Array.isArray(value?.history) ? value.history : [],
    };
  }
  private validNoteId(id: unknown) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Choose a note');
    return id;
  }
  private storedNote(id: string): Note {
    const note = this.core.store.get<Note | null>(this.noteKey(this.validNoteId(id)), null);
    if (!note || note.id !== id || note.kind !== 'note') throw new Error('That note no longer exists');
    return { ...note, history: Array.isArray(note.history) ? note.history : [] };
  }
  private store(note: Note) {
    this.core.store.set(note.kind === 'scratchpad' ? this.scratchKey(note.project) : this.noteKey(note.id), note);
    this.core.changed();
    return note;
  }
  private keyFor(id: string) {
    const project = this.projectFromId(id);
    if (project) return { key: this.scratchKey(project), note: this.scratchpad(project) };
    const note = this.storedNote(id);
    return { key: this.noteKey(note.id), note };
  }
  /** SQLite projects only catalog fields; note bodies and revision histories never enter the JS library scan. */
  private catalog(includePreview = false) {
    type Row = { key: string; id: unknown; kind: unknown; project: unknown; title: unknown; revision: unknown; created: unknown; updated: unknown; deleted: unknown; preview?: unknown };
    const rows = new Map<string, Row>();
    const preview = includePreview ? ",substr(CAST(COALESCE(json_extract(value,'$.text'),'') AS TEXT),1,400) AS preview" : '';
    const query = `SELECT key,json_extract(value,'$.id') AS id,json_extract(value,'$.kind') AS kind,
      json_extract(value,'$.project') AS project,json_extract(value,'$.title') AS title,
      json_extract(value,'$.revision') AS revision,json_extract(value,'$.created') AS created,
      json_extract(value,'$.updated') AS updated,json_extract(value,'$.deleted') AS deleted${preview}
      FROM meta WHERE (key LIKE 'scratchpad:%' OR key LIKE 'notebook-note:%') AND json_valid(value)`;
    for (const database of [this.core.store.db, this.core.store.volatile]) {
      for (const row of database.prepare(query).all() as Row[]) rows.set(String(row.key), row);
    }
    return rows;
  }

  /** The compatible one-per-project scratchpad entry point used by desktop and owner clients. */
  scratchpad(project: string): Note {
    project = this.project(project);
    return this.normalizeScratch(project, this.core.store.get<StoredScratch | null>(this.scratchKey(project), null));
  }

  /** All persisted notes owned by this desktop user, newest first. */
  list() {
    const notes: { id: string; kind: NoteKind; project: string; title: string; revision: string; created: number; updated: number; preview: string }[] = [];
    for (const [key, row] of this.catalog(true)) {
      if (row.deleted) continue;
      const scratchpad = key.startsWith('scratchpad:'), project = scratchpad ? key.slice(11) : String(row.project || '');
      if (!project.startsWith('/')) continue;
      const id = scratchpad ? this.projectId(project) : String(row.id || '');
      if (!scratchpad && (row.kind !== 'note' || !id)) continue;
      notes.push({ id, kind: scratchpad ? 'scratchpad' : 'note', project,
        title: String(row.title || (scratchpad ? this.defaultTitle(project) : 'Untitled note')),
        revision: String(row.revision || '0'), created: Number(row.created) || Number(row.updated) || 0,
        updated: Number(row.updated) || 0, preview: String(row.preview || '').replace(/\s+/g, ' ').trim().slice(0, 180) });
    }
    return { notes: notes.sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title)) };
  }

  get(id: string) {
    const project = this.projectFromId(id);
    return project ? this.scratchpad(project) : this.storedNote(id);
  }

  create(project: string, title = 'Untitled note') {
    project = this.project(project);
    const now = Date.now(), id = randomUUID();
    return this.store({ id, kind: 'note', project, title: this.title(title), text: '', revision: '0', created: now, updated: now, history: [] });
  }

  private saveRecord(current: Note, text: unknown, expectedRevision: string, device?: string) {
    if (typeof text !== 'string' || text.length > notebookLimits.text) throw new Error('A note holds up to 200,000 characters');
    if (current.revision !== expectedRevision) throw Object.assign(remoteError('REVISION_CONFLICT', 'The note changed on another device. Its newer text is shown; your edit is kept to merge.'), { current: { text: current.text, revision: current.revision } });
    if (text === current.text) return current;
    const history = [{ revision: current.revision, text: current.text, updated: current.updated }, ...current.history].filter(h => h.revision !== '0').slice(0, notebookLimits.history);
    return this.store({ ...current, text, revision: String(BigInt(current.revision) + 1n), updated: Date.now(), ...(device ? { device } : {}), history });
  }

  /** Saves the project scratchpad if nobody changed it since `expectedRevision`. */
  save(project: string, text: string, expectedRevision: string, device?: string) {
    return this.saveRecord(this.scratchpad(project), text, expectedRevision, device);
  }

  /** Saves an arbitrary library note, including the compatible project scratchpad. */
  saveNote(id: string, text: string, expectedRevision: string, device?: string) {
    return this.saveRecord(this.get(id), text, expectedRevision, device);
  }

  rename(id: string, title: string) {
    const current = this.get(id), next = this.title(title);
    if (current.title === next) return current;
    return this.store({ ...current, title: next, updated: Date.now() });
  }

  remove(id: string, expectedRevision: string) {
    const { key, note } = this.keyFor(id);
    if (note.revision !== expectedRevision) throw remoteError('REVISION_CONFLICT', 'The note changed before it could be deleted. Open the latest version and try again.');
    if (note.kind === 'scratchpad') {
      // Project identities are reusable. Keep only a monotonic revision marker so an editor that
      // predates delete/recreate can never match the recreated note and overwrite it silently.
      const tombstone = { project: note.project, revision: String(BigInt(note.revision) + 1n), deleted: true };
      this.core.store.volatile.prepare('DELETE FROM meta WHERE key=?').run(key);
      this.core.store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(tombstone));
      this.core.changed();
      return { deleted: true, id };
    }
    let removed = 0;
    for (const database of [this.core.store.db, this.core.store.volatile]) removed += Number(database.prepare('DELETE FROM meta WHERE key=?').run(key).changes);
    if (!removed) throw new Error('That note no longer exists');
    this.core.changed();
    return { deleted: true, id };
  }

  /** Everything PAL recorded on one local date (YYYY-MM-DD), newest first, as links to the records themselves. */
  day(date: string, offsetMinutes = new Date().getTimezoneOffset()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a date as YYYY-MM-DD');
    const start = Date.parse(date + 'T00:00:00Z') + offsetMinutes * 60_000, end = start + 86_400_000;
    const inDay = (time: number) => time >= start && time < end;
    const items: { time: number; kind: string; title: string; sessionId?: string; project?: string; ref?: Record<string, string> }[] = [];
    for (const session of this.core.store.sessions()) {
      if (session.temporary) continue;
      if (inDay(session.updated) || inDay(session.created)) items.push({ time: session.updated, kind: 'conversation', title: session.title || 'Conversation', sessionId: session.id, project: session.cwd });
      for (const operation of this.core.workbench.operations.list(session.id, { limit: 100 })) {
        if (!inDay(operation.updated)) continue;
        if (!['completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(operation.state)) continue;
        items.push({ time: operation.updated, kind: 'run', title: `${operation.label} · ${operation.state}`, sessionId: session.id, project: session.cwd, ref: { operationId: operation.id } });
      }
    }
    for (const run of this.core.research.all()) if (inDay(run.updated)) items.push({ time: run.updated, kind: 'research', title: run.question, sessionId: run.sessionId, ...(run.report ? { ref: { artifactId: run.report.artifactId, versionId: run.report.versionId } } : {}) });
    for (const [key, row] of this.catalog()) {
      if (row.deleted) continue;
      const scratchpad = key.startsWith('scratchpad:'), project = scratchpad ? key.slice(11) : String(row.project || '');
      const updated = Number(row.updated) || 0, id = scratchpad ? this.projectId(project) : String(row.id || '');
      if (project.startsWith('/') && id && (scratchpad || row.kind === 'note') && inDay(updated)) {
        items.push({ time: updated, kind: scratchpad ? 'scratchpad' : 'note', title: String(row.title || (scratchpad ? this.defaultTitle(project) : 'Note edited')), project, ref: { noteId: id } });
      }
    }
    return { date, items: items.sort((a, b) => b.time - a.time).slice(0, 300), derived: false };
  }
}
