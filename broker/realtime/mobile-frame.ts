import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { RealtimeCodec } from './contracts.ts';
import { realtimeLimits } from './contracts.ts';

export const mobileRealtimeProtocol = Object.freeze({
  version: 1,
  magic: 'PLRT',
  encryption: 'aes-256-gcm' as const,
  keyDerivation: 'hkdf-sha256' as const,
  codecs: ['pcm16', 'g711_ulaw', 'g711_alaw', 'opus'] as const,
  headerBytes: 40,
  tagBytes: 16,
  maxPayloadBytes: realtimeLimits.maxAudioChunkBytes,
});

export type MobileFrameDirection = 'input' | 'output';
export type MobileRealtimeFrame = {
  sessionId: string;
  direction: MobileFrameDirection;
  codec: RealtimeCodec;
  sequence: number;
  timestampMs: number;
  endOfTurn?: boolean;
  discontinuity?: boolean;
  audio: Buffer;
};

const magic = Buffer.from(mobileRealtimeProtocol.magic, 'ascii');
const kinds: Record<MobileFrameDirection, number> = { input: 1, output: 2 };
const directions = new Map([[1, 'input' as const], [2, 'output' as const]]);
const codecIds: Record<RealtimeCodec, number> = { pcm16: 1, g711_ulaw: 2, g711_alaw: 3, opus: 4 };
const idCodecs = new Map(Object.entries(codecIds).map(([name, id]) => [id, name as RealtimeCodec]));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidBytes(value: string) {
  if (!uuidPattern.test(value)) throw new Error('Invalid realtime session ID');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}
function bytesUuid(value: Buffer) {
  const hex = value.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function rootSecret(value: Uint8Array) {
  const secret = Buffer.from(value);
  if (secret.length < 32 || secret.length > 1024) throw new Error('Realtime framing requires a paired connection secret');
  return secret;
}
export function deriveMobileRealtimeKey(pairingSecret: Uint8Array, sessionId: string) {
  return Buffer.from(hkdfSync('sha256', rootSecret(pairingSecret), uuidBytes(sessionId), Buffer.from('pal-realtime-audio-v1'), 32));
}
function nonce(key: Buffer, header: Buffer) {
  return createHmac('sha256', key).update('pal-realtime-nonce-v1').update(header.subarray(5, 36)).digest().subarray(0, 12);
}
function validateFrame(frame: MobileRealtimeFrame) {
  if (!directions.has(kinds[frame.direction])) throw new Error('Invalid realtime frame direction');
  if (!(frame.codec in codecIds)) throw new Error('Invalid realtime audio codec');
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_fffe) throw new Error('Invalid realtime frame sequence');
  if (!Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0) throw new Error('Invalid realtime frame timestamp');
  if (!Buffer.isBuffer(frame.audio) || frame.audio.length > realtimeLimits.maxAudioChunkBytes) throw new Error('Realtime audio frame exceeds its size limit');
}

export function encodeMobileRealtimeFrame(pairingSecret: Uint8Array, frame: MobileRealtimeFrame) {
  validateFrame(frame);
  const session = uuidBytes(frame.sessionId), header = Buffer.alloc(mobileRealtimeProtocol.headerBytes);
  magic.copy(header, 0); header[4] = mobileRealtimeProtocol.version; header[5] = kinds[frame.direction]; header[6] = codecIds[frame.codec];
  header[7] = (frame.endOfTurn ? 1 : 0) | (frame.discontinuity ? 2 : 0); session.copy(header, 8);
  header.writeUInt32BE(frame.sequence, 24); header.writeBigUInt64BE(BigInt(frame.timestampMs), 28); header.writeUInt32BE(frame.audio.length, 36);
  const key = deriveMobileRealtimeKey(pairingSecret, frame.sessionId), cipher = createCipheriv('aes-256-gcm', key, nonce(key, header)); cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(frame.audio), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

export class MobileFrameSequence {
  readonly sessionId: string; readonly direction: MobileFrameDirection; next = 0;
  constructor(sessionId: string, direction: MobileFrameDirection, next = 0) { this.sessionId = sessionId; this.direction = direction; this.next = next; }
  check(frame: Pick<MobileRealtimeFrame, 'sessionId' | 'direction' | 'sequence'>) {
    if (frame.sessionId !== this.sessionId || frame.direction !== this.direction) throw new Error('Realtime audio frame belongs to another stream');
    if (frame.sequence !== this.next) throw new Error(frame.sequence < this.next ? 'Duplicate realtime audio frame' : 'Out-of-order realtime audio frame');
  }
  accept() { if (this.next >= 0xffff_fffe) throw new Error('Realtime audio sequence is exhausted'); this.next++; }
}

export function decodeMobileRealtimeFrame(pairingSecret: Uint8Array, bytes: Uint8Array, sequence?: MobileFrameSequence, now = Date.now()) {
  const value = Buffer.from(bytes), minimum = mobileRealtimeProtocol.headerBytes + mobileRealtimeProtocol.tagBytes;
  if (value.length < minimum || value.length > minimum + realtimeLimits.maxAudioChunkBytes) throw new Error('Invalid realtime audio frame length');
  const header = value.subarray(0, mobileRealtimeProtocol.headerBytes);
  if (!timingSafeEqual(header.subarray(0, 4), magic) || header[4] !== mobileRealtimeProtocol.version) throw new Error('Unsupported realtime audio frame');
  const direction = directions.get(header[5]), codec = idCodecs.get(header[6]);
  if (!direction || !codec || header[7] & ~3) throw new Error('Invalid realtime audio frame header');
  const sessionId = bytesUuid(header.subarray(8, 24)), length = header.readUInt32BE(36), timestamp = header.readBigUInt64BE(28);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER) || length > realtimeLimits.maxAudioChunkBytes || value.length !== minimum + length) throw new Error('Invalid realtime audio frame length');
  const timestampMs = Number(timestamp);
  if (Math.abs(now - timestampMs) > 5 * 60_000) throw new Error('Stale realtime audio frame');
  const frame = { sessionId, direction, codec, sequence: header.readUInt32BE(24), timestampMs, endOfTurn: !!(header[7] & 1), discontinuity: !!(header[7] & 2) };
  sequence?.check(frame);
  const key = deriveMobileRealtimeKey(pairingSecret, sessionId), decipher = createDecipheriv('aes-256-gcm', key, nonce(key, header));
  decipher.setAAD(header); decipher.setAuthTag(value.subarray(value.length - mobileRealtimeProtocol.tagBytes));
  let audio: Buffer;
  try { audio = Buffer.concat([decipher.update(value.subarray(mobileRealtimeProtocol.headerBytes, value.length - mobileRealtimeProtocol.tagBytes)), decipher.final()]); }
  catch { throw new Error('Realtime audio frame authentication failed'); }
  sequence?.accept();
  return { ...frame, audio } satisfies MobileRealtimeFrame;
}

