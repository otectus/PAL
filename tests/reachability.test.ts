import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import net, { BlockList } from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import { Discovery, announceable, answer, names, parseQuery, serviceType } from '../broker/remote/discovery.ts';
import { decryptPush, encryptPush, pushEndpoint, readHint, vapid, wakeHint, wakeLimits } from '../broker/remote/wake.ts';

const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proof = (pair: ReturnType<typeof keypair>, value: unknown) => sign('sha256', Buffer.from(canonical(value)), pair.privateKey).toString('base64url');
async function port() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const p = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return p; }
async function fixture(t: any, role?: 'observer' | 'owner') {
  const directory = await mkdtemp(join(tmpdir(), 'pal-reach-'));
  const core = new Core(new Store(directory), () => ({ async send(_text: string, _images: any, options: any) { options?.beforeAccept?.(); options?.onDispatched?.(); options?.onAccepted?.(); }, async interrupt() {}, async close() {} }) as any);
  const gateway = new MobileGateway(core); const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await gateway.close(); await core.close(); await rm(directory, { recursive: true, force: true }); });
  const pairing: any = await gateway.local('remote.preparePair', { addresses: ['127.0.0.1'], name: 'Test desktop', port: await port(), ...(role ? { accessRole: role } : {}) });
  const offer = parsePairing(pairing.uri), connection = keypair(), action = keypair(), deviceId = randomUUID();
  const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId, name: 'Fixture phone', keyVersion: 1, connectionKey: pub(connection), actionKey: pub(action), deviceNonce: randomBytes(32).toString('base64url') };
  const transcript = { domain: 'cere.mobile.pair.response.v1', response: body }, response = pairingUri({ ...body, connectionProof: proof(connection, transcript), actionProof: proof(action, transcript) });
  const review: any = await gateway.local('remote.reviewPair', { response });
  await gateway.local('remote.confirmPair', role === 'owner' ? { response, sas: review.sas, confirmed: true } : { response, sas: review.sas, confirmed: true, projectPaths: [directory], ...(role ? {} : { caps: ['chat.read', 'chat.write', 'providers.execute', 'approvals.answer', 'desktop.control'], categories: ['timers'] }) });
  const connect = async () => {
    const ws = new WebSocket(offer.endpoints[0], 'cere.mobile.v1', { ca: gateway.identity.material().cert }); sockets.push(ws);
    const queue: any[] = [], waiters: ((value: any) => void)[] = []; ws.on('message', bytes => { const message = JSON.parse(String(bytes)); if (message.type === 'event') return; const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waiters.push(resolve));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId: offer.desktopId, deviceId, keyVersion: 1, clientNonce: randomBytes(32).toString('base64url'), appVersion: 'test' };
    ws.send(JSON.stringify(hello)); const { v: _v, type: _t, ...challenge } = await next();
    ws.send(JSON.stringify({ v: 1, type: 'auth', challengeId: challenge.challengeId, signature: proof(connection, { domain: 'cere.mobile.auth.v1', helloDigest: digest(hello), challenge, desktopId: offer.desktopId, deviceId, keyVersion: 1, epoch: challenge.epoch }) }));
    const welcome = await next();
    const request = async (method: string, params: any = {}, commandId?: string) => { ws.send(JSON.stringify({ v: 1, type: 'request', id: randomUUID(), method, params, ...(commandId ? { commandId } : {}) })); return next(); };
    const close = async () => { const closed = new Promise(r => ws.once('close', r)); ws.terminate(); await closed; while ([...gateway.peers].length) await new Promise(r => setTimeout(r, 5)); };
    return { ws, welcome, request, close };
  };
  return { directory, core, gateway, deviceId, connect };
}
/** A phone's keys, as it would make them. */
function phoneKeys() { const pair = createECDH('prime256v1'); pair.generateKeys(); const auth = randomBytes(16); return { private: pair.getPrivateKey(), auth, params: (endpoint: string) => ({ endpoint, key: pair.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }) }; }
const settle = () => new Promise(r => setTimeout(r, 25));

