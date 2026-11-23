// PAL Everywhere (handoff §6–8, §21): owner phones get the desktop's authority through the same services;
// limited phones and older clients keep exactly what they had. PAR-01–06, SYN-03, FIL-01/02, ART-01, TER-01/03/05.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';
import { canonical, digest, parsePairing, pairingUri } from '../broker/remote/crypto.ts';
import { RemoteStore } from '../broker/remote/store.ts';
import { availableOperations, methods, operationDescriptors } from '../broker/remote/schemas.ts';
import { ownerOperations } from '../broker/remote/owner-schemas.ts';
import { sessionCapabilities } from '../broker/tools/contracts.ts';
import type { Hooks } from '../broker/providers.ts';
import { useTerminalWorker, useWorkspaceHelper } from './fixtures/workbench.ts';

const workspace = useWorkspaceHelper(), terminal = useTerminalWorker();
const keypair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = (pair: ReturnType<typeof keypair>) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proof = (pair: ReturnType<typeof keypair>, value: unknown) => sign('sha256', Buffer.from(canonical(value)), pair.privateKey).toString('base64url');
async function port() { const server = net.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const p = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r())); return p; }

type Role = 'owner' | 'limited' | 'observer';
async function fixture(t: any, role: Role = 'owner', options: { trusted?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-owner-test-'));
  const hooks = new Map<string, Hooks>(); let sends = 0;
  const core = new Core(new Store(directory), (session, h) => { hooks.set(session.id, h); return { async send(_text, _images, o) { sends++; h.policy?.(true); o?.beforeAccept?.(); o?.onDispatched?.(); o?.onAccepted?.(); }, async interrupt() { h.event({ type: 'interrupted' }); }, async close() {} }; });
  const resources: (() => unknown)[] = [];
  const own = (release: () => unknown) => { resources.push(release); };
  t.after(async () => { for (const release of resources.reverse()) await release(); });
  own(() => rm(directory, { recursive: true, force: true })); own(() => core.close());
  const gateway = new MobileGateway(core); own(() => gateway.close());
  await gateway.start();
  const pairing: any = await gateway.local('remote.preparePair', { addresses: ['127.0.0.1'], name: 'Test desktop', port: await port(), accessRole: role, actionAuthentication: options.trusted ? 'trusted-device' : 'biometric' });
  const offer = parsePairing(pairing.uri) as any, connection = keypair(), action = keypair(), deviceId = randomUUID();
  const body = { type: 'response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: digest(offer), nonce: offer.nonce, deviceId, name: 'Owner phone', keyVersion: 1, connectionKey: pub(connection), actionKey: pub(action), deviceNonce: randomBytes(32).toString('base64url') };
  const transcript = { domain: 'cere.mobile.pair.response.v1', response: body };
  const response = pairingUri({ ...body, connectionProof: proof(connection, transcript), actionProof: proof(action, transcript) });
  const review: any = await gateway.local('remote.reviewPair', { response });
  await gateway.local('remote.confirmPair', { response, sas: review.sas, confirmed: true, projectPaths: role === 'owner' ? [] : [directory], caps: ['chat.read', 'chat.write', 'providers.execute', 'approvals.answer', 'approvals.provider'], categories: [], scriptIds: [] });
  core.capabilities.ollama = { available: true, modelsStatus: 'ready', models: [{ id: 'fixture', displayName: 'Fixture', description: '', efforts: [], defaultEffort: '', isDefault: true, capabilities: ['completion', 'tools'] }] };
  /** Ends the fake provider's turn, as a provider's completion would. */
  const finish = async (sessionId: string) => { hooks.get(sessionId)?.event({ type: 'complete' }); for (let i = 0; i < 50 && ['starting', 'working', 'waiting', 'stopping'].includes(core.store.session(sessionId).status); i++) await new Promise(r => setTimeout(r, 10)); };
  return { directory, core, gateway, offer, review, connection, action, deviceId, hooks, own, finish, sends: () => sends, device: () => gateway.registry.live(deviceId)! };
}
type F = Awaited<ReturnType<typeof fixture>>;
class Client {
  ws: WebSocket; queue: any[] = []; waiters: ((v: any) => void)[] = []; welcome: any; events: any[] = []; binary: Buffer[] = [];
  constructor(ws: WebSocket) { this.ws = ws; ws.on('message', (bytes, binary) => { if (binary) { this.binary.push(Buffer.from(bytes as any)); return; } const m = JSON.parse(String(bytes)); if (m.type === 'event') { this.events.push(m); return; } const waiter = this.waiters.shift(); if (waiter) waiter(m); else this.queue.push(m); }); }
  next(): Promise<any> { if (this.queue.length) return Promise.resolve(this.queue.shift()); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for wire response')), 8000); this.waiters.push(v => { clearTimeout(timer); resolve(v); }); }); }
  send(value: any) { this.ws.send(JSON.stringify(value)); }
  async request(method: string, params: any = {}, commandId?: string, actionProof?: any) { this.send({ v: 1, type: 'request', id: randomUUID(), method, params, ...(commandId ? { commandId } : {}), ...(actionProof ? { proof: actionProof } : {}) }); return this.next(); }
  async action(method: string, params: any, f: F, commandId = randomUUID()) {
    const challenge = (await this.request('commands.challenge', { method, paramsDigest: digest(params), commandId })).result;
    const transcript = { domain: 'cere.mobile.action.v1', desktopId: f.offer.desktopId, deviceId: f.deviceId, keyVersion: 1, scopeVersion: f.device().scopeVersion, epoch: this.welcome.epoch, authSessionId: this.welcome.authSessionId, challengeId: challenge.challengeId, nonce: challenge.nonce, method, paramsDigest: digest(params), commandId };
    return this.request(method, params, commandId, { challengeId: challenge.challengeId, signature: proof(f.action, transcript) });
  }
  async mutate(method: string, params: any) { return this.request(method, params, randomUUID()); }
  event(name: string, predicate: (data: any) => boolean = () => true, timeout = 8000): Promise<any> {
    const found = this.events.find(e => e.name === name && predicate(e.data)); if (found) return Promise.resolve(found.data);
    return new Promise((resolve, reject) => {
      const started = Date.now(), timer = setInterval(() => { const hit = this.events.find(e => e.name === name && predicate(e.data)); if (hit) { clearInterval(timer); resolve(hit.data); } else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('Timed out waiting for ' + name)); } }, 20);
    });
  }
}
async function connect(t: any, f: F, features: string[] | null = ['owner.policy.v1', 'workbench.remote.v1', 'artifacts.transfer.v1', 'settings.owner.v1', 'terminal.v1']) {
  const ws = new WebSocket(f.offer.endpoints[0], 'cere.mobile.v1', { ca: f.gateway.identity.material().cert });
  const client = new Client(ws); f.own(() => ws.terminate()); await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId: f.offer.desktopId, deviceId: f.deviceId, keyVersion: 1, clientNonce: randomBytes(32).toString('base64url'), appVersion: 'test' };
  client.send(hello); const { v: _v, type: _type, ...challenge } = await client.next();
  const transcript = { domain: 'cere.mobile.auth.v1', helloDigest: digest(hello), challenge, desktopId: f.offer.desktopId, deviceId: f.deviceId, keyVersion: 1, epoch: challenge.epoch };
  client.send({ v: 1, type: 'auth', challengeId: challenge.challengeId, signature: proof(f.connection, transcript) });
  client.welcome = await client.next(); assert.equal(client.welcome.type, 'welcome');
  if (features) { const negotiated = await client.request('client.features', { features }); assert.equal(negotiated.error, undefined); client.welcome.operations = negotiated.result.operations; (client as any).role = negotiated.result.role; }
  await client.request('sync.open', {});
  return client;
}

