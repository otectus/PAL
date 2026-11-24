// A08: the browser companion — who may reach it, what a paired browser may do, and how it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, webcrypto, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { browserCaps, browserLimits, browserMethods, pairingCode } from '../broker/remote/browser.ts';
import { canonical, digest, parsePairing, pairingUri, verified } from '../broker/remote/crypto.ts';
import { methods } from '../broker/remote/schemas.ts';
// The page's own code, as the browser runs it.
// @ts-expect-error plain JavaScript served to browsers
import * as page from '../broker/remote/browser/protocol.js';

const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proof = (pair: ReturnType<typeof keypair>, value: unknown) => sign('sha256', Buffer.from(canonical(value)), pair.privateKey).toString('base64url');
const free = async () => { const server = net.createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const { port } = server.address() as net.AddressInfo; await new Promise<void>(done => server.close(() => done())); return port; };
const until = async (what: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await what()) return; await new Promise(done => setTimeout(done, 20)); } assert.fail('Timed out'); };

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), 'pal-browser-')), project = join(base, 'project'), other = join(base, 'other'); await mkdir(project); await mkdir(other);
  let sends = 0; const hooks = new Map<string, any>();
  const core = new Core(new Store(join(base, 'state')), (session: any, h: any) => { hooks.set(session.id, h); return { async send(_t: string, _i: any, o: any) { sends++; h.policy?.(true); o?.beforeAccept?.(); o?.onDispatched?.(); o?.onAccepted?.(); }, async interrupt() {}, async close() {} } as any; });
  const gateway = new MobileGateway(core), port = await free();
  t.after(async () => { await gateway.close(); await core.close(); await rm(base, { recursive: true, force: true }); });
  core.capabilities.codex = { available: true, remoteRestricted: true } as any;
  const session = await core.create({ provider: 'codex', cwd: project, trusted: true, title: 'In scope' }), hidden = await core.create({ provider: 'codex', cwd: other, trusted: true, title: 'Not in scope' });
  const origin = `http://127.0.0.1:${port}`, local = (method: string, params: any = {}) => gateway.local(method, params) as Promise<any>;
  const on = (extra: any = {}) => local('remote.browserConfigure', { enabled: true, port, ...extra });
  return { base, project, other, core, gateway, port, origin, session, hidden, hooks, local, on, sends: () => sends };
}
type F = Awaited<ReturnType<typeof fixture>>;
// A connection of its own for every request: one kept from before the listener restarted would be refused.
const get = (port: number, path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: any; body: string }>((done, fail) => { const r = httpRequest({ agent: false, host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, response => { let body = ''; response.on('data', part => body += part); response.on('end', () => done({ status: response.statusCode!, headers: response.headers, body })); }); r.on('error', fail); r.end(); });
const socket = (url: string, options: any = {}) => new Promise<WebSocket>((done, fail) => { const ws = new WebSocket(url, 'protocol' in options ? options.protocol : 'cere.mobile.v1', options); ws.once('open', () => done(ws)); ws.once('error', fail); });
class Wire {
  ws: WebSocket; queue: any[] = []; waiting: ((value: any) => void)[] = []; events: any[] = []; closed?: { code: number; reason: string };
  constructor(ws: WebSocket) { this.ws = ws; ws.on('message', bytes => { const frame = JSON.parse(String(bytes)); if (frame.type === 'event') this.events.push(frame); else this.waiting.length ? this.waiting.shift()!(frame) : this.queue.push(frame); }); ws.on('close', (code, reason) => { this.closed = { code, reason: String(reason) }; }); ws.on('error', () => {}); }
  next(): Promise<any> { return this.queue.length ? Promise.resolve(this.queue.shift()) : new Promise((done, fail) => { const timer = setTimeout(() => fail(new Error('No answer')), 4000); this.waiting.push(value => { clearTimeout(timer); done(value); }); }); }
  send(value: any) { this.ws.send(JSON.stringify(value)); return this.next(); }
}
type Keys = { deviceId: string; connection: ReturnType<typeof keypair>; action: ReturnType<typeof keypair> };
/** A browser answering the open offer with a code, as the page does. */
async function answer(f: F, code: string, name = 'Test browser', keys: Keys = { deviceId: randomUUID(), connection: keypair(), action: keypair() }) {
  const wire = new Wire(await socket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: f.origin })), first = await wire.send({ v: 1, type: 'browser.offer' });
  if (first.type !== 'browser.offer') return { wire, keys, result: first };
  const offer = first.offer, body = { type: 'browser-response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId: keys.deviceId, name, keyVersion: 1, connectionKey: pub(keys.connection), actionKey: pub(keys.action), deviceNonce: randomBytes(32).toString('base64url') };
  const transcript = { domain: 'pal.browser.pair.response.v1', response: body };
  const codeProof = createHmac('sha256', pairingCode(code)).update(canonical({ domain: 'pal.browser.pair.code.v1', offer, response: body })).digest('base64url');
  return { wire, keys, result: await wire.send({ v: 1, type: 'browser.pair', response: { ...body, connectionProof: proof(keys.connection, transcript), actionProof: proof(keys.action, transcript) }, codeProof }) };
}
async function paired(f: F, options: any = {}) {
  await f.on(); const made = await f.local('remote.browserPrepare', { projectPaths: [f.project], ...options }), { wire, keys, result } = await answer(f, made.code);
  assert.equal(result.type, 'pair.received'); const { received } = (f.core.remoteStatus as any).browser.pairing;
  await f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: received.sas, confirmed: true }); assert.equal((await wire.next()).type, 'pair.confirmed');
  return keys;
}
async function signIn(f: F, keys: Keys, url = `ws://127.0.0.1:${f.port}/browser/v1`, options: any = { origin: f.origin }) {
  const wire = new Wire(await socket(url, options)), desktopId = f.gateway.identity.id;
  const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId, deviceId: keys.deviceId, keyVersion: 1, clientNonce: randomBytes(32).toString('base64url'), appVersion: 'test' };
  wire.ws.send(JSON.stringify(hello)); const frame = await Promise.race([wire.next(), until(() => !!wire.closed).then(() => undefined)]); if (!frame) return { wire, welcome: undefined, request: undefined as any, act: undefined as any };
  const { v: _v, type: _type, ...challenge } = frame;
  const welcome = await wire.send({ v: 1, type: 'auth', challengeId: challenge.challengeId, signature: proof(keys.connection, { domain: 'cere.mobile.auth.v1', helloDigest: digest(hello), challenge, desktopId, deviceId: keys.deviceId, keyVersion: 1, epoch: challenge.epoch }) });
  const request = async (method: string, params: any = {}, extra: any = {}) => wire.send({ v: 1, type: 'request', id: randomUUID(), method, params, ...extra });
  const act = async (method: string, params: any, key = keys.action, commandId = randomUUID(), tamper?: (transcript: any) => any) => {
    const challenge = (await request('commands.challenge', { method, paramsDigest: digest(params), commandId })).result; if (!challenge) return { error: { code: 'NO_CHALLENGE' } } as any;
    const transcript = { domain: 'cere.mobile.action.v1', desktopId, deviceId: keys.deviceId, keyVersion: 1, scopeVersion: welcome.scopeVersion, epoch: welcome.epoch, authSessionId: welcome.authSessionId, challengeId: challenge.challengeId, nonce: challenge.nonce, method, paramsDigest: digest(params), commandId };
    return request(method, params, { commandId, proof: { challengeId: challenge.challengeId, signature: proof(key, tamper ? tamper(transcript) : transcript) } });
  };
  return { wire, welcome, request, act };
}

