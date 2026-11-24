import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import type { AddressInfo } from 'node:net';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-connections-')), core = new Core(new Store(directory), () => ({ send: async () => {}, interrupt: async () => {}, close: async () => {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  return { core, directory };
}
/** A local service that speaks Chat Completions, as far as it is told to. */
async function service(t: any, p: { key?: string; models?: string[]; tools?: boolean; images?: boolean; stream?: boolean; status?: number } = {}) {
  const seen: { path: string; body: any; auth?: string }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, auth = request.headers.authorization; seen.push({ path: request.url!, body, auth });
    const json = (value: any, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (p.status) return json({ error: { message: 'the secret detail ' + auth } }, p.status);
    if (p.key && auth !== 'Bearer ' + p.key) return json({ error: {} }, 401);
    if (request.url!.endsWith('/models')) return p.models ? json({ data: p.models.map(id => ({ id })) }) : json({}, 404);
    const text = JSON.stringify(body.messages), picture = text.includes('image_url');
    if (picture && !p.images || body.tools && p.tools === false) return json({ error: {} }, 400);
    const said = picture ? 'Red' : body.response_format ? '{"word":"ready"}' : /Count from/.test(text) ? 'one, two, three' : 'ready', usage = { prompt_tokens: 9, completion_tokens: 2 };
    const call = body.tools && body.messages.at(-1).role !== 'tool';
    if (!body.stream) return json({ choices: [{ message: { role: 'assistant', content: said }, finish_reason: 'stop' }], usage });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: any, finish: string | null = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    if (call) { chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'pal_check', arguments: '{"value":"ready"}' } }] }); chunk({}, 'tool_calls'); }
    else if (p.stream === false) { chunk({ content: said }, 'stop'); }
    else { for (const part of said.split(/(?<=,)/)) chunk({ content: part }); chunk({}, 'stop'); }
    response.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n'); response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}
const connect = (core: Core, url: string, endpoint: any = {}) => core.rpc('connections.save', { kind: 'compatible', name: 'Local server ' + Math.random().toString(36).slice(2, 8), endpoint: { baseUrl: url, requiresKey: false, processing: 'local', ...endpoint } });
const stages = (result: any) => Object.fromEntries(result.stages.map((stage: any) => [stage.id, stage.state]));