test('REACH-01 an announcement says the protocol and the desktop ID and nothing else, and answers only about itself', () => {
  const id = '7f9c2ba4-e88f-427d-9c4e-1a2b3c4d5e6f', announcement = { id, major: 1, port: 8443, addresses: ['192.168.1.20'] };
  const question = (name: string, type: number, unicast = false, count = 1) => { const labels = Buffer.concat([...name.split('.').map(part => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])), Buffer.from([0])]), head = Buffer.alloc(12), tail = Buffer.alloc(4); head.writeUInt16BE(77, 0); head.writeUInt16BE(count, 4); tail.writeUInt16BE(type, 0); tail.writeUInt16BE(unicast ? 0x8001 : 1, 2); return Buffer.concat([head, labels, tail]); };
  const query = parseQuery(question('_pal._tcp.local', 12))!;
  assert.deepEqual(query, { id: 77, questions: [{ name: '_pal._tcp.local', type: 12, unicast: false }] });
  const reply = answer(announcement, '192.168.1.20', query.questions)!;
  assert.equal(reply.readUInt16BE(0), 0); assert.equal(reply.readUInt16BE(2), 0x8400); assert.equal(reply.readUInt16BE(6), 1); assert.equal(reply.readUInt16BE(10), 3);
  // TXT: exactly these two strings, and no host name, user, project or path anywhere in the message.
  const text = reply.toString('latin1'); assert.ok(text.includes('v=1')); assert.ok(text.includes('id=' + id)); assert.ok(text.includes('pal-7f9c2ba4e88f'));
  for (const leak of [process.env.USER || 'no-user', 'otectus', '/home', 'cere']) assert.ok(!text.includes(leak), leak);
  assert.ok(reply.includes(Buffer.from([192, 168, 1, 20])));
  // Asked for something else, it says nothing.
  assert.equal(answer(announcement, '192.168.1.20', parseQuery(question('_http._tcp.local', 12))!.questions), undefined);
  assert.equal(answer(announcement, '192.168.1.20', parseQuery(question('pal-000000000000.local', 1))!.questions), undefined);
  assert.ok(answer(announcement, '192.168.1.20', parseQuery(question(names(id).host, 1))!.questions));
  // A plain DNS client gets its question and ID back, with a short life.
  const legacy = answer(announcement, '192.168.1.20', query.questions, { id: 77, legacy: true })!; assert.equal(legacy.readUInt16BE(0), 77); assert.equal(legacy.readUInt16BE(4), 1);
  // Goodbye: the same records with no life left.
  const goodbye = answer(announcement, '192.168.1.20', query.questions, { goodbye: true })!; const at = goodbye.indexOf(Buffer.from([0, 12, 0, 1])); assert.equal(goodbye.readUInt32BE(at + 4), 0);
  // Answers, garbage, truncation and pointer loops are not queries.
  const loop = Buffer.concat([question('_pal._tcp.local', 12).subarray(0, 12), Buffer.from([0xc0, 12, 0, 12, 0, 1])]);
  for (const bad of [reply, Buffer.alloc(3), randomBytes(40).fill(0xff, 2, 4), question('_pal._tcp.local', 12).subarray(0, 20), loop]) assert.equal(parseQuery(bad), undefined);
  assert.deepEqual(['10.0.0.4', '172.20.1.1', '192.168.0.9', '100.101.2.3', '8.8.8.8', '127.0.0.1', 'fe80::1', '172.32.0.1'].filter(announceable), ['10.0.0.4', '172.20.1.1', '192.168.0.9']);
});