test('A08 the page signs, hashes and reads codes exactly as the desktop does', async () => {
  const value = { b: [1, 'ü "', null, true, { z: 1, a: undefined }], a: { '10': 1, '9': 2, é: 'x' }, n: 1_800_000_000_123 };
  assert.equal(page.canonical(value), canonical(value)); assert.equal(await page.digest(value), digest(value)); assert.equal(page.pairingCode(' o1l-ab c '), pairingCode('O1L-ABC'));
  const keys: any = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), key = page.base64(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  for (let i = 0; i < 40; i++) { const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(page.canonical({ i })))); assert.ok(verified(key, { i }, page.base64(page.derSignature(raw))), 'whatever its leading bytes'); }
});

test('A08 nothing listens until it is chosen and needed, and what is served is one static page with nothing of the desktop in it', async t => {
  const f = await fixture(t); assert.equal(f.gateway.browser.config().enabled, false);
  await assert.rejects(f.local('remote.browserPrepare', { projectPaths: [f.project] }), /Turn on browser access/); await assert.rejects(get(f.port, '/'), /ECONNREFUSED/);
  await f.on(); await assert.rejects(get(f.port, '/'), /ECONNREFUSED/, 'on, and still nothing to answer to');
  const made = await f.local('remote.browserPrepare', { projectPaths: [f.project] }); assert.deepEqual(made.urls, [f.origin, `http://localhost:${f.port}`]); assert.match(made.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  for (const path of ['/', '/app.js', '/protocol.js', '/style.css', '/words.json']) {
    const answer = await get(f.port, path); assert.equal(answer.status, 200, path);
    assert.match(answer.headers['content-security-policy'], /^default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/); assert.ok(!/unsafe|https?:|\*/.test(answer.headers['content-security-policy']));
    assert.deepEqual([answer.headers['x-content-type-options'], answer.headers['referrer-policy'], answer.headers['cache-control'], answer.headers['cross-origin-opener-policy'], answer.headers['cross-origin-resource-policy'], answer.headers['x-frame-options'], answer.headers['set-cookie'], answer.headers['access-control-allow-origin']], ['nosniff', 'no-referrer', 'no-store', 'same-origin', 'same-origin', 'DENY', undefined, undefined]);
    for (const secret of [f.gateway.identity.id, f.base, 'In scope', made.code]) assert.ok(!answer.body.includes(secret));
  }
  const html = await readFile(new URL('../broker/remote/browser/index.html', import.meta.url), 'utf8'), script = await readFile(new URL('../broker/remote/browser/app.js', import.meta.url), 'utf8');
  assert.ok(!/<script(?![^>]*src=)|\son\w+=|style=|https?:\/\//i.test(html), 'no inline script, handler or style, and no other site'); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|document\.cookie/.test(script), 'everything is text, and nothing secret is stored where a script can read it');
  for (const path of ['/index.html', '/../core.ts', '/%2e%2e/core.ts', '/app.js?x', '//', '/mobile/v1', '/browser/v1', '/__proto__', '/constructor']) assert.equal((await get(f.port, path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await get(f.port, '/', {}, method)).status, 405, method);
  for (const host of ['evil.example', `evil.example:${f.port}`, '127.0.0.1', 'localhost', '', `127.0.0.1:${f.port + 1}`]) assert.equal((await get(f.port, '/', { host })).status, 421, `host ${host}`);
  assert.equal((await get(f.port, '/', { host: `localhost:${f.port}` })).status, 200); assert.equal((await get(f.port, '/', { origin: 'https://evil.example' })).status, 421); assert.equal((await get(f.port, '/', { origin: `http://localhost:${f.port}` })).status, 421, 'its own origin and no other name’s');
  await f.local('remote.browserCancel'); await until(async () => get(f.port, '/').then(() => false, () => true));
});

test('A08 a connection is taken only from the page itself, and never through the phone’s endpoint', async t => {
  const f = await fixture(t); await f.on(); await f.local('remote.browserPrepare', { projectPaths: [f.project] }); const url = `ws://127.0.0.1:${f.port}/browser/v1`;
  for (const options of [{}, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: `https://127.0.0.1:${f.port}` }, { origin: `http://127.0.0.1:${f.port + 1}` }, { origin: `http://localhost:${f.port}` }, { origin: f.origin, headers: { host: 'evil.example' } }, { origin: f.origin, protocol: [] }, { origin: f.origin, protocol: 'other' }]) await assert.rejects(socket(url, options), () => true, JSON.stringify(options));
  await assert.rejects(socket(`ws://127.0.0.1:${f.port}/mobile/v1`, { origin: f.origin })); const ok = await socket(url, { origin: f.origin }); ok.terminate();
  // It answers nothing but the pairing, and closes what it does not know.
  for (const frame of [{ v: 1, type: 'request', id: randomUUID(), method: 'sync.open', params: {} }, { v: 1, type: 'pair.response', response: 'cere-pair://v1/abcdefgh' }, { type: 'x' }]) { const wire = new Wire(await socket(url, { origin: f.origin })); wire.ws.send(JSON.stringify(frame)); await until(() => !!wire.closed); assert.equal(wire.closed!.code, 4001); }
  const many: WebSocket[] = []; for (let i = 0; i < browserLimits.peers; i++) many.push(await socket(url, { origin: f.origin })); await assert.rejects(socket(url, { origin: f.origin }), () => true, 'a bounded number'); for (const ws of many) ws.terminate();
});

test('A08 pairing needs the code, the six words and the desktop’s yes; a wrong code, a second answer or time ends it', async t => {
  const f = await fixture(t); await f.on();
  assert.equal((await answer(f, 'AAAAA-AAAAA').catch(() => ({ result: { type: 'refused' } }))).result.type, 'refused', 'nothing is open');
  let made = await f.local('remote.browserPrepare', { projectPaths: [f.project] });
  for (let i = 1; i < browserLimits.attempts; i++) { const { result } = await answer(f, '00000-00000'); assert.deepEqual([result.type, result.reason], ['pair.closed', 'refused']); }
  assert.deepEqual([(await answer(f, '00000-00000')).result.reason, (f.core.remoteStatus as any).browser.pairing], ['expired', undefined], 'five wrong codes end it');
  assert.equal((await f.gateway.registry.devices()).length, 0);
  // Two browsers with the code: neither is chosen.
  made = await f.local('remote.browserPrepare', { projectPaths: [f.project] }); const one = await answer(f, made.code.toLowerCase().replace('-', ' ')); assert.equal(one.result.type, 'pair.received');
  const two = await answer(f, made.code, 'Another'); assert.equal(two.result.type, 'pair.closed'); await until(() => !!one.wire.closed); assert.equal((f.core.remoteStatus as any).browser.pairing, undefined);
  await assert.rejects(f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: 'a b c d e f', confirmed: true }), /No browser has answered/);
  // The words have to match, and the yes has to be for this pairing.
  made = await f.local('remote.browserPrepare', { projectPaths: [f.project] }); await assert.rejects(f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: '', confirmed: true }), /No browser has answered/);
  const third = await answer(f, made.code, 'Laptop'); const { received } = (f.core.remoteStatus as any).browser.pairing; assert.equal(received.name, 'Laptop'); assert.equal(received.sas.split(' ').length, 6);
  await assert.rejects(f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: 'a b c d e f', confirmed: true }), /Compare the six words/); await assert.rejects(f.local('remote.browserConfirm', { pairingId: randomUUID(), sas: received.sas, confirmed: true })); await assert.rejects(f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: received.sas, confirmed: false }));
  await f.local('remote.browserConfirm', { pairingId: made.pairingId, sas: received.sas, confirmed: true }); assert.equal((await third.wire.next()).type, 'pair.confirmed');
  const device = f.gateway.registry.live(third.keys.deviceId)!; assert.deepEqual([device.surface, device.role, device.caps, device.categories, device.scriptIds, device.apiProviders, device.lifetime], ['browser', 'observer', ['chat.read', 'approvals.answer'], [], [], [], undefined]);
  assert.ok(device.expiresAt! - Date.now() <= browserLimits.days * 86400_000 && device.expiresAt! - Date.now() > (browserLimits.days - 1) * 86400_000);
  assert.equal((await answer(f, made.code).catch(() => ({ result: { reason: 'none' } }))).result.reason, 'none', 'a code works once');
  // Time ends it too, and a browser that waits is told.
  made = await f.local('remote.browserPrepare', { projectPaths: [f.project], role: 'limited', caps: ['chat.write'] }); const late = await answer(f, made.code); f.gateway.browser.window!.offer.expiresAt = Date.now() - 1; await f.gateway.browser.refresh(); assert.equal((await late.wire.next()).reason, 'expired');
  await assert.rejects(f.local('remote.browserPrepare', { projectPaths: [f.project], role: 'owner' })); await assert.rejects(f.local('remote.browserPrepare', { projectPaths: [f.project], role: 'limited', caps: ['desktop.control'] })); await assert.rejects(f.local('remote.browserPrepare', { projectPaths: [] }));
});