test('an account is checked in stages that cost nothing, and says what it cannot find out', async t => {
  const { core } = await fixture(t), open = await service(t, { models: ['small', 'large'] });
  const account: any = await connect(core, open.url), result: any = await core.rpc('connections.check', { connectionId: account.id });
  assert.deepEqual(stages(result), { configured: 'ok', account: 'ok', models: 'ok' }); assert.deepEqual(result.models.map((model: any) => model.id), ['large', 'small']);
  assert.ok(open.seen.every(request => request.path === '/v1/models'), 'no message was sent'); assert.equal(result.found, undefined);
  const silent: any = await connect(core, (await service(t)).url); const unlisted: any = await core.rpc('connections.check', { connectionId: silent.id });
  assert.deepEqual(stages(unlisted), { configured: 'ok', account: 'unknown', models: 'unknown' }); assert.equal(unlisted.unlisted, true);
  const locked = await service(t, { key: 'right', models: ['small'] }), closed: any = await connect(core, locked.url, { requiresKey: true });
  assert.deepEqual(stages(await core.rpc('connections.check', { connectionId: closed.id })), { configured: 'failed' }, 'nothing is asked without a credential'); assert.equal(locked.seen.length, 0);
  await core.rpc('provider.credentials', { provider: 'compatible', connectionId: closed.id, key: 'wrong' });
  const refused: any = await core.rpc('connections.check', { connectionId: closed.id }); assert.deepEqual(stages(refused), { configured: 'ok', account: 'failed', models: 'failed' }); assert.doesNotMatch(JSON.stringify(refused), /wrong|secret detail/);
  await core.rpc('provider.credentials', { provider: 'compatible', connectionId: closed.id, key: 'right' });
  assert.deepEqual(stages(await core.rpc('connections.check', { connectionId: closed.id })), { configured: 'ok', account: 'ok', models: 'ok' });
  const broken: any = await connect(core, (await service(t, { status: 400 })).url, {}); const failing: any = await core.rpc('connections.check', { connectionId: broken.id });
  assert.equal(stages(failing).account, 'unknown', 'a service in trouble says nothing about the account'); assert.doesNotMatch(JSON.stringify(failing), /secret detail/);
});
test('a model is tried only when asked, and a compatible server shows what it can do before it is declared', async t => {
  const { core } = await fixture(t), able = await service(t, { models: ['small'], tools: true, images: true });
  const account: any = await connect(core, able.url); assert.equal(account.compatible.tools, false);
  await assert.rejects(core.rpc('connections.check', { connectionId: account.id, model: 'small', tests: ['reply'] }), /may be billed/);
  await assert.rejects(core.rpc('connections.check', { connectionId: account.id, tests: ['reply'], paid: true }), /Choose a model/);
  assert.equal(able.seen.length, 0);
  const result: any = await core.rpc('connections.check', { connectionId: account.id, model: 'small', tests: ['reply', 'streaming', 'tools', 'images'], paid: true });
  assert.deepEqual(result.found, { reply: true, streaming: true, tools: true, images: true }); assert.deepEqual(stages(result), { configured: 'ok', account: 'ok', models: 'ok', reply: 'ok', streaming: 'ok', tools: 'ok', images: 'ok' });
  assert.equal(result.stages.find((stage: any) => stage.id === 'images').detail, 'It said “Red”.');
  const kept = core.store.db.prepare("SELECT data FROM usage_records").all().map(row => JSON.parse(String(row.data))).filter(row => row.kind === 'check');
  assert.equal(core.store.sessions().length, 0, 'no conversation is made'); assert.ok(kept.every(row => row.source === 'compatible' && row.model === 'small'));
  const plain = await service(t, { models: ['small'], tools: false, images: false, stream: false }), limited: any = await connect(core, plain.url);
  const found: any = await core.rpc('connections.check', { connectionId: limited.id, model: 'small', tests: ['reply', 'streaming', 'tools', 'images', 'structured'], paid: true });
  assert.deepEqual(found.found, { reply: true, streaming: false, tools: false, images: false, structured: false }); assert.match(found.stages.find((stage: any) => stage.id === 'streaming').detail, /one part/);
  assert.equal(core.chatConnections.get(account.id).compatible!.tools, false, 'finding out changes nothing by itself');
  const down: any = await connect(core, (await service(t, { models: ['small'], status: 400 })).url);
  const stopped: any = await core.rpc('connections.check', { connectionId: down.id, model: 'small', tests: ['reply', 'tools'], paid: true });
  assert.deepEqual(stopped.found, { reply: false }, 'a service that refuses the plain request is not asked more');
});
test('everything that depends on an account is listed, and moves to another of the same provider', async t => {
  const { core, directory } = await fixture(t), save = async (name: string) => { const account: any = await core.rpc('connections.save', { kind: 'openai', name }); await core.rpc('provider.credentials', { provider: 'openai', connectionId: account.id, key: 'key-' + name }); return account; };
  const work = await save('Work'), home = await save('Home'), other: any = await core.rpc('connections.save', { kind: 'xai', name: 'Grok' });
  await core.rpc('provider.credentials', { provider: 'xai', connectionId: other.id, key: 'key-grok' });
  const first = await core.create({ provider: 'openai', connectionId: work.id, model: 'gpt-5.2', cwd: directory, title: 'First' } as any), second = await core.create({ provider: 'openai', connectionId: work.id, model: 'gpt-5.2', cwd: directory, title: 'Second', providerOptions: { store: true } } as any);
  await core.updateSettings({ workbench: { helper: { provider: 'openai', model: 'gpt-5.2-mini', connectionId: work.id }, vision: { provider: 'openai', model: 'gpt-5.2', connectionId: work.id } } } as any);
  await core.updateSettings({ transcription: { provider: 'openai', cloudModel: 'whisper-1', connectionId: work.id } } as any);
  core.specialists.save({ specialist: { name: 'Reviewer', role: Object.keys(core.specialists.list().roles).find(role => role !== 'visual_review'), description: '', provider: 'openai', model: 'gpt-5.2-mini', connectionId: work.id } });
  core.setups.save({ setup: { name: 'Work setup', description: '', provider: 'openai', connection: 'Work', families: {}, collections: [], skills: [] } });
  const listed: any = await core.rpc('connections.uses', { id: work.id });
  assert.deepEqual(listed.uses.map((use: any) => use.kind).sort(), ['conversation', 'conversation', 'helper', 'setup', 'specialist', 'transcription', 'vision']); assert.equal(listed.conversations, 2); assert.ok(listed.uses.every((use: any) => use.movable));
  assert.deepEqual(listed.targets, [{ id: home.id, name: 'Home' }], 'only accounts of the same provider');
  await assert.rejects(core.rpc('connections.remove', { id: work.id }), /2 conversations use this connection/);
  await assert.rejects(core.rpc('connections.reassign', { id: work.id, to: other.id, reviewed: true }), /not for this provider/);
  await assert.rejects(core.rpc('connections.reassign', { id: work.id, to: home.id }), /reviewed/);
  const busy = core.store.session(second.id); busy.status = 'working'; core.store.saveSession(busy);
  const partly: any = await core.rpc('connections.reassign', { id: work.id, to: home.id, reviewed: true });
  assert.equal(partly.problems.length, 1); assert.match(partly.problems[0], /^Second: /); assert.equal(core.store.session(first.id).connectionId, home.id); assert.equal(core.store.session(second.id).connectionId, work.id);
  core.store.saveSession({ ...core.store.session(second.id), status: 'idle' });
  assert.deepEqual((await core.rpc('connections.reassign', { id: work.id, to: home.id, reviewed: true }) as any).problems, []);
  assert.equal(core.store.session(second.id).connectionRevision, home.revision); assert.deepEqual(core.store.session(second.id).api!.options, { store: true }, 'its options go with it');
  assert.equal(core.settings.workbench.helper!.connectionId, home.id); assert.equal(core.settings.workbench.vision.connectionId, home.id); assert.equal(core.settings.transcription.connectionId, home.id);
  assert.equal(core.specialists.list().specialists.find(item => item.name === 'Reviewer')!.connectionId, home.id); assert.equal(core.setups.list().setups.find(item => item.name === 'Work setup')!.connection, 'Home');
  assert.deepEqual((await core.rpc('connections.uses', { id: work.id }) as any).uses, []); assert.equal(await core.rpc('connections.remove', { id: work.id }), true);
  assert.ok(core.store.sessions().every(session => session.connectionId === home.id));
});
test('helpers and specialists keep their account, and a setup never falls back to another one', async t => {
  const { core, directory } = await fixture(t), account: any = await core.rpc('connections.save', { kind: 'openai', name: 'Team' }); await core.rpc('provider.credentials', { provider: 'openai', connectionId: account.id, key: 'team-key' }); await core.rpc('provider.credentials', { provider: 'openai', key: 'default-key' });
  const role = Object.keys(core.specialists.list().roles).find(item => item !== 'visual_review');
  assert.throws(() => core.specialists.save({ specialist: { name: 'Wrong', role, provider: 'xai', model: 'grok', connectionId: account.id } }), /not for this provider/);
  core.specialists.save({ specialist: { name: 'Team reviewer', role, provider: 'openai', model: 'gpt-5.2', connectionId: account.id } });
  await assert.rejects(core.rpc('connections.remove', { id: account.id }), /specialists that use this connection/);
  core.specialists.remove({ id: core.specialists.list().specialists.find(item => item.name === 'Team reviewer')!.id });
  await core.updateSettings({ workbench: { helper: { provider: 'openai', model: 'gpt-5.2', connectionId: account.id } } } as any); await assert.rejects(core.rpc('connections.remove', { id: account.id }), /another helper account/);
  await core.updateSettings({ workbench: { helper: { provider: '', model: '' } } } as any);
  const setup = core.setups.save({ setup: { name: 'Team setup', description: '', provider: 'openai', model: 'gpt-5.2', connection: 'Team', families: {}, collections: [], skills: [] } });
  const started: any = await core.setups.start({ setupId: setup.id, cwd: directory }); assert.equal(started.session.connectionId, account.id);
  const default_ = await core.create({ provider: 'openai', model: 'gpt-5.2', cwd: directory } as any);
  assert.match(core.setups.preview({ setupId: setup.id, sessionId: default_.id }).unresolved[0], /uses the account “Team”/);
  await core.deleteSession({ id: started.session.id, confirmed: true }); await core.rpc('connections.remove', { id: account.id });
  await assert.rejects(core.setups.start({ setupId: setup.id, cwd: directory }), /which is not in Settings/); assert.equal(core.store.sessions().length, 1, 'nothing was started on another account');
});
test('an OpenAI account keeps its organization and project with it', async t => {
  const { core } = await fixture(t);
  const account: any = await core.rpc('connections.save', { kind: 'openai', name: 'Org', organization: 'org-abc', project: 'proj_xyz' });
  assert.deepEqual([core.accountAccess('openai', account.id).route!().organization, core.accountAccess('openai', account.id).route!().project], ['org-abc', 'proj_xyz']);
  const row: any = (await core.rpc('connections.list', {}) as any[]).find(item => item.id === account.id); assert.equal(row.organization, 'org-abc'); assert.equal(row.project, 'proj_xyz');
  await assert.rejects(core.rpc('connections.save', { kind: 'openai', name: 'Bad', organization: 'x\r\nAuthorization: y' }), /organization ID/);
  await assert.rejects(core.rpc('connections.save', { kind: 'xai', name: 'Bad', project: 'proj_xyz' }), /project ID/);
  const cleared: any = await core.rpc('connections.save', { id: account.id, expectedRevision: account.revision, name: 'Org', organization: '', project: '' }); assert.equal(cleared.organization, undefined); assert.equal(cleared.revision, account.revision + 1);
});
