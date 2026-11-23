/**
 * Verified, resumable transfers between an owner phone and the desktop's artifact store
 * (artifacts.transfer.v1, handoff §8.2).
 *
 * Downloads name one immutable artifact version. The original is read by offset from the content-addressed
 * object store, whose bytes were verified against the version's SHA-256 when the transfer began; a reduced
 * preview is a separate variant, so "Download original" is always explicit. Two versions can never be spliced:
 * the transfer is bound to one digest and the object file for a digest never changes.
 *
 * Uploads are staged per device in a private directory, one acknowledged chunk at a time, at the committed
 * offset only (a retried chunk at an earlier offset is refused, not rewritten). Commit verifies size and digest
 * before installing exactly one artifact version with the phone as its provenance, or before handing a layer
 * or mask to the image editor. A transfer retried is never a repeated generation or command.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { remoteError } from '../execution.ts';
import type { Router } from './router.ts';
import type { Device } from './store.ts';

export const transferLimits = {
  chunk: 256 * 1024,
  uploadBytes: 100 * 1024 * 1024,
  /** Bytes one device may have staged at once. */
  stagedPerDevice: 256 * 1024 * 1024,
  openPerDevice: 6,
  idleMs: 30 * 60_000,
  previewEdge: 1600,
};

type Download = { id: string; deviceId: string; sessionId: string; artifactId: string; versionId: string; variant: 'original' | 'preview';
  name: string; mime: string; size: number; sha256: string; path?: string; data?: Buffer; expiresAt: number };
type Upload = { id: string; deviceId: string; sessionId: string; name: string; mime: string; size: number; sha256: string; purpose: 'artifact' | 'layer' | 'mask';
  path: string; offset: number; status: 'uploading' | 'ready' | 'committed' | 'aborted'; expiresAt: number; artifact?: unknown; commit?: Promise<unknown> };