test('A08 an observer browser reads only its projects, stops and denies, and can do nothing else', async t => {
  const f = await fixture(t), keys = await paired(f), b = await signIn(f, keys);
  assert.equal(b.welcome.role, 'observer'); assert.ok(b.welcome.operations.every((method: string) => browserMethods.has(method))); assert.ok(!b.welcome.operations.includes('sessions.send'));
  const snapshot = (await b.request('sync.open')).result; assert.deepEqual(snapshot.sessions.map((s: any) => s.title), ['In scope']); assert.equal((await b.request('sessions.get', { sessionId: f.hidden.id })).error.code, 'SCOPE_DENIED');
  f.core.store.message({ id: randomUUID(), sessionId: f.session.id, role: 'assistant', text: '<img src=x onerror=alert(1)>', time: 1 } as any); assert.match(JSON.stringify((await b.request('sessions.messages', { sessionId: f.session.id })).result), /onerror/, 'text as it is; the page never treats it as markup');
  // Every other operation of the protocol is refused before it is looked at.
  for (const method of Object.keys(methods).filter(name => !browserMethods.has(name))) { const r = await b.request(method, {}, { commandId: randomUUID() }); assert.equal(r.error?.code, 'SCOPE_DENIED', method); assert.match(r.error.message, /A browser cannot do this/); }
  assert.equal((await b.request('commands.challenge', { method: 'memory.save', paramsDigest: digest({}), commandId: randomUUID() })).error.code, 'INVALID_ARGUMENT');
  const send = { sessionId: f.session.id, text: 'Hello', expectedDraftRevision: '0', expectedConfigRevision: '0' }; assert.equal((await b.act('sessions.send', send, keys.connection)).error.code, 'SCOPE_DENIED'); assert.equal(f.sends(), 0);
  // A request of the desktop's own conversation: it may be denied here, and allowed only where it belongs.
  const asked = f.core.approval(f.session.id, { kind: 'provider', title: 'Run it?', detail: 'rm', choices: ['allow', 'deny'] }); const [listed] = (await b.request('approvals.list')).result; assert.equal(listed.canAnswer, false);
  const choice = { approvalId: listed.id, revision: listed.revision, digest: listed.digest }; assert.equal((await b.act('approvals.answer', { ...choice, choice: 'allow' })).error.code, 'SCOPE_DENIED');
  assert.equal((await b.request('approvals.answer', { ...choice, choice: 'deny' }, { commandId: randomUUID() })).error, undefined); assert.equal((await asked).choice, 'deny');
  b.wire.ws.send(Buffer.from('PLRT-binary'), { binary: true }); await until(() => !!b.wire.closed); assert.equal(b.wire.closed!.code, 4001, 'and no binary frames');
});

