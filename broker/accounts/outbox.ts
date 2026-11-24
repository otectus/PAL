/**
 * What is written to an account's service (PAL Everywhere §14.3). Every write starts as a draft kept here, with the
 * account and its identity, the exact target and content, and a digest of both. Sending it is a separate, explicit step.
 * A write whose answer was lost is never repeated blindly: PAL looks for it first, by an identifier chosen before it was
 * sent where the service takes one, and by its exact content otherwise.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { remoteError } from '../execution.ts';
import { AccountError } from './http.ts';
import type { AccountProvider, AccountService } from './oauth.ts';
import type { WriteContext, Written } from './adapter.ts';
import type { EventInput } from './events.ts';
import type { Outgoing } from './mail.ts';
import type { GitHubWrite } from './github.ts';

export type WritePayload =
  | { kind: 'calendar.create'; calendarId: string; event: EventInput }
  | { kind: 'calendar.update'; calendarId: string; eventId: string; event: EventInput; revision: string }
  | { kind: 'calendar.remove'; calendarId: string; eventId: string; revision: string; title: string; when: string }
  | { kind: 'mail.send' | 'mail.draft'; mail: Outgoing }
  | { kind: 'drive.create'; folderId?: string; name: string; artifactId: string; versionId: string; sha256: string; bytes: number; mime: string; ownerSessionId: string }
  | { kind: 'drive.update'; fileId: string; name: string; revision: string; artifactId: string; versionId: string; sha256: string; bytes: number; mime: string; ownerSessionId: string }
  | { kind: 'github'; write: GitHubWrite };
export type WriteState = 'draft' | 'sending' | 'sent' | 'unknown' | 'failed' | 'discarded';
export type AccountWrite = { id: string; accountId: string; subject: string; login: string; provider: AccountProvider; service: AccountService; title: string; description: string; payload: WritePayload; digest: string; state: WriteState; created: number; updated: number; started?: number; sessionId?: string; origin: 'person' | 'assistant' | 'routine'; result?: Written; error?: string };
export const outboxLimits = { kept: 200, drafts: 50 };
export const writeDigest = (accountId: string, subject: string, payload: WritePayload) => createHash('sha256').update(JSON.stringify([accountId, subject, payload])).digest('hex');
export type Performer = { perform(write: AccountWrite, context: WriteContext): Promise<Written>; look(write: AccountWrite, context: WriteContext): Promise<Written | undefined>; check(write: AccountWrite): void };

export class Outbox {
  private store: Store; private performer: Performer; changed: () => void = () => {};
  private running = new Map<string, Promise<AccountWrite>>();
  constructor(store: Store, performer: Performer) {
    this.store = store; this.performer = performer;
    store.db.exec('CREATE TABLE IF NOT EXISTS account_writes(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT, state TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS account_writes_updated ON account_writes(updated);');
    // A write interrupted by a restart may have been made; it is looked for, never repeated.
    for (const write of this.list({ states: ['sending'] })) this.save({ ...write, state: 'unknown', error: 'PAL restarted while this was being sent. Check whether it arrived.' });
  }
  list(p: { accountId?: string; states?: WriteState[]; limit?: number } = {}): AccountWrite[] {
    return this.store.db.prepare('SELECT data FROM account_writes ORDER BY updated DESC LIMIT ?').all(Math.min(p.limit || 100, outboxLimits.kept)).map(row => JSON.parse(String(row.data)) as AccountWrite)
      .filter(write => (!p.accountId || write.accountId === p.accountId) && (!p.states || p.states.includes(write.state)));
  }
  get(id: unknown): AccountWrite { const row = typeof id === 'string' ? this.store.db.prepare('SELECT data FROM account_writes WHERE id=?').get(id) : undefined; if (!row) throw new Error('This draft no longer exists'); return JSON.parse(String(row.data)); }
  private save(write: AccountWrite) {
    const next = { ...write, updated: Date.now() };
    this.store.db.prepare('INSERT OR REPLACE INTO account_writes VALUES (?,?,?,?,?,?)').run(next.id, next.accountId, next.sessionId || null, next.state, next.updated, JSON.stringify(next));
    // Finished records are kept for a while; a draft or an open question is never dropped.
    this.store.db.prepare("DELETE FROM account_writes WHERE state IN ('sent','failed','discarded') AND id NOT IN (SELECT id FROM account_writes ORDER BY updated DESC LIMIT ?)").run(outboxLimits.kept);
    this.changed(); return next;
  }
  create(p: Pick<AccountWrite, 'accountId' | 'subject' | 'login' | 'provider' | 'service' | 'title' | 'description' | 'payload' | 'origin'> & { sessionId?: string }): AccountWrite {
    if (this.list({ states: ['draft'], limit: outboxLimits.kept }).length >= outboxLimits.drafts) throw new Error('There are many drafts waiting. Send or discard some first.');
    return this.save({ ...p, id: randomUUID(), digest: writeDigest(p.accountId, p.subject, p.payload), state: 'draft', created: Date.now(), updated: Date.now() });
  }
  /** A draft's new content; one that was sent, or may have been, is not changed. */
  revise(id: string, expected: string, p: Pick<AccountWrite, 'title' | 'description' | 'payload'>): AccountWrite {
    const write = this.get(id);
    if (!['draft', 'failed'].includes(write.state)) throw new Error('This can no longer be changed');
    if (write.digest !== expected) throw remoteError('REVISION_CONFLICT', 'This draft changed on another screen. Open it again.');
    const { error: _error, started: _started, ...rest } = write;
    return this.save({ ...rest, ...p, state: 'draft', digest: writeDigest(write.accountId, write.subject, p.payload) });
  }
  discard(id: string) { const write = this.get(id); if (!['draft', 'failed', 'unknown'].includes(write.state)) throw new Error('This is already finished'); return this.save({ ...write, state: 'discarded' }); }
  /** Sends exactly what was reviewed, once. A second request for it waits for the first. */
  commit(id: string, digest: string, signal?: AbortSignal): Promise<AccountWrite> {
    const running = this.running.get(id); if (running) return running;
    const task = this.send(id, digest, signal).finally(() => this.running.delete(id)); this.running.set(id, task); return task;
  }
  private async send(id: string, digest: string, signal?: AbortSignal): Promise<AccountWrite> {
    let write = this.get(id);
    if (write.digest !== digest || writeDigest(write.accountId, write.subject, write.payload) !== digest) throw remoteError('REVISION_CONFLICT', 'This draft changed since it was reviewed. Review it again.');
    if (write.state === 'sent') return write;
    if (write.state === 'unknown') throw new Error('Check first whether this already arrived');
    if (!['draft', 'failed'].includes(write.state)) throw new Error('This can no longer be sent');
    this.performer.check(write);
    const started = Date.now(); write = this.save({ ...write, state: 'sending', started });
    const context: WriteContext = { key: write.id, started, ...(signal ? { signal } : {}) };
    try { const result = await this.performer.perform(write, context); const { error: _error, ...rest } = write; return this.save({ ...rest, state: 'sent', result }); }
    catch (error: any) {
      const message = String(error?.message || error).slice(0, 400);
      // Refused before or by the service: nothing was written.
      if (!(error instanceof AccountError && error.ambiguous) && !signal?.aborted) return this.save({ ...write, state: 'failed', error: message });
      const found = await this.performer.look(write, { key: write.id, started }).catch(() => undefined);
      const { error: _error, ...rest } = write;
      return found ? this.save({ ...rest, state: 'sent', result: found }) : this.save({ ...write, state: 'unknown', error: `${message}. It may have arrived.` });
    }
  }
  /** Looks for a write whose answer was lost. Only when it is certainly not there can it be sent again. */
  async check(id: string): Promise<AccountWrite> {
    const write = this.get(id); if (write.state !== 'unknown') return write;
    this.performer.check(write);
    const found = await this.performer.look(write, { key: write.id, started: write.started || write.created }), { error: _error, ...rest } = write;
    return found ? this.save({ ...rest, state: 'sent', result: found }) : this.save({ ...rest, state: 'draft', error: 'It did not arrive. You can send it again.' });
  }
  /** An account that was removed takes its open drafts with it; what was sent stays recorded. */
  forgetAccount(accountId: string) { for (const write of this.list({ accountId, limit: outboxLimits.kept })) if (['draft', 'failed', 'unknown'].includes(write.state)) this.save({ ...write, state: 'discarded' }); }
  forgetSession(sessionId: string) { this.store.db.prepare("DELETE FROM account_writes WHERE session_id=? AND state IN ('draft','failed','discarded')").run(sessionId); this.store.db.prepare('UPDATE account_writes SET session_id=NULL WHERE session_id=?').run(sessionId); }
}