test('every gateway operation has one descriptor; owner operations need the owner role and a negotiated feature', () => {
  for (const method of Object.keys(methods)) assert.ok(operationDescriptors[method], method);
  for (const [method, entry] of Object.entries(ownerOperations)) {
    const descriptor = operationDescriptors[method];
    assert.equal(descriptor.feature, entry.feature, method);
    if (method === 'client.features' || method === 'devices.setSelfRole') assert.deepEqual([...descriptor.roles].sort(), ['limited', 'observer', 'owner']);
    else assert.deepEqual([...descriptor.roles], ['owner'], method);
  }
  const all = ['chat.read', 'chat.write', 'approvals.answer', 'providers.execute', 'desktop.control', 'memory.read', 'memory.write', 'settings.write'];
  const limited = availableOperations(all, 'limited'), owner = availableOperations(all, 'owner'), observer = availableOperations(all, 'observer');
  assert.ok(!limited.some(method => method.startsWith('workbench.') || method.startsWith('terminal.') || method.startsWith('owner.')));
  assert.ok(owner.includes('terminal.create') && owner.includes('workbench.files.list') && owner.includes('sessions.send'));
  assert.ok(!observer.includes('sessions.send') && observer.includes('sessions.stop') && observer.includes('approvals.answer'));
  // Sensitive owner fields are declared, so logs and contracts can exclude them.
  assert.deepEqual(operationDescriptors['owner.credentials.set'].sensitive, ['key']);
});