test('A08 a limited browser sends what it signed, once, in its projects; a stale or altered proof does nothing', async t => {
  const f = await fixture(t), keys = await paired(f, { role: 'limited', caps: ['chat.write', 'providers.execute', 'approvals.answer', 'approvals.provider'] }), b = await signIn(f, keys); await b.request('sync.open', { selectedSessionId: f.session.id });
  const dto = async () => (await b.request('sessions.get', { sessionId: f.session.id })).result, before = await dto(); assert.equal(before.canSend, true);
  const send = { sessionId: f.session.id, text: 'From the browser', expectedDraftRevision: before.draftRevision, expectedConfigRevision: before.configRevision }, commandId = randomUUID();
  assert.equal((await b.request('sessions.send', send, { commandId: randomUUID() })).error.code, 'UNAUTHENTICATED', 'unsigned');
  assert.equal((await b.act('sessions.send', send, keypair())).error.code, 'UNAUTHENTICATED', 'another key'); for (const tamper of [(x: any) => ({ ...x, authSessionId: randomUUID() }), (x: any) => ({ ...x, scopeVersion: '9' }), (x: any) => ({ ...x, commandId: randomUUID() }), (x: any) => ({ ...x, paramsDigest: digest({}) })]) assert.equal((await b.act('sessions.send', send, keys.connection, randomUUID(), tamper)).error.code, 'UNAUTHENTICATED');
  assert.equal(f.sends(), 0); assert.equal((await b.act('sessions.send', send, keys.connection, commandId)).result.status, 'accepted'); await until(() => f.sends() === 1);
  assert.equal((await b.request('sessions.send', send, { commandId })).result.status, 'accepted'); assert.equal((await b.request('sessions.send', { ...send, text: 'Other' }, { commandId })).error.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.sends(), 1, 'a repeated command is answered, not run');
  assert.equal(f.core.store.session(f.session.id).remote?.role, 'limited'); assert.equal(f.core.store.session(f.session.id).effectivePolicy, 'restricted', 'a browser’s turn runs under the phone’s limits');
  assert.equal((await b.act('sessions.send', { ...send, sessionId: f.hidden.id }, keys.connection)).error.code, 'SCOPE_DENIED');
  // A request of the turn it started can be allowed with the key that signs actions, not the one that signs in.
  const asked = f.core.approval(f.session.id, { kind: 'provider', title: 'Run it?', detail: 'ls', choices: ['allow', 'deny'] }); const [listed] = (await b.request('approvals.list')).result; assert.equal(listed.canAnswer, true);
  const params = { approvalId: listed.id, revision: listed.revision, digest: listed.digest, choice: 'allow' }; assert.equal((await b.act('approvals.answer', params, keys.connection)).error.code, 'UNAUTHENTICATED'); assert.equal((await b.act('approvals.answer', params)).error, undefined); assert.equal((await asked).choice, 'allow');
  // A grant taken away on the desktop ends the connection and the operation.
  await f.local('remote.updateDevice', { id: keys.deviceId, projectPaths: [f.project], caps: ['chat.read', 'desktop.control', 'memory.write'], categories: [], scriptIds: [] }); await until(() => !!b.wire.closed); assert.equal(b.wire.closed!.reason, 'SCOPE_CHANGED');
  assert.deepEqual(f.gateway.registry.live(keys.deviceId)!.caps, ['chat.read'], 'what a browser may not hold is dropped'); const again = await signIn(f, keys); assert.ok(!again.welcome.operations.includes('sessions.send'));
  await assert.rejects(f.local('remote.updateDevice', { id: keys.deviceId, projectPaths: [f.project], caps: ['chat.read'], categories: ['apps'], scriptIds: [] }), /never controls the desktop/); await assert.rejects(f.local('remote.setRole', { id: keys.deviceId, role: 'owner', confirmed: true }), /Pair the browser again/); await f.local('remote.setRole', { id: keys.deviceId, role: 'observer', confirmed: true }); assert.deepEqual([f.gateway.registry.live(keys.deviceId)!.role, f.gateway.registry.live(keys.deviceId)!.caps], ['observer', ['chat.read']], 'less is always possible'); await assert.rejects(f.local('remote.setRole', { id: keys.deviceId, role: 'limited', confirmed: true }), /Pair the browser again/);
  assert.ok(browserCaps.every(cap => !['desktop.control', 'settings.write', 'memory.write', 'attachments.write', 'capture.preview', 'providers.api'].includes(cap)));
});

