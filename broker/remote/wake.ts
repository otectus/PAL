/**
 * Waking a phone through a push service its owner chose (mobile plan: optional UnifiedPush). Off until the owner allows
 * it on this desktop for one phone and one push server. What is sent is a hint and nothing else: a time and a random
 * number, encrypted to that phone as Web Push asks (RFC 8291). No name, text, title, count or decision is in it, so the
 * push service learns only that something happened, and it cannot make a hint of its own.
 *
 * A hint is sent only when that phone has something new and no connection, at most once in half a minute and sixty times
 * a day. It is never resent: the phone learns everything when it connects, with or without it.
 */
import { createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Device, RemoteStore } from './store.ts';
import { remoteError } from '../execution.ts';

export type WakeRegistration = { endpoint: string; host: string; key: string; auth: string; registered: number; approved: boolean; failures: number; lastSent: number; sentDay: string; sentToday: number; problem?: string };
export const wakeLimits = { quietMs: 30_000, failingQuietMs: 15 * 60_000, perDay: 60, failures: 5, timeoutMs: 10_000, ttlSeconds: 600, hint: 28 };
const magic = Buffer.from('PALW');

/** `PALW` · time (8 bytes, milliseconds) · nonce (16 bytes). The phone accepts each time once and never an earlier one. */
export function wakeHint(time = Date.now(), nonce = randomBytes(16)) {
  const head = Buffer.alloc(12); magic.copy(head, 0); head.writeBigUInt64BE(BigInt(time), 4);
  return Buffer.concat([head, nonce]);
}
export function readHint(hint: Buffer) { return hint.length === wakeLimits.hint && hint.subarray(0, 4).equals(magic) ? { time: Number(hint.readBigUInt64BE(4)), nonce: hint.subarray(12).toString('hex') } : undefined; }