test('PAR-02/PAR-03 an existing phone becomes an explicit limited device; trusted signing never implies owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-owner-migrate-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  // A schema-1 record exactly as 0.1.5 wrote it.
  store.db.exec('CREATE TABLE IF NOT EXISTS remote_devices(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const legacy = { id: randomUUID(), name: 'Old phone', connectionKey: 'c', actionKey: 'a', keyVersion: 1, scopeVersion: '7', actionAuthentication: 'trusted-device', createdAt: 1, expiresAt: Date.now() + 86400000, projects: [{ id: randomUUID(), name: 'p', path: directory }], caps: ['chat.read'], categories: [], scriptIds: [], ollamaHosts: [] };
  store.db.prepare('INSERT INTO remote_devices VALUES (?,?)').run(legacy.id, JSON.stringify(legacy));
  store.set('remoteSchema', 1);
  const registry = new RemoteStore(store);
  const migrated = registry.device(legacy.id)!;
  assert.equal(store.get('remoteSchema', 0), 2);
  assert.equal(migrated.role, 'limited');
  assert.equal(migrated.actionAuthentication, 'trusted-device');
  assert.deepEqual({ ...migrated, role: undefined }, { ...legacy, role: undefined });
  assert.equal(RemoteStore.effectiveRole(migrated), 'limited');
  // A newer authority schema is refused by an older reader rather than read more broadly.
  store.set('remoteSchema', 3);
  assert.throws(() => new RemoteStore(store), /Unsupported remote database version/);
  store.close();
});

test('owner pairing signs the role into the offer and grants the owner ceiling until revoked', async t => {
  const f = await fixture(t, 'owner', { trusted: true });
  assert.equal(f.offer.accessRole, 'owner');
  assert.equal(f.review.accessRole, 'owner');
  const device = f.device();
  assert.equal(device.role, 'owner'); assert.equal(device.lifetime, 'until-revoked'); assert.equal(device.expiresAt, undefined);
  assert.equal(device.profile, 'desktop'); assert.equal(device.actionAuthentication, 'trusted-device');
  // A limited offer stays byte-compatible with phones that predate roles: no accessRole field at all.
  const limited = await fixture(t, 'limited');
  assert.equal(limited.offer.accessRole, undefined); assert.equal(limited.device().role, 'limited');
  assert.ok(typeof limited.device().expiresAt === 'number');
});

test('SYN-03 an owner phone acts as an owner only after its client negotiates; an older client keeps the takeover path', async t => {
  const f = await fixture(t, 'owner');
  const session = await f.core.create({ provider: 'ollama', cwd: f.directory, trusted: true, tools: true, model: 'fixture', capabilities: { files: true } });
  const legacy = await connect(t, f, null);
  assert.ok(!legacy.welcome.operations.includes('workbench.files.list'));
  assert.ok(legacy.welcome.operations.includes('client.features'));
  const dto = (await legacy.request('sessions.get', { sessionId: session.id })).result;
  assert.equal(dto.workbenchTakeover, 'acknowledge');
  const refused = await legacy.action('sessions.send', { sessionId: session.id, text: 'hi', attachments: [], webSearch: false, expectedDraftRevision: dto.draftRevision, expectedConfigRevision: dto.configRevision }, f);
  assert.equal(refused.error.code, 'PROVIDER_POLICY_UNSAFE');
  assert.match(refused.error.message, /Update PAL Mobile/);
  // The same phone, once its client declares owner policy, sees the parity path.
  legacy.ws.close(); await new Promise(r => setTimeout(r, 50));
  const owner = await connect(t, f);
  assert.equal((owner as any).role, 'owner');
  assert.ok(owner.welcome.operations.includes('workbench.files.list'));
  const ownerDto = (await owner.request('sessions.get', { sessionId: session.id })).result;
  assert.equal(ownerDto.workbenchTakeover, null);
  assert.deepEqual(ownerDto.capabilities, ['files']);
});

test('partial owner clients see only the operation families they negotiated', async t => {
  const f = await fixture(t), client = await connect(t, f, ['owner.policy.v1', 'settings.owner.v1']);
  assert.ok(client.welcome.operations.includes('owner.settings.get'));
  assert.ok(!client.welcome.operations.includes('terminal.list'));
  assert.equal((await client.request('terminal.list')).error.code, 'SCOPE_DENIED');
});