test('A08 a browser’s keys are unknown to the phone’s endpoint and a phone’s to the browser’s, and one does not open the other', async t => {
  const f = await fixture(t), keys = await paired(f); assert.equal(f.gateway.bindings.size, 0, 'a paired browser alone opens no phone endpoint'); assert.deepEqual(f.gateway.discovery.active, []);
  const mobilePort = await free(), prepared = await f.local('remote.preparePair', { addresses: ['127.0.0.1'], name: 'Desk', port: mobilePort }), offer = parsePairing(prepared.uri), phone: Keys = { deviceId: randomUUID(), connection: keypair(), action: keypair() };
  const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId: phone.deviceId, name: 'Phone', keyVersion: 1, connectionKey: pub(phone.connection), actionKey: pub(phone.action), deviceNonce: randomBytes(32).toString('base64url') }, transcript = { domain: 'cere.mobile.pair.response.v1', response: body };
  const response = pairingUri({ ...body, connectionProof: proof(phone.connection, transcript), actionProof: proof(phone.action, transcript) }), review = await f.local('remote.reviewPair', { response }); await f.local('remote.confirmPair', { response, sas: review.sas, confirmed: true, projectPaths: [f.project] });
  const mobile = `wss://127.0.0.1:${mobilePort}/mobile/v1`, tls = { ca: f.gateway.identity.material().cert };
  assert.ok((await signIn(f, phone, mobile, tls)).welcome); assert.equal((await signIn(f, keys, mobile, tls)).welcome, undefined, 'a browser on the phone’s endpoint'); assert.equal((await signIn(f, phone)).welcome, undefined, 'a phone on the browser’s');
  await assert.rejects(socket(mobile, { ...tls, origin: `https://127.0.0.1:${mobilePort}` }), () => true, 'the phone’s endpoint still refuses every browser');
  await assert.rejects(f.local('remote.browserConfigure', { port: mobilePort, addresses: ['127.0.0.1'] }), /The phone’s connection uses this port/);
  // Switching the browser off leaves the phone connected.
  const still = await signIn(f, phone, mobile, tls), b = await signIn(f, keys); await f.local('remote.browserConfigure', { enabled: false }); await until(() => !!b.wire.closed); await new Promise(done => setTimeout(done, 100)); assert.equal(still.wire.closed, undefined); await f.gateway.start(); assert.equal(still.wire.closed, undefined); await assert.rejects(get(f.port, '/'), /ECONNREFUSED/);
});

