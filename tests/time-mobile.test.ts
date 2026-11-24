// Time across phones (PAL_Time_Awareness_Implementation_Handoff.md §13.4), through the signed gateway as a phone uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { availableOperations, methods, protocolFeatures } from '../broker/remote/schemas.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import { Temporal } from '../broker/temporal-context.ts';
import { TimeService, type Clock } from '../broker/time.ts';
import type { Hooks } from '../broker/providers.ts';

class FakeClock implements Clock {
  wall = Date.parse('2026-11-21T16:30:00Z'); monotonic = 10_000; instanceId = 'broker-1';
  wallNowMs() { return this.wall; }
  monotonicNowMs() { return this.monotonic; }
  pass(ms: number) { this.wall += ms; this.monotonic += ms; }
}
const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proof = (pair: ReturnType<typeof keypair>, value: unknown) => sign('sha256', Buffer.from(canonical(value)), pair.privateKey).toString('base64url');
async function freePort() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const p = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return p; }
async function setup(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-time-mobile-')), clock = new FakeClock(), hooks = new Map<string, Hooks>(), sent: { id: string; time: string }[] = [];
  const core: Core = new Core(new Store(directory), (s, h) => { hooks.set(s.id, h); return { async send(_text, _images, o) { h.policy?.(true); o?.beforeAccept?.(); sent.push({ id: s.id, time: core.temporal.request(s.id)?.text || '' }); o?.onDispatched?.(); o?.onAccepted?.(); o?.acknowledged?.(); }, async interrupt() { h.event({ type: 'interrupted' }); }, async close() {} }; });
  core.temporal = new Temporal(core, new TimeService(clock, () => 'America/New_York'));
  const resources: (() => unknown)[] = [], own = (release: () => unknown) => { resources.push(release); };
  t.after(async () => { for (const release of resources.reverse()) await release(); });
  own(() => rm(directory, { recursive: true, force: true })); own(() => core.close());
  const gateway = new MobileGateway(core); own(() => gateway.close()); await gateway.start();
  core.capabilities.ollama = { available: true, modelsStatus: 'ready', models: [{ id: 'fixture', displayName: 'Fixture', description: '', efforts: [], defaultEffort: '', isDefault: true, capabilities: ['completion', 'tools'] }] };
  const port = await freePort();
  const pair = async (name: string, caps = ['chat.read', 'chat.write'], projects = [directory]) => {
    const prepared: any = await gateway.local('remote.preparePair', { addresses: ['127.0.0.1'], name: 'Test desktop', port }), offer = parsePairing(prepared.uri) as any, connection = keypair(), action = keypair(), deviceId = randomUUID();
    const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId, name, keyVersion: 1, connectionKey: pub(connection), actionKey: pub(action), deviceNonce: randomBytes(32).toString('base64url') };
    const transcript = { domain: 'cere.mobile.pair.response.v1', response: body }, response = pairingUri({ ...body, connectionProof: proof(connection, transcript), actionProof: proof(action, transcript) });
    const review: any = await gateway.local('remote.reviewPair', { response });
    await gateway.local('remote.confirmPair', { response, sas: review.sas, confirmed: true, projectPaths: projects, caps, categories: [], scriptIds: [] });
    return { offer, connection, action, deviceId };
  };
  type Phone = Awaited<ReturnType<typeof pair>>;
  const connect = async (phone: Phone) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/mobile/v1`, 'cere.mobile.v1', { ca: gateway.identity.material().cert }), queue: any[] = [], waiters: ((v: any) => void)[] = [];
    own(() => ws.terminate()); ws.on('message', bytes => { const m = JSON.parse(String(bytes)); if (m.type === 'event') return; const waiter = waiters.shift(); if (waiter) waiter(m); else queue.push(m); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = (): Promise<any> => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out')), 8000); waiters.push(v => { clearTimeout(timer); resolve(v); }); });
    const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId: phone.offer.desktopId, deviceId: phone.deviceId, keyVersion: 1, clientNonce: randomBytes(32).toString('base64url'), appVersion: 'test' };
    ws.send(JSON.stringify(hello)); const { v: _v, type: _type, ...challenge } = await next();
    ws.send(JSON.stringify({ v: 1, type: 'auth', challengeId: challenge.challengeId, signature: proof(phone.connection, { domain: 'cere.mobile.auth.v1', helloDigest: digest(hello), challenge, desktopId: phone.offer.desktopId, deviceId: phone.deviceId, keyVersion: 1, epoch: challenge.epoch }) }));
    const welcome = await next(); assert.equal(welcome.type, 'welcome');
    const request = async (method: string, params: any = {}, commandId?: string, actionProof?: any) => { ws.send(JSON.stringify({ v: 1, type: 'request', id: randomUUID(), method, params, ...(commandId ? { commandId } : {}), ...(actionProof ? { proof: actionProof } : {}) })); return next(); };
    const signed = async (method: string, params: any, p: { commandId?: string; as?: any } = {}) => {
      const commandId = p.commandId || randomUUID(), challenged = await request('commands.challenge', { method, paramsDigest: digest(params), commandId }), challengeFor = challenged.result;
      if (!challengeFor) throw new Error(JSON.stringify(challenged));
      const transcript = { domain: 'cere.mobile.action.v1', desktopId: phone.offer.desktopId, deviceId: phone.deviceId, keyVersion: 1, scopeVersion: gateway.registry.live(phone.deviceId)!.scopeVersion, epoch: welcome.epoch, authSessionId: welcome.authSessionId, challengeId: challengeFor.challengeId, nonce: challengeFor.nonce, method, paramsDigest: digest(params), commandId };
      return request(method, p.as || params, commandId, { challengeId: challengeFor.challengeId, signature: proof(phone.action, transcript) });
    };
    return { ws, welcome, request, signed };
  };
  const conversation = () => core.create({ provider: 'ollama', cwd: directory, model: 'fixture', tools: false });
  const params = (id: string, text: string, extra: any = {}) => { const s = core.store.session(id); return { sessionId: id, text, attachments: [], webSearch: false, expectedDraftRevision: s.draftRevision || '0', expectedConfigRevision: s.configRevision || '0', ...extra }; };
  const finish = async (id: string) => { hooks.get(id)!.event({ type: 'complete' }); for (let i = 0; i < 100 && core.store.session(id).status !== 'idle'; i++) await new Promise(r => setTimeout(r, 5)); };
  return { core, gateway, clock, directory, sent, pair, connect, conversation, params, finish };
}
const field = (block: string, name: string) => block.match(new RegExp('^' + name + ': (.*)$', 'm'))?.[1];

test('M06/M07 the feature is advertised and optional: an older phone’s send works and is labelled with this computer’s zone', async t => {
  const f = await setup(t), phone = await f.pair('Old phone'), client = await f.connect(phone), s = await f.conversation();
  assert.ok((protocolFeatures as readonly string[]).includes('time.context.v1')); assert.ok(client.welcome.features.includes('time.context.v1'));
  for (const operation of ['time.now', 'time.elapsed', 'sessions.timeZone']) assert.ok(client.welcome.operations.includes(operation), operation);
  const answer = await client.signed('sessions.send', f.params(s.id, 'What day is it?'));
  assert.equal(answer.error, undefined, JSON.stringify(answer.error)); assert.equal(answer.result.status, 'accepted');
  assert.deepEqual([field(f.sent[0].time, 'timezone'), field(f.sent[0].time, 'timezone_source')], ['America/New_York', 'broker-system']);
  // The hello carries nothing about time, so an older desktop still authenticates this phone.
  assert.equal((await client.request('sync.open', {})).error, undefined);
});

test('M08/M09 two phones in two zones share one instant; neither changes a setting, and a wrong phone clock cannot be sent', async t => {
  const f = await setup(t), [a, b] = [await f.connect(await f.pair('Denver')), await f.connect(await f.pair('Tokyo'))], [one, two] = [await f.conversation(), await f.conversation()];
  assert.equal((await a.signed('sessions.send', f.params(one.id, 'Hi', { clientContext: { timeZone: 'America/Denver', locale: 'en-US' } }))).error, undefined);
  assert.equal((await b.signed('sessions.send', f.params(two.id, 'Hi', { clientContext: { timeZone: 'Asia/Tokyo' } }))).error, undefined);
  assert.deepEqual(f.sent.map(s => [field(s.time, 'sampled_at_utc'), field(s.time, 'timezone'), field(s.time, 'timezone_source'), field(s.time, 'message_reference_date')]),
    [['2026-11-21T16:30:00.000Z', 'America/Denver', 'message-device', '2026-11-21'], ['2026-11-21T16:30:00.000Z', 'Asia/Tokyo', 'message-device', '2026-11-22']]);
  assert.deepEqual(f.core.settings.time, { enabled: true, zoneMode: 'automatic', fixedZone: null, conversationTiming: true, clockFormat: 'system' });
  assert.equal(f.core.store.session(one.id).timeZone, undefined); assert.equal(process.env.TZ, undefined);
  assert.deepEqual(f.core.store.messages(one.id).find(m => m.role === 'user')!.timing, { receivedAtMs: f.clock.wall, referenceTimeZone: 'America/Denver', zoneSource: 'message-device', origin: 'human-mobile', timestampKind: 'broker-received' });
  await f.finish(one.id);
  for (const clientContext of [{ timeZone: 'America/Denver', now: 1 }, { timeZone: 'x'.repeat(200) }, { locale: 'en-US' }, 'America/Denver']) assert.equal(methods['sessions.send'].safeParse(f.params(one.id, 'x', { clientContext })).success, false, JSON.stringify(clientContext));
  assert.equal((await a.signed('sessions.send', f.params(one.id, 'x', { clientContext: { timeZone: 'America/Denver', now: 1 } }))).error.code, 'INVALID_ARGUMENT');
  // A zone this desktop does not know is a suggestion it cannot use, not a refused message.
  assert.equal((await a.signed('sessions.send', f.params(one.id, 'From Mars', { clientContext: { timeZone: 'Mars/Olympus_Mons' } }))).error, undefined);
  assert.equal(field(f.sent.at(-1)!.time, 'timezone_source'), 'broker-system');
});

test('M10/M11 the zone is part of the signed command: tampering fails, a retry is the same message, and travel only affects a new one', async t => {
  const f = await setup(t), client = await f.connect(await f.pair('Traveller')), s = await f.conversation();
  const params = f.params(s.id, 'Tomorrow, please', { clientContext: { timeZone: 'America/Denver' } });
  assert.ok((await client.signed('sessions.send', params, { as: { ...params, clientContext: { timeZone: 'Asia/Tokyo' } } })).error);
  assert.equal(f.sent.length, 0);
  const commandId = randomUUID(), accepted = await client.signed('sessions.send', params, { commandId });
  assert.equal(accepted.error, undefined);
  const repeated = await client.signed('sessions.send', params, { commandId });
  assert.deepEqual([repeated.result?.turnId, f.sent.length], [accepted.result.turnId, 1], 'exactly once, with the zone it was sent with');
  await f.finish(s.id); f.clock.pass(3600_000);
  await client.signed('sessions.send', f.params(s.id, 'Now in Tokyo', { clientContext: { timeZone: 'Asia/Tokyo' } }));
  assert.deepEqual(f.core.store.messages(s.id).filter(m => m.role === 'user').map(m => m.timing!.referenceTimeZone), ['America/Denver', 'Asia/Tokyo'], 'history keeps the zone it had');
});

test('M02/M13 clock reads need chat access to that conversation, and nothing else; another project is not acknowledged', async t => {
  const f = await setup(t), client = await f.connect(await f.pair('Reader', ['chat.read'])), s = await f.conversation();
  const now = (await client.request('time.now', { sessionId: s.id })).result;
  assert.deepEqual([now.localIso, now.zoneSource, now.enabled], ['2026-11-21T11:30:00-05:00', 'broker-system', true]);
  assert.equal((await client.request('time.now', { sessionId: s.id, timeZone: 'Asia/Tokyo' })).result.zoneSource, 'explicit-query');
  assert.equal((await client.request('time.now', { sessionId: s.id, timeZone: 'Nowhere/Bad' })).error.code, 'INVALID_ARGUMENT');
  const elapsed = (await client.request('time.elapsed', { sessionId: s.id, anchor: 'session_created' })).result;
  assert.equal(elapsed.anchorKind, 'session_created');
  assert.equal((await client.request('time.elapsed', { sessionId: s.id, anchor: 'session_created', messageId: 'x' })).error.code, 'INVALID_ARGUMENT');
  const elsewhere = await mkdtemp(join(tmpdir(), 'pal-time-other-')); t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const hidden = await f.core.create({ provider: 'ollama', cwd: elsewhere, model: 'fixture', tools: false });
  f.core.store.message({ id: 'hidden-message', sessionId: hidden.id, role: 'user', text: 'private', time: f.clock.wall });
  assert.equal((await client.request('time.now', { sessionId: hidden.id })).error.code, (await client.request('time.now', { sessionId: randomUUID() })).error.code);
  const probe = (await client.request('time.elapsed', { sessionId: s.id, anchor: 'message', messageId: 'hidden-message' })).result;
  assert.deepEqual([probe.status, probe.fromMs], ['unknown', undefined]);
  // Reading is not writing: this phone cannot set the conversation's zone.
  assert.ok((await client.request('sessions.timeZone', { sessionId: s.id, timeZone: 'UTC', expectedConfigRevision: '0' }, randomUUID())).error);
  assert.ok(!availableOperations(['memory.read'], 'limited').includes('time.now'));
});

test('a phone sets and clears a conversation’s zone under its configuration revision, and sees it in the session', async t => {
  const f = await setup(t), client = await f.connect(await f.pair('Writer')), s = await f.conversation();
  const revision = f.core.store.session(s.id).configRevision || '0';
  const set = await client.request('sessions.timeZone', { sessionId: s.id, timeZone: 'Europe/Berlin', expectedConfigRevision: revision }, randomUUID());
  assert.equal(set.error, undefined, JSON.stringify(set.error)); assert.equal(set.result.timeZone, 'Europe/Berlin'); assert.notEqual(set.result.configRevision, revision);
  assert.equal((await client.request('sessions.timeZone', { sessionId: s.id, timeZone: 'UTC', expectedConfigRevision: revision }, randomUUID())).error.code, 'REVISION_CONFLICT');
  assert.equal((await client.request('sessions.timeZone', { sessionId: s.id, timeZone: 'Nowhere/Bad', expectedConfigRevision: set.result.configRevision }, randomUUID())).error.code, 'INVALID_ARGUMENT');
  // The conversation's own zone outranks the phone's.
  await client.signed('sessions.send', f.params(s.id, 'Hi', { clientContext: { timeZone: 'America/Denver' } }));
  assert.deepEqual([field(f.sent[0].time, 'timezone'), field(f.sent[0].time, 'timezone_source')], ['Europe/Berlin', 'conversation']);
  await f.finish(s.id);
  const cleared = await client.request('sessions.timeZone', { sessionId: s.id, timeZone: null, expectedConfigRevision: f.core.store.session(s.id).configRevision }, randomUUID());
  assert.equal(cleared.result.timeZone, null);
  assert.deepEqual((await client.request('settings.get', {})).result.time, { enabled: true, conversationTiming: true, zoneMode: 'automatic', fixedZone: null, clockFormat: 'system' });
});