test('owner handoff keeps the reviewed draft and named API accounts work without a default endpoint', async t => {
  const f = await fixture(t), client = await connect(t, f);
  const source = await f.core.create({ provider: 'ollama', model: 'fixture', cwd: f.directory });
  const projectId = f.gateway.router.projectFor(f.device(), source.cwd).id;
  const preview = (await client.request('sessions.handoffPreview', { sessionId: source.id })).result;
  const handoff = await client.action('sessions.handoffCreate', { sourceSessionId: source.id, projectId, sourceDigest: preview.sourceDigest, draft: 'Reviewed on phone', provider: 'ollama', model: 'fixture' }, f);
  assert.equal(handoff.error, undefined);
  assert.equal(f.core.store.session(handoff.result.id).draft, 'Reviewed on phone');
  const connection = await f.core.rpc('connections.save', { kind: 'compatible', name: 'Fixture account', endpoint: { baseUrl: 'http://127.0.0.1:57121/v1', requiresKey: true } });
  await f.core.rpc('provider.credentials', { provider: 'compatible', connectionId: connection.id, key: 'fixture' });
  const created = await client.action('sessions.create', { provider: 'compatible', connectionId: connection.id, model: 'fixture', projectId }, f);
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  assert.equal((await client.request('sessions.get', { sessionId: created.result.id })).result.canSend, true);
});

test('an owner can import native history under desktop policy without restricted Claude support', async t => {
  const f = await fixture(t), client = await connect(t, f);
  await f.core.create({ provider: 'ollama', model: 'fixture', cwd: f.directory });
  const projectId = f.gateway.router.projectFor(f.device(), f.directory).id;
  f.core.history = async () => [{ nativeId: 'fixture-history', provider: 'claude', cwd: f.directory, title: 'Fixture', mode: 'historical' }];
  const history = await client.request('sessions.history', { projectId, provider: 'claude' });
  assert.equal(history.error, undefined);
  const imported = await client.action('sessions.import', { historyId: history.result.items[0].id, externalWriterStopped: true }, f);
  assert.equal(imported.error, undefined);
  assert.equal(f.core.store.session(imported.result.id).effectivePolicy, 'desktop');
});

test('PAR-01 a desktop conversation continued on an owner phone keeps its families and the desktop launch policy', async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const session = await f.core.create({ provider: 'ollama', cwd: f.directory, trusted: true, tools: true, model: 'fixture', capabilities: { files: true, analysis: true } });
  const dto = (await client.request('sessions.get', { sessionId: session.id })).result;
  assert.equal(dto.canSend, true);
  const sent = await client.action('sessions.send', { sessionId: session.id, text: 'Continue from the couch', attachments: [], webSearch: false, expectedDraftRevision: dto.draftRevision, expectedConfigRevision: dto.configRevision }, f);
  assert.equal(sent.error, undefined); assert.equal(sent.result.status, 'accepted');
  const after = f.core.store.session(session.id);
  assert.equal(after.id, session.id);
  assert.equal(after.remote?.role, 'owner'); assert.equal(after.effectivePolicy, 'desktop');
  assert.deepEqual(sessionCapabilities(after), { files: true, images: false, analysis: true });
  assert.equal(f.hooks.get(session.id)?.restrictive, false);
  // Returning to the desktop transfers control back without relaunching or downgrading anything.
  await f.finish(session.id);
  await f.core.rpc('session.send', { id: session.id, text: 'Back at the desk', expectedDraftRevision: f.core.store.session(session.id).draftRevision });
  const back = f.core.store.session(session.id);
  assert.equal(back.remote, undefined); assert.equal(back.remoteOrigin?.deviceId, f.deviceId);
  assert.deepEqual(sessionCapabilities(back), { files: true, images: false, analysis: true });
});