test('REACH-02 the responder binds only its own local addresses, announces twice, limits its answers and says goodbye', async () => {
  class Fake extends EventEmitter { sent: { data: Buffer; port: number; to: string }[] = []; joined: string[] = []; via = ''; closed = false; bind(_o: any, done: () => void) { setImmediate(done); } setMulticastTTL() {} setMulticastLoopback() {} addMembership(g: string, a: string) { this.joined.push(g + '@' + a); } setMulticastInterface(a: string) { this.via = a; } send(data: Buffer, port: number, to: string) { this.sent.push({ data, port, to }); } close(done?: () => void) { this.closed = true; done?.(); } }
  const made: Fake[] = [], discovery = new Discovery({ network: address => { const list = new BlockList(); list.addSubnet(address, 24); return list; }, create: () => { const socket = new Fake(); made.push(socket); return socket as any; } });
  const announcement = { id: randomUUID(), major: 1, port: 8443, addresses: ['192.168.1.20', '100.90.1.2', '10.1.1.1'] };
  await discovery.set(announcement);
  assert.deepEqual(discovery.active, ['192.168.1.20', '10.1.1.1']); assert.deepEqual(made.map(s => s.via), ['192.168.1.20', '10.1.1.1']); assert.deepEqual(made[0].joined, ['224.0.0.251@192.168.1.20']);
  assert.deepEqual(made[0].sent.map(s => [s.port, s.to]), [[5353, '224.0.0.251']]);
  await discovery.set({ ...announcement }); assert.equal(made.length, 2, 'the same announcement is not started again');
  await new Promise(r => setTimeout(r, 1050)); assert.equal(made[0].sent.length, 2);
  const ask = Buffer.concat([Buffer.from([0, 9, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...serviceType.split('.').map(part => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])), Buffer.from([0, 0, 12, 0, 1])]);
  for (let i = 0; i < 40; i++) made[0].emit('message', ask, { address: '192.168.1.50', port: 5353 });
  assert.equal(made[0].sent.length, 12, 'at most ten answers a second'); assert.equal(made[0].sent.at(-1)!.to, '224.0.0.251');
  const before = made[1].sent.length; made[1].emit('message', ask, { address: '192.168.1.50', port: 5353 }); assert.equal(made[1].sent.length, before, 'a question from another network is left alone');
  made[1].emit('message', ask, { address: '10.1.1.9', port: 40000 }); assert.deepEqual([made[1].sent.at(-1)!.to, made[1].sent.at(-1)!.port], ['10.1.1.9', 40000]);
  await discovery.set(undefined); assert.deepEqual(discovery.active, []); assert.ok(made.every(s => s.closed));
  const goodbye = made[0].sent.at(-1)!.data, at = goodbye.indexOf(Buffer.from([0, 12, 0, 1])); assert.equal(goodbye.readUInt32BE(at + 4), 0);
  // A port another program keeps to itself is reported, not thrown.
  const busy = new Discovery({ create: () => { const socket = new Fake(); socket.bind = () => { setImmediate(() => socket.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))); }; return socket as any; } });
  await busy.set(announcement); assert.deepEqual(busy.active, []); assert.match(busy.problem, /Another program/);
});

test('REACH-03 the desktop announces only when asked to, with a live phone, on addresses it listens on', async t => {
  const f = await fixture(t), calls: any[] = []; f.gateway.discovery.set = async value => { calls.push(value); };
  await f.gateway.start(); assert.equal(calls.at(-1), undefined, 'off unless chosen');
  f.gateway.bindings.set('192.168.5.5', { server: { close: (done: any) => done(), closeAllConnections() {} } as any, ws: { clients: new Set(), close() {} } as any });
  await f.gateway.local('remote.setDiscovery', { enabled: true });
  assert.deepEqual(calls.at(-1), { id: f.gateway.identity.id, major: 1, port: f.gateway.registry.config().port, addresses: ['192.168.5.5'] }, 'loopback is never announced');
  assert.equal(f.gateway.registry.config().discovery, true);
  await assert.rejects(f.gateway.local('remote.setDiscovery', { enabled: true, name: 'x' }));
  await f.gateway.local('remote.setDiscovery', { enabled: false }); assert.equal(calls.at(-1), undefined);
  await f.gateway.local('remote.setDiscovery', { enabled: true }); await f.gateway.revoke(f.deviceId);
  await f.gateway.local('remote.setDiscovery', { enabled: true }); assert.equal(calls.at(-1), undefined, 'without a paired phone there is nothing to announce');
});

