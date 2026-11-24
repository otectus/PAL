/**
 * Files a provider's own code made during a reply: kept with the conversation before they expire there. Only what that
 * reply named is fetched, from the account that made it and its own endpoint, within bounds, and never for a temporary
 * conversation or a turn a restricted phone controls. A file is saved once, however often the reply is read again.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { responseBytes, responseJson } from '../provider-http.ts';
import type { Core } from '../core.ts';
import { mimeFor, safeName, type ArtifactVersion } from './store.ts';

export type HostedFile = { kind: 'anthropic'; id: string } | { kind: 'openai'; container: string; id: string; name: string } | { kind: 'inline'; mime: string; data: string };
export type HostedReceipt = { files: { artifactId: string; versionId: string; name: string }[]; notes: string[] };
export type HostedSource = { sessionId: string; provider: string; connectionId?: string; base: string; key: string; turnId?: string; fetch?: typeof fetch;
  /** Throws when the account, the conversation or the authority for this reply has changed. */
  check: () => void };
export const hostedLimits = { files: 16, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, metadata: 64 * 1024, timeoutMs: 60_000 };
const id = /^[A-Za-z0-9_-]{1,200}$/;
const executable = (bytes: Buffer) => bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.subarray(0, 2).toString('latin1') === 'MZ';

export class HostedOutputs {
  readonly core: Core;
  constructor(core: Core) { this.core = core; }
  /** A file of this reply that is already kept here. */
  private kept(sessionId: string, fileId: string): ArtifactVersion | undefined {
    const row = this.core.store.db.prepare("SELECT data FROM artifact_versions WHERE json_extract(data,'$.sessionId')=? AND json_extract(data,'$.provenance.kind')='provider-code-output' AND json_extract(data,'$.provenance.fileId')=? ORDER BY rowid DESC LIMIT 1").get(sessionId, fileId);
    if (!row) return undefined;
    const version = JSON.parse(String(row.data)) as ArtifactVersion;
    return this.core.workbench.artifacts.authorized(sessionId, version.artifactId) ? version : undefined;
  }
  async capture(files: HostedFile[], source: HostedSource, signal: AbortSignal): Promise<HostedReceipt> {
    const receipt: HostedReceipt = { files: [], notes: [] }, session = this.core.store.session(source.sessionId);
    if (session.temporary) { receipt.notes.push('Files made by the provider are not kept in a temporary conversation.'); return receipt; }
    const request = source.fetch || fetch, base = source.base.replace(/\/+$/, '') + '/', combined = AbortSignal.any([signal, AbortSignal.timeout(hostedLimits.timeoutMs)]);
    const headers: Record<string, string> = source.provider === 'anthropic' ? { 'x-api-key': source.key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14' } : { Authorization: 'Bearer ' + source.key };
    const wanted = new Map<string, HostedFile>();
    for (const file of files) {
      const key = file.kind === 'inline' ? 'inline-' + createHash('sha256').update(file.mime + '\0' + file.data).digest('hex').slice(0, 40) : file.kind === 'openai' ? file.container + '-' + file.id : file.id;
      if (!wanted.has(key)) wanted.set(key, file);
    }
    let total = 0;
    for (const [key, file] of [...wanted].slice(0, hostedLimits.files)) {
      const before = this.kept(source.sessionId, key);
      if (before) { receipt.files.push({ artifactId: before.artifactId, versionId: before.versionId, name: before.name }); continue; }
      try {
        source.check(); combined.throwIfAborted();
        let bytes: Buffer, name: string, declared = '';
        if (file.kind === 'inline') {
          bytes = Buffer.from(file.data, 'base64'); declared = file.mime.split(';', 1)[0].trim().toLowerCase();
          const extension = /^image\/(png|jpeg|webp|gif)$/.exec(declared)?.[1];
          if (!extension) continue;
          name = `${source.provider === 'google' ? 'gemini' : source.provider}-figure-${receipt.files.length + 1}.${extension === 'jpeg' ? 'jpg' : extension}`;
        } else {
          if (!id.test(file.id) || file.kind === 'openai' && !id.test(file.container)) throw new Error('Invalid file reference');
          if (file.kind === 'anthropic') {
            const value = await responseJson(await request(base + 'files/' + encodeURIComponent(file.id), { headers, redirect: 'error', signal: combined }), hostedLimits.metadata);
            if (value?.id !== file.id || typeof value.filename !== 'string') throw new Error('Invalid file description');
            if (Number(value.size_bytes) > hostedLimits.fileBytes) throw new Error('larger than 32 MiB');
            name = value.filename; declared = typeof value.mime_type === 'string' ? value.mime_type : '';
          } else name = file.name;
          const path = file.kind === 'anthropic' ? `files/${encodeURIComponent(file.id)}/content` : `containers/${encodeURIComponent(file.container)}/files/${encodeURIComponent(file.id)}/content`;
          bytes = await responseBytes(await request(base + path, { headers, redirect: 'error', signal: combined }), hostedLimits.fileBytes);
        }
        if (!bytes.length) throw new Error('empty');
        if ((total += bytes.length) > hostedLimits.totalBytes) throw new Error('more than 64 MiB in one reply');
        if (bytes.length > hostedLimits.fileBytes) throw new Error('larger than 32 MiB');
        if (executable(bytes)) throw new Error('a program');
        source.check(); combined.throwIfAborted();
        const safe = safeName(name.split(/[\\/]/).at(-1) || '', 'provider file'), inferred = mimeFor(safe, bytes);
        const version = await this.core.workbench.artifacts.install({ sessionId: source.sessionId, bytes, name: safe, mime: inferred === 'application/octet-stream' && declared && declared !== 'application/octet-stream' && !declared.startsWith('image/') ? declared : inferred,
          source: 'model-generation', ...(source.turnId ? { turnId: source.turnId } : {}), provenance: { kind: 'provider-code-output', provider: source.provider, fileId: key, ...(source.connectionId ? { connectionId: source.connectionId } : {}) } });
        receipt.files.push({ artifactId: version.artifactId, versionId: version.versionId, name: version.name });
      } catch (error: any) {
        signal.throwIfAborted();
        receipt.notes.push(`One file was not kept (${String(error?.message || 'unavailable').slice(0, 80)}).`);
      }
    }
    if (wanted.size > hostedLimits.files) receipt.notes.push(`Only the first ${hostedLimits.files} files were kept.`);
    return receipt;
  }
}