const hex = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const uuidOf = (bytes: Buffer) => { const h = bytes.subarray(0, 16).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

export class Transfers {
  router: Router;
  downloads = new Map<string, Download>();
  uploads = new Map<string, Upload>();
  private busy = new Set<string>();
  constructor(router: Router) { this.router = router; }
  get directory() { return join(this.router.core.store.directory, 'remote-transfers'); }

  /** Active transfer IDs have gateway lifetime. Remove unreachable private staging from the previous broker. */
  async resetStaging() { await rm(this.directory, { recursive: true, force: true }); }

  async prune() {
    const now = Date.now();
    for (const [id, d] of this.downloads) if (d.expiresAt < now) this.downloads.delete(id);
    await Promise.all([...this.uploads].map(async ([id, u]) => {
      if (u.expiresAt >= now || u.commit || this.busy.has(id)) return;
      if (u.status !== 'committed') await rm(u.path, { force: true });
      this.uploads.delete(id);
    }));
  }
  private owned<T extends { deviceId: string; expiresAt: number }>(map: Map<string, T>, device: Device, id: string, what: string): T {
    const value = map.get(id);
    if (!value || value.deviceId !== device.id || value.expiresAt <= Date.now()) throw remoteError('ATTACHMENT_INVALID', `This ${what} ended or belongs to another phone. Start it again.`);
    return value;
  }

  private checkDownloadLimit(deviceId: string) {
    const open = [...this.downloads.values()].filter(d => d.deviceId === deviceId).length;
    if (open >= transferLimits.openPerDevice) throw remoteError('LIMIT_EXCEEDED', 'Finish or wait for other downloads first.');
  }

  /** Starts reading one artifact version: its original bytes, or a reduced image preview. */
  async download(device: Device, p: { sessionId: string; artifactId: string; versionId?: string; variant: 'original' | 'preview' }) {
    await this.prune();
    this.checkDownloadLimit(device.id);
    const artifacts = this.router.core.workbench.artifacts;
    const { version, data } = await artifacts.bytes(p.sessionId, p.artifactId, p.versionId);
    const base = { id: randomUUID(), deviceId: device.id, sessionId: p.sessionId, artifactId: version.artifactId, versionId: version.versionId, expiresAt: Date.now() + transferLimits.idleMs };
    let download: Download;
    if (p.variant === 'preview') {
      if (version.kind !== 'image' && version.kind !== 'plot') throw remoteError('INVALID_ARGUMENT', 'Only images have a reduced preview. Download the original instead.');
      const preview = await sharp(data, { limitInputPixels: 100_000_000 }).rotate().resize(transferLimits.previewEdge, transferLimits.previewEdge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      download = { ...base, variant: 'preview', name: version.name.replace(/\.[^.]+$/, '') + ' (preview).jpg', mime: 'image/jpeg', size: preview.length, sha256: hex(preview), data: preview };
    } else {
      download = { ...base, variant: 'original', name: version.name, mime: version.mime, size: version.bytes, sha256: version.sha256, path: artifacts.objectPath(version.sha256) };
    }
    this.router.session(device, p.sessionId);
    this.checkDownloadLimit(device.id);
    this.downloads.set(download.id, download);
    return { transferId: download.id, variant: download.variant, name: download.name, mime: download.mime, size: download.size, sha256: download.sha256,
      artifactId: download.artifactId, versionId: download.versionId, chunk: transferLimits.chunk, expiresAt: download.expiresAt };
  }

  /** One chunk of a download, framed like attachment reads: 16-byte transfer ID, 8-byte offset, bytes. */
  async read(device: Device, p: { transferId: string; offset: number; length: number }): Promise<Buffer> {
    const d = this.owned(this.downloads, device, p.transferId, 'download');
    // The conversation must still give this phone the artifact (it may have been removed or forgotten).
    this.router.session(device, d.sessionId);
    if (!this.router.core.workbench.artifacts.authorized(d.sessionId, d.artifactId)) throw remoteError('ATTACHMENT_INVALID', 'This file is no longer available in the conversation.');
    if (p.offset >= d.size) throw remoteError('INVALID_ARGUMENT', 'The offset is past the end of the file.');
    const length = Math.min(p.length, d.size - p.offset, transferLimits.chunk);
    let body: Buffer;
    if (d.data) body = d.data.subarray(p.offset, p.offset + length);
    else {
      const file = await open(d.path!, 'r');
      try { body = Buffer.alloc(length); const { bytesRead } = await file.read(body, 0, length, p.offset); body = body.subarray(0, bytesRead); }
      finally { await file.close(); }
      if (body.length !== length) throw remoteError('ATTACHMENT_INVALID', 'The stored file changed size. Download it again.');
    }
    d.expiresAt = Date.now() + transferLimits.idleMs;
    const header = Buffer.alloc(24); Buffer.from(d.id.replaceAll('-', ''), 'hex').copy(header); header.writeBigUInt64BE(BigInt(p.offset), 16);
    return Buffer.concat([header, body]);
  }

  /** Reserves a staged upload; the phone then sends binary chunks at the committed offset. */
  async upload(device: Device, p: { sessionId: string; name: string; mime: string; size: number; sha256: string; purpose: Upload['purpose'] }) {
    await this.prune();
    const mine = [...this.uploads.values()].filter(u => u.deviceId === device.id && u.status !== 'committed');
    if (mine.length >= transferLimits.openPerDevice) throw remoteError('LIMIT_EXCEEDED', 'Finish or cancel other uploads first.');
    if (mine.reduce((sum, u) => sum + u.size, 0) + p.size > transferLimits.stagedPerDevice) throw remoteError('LIMIT_EXCEEDED', 'Too much is waiting to upload from this phone. Finish or cancel some uploads.');
    if ((p.purpose === 'layer' || p.purpose === 'mask') && p.mime !== 'image/png') throw remoteError('INVALID_ARGUMENT', 'Edit layers and masks are PNG images.');
    const id = randomUUID(), folder = join(this.directory, device.id);
    const path = join(folder, id);
    const upload: Upload = { id, deviceId: device.id, sessionId: p.sessionId, name: p.name.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 200) || 'upload',
      mime: p.mime, size: p.size, sha256: p.sha256, purpose: p.purpose, path, offset: 0, status: 'uploading', expiresAt: Date.now() + transferLimits.idleMs };
    this.router.session(device, p.sessionId);
    this.uploads.set(id, upload);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await (await open(path, 'wx', 0o600)).close();
      this.router.current(device);
      return this.dto(upload);
    } catch (error) {
      this.uploads.delete(id);
      await rm(path, { force: true });
      throw error;
    }
  }
  dto(u: Upload) { return { transferId: u.id, status: u.status, offset: u.offset, size: u.size, sha256: u.sha256, purpose: u.purpose, chunk: transferLimits.chunk, expiresAt: u.expiresAt, ...(u.artifact ? { artifact: u.artifact } : {}) }; }
  status(device: Device, id: string) {
    const download = this.downloads.get(id);
    if (download && download.deviceId === device.id && download.expiresAt > Date.now()) return { transferId: id, kind: 'download', size: download.size, sha256: download.sha256, expiresAt: download.expiresAt };
    return this.dto(this.owned(this.uploads, device, id, 'upload'));
  }
  /** Whether a binary frame belongs to one of this device's uploads (otherwise it is an attachment chunk). */
  claims(device: Device, bytes: Buffer) { if (bytes.length < 24) return false; const u = this.uploads.get(uuidOf(bytes)); return !!u && u.deviceId === device.id; }
  async chunk(device: Device, bytes: Buffer) {
    if (bytes.length <= 24 || bytes.length > 24 + transferLimits.chunk) throw remoteError('LIMIT_EXCEEDED', 'Invalid upload chunk.');
    const u = this.owned(this.uploads, device, uuidOf(bytes), 'upload'), offset = bytes.readBigUInt64BE(16), body = bytes.subarray(24);
    if (u.status !== 'uploading' || offset !== BigInt(u.offset) || u.offset + body.length > u.size || this.busy.has(u.id)) throw remoteError('ATTACHMENT_INVALID', 'Resume at the committed upload offset.');
    this.busy.add(u.id);
    try {
      const file = await open(u.path, 'r+');
      try { this.router.current(device); const { bytesWritten } = await file.write(body, 0, body.length, u.offset); if (bytesWritten !== body.length) throw remoteError('ATTACHMENT_INVALID', 'The complete chunk could not be written.'); await file.sync(); }
      finally { await file.close(); }
      u.offset += body.length; u.expiresAt = Date.now() + transferLimits.idleMs;
      if (u.offset === u.size) u.status = 'ready';
      return { transferId: u.id, offset: u.offset, size: u.size };
    } finally { this.busy.delete(u.id); }
  }
  /** Verified staged bytes of a ready upload, for the image editor (layer, mask). */
  async staged(device: Device, id: string, purpose: 'layer' | 'mask') {
    const u = this.owned(this.uploads, device, id, 'upload');
    if (u.purpose !== purpose || (u.status !== 'ready' && u.status !== 'committed')) throw remoteError('ATTACHMENT_INVALID', 'Finish uploading the edit first.');
    const bytes = await readFile(u.path);
    if (bytes.length !== u.size || hex(bytes) !== u.sha256) throw remoteError('ATTACHMENT_INVALID', 'The uploaded edit does not match what the phone sent. Upload it again.');
    return bytes;
  }
  async consume(device: Device, id: string) { const u = this.uploads.get(id); if (u && u.deviceId === device.id) { this.uploads.delete(id); await rm(u.path, { force: true }); } }
  /** Verifies and installs exactly one artifact version; a repeated commit returns the same version. */
  async commit(device: Device, p: { transferId: string; destinations?: { remote: boolean; cloud: boolean } }) {
    const u = this.owned(this.uploads, device, p.transferId, 'upload');
    if (u.status === 'committed') return this.dto(u);
    if (u.commit) return u.commit;
    try {
      u.commit = this.install(device, u, p.destinations);
      return await u.commit;
    } finally { delete u.commit; }
  }
  private async install(device: Device, u: Upload, destinations?: { remote: boolean; cloud: boolean }) {
    if (u.purpose !== 'artifact') throw remoteError('INVALID_ARGUMENT', 'Edit layers and masks are used by the image editor, not saved alone.');
    if (u.status !== 'ready' || u.offset !== u.size) throw remoteError('ATTACHMENT_INVALID', 'The upload is incomplete.');
    const bytes = await readFile(u.path);
    if (bytes.length !== u.size || hex(bytes) !== u.sha256) { u.status = 'aborted'; await rm(u.path, { force: true }); this.uploads.delete(u.id); throw remoteError('ATTACHMENT_INVALID', 'The uploaded bytes do not match their digest. Upload the file again.'); }
    this.router.session(device, u.sessionId);
    const policy = destinations ? { remote: destinations.remote || destinations.cloud, cloud: destinations.cloud } : { remote: false, cloud: false };
    const version = await this.router.core.workbench.artifacts.install({ sessionId: u.sessionId, bytes, name: u.name, mime: u.mime, source: 'user-import', policy,
      provenance: { kind: 'phone-import', name: u.name, deviceId: device.id, device: device.name.slice(0, 48) } });
    u.status = 'committed'; u.artifact = { artifactId: version.artifactId, versionId: version.versionId, name: version.name, sha256: version.sha256 };
    await rm(u.path, { force: true });
    this.router.core.changed();
    return this.dto(u);
  }
  async abort(device: Device, id: string) {
    const u = this.uploads.get(id);
    if (u?.deviceId === device.id && u.commit) await u.commit.catch(() => {});
    if (u && u.deviceId === device.id && u.status !== 'committed') { u.status = 'aborted'; this.uploads.delete(id); await rm(u.path, { force: true }); }
    const d = this.downloads.get(id); if (d && d.deviceId === device.id) this.downloads.delete(id);
    return true;
  }
  /** Revocation and scope changes end a device's transfers and remove its staged bytes. */
  async purge(deviceId: string) {
    for (const [id, d] of this.downloads) if (d.deviceId === deviceId) this.downloads.delete(id);
    for (const [id, u] of this.uploads) if (u.deviceId === deviceId) this.uploads.delete(id);
    await rm(join(this.directory, deviceId), { recursive: true, force: true });
  }
  async sizeOf(path: string) { try { return (await stat(path)).size; } catch { return -1; } }
}
