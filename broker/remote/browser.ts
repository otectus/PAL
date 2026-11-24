/**
 * A08 browser companion (opt-in): the conversations a person chose, in a web browser. It is a surface of its own beside
 * the phone's, with the same routing, scopes, signed commands and revocation behind it, and it never opens the phone's
 * endpoint to a browser.
 *
 * - Off unless chosen, and on this computer only unless chosen. Nothing listens without a paired browser or an open
 *   pairing. Off switches it off at once, and so does switching remote access off.
 * - No cookies, passwords, tokens or sessions to steal: each connection proves a key the browser cannot export. The page
 *   is static, loads nothing from anywhere else, and shows everything as text.
 * - A connection is accepted only from the page's own origin, for a host name this listener answers to: another site, or
 *   a name pointed at this computer, gets nothing.
 * - A browser is never an owner and never holds desktop, settings, file or billing grants. What it may call is a short
 *   list here, and its keys work on no other surface.
 * - Pairing needs a one-time code shown on the desktop, the same six words on both screens, and a yes on the desktop.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { observerCaps, deviceRole } from '../authority.ts';
import { remoteError } from '../execution.ts';
import { canonical, digest, verified } from './crypto.ts';
import { addresses as localAddresses } from './identity.ts';
import type { MobileGateway } from './server.ts';
import type { Device, Project, RemoteConfig } from './store.ts';

/** Everything a browser may call. A grant decides which of these it may; nothing else exists for it. */
export const browserMethods = new Set(['client.features', 'sync.open', 'sync.ack', 'sessions.list', 'sessions.get', 'sessions.batch', 'sessions.messages', 'sessions.messagePart', 'sessions.send', 'sessions.stop', 'sessions.read', 'projects.list', 'approvals.list', 'approvals.get', 'approvals.answer', 'commands.challenge', 'commands.status', 'permissions.get', 'devices.self', 'devices.selfRevoke']);
/** Grants a browser may hold at all. */
export const browserCaps = ['chat.read', 'chat.write', 'approvals.answer', 'approvals.provider', 'providers.execute'] as const;
export const browserLimits = { days: 14, offerMs: 5 * 60_000, attempts: 5, peers: 6, codeLength: 10 };
export type BrowserConfig = NonNullable<RemoteConfig['browser']>;
export const defaultBrowser: BrowserConfig = { enabled: false, addresses: [], port: 8444 };

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ', b64 = z.string().regex(/^[A-Za-z0-9_-]+$/), uuid = z.uuid();
export const pairingCode = (text: string) => text.toUpperCase().replace(/[^0-9A-Z]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
const responseSchema = z.strictObject({ type: z.literal('browser-response'), v: z.literal(1), desktopId: uuid, pairingId: uuid, offerDigest: b64, nonce: b64.length(43), deviceId: uuid, name: z.string().min(1).max(48), keyVersion: z.literal(1), connectionKey: b64, actionKey: b64, deviceNonce: b64.length(43), connectionProof: b64, actionProof: b64 });
const pairSchema = z.strictObject({ v: z.literal(1), type: z.literal('browser.pair'), response: responseSchema, codeProof: b64.length(43) });
export const browserOfferRequest = z.strictObject({ v: z.literal(1), type: z.literal('browser.offer') });

type Offer = { type: 'browser-offer'; v: 1; desktopId: string; name: string; pairingId: string; nonce: string; role: 'observer' | 'limited'; expiresAt: number };
type Window = { offer: Offer; key: string; attempts: number; projects: Project[]; caps: string[]; received?: { name: string; sas: string; response: z.infer<typeof responseSchema>; at: number } };
type Page = { body: Buffer; type: string };

const words: string[] = JSON.parse(readFileSync(new URL('../../protocol/mobile/v1/sas-words.json', import.meta.url), 'utf8'));
/** The page, read once. It is the same for everyone and holds nothing about this desktop. */
const file = (name: string, type: string): Page => ({ body: readFileSync(new URL('./browser/' + name, import.meta.url)), type });
const pages: Record<string, Page> = { '/': file('index.html', 'text/html; charset=utf-8'), '/app.js': file('app.js', 'text/javascript; charset=utf-8'), '/protocol.js': file('protocol.js', 'text/javascript; charset=utf-8'), '/style.css': file('style.css', 'text/css; charset=utf-8'), '/words.json': { body: Buffer.from(JSON.stringify(words)), type: 'application/json; charset=utf-8' } };
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
const bracket = (address: string) => isIP(address) === 6 ? `[${address}]` : address;

export class BrowserCompanion {
  gateway: MobileGateway; window?: Window; problem = '';
  private bindings = new Map<string, { server: Server; ws: WebSocketServer }>(); private lifecycle = Promise.resolve();
  constructor(gateway: MobileGateway) { this.gateway = gateway; }
  config(): BrowserConfig { return { ...defaultBrowser, ...this.gateway.registry.config().browser }; }
  private devices() { return this.gateway.registry.devices().filter(device => device.surface === 'browser' && this.gateway.registry.live(device.id)); }
  private open() { return !!this.window && this.window.offer.expiresAt > Date.now(); }
  shouldListen() { const config = this.config(); return config.enabled && !this.gateway.closed && (this.open() || this.gateway.registry.config().enabled && this.devices().length > 0); }
  /** Where the page is: plain HTTP on this computer alone, TLS with the desktop's own certificate anywhere else. */
  origins(config = this.config()): string[] { return [...config.addresses.length ? config.addresses.map(address => `https://${bracket(address)}:${config.port}`) : [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`], ...(config.proxy ? [config.proxy] : [])]; }
  /** Refuses a name pointed at this computer (DNS rebinding) and every other site. */
  accepts(request: Pick<IncomingMessage, 'headers'>, origin: 'required' | 'absent-or-own'): boolean {
    const own = this.origins(), hosts = own.map(value => new URL(value).host), host = request.headers.host || '', from = request.headers.origin;
    if (!hosts.includes(host)) return false;
    if (origin === 'absent-or-own' && from === undefined) return true;
    return typeof from === 'string' && own.includes(from) && new URL(from).host === host;
  }
  private serve = (request: IncomingMessage, response: ServerResponse) => {
    const end = (status: number, body: Buffer | string = '', type = 'text/plain; charset=utf-8') => { response.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); response.end(request.method === 'HEAD' ? undefined : body); };
    if (!this.accepts(request, 'absent-or-own')) return end(421, 'This address is not one PAL answers to.');
    if (request.method !== 'GET' && request.method !== 'HEAD') return end(405, 'Only reading.');
    const page = Object.hasOwn(pages, request.url || '') ? pages[request.url!] : undefined;
    return page ? end(200, page.body, page.type) : end(404, 'Not found.');
  };
  private upgrade(server: WebSocketServer, request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const registry = this.gateway.registry.config(), peers = [...this.gateway.peers].filter(peer => peer.surface === 'browser').length;
    const allowed = request.url === '/browser/v1' && this.accepts(request, 'required') && request.headers['sec-websocket-protocol'] === 'cere.mobile.v1' && (registry.enabled || this.open()) && this.config().enabled && peers < browserLimits.peers;
    if (!allowed) { socket.destroy(); return; }
    server.handleUpgrade(request, socket, head, (client: WebSocket) => this.gateway.connection(client, 'browser'));
  }
  refresh() { return this.lifecycle = this.lifecycle.catch(() => {}).then(() => this.apply()); }
  private async apply() {
    const config = this.config();
    if (this.window && !this.open()) this.endWindow('expired');
    if (!this.shouldListen()) { await this.stop(); return; }
    const wanted = config.addresses.length ? config.addresses.filter(address => this.gateway.availableAddresses().includes(address)) : ['127.0.0.1'];
    for (const address of [...this.bindings.keys()]) if (!wanted.includes(address)) await this.unbind(address);
    this.problem = wanted.length ? '' : 'None of the chosen addresses is on this computer now.';
    for (const address of wanted) {
      if (this.bindings.has(address)) continue;
      let server: Server | undefined;
      try {
        const options = { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 };
        if (config.addresses.length) { await this.gateway.identity.ensure({ ...this.gateway.registry.config(), addresses: config.addresses }); const material = this.gateway.identity.material(); server = createHttps({ ...options, key: material.key, cert: material.cert, minVersion: 'TLSv1.2' }, this.serve); }
        else server = createHttp(options, this.serve);
        const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024, handleProtocols: protocols => protocols.has('cere.mobile.v1') ? 'cere.mobile.v1' : false }), bound = server;
        bound.on('upgrade', (request, socket, head) => this.upgrade(ws, request, socket, head));
        this.bindings.set(address, { server: bound, ws });
        await new Promise<void>((done, fail) => { bound.once('error', fail); bound.listen(config.port, address, () => { bound.off('error', fail); bound.on('error', error => { this.problem = error.message; void this.unbind(address); }); done(); }); });
        if (!this.shouldListen()) await this.unbind(address);
      } catch (error: any) { await this.unbind(address); this.problem = error?.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : String(error?.message || error).slice(0, 200); }
    }
  }
  private async unbind(address: string) {
    const binding = this.bindings.get(address); if (!binding) return; this.bindings.delete(address);
    for (const client of binding.ws.clients) client.terminate();
    await new Promise<void>(done => { binding.server.close(() => done()); binding.server.closeAllConnections(); }); binding.ws.close();
  }
  async stop() { await Promise.all([...this.bindings.keys()].map(address => this.unbind(address))); for (const peer of this.gateway.peers) if (peer.surface === 'browser') peer.socket.terminate(); }

  /** A one-time code for one browser, with exactly what it will be allowed, for five minutes. */
  async prepare(params: unknown) {
    const p = z.strictObject({ role: z.enum(['observer', 'limited']).default('observer'), projectPaths: z.array(z.string()).min(1).max(32), caps: z.array(z.enum(browserCaps)).default([]) }).parse(params), { registry, identity } = this.gateway;
    if (!this.config().enabled) throw new Error('Turn on browser access first.');
    if (registry.devices().filter(device => registry.live(device.id)).length >= 5) throw new Error('At most five devices may be paired.');
    const projects: Project[] = [...new Set(p.projectPaths.map(path => realpathSync(path)))].map(path => { if (!statSync(path).isDirectory()) throw new Error('Choose a project directory'); return { id: randomUUID(), name: basename(path) || path, path }; });
    if (this.config().addresses.length) await identity.ensure({ ...registry.config(), addresses: this.config().addresses }); else if (!identity.id) registry.store.set('remoteDesktopId', randomUUID());
    const code = Array.from({ length: browserLimits.codeLength }, () => alphabet[randomInt(alphabet.length)]).join('');
    const offer: Offer = { type: 'browser-offer', v: 1, desktopId: identity.id, name: registry.config().name, pairingId: randomUUID(), nonce: randomBytes(32).toString('base64url'), role: p.role, expiresAt: Date.now() + browserLimits.offerMs };
    this.endWindow('replaced');
    this.window = { offer, key: code, attempts: 0, projects, caps: p.role === 'observer' ? ['chat.read', 'approvals.answer'] : [...new Set(['chat.read', ...p.caps])] };
    registry.audit({ operation: 'browser.prepare', decision: 'prepared' }); await this.refresh(); this.gateway.presence();
    return { pairingId: offer.pairingId, code: code.slice(0, 5) + '-' + code.slice(5), expiresAt: offer.expiresAt, role: offer.role, ...this.address() };
  }
  /** The addresses to open, and the certificate to compare when the browser asks about it. */
  address() {
    const config = this.config(), tls = config.addresses.length > 0; let fingerprint = '';
    if (tls) try { fingerprint = createHash('sha256').update(Buffer.from(this.gateway.identity.material().certificate, 'base64url')).digest('hex').toUpperCase().match(/../g)!.join(':'); } catch { /* Not made yet. */ }
    return { urls: this.origins(), ...(fingerprint ? { fingerprint } : {}), listening: [...this.bindings.keys()], problem: this.problem };
  }
  endWindow(reason: 'expired' | 'cancelled' | 'replaced' | 'attempts') {
    const id = this.window?.offer.pairingId; this.window = undefined; if (!id) return;
    for (const peer of this.gateway.peers) if (peer.surface === 'browser' && peer.pairingId === id && !peer.device) { this.gateway.send(peer, { v: 1, type: 'pair.closed', reason }); peer.socket.close(1000, 'PAIR_CLOSED'); }
    this.gateway.presence();
  }
  offer() { return this.open() ? this.window!.offer : undefined; }
  /** A browser's answer. The code proves the person read it from the desktop; the six words that nobody stood between. */
  receive(frame: unknown): { pairingId: string; expiresAt: number } {
    const { response, codeProof } = pairSchema.parse(frame), window = this.window;
    if (!window || !this.open()) throw remoteError('AUTH_EXPIRED', 'This code has ended. Make a new one on the desktop.');
    const { connectionProof, actionProof, ...body } = response, { offer } = window;
    const expected = createHmac('sha256', window.key).update(canonical({ domain: 'pal.browser.pair.code.v1', offer, response: body })).digest(), given = Buffer.from(codeProof, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      if (++window.attempts >= browserLimits.attempts) { this.gateway.registry.audit({ operation: 'browser.pair', decision: 'attempts' }); this.endWindow('attempts'); throw remoteError('AUTH_EXPIRED', 'Too many wrong codes. Make a new one on the desktop.'); }
      throw remoteError('UNAUTHENTICATED', 'That is not the code on the desktop.');
    }
    const transcript = { domain: 'pal.browser.pair.response.v1', response: body };
    if (response.desktopId !== offer.desktopId || response.pairingId !== offer.pairingId || response.offerDigest !== digest(offer) || response.nonce !== offer.nonce || response.connectionKey === response.actionKey || !verified(response.connectionKey, transcript, connectionProof) || !verified(response.actionKey, transcript, actionProof)) throw remoteError('UNAUTHENTICATED', 'This browser’s answer does not match the desktop’s offer.');
    // Only one browser can have the code honestly: a second answer ends the pairing instead of choosing between them.
    if (window.received && digest(window.received.response) !== digest(response)) { this.gateway.registry.audit({ operation: 'browser.pair', decision: 'contested' }); this.endWindow('cancelled'); throw remoteError('UNAUTHENTICATED', 'Another browser answered. Make a new code on the desktop.'); }
    if (this.gateway.registry.device(response.deviceId)) throw remoteError('UNAUTHENTICATED', 'This browser’s identity already exists.');
    window.received ||= { name: response.name, sas: [...createHash('sha256').update(digest(offer) + '.' + digest(response)).digest().subarray(0, 6)].map(value => words[value]).join(' '), response, at: Date.now() };
    this.gateway.registry.audit({ operation: 'browser.pair', decision: 'received' }); this.gateway.presence();
    return { pairingId: offer.pairingId, expiresAt: offer.expiresAt };
  }
  confirm(params: unknown): Device {
    const p = z.strictObject({ pairingId: uuid, sas: z.string(), confirmed: z.literal(true) }).parse(params), window = this.window, { registry } = this.gateway;
    if (!window || !this.open() || window.offer.pairingId !== p.pairingId || !window.received) throw remoteError('AUTH_EXPIRED', 'No browser has answered, or the code ended. Make a new one.');
    if (p.sas !== window.received.sas) throw remoteError('UNAUTHENTICATED', 'Compare the six words in the browser and here.');
    if (registry.devices().filter(device => registry.live(device.id)).length >= 5) throw new Error('At most five devices may be paired.');
    const { response } = window.received;
    const device: Device = { id: response.deviceId, name: response.name, surface: 'browser', connectionKey: response.connectionKey, actionKey: response.actionKey, keyVersion: 1, scopeVersion: '1', actionAuthentication: 'trusted-device', role: window.offer.role, createdAt: Date.now(), expiresAt: Date.now() + browserLimits.days * 86400_000, projects: window.projects, caps: window.caps, categories: [], scriptIds: [], apiProviders: [], ollamaHosts: [registry.store.settings().ollama.host] };
    registry.saveDevice(device); registry.configure({ ...registry.config(), enabled: true });
    registry.audit({ deviceId: device.id, operation: 'browser.confirm', decision: 'paired' });
    const id = window.offer.pairingId; this.window = undefined;
    for (const peer of this.gateway.peers) if (peer.surface === 'browser' && peer.pairingId === id && !peer.device) { this.gateway.send(peer, { v: 1, type: 'pair.confirmed' }); peer.socket.close(1000, 'PAIR_CONFIRMED'); }
    return device;
  }
  async configure(params: unknown) {
    const p = z.strictObject({ enabled: z.boolean().optional(), addresses: z.array(z.string()).max(3).optional(), port: z.number().int().min(1024).max(65535).optional(), proxy: z.string().max(200).optional() }).parse(params), registry = this.gateway.registry;
    const before = this.config(), next: BrowserConfig = { ...before, ...(p.enabled === undefined ? {} : { enabled: p.enabled }), ...(p.port === undefined ? {} : { port: p.port }) };
    if (p.addresses) next.addresses = p.addresses.length ? localAddresses(p.addresses) : [];
    if (p.proxy !== undefined) {
      // A name with a certificate browsers already trust, in front of the loopback page (Tailscale Serve, for example).
      if (!p.proxy.trim()) delete next.proxy;
      else { let url: URL; try { url = new URL(p.proxy.trim()); } catch { throw new Error('Enter the secure address people open, such as https://desk.example.net'); } if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Enter a secure address with a name, such as https://desk.example.net'); next.proxy = url.origin; }
    }
    if (next.addresses.length && next.port === registry.config().port && next.addresses.some(address => registry.config().addresses.includes(address))) throw new Error('The phone’s connection uses this port. Choose another.');
    registry.configure({ ...registry.config(), browser: next });
    registry.audit({ operation: 'browser.configure', decision: next.enabled ? 'enabled' : 'disabled' });
    // Any change of where it is reached starts over; off ends every connection and the open code at once.
    if (!next.enabled) this.endWindow('cancelled');
    if (!next.enabled || JSON.stringify([before.addresses, before.port, before.proxy]) !== JSON.stringify([next.addresses, next.port, next.proxy])) await this.stop();
    await this.refresh(); this.gateway.presence(); return this.status();
  }
  status() {
    const config = this.config(), window = this.open() ? this.window : undefined;
    return { ...config, ...this.address(), paired: this.devices().length, ...(window ? { pairing: { pairingId: window.offer.pairingId, expiresAt: window.offer.expiresAt, role: window.offer.role, ...(window.received ? { received: { name: window.received.name, sas: window.received.sas } } : {}) } } : {}) };
  }
  /** What a grant change on the desktop may leave a browser with. */
  static narrowed(device: Device, caps: string[]) { return caps.filter(cap => (deviceRole(device.role) === 'observer' ? observerCaps as readonly string[] : browserCaps as readonly string[]).includes(cap) && (browserCaps as readonly string[]).includes(cap)); }
}