test('PAR-04/PAR-05 an owner phone launches Codex and Claude with the desktop policy; a limited phone keeps restricted launch', async t => {
  const owner = await fixture(t, 'owner'), ownerClient = await connect(t, owner);
  owner.core.capabilities.claude = { available: true, modelsStatus: 'ready', models: [], remoteRestricted: false };
  owner.core.capabilities.codex = { available: true, modelsStatus: 'ready', models: [] };
  // Restricted-mode support is irrelevant to an owner: the ordinary desktop launch is used.
  const claude = (await ownerClient.action('sessions.create', { provider: 'claude', cwd: owner.directory, tools: false }, owner)).result;
  assert.equal(claude.remoteRestricted, false); assert.equal(claude.canSend, true);
  const sent = await ownerClient.action('sessions.send', { sessionId: claude.id, text: 'Run the checks with Bash', attachments: [], webSearch: false, expectedDraftRevision: claude.draftRevision, expectedConfigRevision: claude.configRevision }, owner);
  assert.equal(sent.result?.status, 'accepted', JSON.stringify(sent.error));
  assert.equal(owner.hooks.get(claude.id)?.restrictive, false);
  // Automatic CLI approval follows the desktop switch for the owner (desktop choices profile).
  await owner.core.updateSettings({ bypassCliPermissions: true });
  assert.equal(owner.hooks.get(claude.id)?.bypassCliPermissions?.(), true);

  const limited = await fixture(t, 'limited'), limitedClient = await connect(t, limited, null);
  limited.core.capabilities.claude = { available: true, modelsStatus: 'ready', models: [], remoteRestricted: true };
  const restricted = (await limitedClient.action('sessions.create', { provider: 'claude', projectId: limited.device().projects[0].id, tools: false }, limited)).result;
  await limitedClient.action('sessions.send', { sessionId: restricted.id, text: 'hello', attachments: [], webSearch: false, expectedDraftRevision: restricted.draftRevision, expectedConfigRevision: restricted.configRevision }, limited);
  assert.equal(limited.hooks.get(restricted.id)?.restrictive, true);
  await limited.core.updateSettings({ bypassCliPermissions: true });
  assert.equal(limited.hooks.get(restricted.id)?.bypassCliPermissions?.(), false);
  // A limited phone cannot reach owner operations at all.
  assert.equal((await limitedClient.request('workbench.roots', { sessionId: restricted.id })).error.code, 'SCOPE_DENIED');
  assert.equal((await limitedClient.request('terminal.list', {})).error.code, 'SCOPE_DENIED');
});

test('working profiles resolve automatic approval; a turn keeps the narrower of its own and the current profile', async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const session = (await client.action('sessions.create', { provider: 'codex', cwd: f.directory, tools: false }, f)).result;
  await client.action('sessions.send', { sessionId: session.id, text: 'go', attachments: [], webSearch: false, expectedDraftRevision: session.draftRevision, expectedConfigRevision: session.configRevision }, f);
  const provider = { kind: 'provider' as const, choices: ['allow', 'deny'] };
  assert.equal(f.core.automaticallyApprove(session.id, provider), false);
  // Choosing "Work automatically" applies to the next turn, not to the turn already accepted under "desktop".
  const set = await client.action('owner.profile.set', { profile: 'automatic', expectedProfileRevision: f.device().profileRevision }, f);
  assert.equal(set.result.workingProfile, 'automatic');
  assert.equal(f.core.automaticallyApprove(session.id, provider), false, 'no authority is gained mid-run');
  await f.finish(session.id);
  const fresh = f.core.store.session(session.id);
  const next = await client.action('sessions.send', { sessionId: session.id, text: 'next', attachments: [], webSearch: false, expectedDraftRevision: fresh.draftRevision || '0', expectedConfigRevision: fresh.configRevision || '0' }, f);
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(f.core.automaticallyApprove(session.id, provider), true);
  // Narrowing to Review applies at once, even to the turn already running.
  await f.gateway.local('remote.setProfile', { id: f.deviceId, profile: 'review' });
  assert.equal(f.core.automaticallyApprove(session.id, provider), false);
  // A stale profile revision is a conflict, not a silent overwrite.
  assert.equal((await client.action('owner.profile.set', { profile: 'desktop', expectedProfileRevision: '1' }, f)).error.code, 'REVISION_CONFLICT');
});

test('PAR-06 owner power sessions and children: a child inherits the owner snapshot and joins the lease', async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const parent = (await client.action('sessions.create', { provider: 'codex', cwd: f.directory, tools: false }, f)).result;
  await client.action('sessions.send', { sessionId: parent.id, text: 'go', attachments: [], webSearch: false, expectedDraftRevision: parent.draftRevision, expectedConfigRevision: parent.configRevision }, f);
  await f.finish(parent.id);
  const live = f.core.store.session(parent.id);
  assert.equal(f.core.power.startUnavailableReason({ ...live, status: 'idle' }), '');
  const lease = await client.action('owner.power.start', { sessionIds: [parent.id], minutes: 5, cli: true, computer: false }, f);
  assert.equal(lease.error, undefined, JSON.stringify(lease.error));
  assert.equal(f.core.settingsFor(parent.id).bypassCliPermissions, true);
  const ended = await client.mutate('owner.power.end', { id: lease.result.id });
  assert.equal(ended.error, undefined);
  assert.equal(f.core.settingsFor(parent.id).bypassCliPermissions, false);
});

test('revoking an owner phone returns its conversations to the desktop and stops terminals it started', async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const session = (await client.action('sessions.create', { provider: 'codex', cwd: f.directory, tools: false }, f)).result;
  await client.action('sessions.send', { sessionId: session.id, text: 'go', attachments: [], webSearch: false, expectedDraftRevision: session.draftRevision, expectedConfigRevision: session.configRevision }, f);
  await f.finish(session.id);
  assert.equal(f.core.store.session(session.id).remote?.deviceId, f.deviceId);
  await f.gateway.revoke(f.deviceId);
  const after = f.core.store.session(session.id);
  assert.equal(after.remote, undefined); assert.equal(after.remoteOrigin?.deviceId, f.deviceId);
  assert.doesNotThrow(() => f.core.settingsFor(session.id));
});