test('A08 revoking, switching off, expiry and forgetting all end a browser at once', async t => {
  const f = await fixture(t), first = await paired(f), a = await signIn(f, first); await f.local('remote.revoke', { id: first.deviceId }); await until(() => !!a.wire.closed); assert.equal(a.wire.closed!.reason, 'AUTH_REVOKED'); assert.ok(a.wire.events.some(event => event.name === 'device.revoked'));
  await assert.rejects(signIn(f, first), /ECONNREFUSED/, 'no paired browser is left, so nothing listens');
  const second = await paired(f), b = await signIn(f, second); assert.equal((await b.request('devices.selfRevoke', {}, { commandId: randomUUID() })).error, undefined); await until(() => !!b.wire.closed); assert.equal(f.gateway.registry.live(second.deviceId), undefined);
  const third = await paired(f), c = await signIn(f, third); await f.local('remote.off'); await until(() => !!c.wire.closed); await assert.rejects(get(f.port, '/'), /ECONNREFUSED/, 'remote access off is off here too'); await f.local('remote.enable'); await until(async () => get(f.port, '/').then(() => true, () => false));
  const device = f.gateway.registry.device(third.deviceId)!; f.gateway.registry.saveDevice({ ...device, expiresAt: Date.now() - 1 }); assert.equal((await signIn(f, third).catch(() => ({ welcome: undefined }))).welcome, undefined);
  const fourth = await paired(f); await f.local('remote.renewDevice', { id: fourth.deviceId, confirmed: true }); assert.ok(f.gateway.registry.live(fourth.deviceId)!.expiresAt! <= Date.now() + browserLimits.days * 86400_000, 'renewed for its own, shorter time');
  const d = await signIn(f, fourth); await f.gateway.close(); await until(() => !!d.wire.closed); await assert.rejects(get(f.port, '/'), /ECONNREFUSED/);
});