test('REACH-04 Web Push encryption matches the RFC 8291 example and opens only with the phone’s keys', () => {
  const b = (value: string) => Buffer.from(value, 'base64url');
  const phone = b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), auth = b('BTBZMqHH6r4Tts7J_aSIgg');
  const message = encryptPush(Buffer.from('When I grow up, I want to be a watermelon'), phone, auth, { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
  assert.equal(message.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.equal(decryptPush(message, b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), auth).toString(), 'When I grow up, I want to be a watermelon');
  const keys = phoneKeys(), hint = wakeHint(1_700_000_000_000), sealed = encryptPush(hint, Buffer.from(keys.params('x').key, 'base64url'), keys.auth);
  assert.equal(sealed.length, 86 + wakeLimits.hint + 17); assert.deepEqual(decryptPush(sealed, keys.private, keys.auth), hint); assert.equal(readHint(hint)!.time, 1_700_000_000_000);
  assert.throws(() => decryptPush(sealed, keys.private, randomBytes(16))); assert.throws(() => decryptPush(sealed, phoneKeys().private, keys.auth));
  assert.equal(readHint(Buffer.alloc(28)), undefined); assert.equal(readHint(hint.subarray(0, 27)), undefined);
  // The sender's signature names the push server it is for, and nothing about the desktop.
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, header = vapid(pem, 'https://push.example', 1_700_000_000_000);
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!, [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' }); assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), { aud: 'https://push.example', exp: 1_700_000_000 + 43200 });
  const raw = Buffer.from(key, 'base64url'), publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  for (const bad of ['http://push.example/a', 'https://user:pass@push.example/a', 'https://push.example/a#b', 'ftp://push.example', 'not a url', 'https://push.example/' + 'a'.repeat(1000)]) assert.throws(() => pushEndpoint(bad), /cannot use/);
});

test('REACH-05 a phone asks, the owner allows the named server, and only then is it woken, with nothing in the message', async t => {
  const f = await fixture(t), phone = await f.connect(), keys = phoneKeys(), posts: { url: string; body: Buffer; headers: any }[] = [];
  f.gateway.wake.send = (async (url: any, init: any) => { posts.push({ url: String(url), body: Buffer.from(init.body), headers: init.headers }); assert.equal(init.redirect, 'error'); return new Response(null, { status: 201 }); }) as any;
  const off = (await phone.request('wake.status')).result; assert.equal(off.state, 'off'); assert.match(off.senderKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await phone.request('wake.register', keys.params('http://push.example/up'), randomUUID())).error.code, 'INVALID_ARGUMENT');
  assert.equal((await phone.request('wake.register', { ...keys.params('https://push.example/up'), key: 'A'.repeat(87) }, randomUUID())).error.code, 'INVALID_ARGUMENT');
  const asked = (await phone.request('wake.register', keys.params('https://push.example/up?token=secretpath'), randomUUID())).result;
  assert.deepEqual([asked.state, asked.host], ['waiting', 'push.example']);
  const session = await f.core.create({ provider: 'codex', cwd: f.directory, trusted: true, title: 'Private title' });
  await phone.close();
  f.core.emit('notice', { kind: 'complete', sessionId: session.id, text: 'SECRET TEXT' }); await settle(); assert.equal(posts.length, 0, 'not before the owner allowed it');
  // The address and keys never leave the desktop again: not to the desktop's window, not to the phone.
  const status = JSON.stringify(await f.gateway.local('remote.status')); for (const secret of ['secretpath', keys.params('').key, keys.params('').auth]) assert.ok(!status.includes(secret));
  assert.deepEqual((await f.gateway.local('remote.status') as any).devices[0].wake, { state: 'waiting', host: 'push.example' });
  await assert.rejects(f.gateway.local('remote.decideWake', { id: f.deviceId, approved: true, host: 'other.example' }), /changed/);
  await f.gateway.local('remote.decideWake', { id: f.deviceId, approved: true, host: 'push.example' });
  f.core.emit('notice', { kind: 'complete', sessionId: session.id, text: 'SECRET TEXT' }); await settle();
  assert.equal(posts.length, 1); assert.equal(posts[0].url, 'https://push.example/up?token=secretpath'); assert.equal(posts[0].headers['Content-Encoding'], 'aes128gcm'); assert.match(posts[0].headers.Authorization, /^vapid t=/);
  const plain = decryptPush(posts[0].body, keys.private, keys.auth); assert.equal(plain.length, 28); assert.ok(readHint(plain)); assert.ok(!posts[0].body.includes('SECRET') && !JSON.stringify(posts[0].headers).includes('Private'));
  // Within the quiet time one more is kept for its end, never a burst.
  for (let i = 0; i < 5; i++) f.core.emit('notice', { kind: 'error', sessionId: session.id, text: 'again' }); await settle(); assert.equal(posts.length, 1);
  assert.equal((f.gateway.wake as any).later.size, 1);
});

test('REACH-06 only what the phone may see wakes it, only while it is away, and a phone can stop it at any time', async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'pal-reach-other-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const phone = await f.connect(), keys = phoneKeys(); let posts = 0, clock = Date.now(), status = 201;
  f.gateway.wake.now = () => clock; f.gateway.wake.send = (async () => { posts++; return new Response(null, { status }); }) as any;
  await phone.request('wake.register', keys.params('https://push.example/up'), randomUUID()); await f.gateway.local('remote.decideWake', { id: f.deviceId, approved: true, host: 'push.example' });
  const mine = await f.core.create({ provider: 'codex', cwd: f.directory, trusted: true }), other = await f.core.create({ provider: 'codex', cwd: outside, trusted: true });
  await phone.request('sync.open', {});
  f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); assert.equal(posts, 0, 'a connected phone is told directly');
  await phone.close(); clock += 60_000;
  f.core.emit('notice', { kind: 'complete', sessionId: other.id }); f.core.emit('notice', { kind: 'schedule', text: 'x' }); f.core.emit('notice', { kind: 'remote-view', text: 'x' }); f.core.emit('notice', { kind: 'timer', text: 'local timer' }); await settle();
  assert.equal(posts, 0, 'nothing outside its projects, and nothing it is never told about');
  f.core.emit('notice', { kind: 'timer', text: 'tea', remoteProjectId: f.gateway.registry.live(f.deviceId)!.projects[0].id }); await settle(); assert.equal(posts, 1);
  clock += 60_000; void f.core.approval(mine.id, { kind: 'provider', title: 'Allow?', detail: '', choices: ['allow', 'deny'] }); await settle(); assert.equal(posts, 2, 'a request waiting for its answer');
  // A failing server is named, tried less often, and forgotten when it says it no longer knows the phone.
  status = 503; clock += 60_000; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle();
  assert.deepEqual((await f.gateway.local('remote.status') as any).devices[0].wake, { state: 'failing', host: 'push.example', problem: 'The push server answered HTTP 503' });
  for (let i = 0; i < 4; i++) { clock += 60_000; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); }
  const tried = posts; clock += 60_000; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); assert.equal(posts, tried, 'five failures slow it down');
  status = 201; clock += 15 * 60_000; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); assert.equal((await f.gateway.local('remote.status') as any).devices[0].wake.state, 'on');
  status = 410; clock += 60_000; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); assert.equal((await f.gateway.local('remote.status') as any).devices[0].wake.state, 'off');
  // A changed address on the same host keeps the owner's answer; another host asks again. Turning it off needs no desktop.
  const again = await f.connect();
  assert.equal((await again.request('wake.register', keys.params('https://push.example/up'), randomUUID())).result.state, 'waiting');
  await f.gateway.local('remote.decideWake', { id: f.deviceId, approved: true, host: 'push.example' });
  assert.equal((await again.request('wake.register', keys.params('https://push.example/moved'), randomUUID())).result.state, 'on');
  assert.equal((await again.request('wake.register', keys.params('https://elsewhere.example/up'), randomUUID())).result.state, 'waiting');
  assert.equal((await again.request('wake.clear', {}, randomUUID())).result.state, 'off'); assert.equal(f.gateway.registry.device(f.deviceId)!.wake, undefined);
  // A day has a ceiling, and revoking the phone removes everything it registered.
  await again.request('wake.register', keys.params('https://push.example/up'), randomUUID()); await f.gateway.local('remote.decideWake', { id: f.deviceId, approved: true, host: 'push.example' });
  const device = f.gateway.registry.device(f.deviceId)!; device.wake = { ...device.wake!, sentDay: new Date(clock += 120_000).toISOString().slice(0, 10), sentToday: wakeLimits.perDay }; f.gateway.registry.saveDevice(device);
  await again.close(); const before = posts; f.core.emit('notice', { kind: 'complete', sessionId: mine.id }); await settle(); assert.equal(posts, before);
  await f.gateway.revoke(f.deviceId); assert.equal(f.gateway.registry.device(f.deviceId)!.wake, undefined);
});

