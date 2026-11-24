/**
 * M11 speech cache (opt-in): audio synthesized for a message of a saved conversation, kept for a number of days so that
 * reading it again needs no new synthesis. Audio is found only by the complete identity of what was synthesized: the
 * text, the engine, the voice and every option that changes the sound. It belongs to the messages it was made from and
 * leaves with any of them. Text that belongs to no saved message, and temporary conversations, leave nothing behind.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir } from './paths.ts';
import type { Store } from './store.ts';

export type SpeechCacheSettings = { enabled: boolean; days: number; megabytes: number };
export const defaultSpeechCache: SpeechCacheSettings = { enabled: false, days: 7, megabytes: 100 };
export const speechCacheLimits = { itemBytes: 32 * 1024 * 1024, days: [1, 90], megabytes: [10, 2000] } as const;
export type SpeechSource = { sessionId: string; messageId: string };
/** Everything that decides how an utterance sounds. A field that is not there is different from one that is empty. */
export type SpeechFacts = Record<string, unknown>;

const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
    : JSON.stringify(value ?? null);
export const speechKey = (facts: SpeechFacts) => createHash('sha256').update('pal-speech-1\n' + canonical(facts)).digest('hex');

export function validateSpeechCache(patch: any, current: SpeechCacheSettings = defaultSpeechCache): SpeechCacheSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['enabled', 'days', 'megabytes'].includes(key))) throw new Error('Invalid speech cache settings');
  const next = { ...current, ...patch }, inside = (value: unknown, [low, high]: readonly [number, number]) => Number.isInteger(value) && Number(value) >= low && Number(value) <= high;
  if (typeof next.enabled !== 'boolean' || !inside(next.days, speechCacheLimits.days) || !inside(next.megabytes, speechCacheLimits.megabytes))
    throw new Error(`Keep speech for ${speechCacheLimits.days.join(' to ')} days and ${speechCacheLimits.megabytes.join(' to ')} MB`);
  return next;
}

/** One utterance: audio that is already here, or a recorder for what is being made. */
export class CachedSpeech {
  readonly hit?: { rate: number; pcm: Buffer };
  private keep: (rate: number, pcm: Buffer) => void;
  private parts: Buffer[] = []; private bytes = 0; private full = false;
  constructor(hit: CachedSpeech['hit'], keep: CachedSpeech['keep']) { this.hit = hit; this.keep = keep; }
  add(chunk: Buffer) {
    if (this.full) return;
    this.bytes += chunk.length;
    if (this.bytes > speechCacheLimits.itemBytes) { this.full = true; this.parts = []; return; }
    this.parts.push(Buffer.from(chunk));
  }
  /** Only an utterance that was synthesized to its end is kept. */
  finish(rate: number) { if (!this.full && this.bytes && this.bytes % 2 === 0) this.keep(rate, Buffer.concat(this.parts)); this.parts = []; }
  /** The kept audio in playable pieces, or what `audio` makes, recorded on the way through. */
  async *through(rate: number, audio: () => AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    if (this.hit) { for (let at = 0; at < this.hit.pcm.length; at += 65_536) yield this.hit.pcm.subarray(at, at + 65_536); return; }
    for await (const chunk of audio()) { this.add(chunk); yield chunk; }
    this.finish(rate);
  }
}