test('A08 beyond this computer it speaks TLS with the desktop’s own certificate, or sits behind a name that was chosen', async t => {
  const f = await fixture(t); await f.on({ addresses: ['127.0.0.1'] }); const made = await f.local('remote.browserPrepare', { projectPaths: [f.project] }), { cert } = f.gateway.identity.material();
  assert.deepEqual(made.urls, [`https://127.0.0.1:${f.port}`]); assert.equal(made.fingerprint, new X509Certificate(cert).fingerprint256);
  const secure = (headers: any = {}) => new Promise<number>((done, fail) => { const r = httpsRequest({ agent: false, host: '127.0.0.1', port: f.port, path: '/', ca: cert, headers }, response => { response.resume(); done(response.statusCode!); }); r.on('error', fail); r.end(); });
  assert.equal(await secure(), 200); await assert.rejects(get(f.port, '/'), () => true, 'and nothing else'); await assert.rejects(socket(`wss://127.0.0.1:${f.port}/browser/v1`, { ca: cert, origin: f.origin }), () => true, 'the plain origin is another one'); (await socket(`wss://127.0.0.1:${f.port}/browser/v1`, { ca: cert, origin: `https://127.0.0.1:${f.port}` })).terminate();
  for (const bad of ['http://desk.example.net', 'https://192.168.1.2', 'https://desk.example.net/path', 'https://u:p@desk.example.net', 'nonsense', 'https://desk.example.net/?a']) await assert.rejects(f.local('remote.browserConfigure', { proxy: bad }), /secure address/, bad);
  await assert.rejects(f.local('remote.browserConfigure', { addresses: ['203.0.113.9'] }), /not on a current desktop interface/);
  // Behind a trusted name the page stays on loopback, and only that name is one more it answers to.
  await f.local('remote.browserConfigure', { addresses: [], proxy: 'https://desk.example.net/' }); await f.local('remote.browserPrepare', { projectPaths: [f.project] });
  assert.equal((await get(f.port, '/', { host: 'desk.example.net' })).status, 200); (await socket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: 'https://desk.example.net', headers: { host: 'desk.example.net' } })).terminate();
  await assert.rejects(socket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: 'https://desk.example.net' }), () => true, 'a name and an origin have to agree'); await f.local('remote.browserConfigure', { proxy: '' }); await f.local('remote.browserPrepare', { projectPaths: [f.project] }); assert.equal((await get(f.port, '/', { host: 'desk.example.net' })).status, 421);
  // A port that is taken is said, and tried again later.
  const taken = net.createServer(); const port = await free(); await new Promise<void>(done => taken.listen(port, '127.0.0.1', done)); t.after(() => taken.close()); const blocked = await f.local('remote.browserConfigure', { port }); assert.match(blocked.problem, /already in use/); assert.deepEqual(blocked.listening, []);
});