test('REACH-07 a phone that only observes may ask to be woken, and an owner phone is woken for any conversation it can see', async t => {
  const observer = await fixture(t, 'observer'), phone = await observer.connect(), keys = phoneKeys();
  assert.ok(phone.welcome.operations.includes('wake.register')); assert.ok(phone.welcome.features.includes('wake.v1'));
  assert.equal((await phone.request('wake.register', keys.params('https://push.example/up'), randomUUID())).result.state, 'waiting');
  const owner = await fixture(t, 'owner'), outside = await mkdtemp(join(tmpdir(), 'pal-reach-owner-')); t.after(() => rm(outside, { recursive: true, force: true }));
  let posts = 0; owner.gateway.wake.send = (async () => { posts++; return new Response(null, { status: 200 }); }) as any;
  const mine = await owner.connect(); await mine.request('wake.register', keys.params('https://push.example/up'), randomUUID()); await owner.gateway.local('remote.decideWake', { id: owner.deviceId, approved: true, host: 'push.example' });
  await mine.close(); const session = await owner.core.create({ provider: 'codex', cwd: outside, trusted: true });
  owner.core.emit('notice', { kind: 'complete', sessionId: session.id }); await settle(); assert.equal(posts, 1);
  // Remote access off: nothing is sent.
  await owner.gateway.disable(); owner.gateway.wake.now = () => Date.now() + 600_000; owner.core.emit('notice', { kind: 'complete', sessionId: session.id }); await settle(); assert.equal(posts, 1);
});
