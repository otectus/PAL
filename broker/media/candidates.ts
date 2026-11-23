/** Alignment-failed protected outputs remain private until the user accepts an unprotected candidate. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';

export type UnprotectedCandidate = { candidateId: string; index: number; sha256: string; mime: string; bytes: number; reason: string; createdAt: number; accepted?: { artifactId: string; versionId: string } };
const uuid = /^[0-9a-f-]{36}$/;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class ImageCandidateStore {
  directory: string;
  constructor(storeDirectory: string) { this.directory = privateDir(join(storeDirectory, 'media', 'candidates')); }
  async ensure() { await mkdir(this.directory, { recursive: true }); }
  private path(operationId: string, candidateId: string) {
    if (!uuid.test(operationId) || !uuid.test(candidateId)) throw new Error('Unknown image candidate');
    return join(this.directory, `${operationId}-${candidateId}`);
  }
  async put(operationId: string, index: number, bytes: Buffer, mime: string, reason: string): Promise<UnprotectedCandidate> {
    const candidateId = randomUUID(), hash = sha256(bytes);
    await writeFile(this.path(operationId, candidateId), bytes, { mode: 0o600, flag: 'wx' });
    return { candidateId, index, sha256: hash, mime, bytes: bytes.length, reason: reason.slice(0, 600), createdAt: Date.now() };
  }
  async read(operationId: string, candidate: UnprotectedCandidate) {
    const bytes = await readFile(this.path(operationId, candidate.candidateId)).catch(() => { throw new Error('That unprotected candidate is no longer available'); });
    if (bytes.length !== candidate.bytes || sha256(bytes) !== candidate.sha256) throw new Error('That unprotected candidate no longer matches its record');
    return bytes;
  }
  async remove(operationId: string, candidateId: string) { await rm(this.path(operationId, candidateId), { force: true }); }
  async removeOperations(operationIds: string[]) {
    const prefixes = new Set(operationIds.filter(id => uuid.test(id)).map(id => id + '-'));
    if (!prefixes.size) return;
    for (const name of await readdir(this.directory).catch(() => [] as string[])) if ([...prefixes].some(prefix => name.startsWith(prefix))) await rm(join(this.directory, name), { force: true });
  }
  async collectOperations(valid: Set<string>) {
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      const operationId = name.slice(0, 36);
      if (!uuid.test(operationId) || !valid.has(operationId)) await rm(join(this.directory, name), { force: true });
    }
  }
}