const hmac = (key: Buffer, ...parts: Buffer[]) => { const mac = createHmac('sha256', key); for (const part of parts) mac.update(part); return mac.digest(); };
const one = Buffer.from([1]), text = (value: string) => Buffer.from(value + '\0');
function contentKeys(shared: Buffer, auth: Buffer, phone: Buffer, server: Buffer, salt: Buffer) {
  const input = hmac(hmac(auth, shared), text('WebPush: info'), phone, server, one), key = hmac(salt, input);
  return { key: hmac(key, text('Content-Encoding: aes128gcm'), one).subarray(0, 16), nonce: hmac(key, text('Content-Encoding: nonce'), one).subarray(0, 12) };
}
/** One Web Push message (RFC 8291, content coding aes128gcm) for the phone's public key and shared secret. */
export function encryptPush(plain: Buffer, phone: Buffer, auth: Buffer, fixed?: { salt: Buffer; privateKey: Buffer }) {
  const pair = createECDH('prime256v1'); if (fixed) pair.setPrivateKey(fixed.privateKey); else pair.generateKeys();
  const server = pair.getPublicKey(), salt = fixed?.salt || randomBytes(16), { key, nonce } = contentKeys(pair.computeSecret(phone), auth, phone, server, salt);
  const cipher = createCipheriv('aes-128-gcm', key, nonce), size = Buffer.alloc(5); size.writeUInt32BE(4096, 0); size[4] = server.length;
  return Buffer.concat([salt, size, server, cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
}
/** The phone's side, kept here so both sides are tested against each other. */
export function decryptPush(message: Buffer, privateKey: Buffer, auth: Buffer) {
  const pair = createECDH('prime256v1'); pair.setPrivateKey(privateKey);
  const salt = message.subarray(0, 16), server = message.subarray(21, 21 + message[20]), body = message.subarray(21 + message[20]);
  const { key, nonce } = contentKeys(pair.computeSecret(server), auth, pair.getPublicKey(), server, salt), open = createDecipheriv('aes-128-gcm', key, nonce);
  open.setAuthTag(body.subarray(-16));
  const padded = Buffer.concat([open.update(body.subarray(0, -16)), open.final()]), end = padded.lastIndexOf(2);
  return padded.subarray(0, end);
}
/** Some push servers ask who is sending (RFC 8292). This says only that it is the same desktop as before. */
export function vapid(privatePem: string, audience: string, now: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600 })}`;
  return `vapid t=${body}.${sign('sha256', Buffer.from(body), { key: privatePem, dsaEncoding: 'ieee-p1363' }).toString('base64url')}, k=${publicPoint(privatePem)}`;
}
function publicPoint(privatePem: string) {
  const { x, y } = createPublicKey(createPrivateKey(privatePem)).export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');
}
/** A push endpoint: an ordinary HTTPS address, without credentials or a fragment. */
export function pushEndpoint(value: unknown): URL {
  let url: URL; try { url = new URL(String(value)); } catch { throw remoteError('INVALID_ARGUMENT', 'The push service gave an address PAL cannot use.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || String(value).length > 1000 || !url.hostname) throw remoteError('INVALID_ARGUMENT', 'The push service gave an address PAL cannot use. It must be an HTTPS address.');
  return url;
}

export class Wake {
  registry: RemoteStore;
  send: typeof fetch = fetch;
  now = () => Date.now();
  changed: () => void = () => {};
  /** A connected phone is told directly. */
  connected: (deviceId: string) => boolean = () => false;
  closed = false;
  private sending = new Set<string>();
  private later = new Map<string, NodeJS.Timeout>();
  constructor(registry: RemoteStore) { this.registry = registry; }
  private save(id: string, wake: WakeRegistration | undefined) { const current = this.registry.device(id); if (!current) return; if (wake) current.wake = wake; else delete current.wake; this.registry.saveDevice(current); this.changed(); }
  /** The key this desktop signs its pushes with, made when a phone first asks for it. */
  private signing() {
    let pem = this.registry.store.get('remoteWakeKey', '');
    if (!pem) { pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string; this.registry.store.set('remoteWakeKey', pem); }
    return pem;
  }
  /** A phone's request. A new server, or a changed address on another host, waits for the owner's answer on the desktop. */
  register(device: Device, p: { endpoint: string; key: string; auth: string }) {
    const url = pushEndpoint(p.endpoint), key = Buffer.from(p.key, 'base64url'), auth = Buffer.from(p.auth, 'base64url');
    if (key.length !== 65 || key[0] !== 4 || auth.length !== 16) throw remoteError('INVALID_ARGUMENT', 'The wake-up key is not valid.');
    try { const pair = createECDH('prime256v1'); pair.generateKeys(); pair.computeSecret(key); } catch { throw remoteError('INVALID_ARGUMENT', 'The wake-up key is not valid.'); }
    const known = this.registry.device(device.id)?.wake, approved = !!known?.approved && known.host === url.host;
    const same = known && known.endpoint === url.href && known.key === p.key && known.auth === p.auth;
    const next: WakeRegistration = same ? known : { endpoint: url.href, host: url.host, key: p.key, auth: p.auth, registered: this.now(), approved, failures: 0, lastSent: known?.lastSent || 0, sentDay: known?.sentDay || '', sentToday: known?.sentToday || 0 };
    if (!same) { this.save(device.id, next); this.registry.audit({ deviceId: device.id, operation: 'wake.register', decision: approved ? 'approved' : 'waiting', scope: url.host }); }
    return this.status(device.id);
  }
  unregister(device: Device) { this.forget(device.id); this.registry.audit({ deviceId: device.id, operation: 'wake.unregister', decision: 'removed' }); return this.status(device.id); }
  /** Removes what a phone registered, with any hint still waiting for it. */
  forget(id: string) { clearTimeout(this.later.get(id)); this.later.delete(id); if (this.registry.device(id)?.wake) this.save(id, undefined); }
  /** The owner's answer on this desktop, for the exact server it names. */
  decide(id: string, approved: boolean, host?: string) {
    const device = this.registry.live(id); if (!device?.wake) throw new Error('This phone no longer asks to be woken');
    if (!approved) { this.forget(id); this.registry.audit({ deviceId: id, operation: 'wake.decide', decision: 'denied' }); return true; }
    if (host !== device.wake.host) throw new Error('The phone’s push server changed. Review it again.');
    const { problem: _problem, ...wake } = device.wake;
    this.save(id, { ...wake, approved: true, failures: 0 });
    this.registry.audit({ deviceId: id, operation: 'wake.decide', decision: 'approved', scope: wake.host });
    return true;
  }
  /** What the owner and the phone are shown. The address and the keys stay here. */
  describe(wake: WakeRegistration | undefined) { return wake ? { state: wake.approved ? (wake.problem ? 'failing' as const : 'on' as const) : 'waiting' as const, host: wake.host, ...(wake.problem ? { problem: wake.problem } : {}) } : { state: 'off' as const }; }
  /** For the phone itself, with the key some push services ask it to name when it registers. */
  status(id: string) { return { ...this.describe(this.registry.device(id)?.wake), senderKey: publicPoint(this.signing()) }; }
  /** Sends one hint if this phone may be woken now; within the quiet time, one is kept for its end. Never throws. */
  async hint(deviceId: string): Promise<'sent' | 'skipped' | 'later' | 'failed'> {
    const device = this.registry.live(deviceId), wake = device?.wake, now = this.now();
    if (this.closed || !device || !wake?.approved || this.sending.has(deviceId) || this.connected(deviceId)) return 'skipped';
    const wait = wake.lastSent + (wake.failures >= wakeLimits.failures ? wakeLimits.failingQuietMs : wakeLimits.quietMs) - now;
    if (wait > 0) {
      if (!this.later.has(deviceId)) { const timer = setTimeout(() => { this.later.delete(deviceId); void this.hint(deviceId).catch(() => {}); }, wait); timer.unref(); this.later.set(deviceId, timer); }
      return 'later';
    }
    const day = new Date(now).toISOString().slice(0, 10), sentToday = wake.sentDay === day ? wake.sentToday : 0;
    if (sentToday >= wakeLimits.perDay) return 'skipped';
    this.sending.add(deviceId);
    this.save(deviceId, { ...wake, lastSent: now, sentDay: day, sentToday: sentToday + 1 });
    let status = 0;
    try {
      const url = pushEndpoint(wake.endpoint), body = encryptPush(wakeHint(now), Buffer.from(wake.key, 'base64url'), Buffer.from(wake.auth, 'base64url'));
      const response = await this.send(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(wakeLimits.timeoutMs), body: new Uint8Array(body),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(wakeLimits.ttlSeconds), Urgency: 'high', Authorization: vapid(this.signing(), url.origin, now) } });
      status = response.status; await response.body?.cancel().catch(() => {});
    } catch { status = 0; } finally { this.sending.delete(deviceId); }
    const current = this.closed ? undefined : this.registry.live(deviceId)?.wake;
    if (!current || current.endpoint !== wake.endpoint) return 'skipped';
    const { problem: _problem, ...rest } = current;
    if (status >= 200 && status < 300) { if (current.failures || current.problem) this.save(deviceId, { ...rest, failures: 0 }); return 'sent'; }
    // The push service no longer knows this address: the phone has to register again.
    if (status === 404 || status === 410) { this.forget(deviceId); return 'failed'; }
    this.save(deviceId, { ...rest, failures: current.failures + 1, problem: status ? `The push server answered HTTP ${status}` : 'The push server could not be reached' });
    return 'failed';
  }
  close() { this.closed = true; for (const timer of this.later.values()) clearTimeout(timer); this.later.clear(); }
}