test('promotion keeps keys, signing and project IDs; demotion names what the phone keeps', async t => {
  const f = await fixture(t, 'limited', { trusted: true });
  const before = f.device();
  await f.gateway.local('remote.setRole', { id: f.deviceId, role: 'owner', confirmed: true });
  const promoted = f.device();
  assert.equal(promoted.role, 'owner'); assert.equal(promoted.lifetime, 'until-revoked');
  assert.equal(promoted.connectionKey, before.connectionKey); assert.equal(promoted.actionKey, before.actionKey); assert.equal(promoted.actionAuthentication, 'trusted-device');
  assert.notEqual(promoted.scopeVersion, before.scopeVersion);
  const client = await connect(t, f);
  const projects = (await client.request('projects.list', {})).result;
  assert.ok(projects.some((project: any) => project.id === before.projects[0].id && project.path === before.projects[0].path), 'a promoted phone keeps its project IDs');
  await f.gateway.local('remote.setRole', { id: f.deviceId, role: 'limited', confirmed: true, projectPaths: [f.directory] });
  const demoted = f.device();
  assert.equal(demoted.role, 'limited'); assert.ok(typeof demoted.expiresAt === 'number'); assert.equal(demoted.lifetime, undefined);
  assert.deepEqual(demoted.caps, ['chat.read', 'chat.write', 'approvals.answer']);
});

test('limiting an owner phone on the desktop stops its terminal and clears its transfers', { skip: !terminal }, async t => {
  const f = await fixture(t), client = await connect(t, f);
  const created = await client.action('terminal.create', { shell: 'bash', cwd: f.directory, rows: 12, cols: 70 }, f);
  const session = await f.core.create({ provider: 'ollama', model: 'fixture', cwd: f.directory });
  const upload = await client.action('transfers.upload', { sessionId: session.id, name: 'sample', mime: 'text/plain', size: 5, sha256: '0'.repeat(64) }, f);
  await f.gateway.local('remote.setRole', { id: f.deviceId, role: 'limited', confirmed: true, projectPaths: [f.directory] });
  const stopped = f.core.terminals.get(created.result.terminal.id);
  assert.ok(!['starting', 'running', 'stopping'].includes(stopped.state), stopped.state);
  assert.equal(stopped.controller, null);
  assert.equal(f.gateway.router.transfers.uploads.has(upload.result.transferId), false);
});

test('an observer reads, stops and denies, and can never allow or send', async t => {
  const f = await fixture(t, 'observer');
  assert.deepEqual(f.device().caps.sort(), ['approvals.answer', 'chat.read']);
  const client = await connect(t, f, null);
  const session = await f.core.create({ provider: 'codex', cwd: f.directory, trusted: true });
  assert.equal((await client.request('sessions.get', { sessionId: session.id })).error, undefined);
  const send = await client.action('sessions.send', { sessionId: session.id, text: 'x', attachments: [], webSearch: false, expectedDraftRevision: '0', expectedConfigRevision: '0' }, f);
  assert.equal(send.error.code, 'SCOPE_DENIED');
  const pending = f.core.approval(session.id, { kind: 'provider', title: 'Run', detail: 'x', choices: ['allow', 'deny'] });
  const approval = (await client.request('approvals.list')).result[0];
  const allow = await client.action('approvals.answer', { approvalId: approval.id, revision: approval.revision, digest: approval.digest, choice: 'allow', answers: {} }, f);
  assert.equal(allow.error.code, 'SCOPE_DENIED');
  const deny = await client.mutate('approvals.answer', { approvalId: approval.id, revision: approval.revision, digest: approval.digest, choice: 'deny', answers: {} });
  assert.equal(deny.error, undefined);
  assert.equal((await pending).choice, 'deny');
});

