import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { whisperModels } from '../broker/model-choices.ts';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-choices-')), core = new Core(new Store(directory), () => ({ send: async () => {}, interrupt: async () => {}, close: async () => {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  return { core, directory };
}
async function service(t: any, answer: (path: string, count: number) => { status?: number; body: unknown }) {
  const seen: string[] = [];
  const server = createServer((request, response) => { seen.push(request.url!); const { status = 200, body } = answer(request.url!, seen.length); response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const ids = (result: any) => result.models.map((model: any) => model.id);
const choices = (core: Core, params: any): Promise<any> => core.rpc('models.choices', params) as Promise<any>;

test('a list is the account’s own, sorted by use, and is asked for once until it is refreshed', async t => {
  const { core } = await fixture(t), open = await service(t, () => ({ body: { data: [{ id: 'chat-a' }, { id: 'text-embed-b' }, { id: 'whisper-c' }] } }));
  const account: any = await core.rpc('connections.save', { kind: 'compatible', name: 'Lab', endpoint: { baseUrl: open.url + '/v1', requiresKey: false, processing: 'local' } });
  assert.deepEqual(ids(await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed', known: true })), [], 'known only: nothing is asked');
  assert.equal(open.seen.length, 0);
  const first = await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed' });
  assert.deepEqual(ids(first), ['text-embed-b']); assert.equal(first.live, true); assert.equal(first.problem, undefined);
  await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed' });
  assert.deepEqual(ids(await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed', known: true })), ['text-embed-b']);
  assert.equal(open.seen.length, 1, 'kept');
  assert.deepEqual(ids(await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'speech.transcribe' })), ['whisper-c'], 'another use is another list');
  await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed', refresh: true });
  assert.equal(open.seen.length, 3);
  // A changed account is not served the old list.
  await core.rpc('connections.save', { id: account.id, kind: 'compatible', name: 'Lab 2', endpoint: { baseUrl: open.url + '/v1', requiresKey: false, processing: 'local' }, expectedRevision: account.revision });
  await choices(core, { provider: 'compatible', connectionId: account.id, operation: 'embed' });
  assert.equal(open.seen.length, 4);
});

test('a list that cannot be loaded is reported beside what PAL names itself, and is not kept', async t => {
  const { core } = await fixture(t);
  const speech = await choices(core, { provider: 'openai', operation: 'speech.synthesize' });
  assert.equal(speech.live, false); assert.match(speech.problem, /key/i); assert.deepEqual(ids(speech), ['gpt-4o-mini-tts']);
  assert.ok(ids(await choices(core, { provider: 'xai', operation: 'image.generate' })).includes('grok-imagine-image-2.0'));
  let working = false;
  const flaky = await service(t, () => working ? { body: { data: [{ id: 'chat-a' }] } } : { status: 403, body: { error: {} } });
  const account: any = await core.rpc('connections.save', { kind: 'compatible', name: 'Flaky', endpoint: { baseUrl: flaky.url + '/v1', requiresKey: false, processing: 'local' } });
  const failed = await choices(core, { provider: 'compatible', connectionId: account.id });
  assert.equal(failed.live, false); assert.ok(failed.problem); assert.deepEqual(ids(failed), []);
  working = true;
  assert.deepEqual(ids(await choices(core, { provider: 'compatible', connectionId: account.id })), ['chat-a']);
});

test('services without a catalog offer their documented models; others are refused', async t => {
  const { core } = await fixture(t);
  assert.ok(ids(await choices(core, { provider: 'voyage', operation: 'rerank' })).includes('rerank-3'));
  assert.ok(ids(await choices(core, { provider: 'voyage', operation: 'embed' })).includes('voyage-4'));
  assert.ok(ids(await choices(core, { provider: 'mistral', operation: 'ocr' })).includes('mistral-ocr-latest'));
  for (const bad of [{ provider: 'voyage', operation: 'chat' }, { provider: 'nobody' }, { provider: 'huggingface', operation: 'inference' }, { provider: 'openai', operation: 'nothing' }, { provider: 'jev', operation: 'chat' }])
    await assert.rejects(choices(core, bad));
  const other: any = await core.rpc('connections.save', { kind: 'compatible', name: 'Lab', endpoint: { baseUrl: 'http://127.0.0.1:9/v1', requiresKey: false, processing: 'local' } });
  await assert.rejects(choices(core, { provider: 'mistral', connectionId: other.id, operation: 'ocr' }), /account of this provider/);
});

test('Hugging Face tasks list public models, naming only the task', async t => {
  const { core } = await fixture(t), asked: string[] = [];
  core.modelChoices.fetch = (async (url: any, init: any) => { asked.push(String(url)); assert.equal(init.headers, undefined); return Response.json([{ id: 'google/vit-base', downloads: 1200 }, { id: '../x' }, { id: 5 }]); }) as any;
  const result = await choices(core, { provider: 'huggingface', operation: 'inference', task: 'image-classification' });
  assert.deepEqual(ids(result), ['google/vit-base']); assert.equal(result.models[0].detail, '1,200 downloads a month');
  assert.equal(new URL(asked[0]).searchParams.get('pipeline_tag'), 'image-classification');
});

test('local embeddings, a speech server here and whisper.cpp files are listed from this computer', async t => {
  const { core, directory } = await fixture(t);
  const ollama = await service(t, path => path === '/api/tags' ? { body: { models: [{ model: 'nomic-embed-text:latest', capabilities: ['embedding'], details: {}, model_info: { 'general.architecture': 'n', 'n.context_length': 2048 } }, { model: 'chat:latest', capabilities: ['completion'], details: {}, model_info: { 'general.architecture': 'n', 'n.context_length': 2048 } }] } } : { body: {} });
  await core.updateSettings({ ollama: { host: ollama.url } });
  assert.deepEqual(ids(await choices(core, { provider: 'ollama', operation: 'embed' })), ['nomic-embed-text:latest'], 'what is installed is not suggested again');
  const speech = await service(t, () => ({ body: { data: [{ id: 'large-v3' }, { id: 7 }] } }));
  assert.deepEqual(ids(await choices(core, { provider: 'local-server', operation: 'speech.transcribe', url: speech.url + '/v1' })), ['large-v3']);
  assert.deepEqual(ids(await choices(core, { provider: 'local-server', operation: 'speech.transcribe', url: speech.url })), [], 'whisper-server has one model and no list');
  assert.match((await choices(core, { provider: 'local-server', operation: 'speech.transcribe', url: 'https://example.com/v1' })).problem, /this computer/);
  const folder = join(directory, 'home/.cache/whisper'), chosen = join(directory, 'models'), shared = join(directory, 'share'); await mkdir(folder, { recursive: true }); await mkdir(chosen); await mkdir(join(shared, 'whisper.cpp-model-base'), { recursive: true });
  for (const path of [join(folder, 'ggml-small.bin'), join(folder, 'notes.txt'), join(chosen, 'ggml-large-v3.bin'), join(shared, 'whisper.cpp-model-base/ggml-base.bin')]) await writeFile(path, 'x');
  const found = await whisperModels(join(chosen, 'ggml-large-v3.bin'), join(directory, 'home'), join(directory, 'none'), shared);
  assert.deepEqual(found.map(model => model.displayName).sort(), ['base', 'large-v3', 'small']); assert.equal(found[0].id, join(chosen, 'ggml-large-v3.bin'));
});