export class SpeechCache {
  now = () => Date.now(); hits = 0;
  private store: Store; private settings: () => SpeechCacheSettings; private changed: () => void;
  /** Forgetting a conversation while its words are being synthesized keeps nothing of them. */
  private generation = new Map<string, number>(); private every = 0;
  constructor(store: Store, settings: () => SpeechCacheSettings, changed = () => {}) {
    this.store = store; this.settings = settings; this.changed = changed;
    store.db.exec('CREATE TABLE IF NOT EXISTS speech_cache(key TEXT PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, rate INTEGER NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS speech_cache_sources(key TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(key,session_id,message_id));');
    this.sweep();
  }
  private get directory() { return join(this.store.directory, 'speech-cache'); }
  private files() { try { return readdirSync(this.directory); } catch { return []; } }
  private remove(keys: string[]) {
    for (const key of keys) {
      const row = this.store.db.prepare('SELECT file FROM speech_cache WHERE key=?').get(key);
      this.store.db.prepare('DELETE FROM speech_cache WHERE key=?').run(key); this.store.db.prepare('DELETE FROM speech_cache_sources WHERE key=?').run(key);
      // Files cannot roll back with the database; removing sooner is the privacy-preserving failure mode.
      if (row) try { unlinkSync(join(this.directory, String(row.file))); } catch { /* Already gone. */ }
    }
    return keys.length;
  }
  /** Expired audio, audio nothing owns, rows whose file is gone, and files no row names. */
  sweep() {
    const db = this.store.db, rows = db.prepare('SELECT key,file,created FROM speech_cache').all(), files = new Set(this.files()), oldest = this.now() - this.settings().days * 86400_000;
    const owned = new Set(db.prepare('SELECT DISTINCT key FROM speech_cache_sources').all().map(row => String(row.key)));
    this.remove(rows.filter(row => Number(row.created) < oldest || !owned.has(String(row.key)) || !files.has(String(row.file))).map(row => String(row.key)));
    const kept = new Set(db.prepare('SELECT file FROM speech_cache').all().map(row => String(row.file)));
    for (const file of files) if (!kept.has(file)) try { unlinkSync(join(this.directory, file)); } catch { /* Another process may own it. */ }
    db.exec('DELETE FROM speech_cache_sources WHERE key NOT IN (SELECT key FROM speech_cache)');
  }
  private evict() {
    const limit = this.settings().megabytes * 1024 * 1024;
    let total = Number(this.store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM speech_cache').get()!.n);
    if (total <= limit) return;
    const doomed: string[] = [];
    for (const row of this.store.db.prepare('SELECT key,bytes FROM speech_cache ORDER BY used').all()) { if (total <= limit) break; total -= Number(row.bytes); doomed.push(String(row.key)); }
    this.remove(doomed);
  }
  /** What PAL may keep of this utterance: nothing when the cache is off or its words belong to no saved message. */
  use(facts: SpeechFacts, source: SpeechSource | undefined): CachedSpeech | undefined {
    if (!source || !this.settings().enabled) return undefined;
    const message = this.store.messageById(source.messageId);
    if (this.store.temporary(source.sessionId) || !message || message.sessionId !== source.sessionId) return undefined;
    const key = speechKey(facts), generation = this.generation.get(source.sessionId) || 0, every = this.every;
    const attribute = () => this.store.db.prepare('INSERT OR IGNORE INTO speech_cache_sources VALUES (?,?,?)').run(key, source.sessionId, source.messageId);
    const row = this.store.db.prepare('SELECT file,sha256,rate,created FROM speech_cache WHERE key=?').get(key);
    let hit: CachedSpeech['hit'];
    if (row) {
      try {
        const pcm = readFileSync(join(this.directory, String(row.file)));
        if (Number(row.created) < this.now() - this.settings().days * 86400_000 || createHash('sha256').update(pcm).digest('hex') !== row.sha256) throw new Error('stale');
        hit = { rate: Number(row.rate), pcm }; this.hits++; attribute();
        this.store.db.prepare('UPDATE speech_cache SET used=? WHERE key=?').run(this.now(), key);
      } catch { this.remove([key]); }
    }
    return new CachedSpeech(hit, (rate, pcm) => {
      // The conversation may have been deleted or forgotten while this was being spoken.
      const still = this.store.messageById(source.messageId);
      if (!this.settings().enabled || (this.generation.get(source.sessionId) || 0) !== generation || this.every !== every || !still || still.text !== message.text) return;
      privateDir(this.directory);
      const file = randomUUID() + '.pcm', partial = join(this.directory, '.' + file);
      try {
        writeFileSync(partial, pcm, { mode: 0o600, flag: 'wx' }); renameSync(partial, join(this.directory, file));
        this.remove([key]);
        this.store.db.prepare('INSERT INTO speech_cache VALUES (?,?,?,?,?,?,?)').run(key, file, createHash('sha256').update(pcm).digest('hex'), rate, pcm.length, this.now(), this.now());
        attribute(); this.evict(); this.changed();
      } catch { rmSync(partial, { force: true }); /* Speech never fails because it could not be kept. */ }
    });
  }
  forgetSession(id: string) {
    this.generation.set(id, (this.generation.get(id) || 0) + 1);
    return this.remove(this.store.db.prepare('SELECT DISTINCT key FROM speech_cache_sources WHERE session_id=?').all(id).map(row => String(row.key)));
  }
  clear() { this.every++; const removed = this.remove(this.store.db.prepare('SELECT key FROM speech_cache').all().map(row => String(row.key))); this.sweep(); this.changed(); return removed; }
  configured() { if (!this.settings().enabled) this.clear(); else { this.sweep(); this.evict(); } }
  status() { const row = this.store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM speech_cache').get()!; return { ...this.settings(), items: Number(row.n), bytes: Number(row.bytes), hits: this.hits }; }
}
/** Within transcript erasure: a recording of a message that is being erased goes, whatever else it was also made from. */
export function eraseSpeechCopies(store: Store, sessionId: string, erased: (message: { id: string; turnId?: string; text: string } | undefined) => boolean) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='speech_cache_sources'").get()) return;
  const gone = new Set(store.db.prepare('SELECT key,message_id FROM speech_cache_sources WHERE session_id=?').all(sessionId).filter(row => erased(store.messageById(String(row.message_id)))).map(row => String(row.key)));
  for (const key of gone) {
    const row = store.db.prepare('SELECT key,file FROM speech_cache WHERE key=?').get(key); if (!row) continue;
    try { unlinkSync(join(store.directory, 'speech-cache', String(row.file))); } catch { /* Already gone. */ }
    store.db.prepare('DELETE FROM speech_cache WHERE key=?').run(String(row.key)); store.db.prepare('DELETE FROM speech_cache_sources WHERE key=?').run(String(row.key));
  }
}