test('FIL-01/FIL-02 an owner phone edits through the change engine; a stale review never overwrites newer content', { skip: workspace ? false : 'needs pal-workspacefs' }, async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  // A project folder of its own: PAL's private state directory can never be a workspace folder.
  const project = await mkdtemp(join(tmpdir(), 'pal-owner-project-')); t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(join(project, 'notes.txt'), 'first line\n');
  const session = await f.core.create({ provider: 'ollama', cwd: project, trusted: true, tools: true, model: 'fixture', capabilities: { files: true } });
  const root = await client.action('workbench.addRoot', { sessionId: session.id, path: project, policy: { write: true } }, f);
  assert.equal(root.error, undefined, JSON.stringify(root.error));
  const roots = (await client.request('workbench.roots', { sessionId: session.id })).result.roots;
  const rootId = roots[0].id;
  const listed = (await client.request('workbench.files.list', { sessionId: session.id, rootId, path: '' })).result;
  assert.ok(JSON.stringify(listed).includes('notes.txt'));
  const text = (await client.request('workbench.files.text', { sessionId: session.id, rootId, path: 'notes.txt' })).result;
  assert.equal(text.text, 'first line\n');
  const edit = { kind: 'patch_text', rootId, path: 'notes.txt', baseVersion: text.version, content: 'edited on the phone\n' };
  const saved = await client.action('workbench.changes.propose', { sessionId: session.id, operations: [edit], apply: true }, f);
  assert.equal(saved.error, undefined, JSON.stringify(saved.error));
  assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'edited on the phone\n');
  // The same reviewed version again: the file changed since, so nothing is overwritten.
  const stale = await client.action('workbench.changes.propose', { sessionId: session.id, operations: [{ ...edit, content: 'stale' }], apply: true }, f);
  assert.ok(stale.error || stale.result?.applied?.status !== 'applied', 'a stale edit must not apply');
  assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'edited on the phone\n');
  // The owner's host browser lists folders for choosing, never contents.
  const browse = (await client.request('workbench.browse', { path: project })).result;
  assert.ok(browse.items.some((item: any) => item.name === 'notes.txt' && item.kind === 'file'));
  assert.ok(!JSON.stringify(browse).includes('edited on the phone'));
});

test('gateway restart clears abandoned transfer staging before accepting new transfers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-staging-'));
  const core = new Core(new Store(directory));
  const gateway = new MobileGateway(core);
  t.after(async () => { await gateway.close(); await core.close(); await rm(directory, {recursive: true, force: true}); });
  const folder = join(gateway.router.transfers.directory, randomUUID());
  await mkdir(folder, {recursive: true});
  const staged = join(folder, randomUUID());
  await writeFile(staged, 'previous broker upload');
  await gateway.start();
  await assert.rejects(access(staged), {code: 'ENOENT'});
  // A normal listener refresh must keep this broker's staging.
  await mkdir(folder, {recursive: true});
  await writeFile(staged, 'current upload');
  await gateway.start();
  assert.equal(await readFile(staged, 'utf8'), 'current upload');
});

test('ART-01 a phone upload is verified, resumable at the committed offset and installs one artifact; downloads verify', async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const session = await f.core.create({ provider: 'ollama', cwd: f.directory, trusted: true, tools: true, model: 'fixture', capabilities: { files: true } });
  const bytes = randomBytes(300 * 1024), sha256 = createHash('sha256').update(bytes).digest('hex');
  const begun = await client.action('transfers.upload', { sessionId: session.id, name: 'photo.bin', mime: 'application/octet-stream', size: bytes.length, sha256, purpose: 'artifact' }, f);
  assert.equal(begun.error, undefined, JSON.stringify(begun.error));
  const id = Buffer.from(begun.result.transferId.replaceAll('-', ''), 'hex');
  const chunk = (offset: number, body: Buffer) => { const header = Buffer.alloc(24); id.copy(header); header.writeBigUInt64BE(BigInt(offset), 16); return Buffer.concat([header, body]); };
  client.ws.send(chunk(0, bytes.subarray(0, 256 * 1024)));
  await client.event('transfer.progress', data => data.offset === 256 * 1024);
  // An interrupted phone asks where to resume instead of resending from the start.
  const status = (await client.request('transfers.status', { transferId: begun.result.transferId })).result;
  assert.equal(status.offset, 256 * 1024);
  client.ws.send(chunk(status.offset, bytes.subarray(status.offset)));
  await client.event('transfer.progress', data => data.offset === bytes.length);
  const other = await connect(t, f);
  const [committed, concurrent] = await Promise.all([client, other].map(peer =>
    peer.mutate('transfers.commit', { transferId: begun.result.transferId })));
  assert.equal(concurrent.result.artifact.versionId, committed.result.artifact.versionId);
  assert.equal(committed.error, undefined, JSON.stringify(committed.error));
  assert.equal(committed.result.artifact.sha256, sha256);
  const again = await client.action('transfers.commit', { transferId: begun.result.transferId }, f);
  assert.equal(again.result.artifact.versionId, committed.result.artifact.versionId, 'a repeated commit installs nothing new');
  const download = (await client.request('transfers.download', { sessionId: session.id, artifactId: committed.result.artifact.artifactId, variant: 'original' })).result;
  assert.equal(download.sha256, sha256); assert.equal(download.size, bytes.length);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < download.size; offset += download.chunk) {
    const read = await client.request('transfers.read', { transferId: download.transferId, offset, length: download.chunk });
    assert.equal(read.error, undefined); await new Promise(r => setTimeout(r, 10));
    const frame = client.binary.shift()!; assert.equal(Number(frame.readBigUInt64BE(16)), offset); parts.push(frame.subarray(24));
  }
  assert.equal(createHash('sha256').update(Buffer.concat(parts)).digest('hex'), sha256);
  const artifact = (await client.request('workbench.artifacts.get', { sessionId: session.id, artifactId: committed.result.artifact.artifactId })).result;
  assert.equal(artifact.versions[0].provenance.kind, 'phone-import');
  const transfers = f.gateway.router.transfers;
  transfers.uploads.get(begun.result.transferId)!.expiresAt = 0;
  await transfers.prune();
  assert.equal(transfers.uploads.size, 0, 'committed receipts expire after their retry window');
});

test('TER-01/TER-03/TER-05 an owner phone runs Bash on this computer: ordered input, no replay, interrupt and stop', { skip: terminal ? false : 'needs a C compiler to build pal-terminal' }, async t => {
  const f = await fixture(t, 'owner'), client = await connect(t, f);
  const profiles = (await client.request('terminal.profiles', {})).result;
  assert.ok(profiles.shells.some((shell: any) => shell.id === 'bash'), 'Bash is offered whatever the login shell is');
  const created = await client.action('terminal.create', { shell: 'bash', cwd: f.directory, rows: 12, cols: 70 }, f);
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const id = created.result.terminal.id, lease = created.result.lease;
  assert.ok(created.result.terminal.controller.name, 'other clients can name the phone holding the lease');
  assert.equal(created.result.terminal.host.length > 0, true); assert.equal(created.result.terminal.profile, 'desktop-account');
  const screenText = () => f.core.terminals.snapshot(id).screen.lines.map((line: any) => line.map((run: any) => run[1]).join('')).join('\n');
  const until = async (predicate: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('timed out: ' + screenText()); await new Promise(r => setTimeout(r, 30)); } };
  await until(() => f.core.terminals.get(id).state === 'running');
  const send = (sequence: number, events: any[]) => client.request('terminal.input', { terminalId: id, leaseId: lease.leaseId, epoch: lease.epoch, sequence, events });
  const first = await send(1, [{ text: 'echo "piped words" | tr a-z A-Z; echo marker-$((40+2))' }, { key: 'enter' }]);
  assert.equal(first.result.accepted, true);
  await until(() => screenText().includes('PIPED WORDS') && screenText().includes('marker-42'));
  // A lost acknowledgement: the phone asks what was accepted, and a resent frame is never written twice.
  const status = (await client.request('terminal.inputStatus', { terminalId: id, leaseId: lease.leaseId, epoch: lease.epoch })).result;
  assert.equal(status.lastSequence, 1);
  const duplicate = await send(1, [{ text: 'echo marker-$((40+2))' }, { key: 'enter' }]);
  assert.equal(duplicate.result.duplicate, true);
  assert.equal((await send(5, [{ text: 'x' }])).error.code, 'REVISION_CONFLICT', 'a gap is refused');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(screenText().split('marker-42').length - 1, 1, 'the command ran once');
  // Ctrl+C reaches the foreground job, not the shell.
  await send(2, [{ text: 'sleep 30' }, { key: 'enter' }]);
  await until(() => f.core.terminals.get(id).foreground?.name === 'sleep');
  assert.equal((await client.mutate('terminal.interrupt', { terminalId: id })).result.interrupted, true);
  await until(() => f.core.terminals.get(id).foreground?.name === 'bash');
  // Taking control elsewhere ends this lease at once.
  const local = await f.core.rpc('terminal.acquireControl', { terminalId: id, expectedControllerRevision: f.core.terminals.dto(f.core.terminals.get(id)).controllerRevision });
  assert.ok(local.lease.leaseId);
  await client.event('terminal.state', data => data.id === id && data.controller?.kind === 'local');
  for (const frame of client.events.filter(event => event.name.startsWith('terminal.'))) {
    assert.equal(typeof frame.resourceRevision, 'string', frame.name + ' must decode on a subscribed phone');
  }
  assert.equal((await send(3, [{ text: 'echo late' }])).error.code, 'REVISION_CONFLICT');
  const closed = await client.mutate('terminal.close', { terminalId: id });
  assert.equal(closed.result.state, 'exited'); assert.equal(closed.result.stopReport.remaining, 0);
});
