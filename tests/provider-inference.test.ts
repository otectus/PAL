import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderInferenceService, type ProviderInferenceAccount } from '../broker/provider-inference/service.ts';

function fixture(accounts: ProviderInferenceAccount[]) {
  const authorized: string[] = [], dispatched: string[] = [], sleeps: number[] = [];
  const service = new ProviderInferenceService({
    account: id => accounts.find(account => account.id === id),
    beforeDispatch: (_binding, operation) => authorized.push(operation),
    dispatched: (_binding, operation) => dispatched.push(operation),
    sleep: async milliseconds => { sleeps.push(milliseconds); },
  });
  return { service, authorized, dispatched, sleeps };
}
const binding = { connectionId: 'hf-account', connectionRevision: 3 };

test('Hugging Face non-chat tasks use the dedicated hf-inference route and account consent', async () => {
  let request: any;
  const f = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'hf_private', fetch: async (url, init) => {
    request = { url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) };
    return Response.json([{ label: 'POSITIVE', score: 0.99 }]);
  } }]);
  const result = await f.service.run({ ...binding, task: 'text-classification', model: 'org/sentiment', inputs: 'good', parameters: { top_k: 2, function_to_apply: 'softmax' } }, AbortSignal.timeout(1000));
  assert.equal(result.kind, 'json'); assert.equal(result.servingProvider, 'hf-inference');
  assert.equal(request.url, 'https://router.huggingface.co/hf-inference/models/org/sentiment'); assert.equal(request.headers.Authorization, 'Bearer hf_private');
  assert.deepEqual(request.body, { inputs: 'good', parameters: { top_k: 2, function_to_apply: 'softmax' } });
  assert.deepEqual(f.authorized, ['huggingface.text-classification']); assert.deepEqual(f.dispatched, f.authorized);
  assert.ok(!JSON.stringify(result).includes('hf_private'));
});

test('Hugging Face feature extraction validates batch shape, pooling, dimension and normalization', async () => {
  const f = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', fetch: async () => Response.json([[[3, 4], [0, 2]], [[6, 8], [2, 0]]]) }]);
  const result = await f.service.run({ ...binding, task: 'feature-extraction', model: 'org/embed', inputs: ['a', 'b'], pooling: 'mean', normalize: true }, AbortSignal.timeout(1000));
  assert.equal(result.kind, 'embeddings'); if (result.kind !== 'embeddings') return;
  assert.equal(result.dimension, 2); assert.equal(result.vectors.length, 2); assert.ok(Math.abs(Math.hypot(...result.vectors[0]) - 1) < 1e-12);
  await assert.rejects(f.service.run({ ...binding, task: 'feature-extraction', model: 'org/embed', inputs: 'a' }, AbortSignal.timeout(1000)), /Choose none, mean, or CLS pooling/);
});

test('Hugging Face preserves original binary inputs and validates task-specific parameters', async () => {
  let body: any;
  const f = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ text: 'hello' }); } }]);
  const result = await f.service.run({ ...binding, task: 'automatic-speech-recognition', model: 'org/asr', inputs: { mime: 'audio/flac', data: Buffer.from('original-audio') }, parameters: { return_timestamps: true } }, AbortSignal.timeout(1000));
  assert.equal(result.kind, 'json'); assert.equal(body.inputs, Buffer.from('original-audio').toString('base64'));
  await assert.rejects(f.service.run({ ...binding, task: 'automatic-speech-recognition', model: 'org/asr', inputs: 'not audio' }, AbortSignal.timeout(1000)), /requires original image or audio bytes/);
  await assert.rejects(f.service.run({ ...binding, task: 'text-classification', model: 'org/model', inputs: 'x', parameters: { temperature: 1 } }, AbortSignal.timeout(1000)), /does not support parameter/);
});

test('Hugging Face loading retries are bounded and gated/missing models are actionable', async () => {
  let calls = 0;
  const loading = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', fetch: async () => ++calls < 3 ? new Response('', { status: 503, headers: { 'retry-after': '1' } }) : Response.json([{ label: 'ok', score: 1 }]) }]);
  await loading.service.run({ ...binding, task: 'text-classification', model: 'org/model', inputs: 'x' }, AbortSignal.timeout(1000));
  assert.equal(calls, 3); assert.deepEqual(loading.sleeps, [1000, 1000]); assert.equal(loading.authorized.length, 3);
  for (const [status, message] of [[403, /gated/], [404, /not deployed/]] as const) {
    const f = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', fetch: async () => new Response('private detail', { status }) }]);
    await assert.rejects(f.service.run({ ...binding, task: 'text-classification', model: 'org/model', inputs: 'x' }, AbortSignal.timeout(1000)), message);
  }
});

test('Hugging Face dedicated endpoints are account-bound and arbitrary URLs are refused', async () => {
  let url = '';
  const good = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', baseUrl: 'https://private.us-east-1.endpoints.huggingface.cloud', fetch: async value => { url = String(value); return Response.json([{ label: 'ok', score: 1 }]); } }]);
  const result = await good.service.run({ ...binding, task: 'text-classification', model: 'org/model', inputs: 'x' }, AbortSignal.timeout(1000));
  assert.equal(result.servingProvider, 'dedicated-endpoint'); assert.equal(url, 'https://private.us-east-1.endpoints.huggingface.cloud');
  const bad = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', baseUrl: 'https://attacker.example/inference' }]);
  await assert.rejects(bad.service.run({ ...binding, task: 'text-classification', model: 'org/model', inputs: 'x' }, AbortSignal.timeout(1000)), /official router or dedicated endpoint/);
});

test('Mistral OCR sends original file bytes and returns page-linked provenance', async () => {
  const source = Buffer.from('%PDF-original'), captured: any[] = [];
  const f = fixture([{ id: 'mistral-account', revision: 7, provider: 'mistral', key: () => 'mistral-key', fetch: async (url, init) => {
    captured.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) });
    return Response.json({ model: 'mistral-ocr-4-0', pages: [{ index: 1, markdown: '# Page two', images: [], blocks: [{ type: 'heading' }] }, { index: 0, markdown: '# Page one', images: [{ id: 'img-0.jpeg', top_left_x: 1, top_left_y: 2, bottom_right_x: 3, bottom_right_y: 4 }], dimensions: { width: 100, height: 200 } }], usage_info: { pages_processed: 2, doc_size_bytes: source.length } });
  } }]);
  const result = await f.service.mistralOcr({ connectionId: 'mistral-account', connectionRevision: 7, file: { name: 'report.pdf', mime: 'application/pdf', bytes: source }, pages: '0-1', includeBlocks: true }, AbortSignal.timeout(1000));
  assert.equal(captured[0].url, 'https://api.mistral.ai/v1/ocr'); assert.equal(captured[0].headers.Authorization, 'Bearer mistral-key');
  assert.deepEqual(captured[0].body.document, { type: 'document_url', document_url: `data:application/pdf;base64,${source.toString('base64')}` });
  assert.deepEqual(result.pages.map(page => page.index), [0, 1]); assert.equal(result.source.originalFile, true); assert.equal(result.source.bytes, source.length); assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.pages[0].images[0].box, { left: 1, top: 2, right: 3, bottom: 4 }); assert.equal(result.usage.pagesProcessed, 2);
  assert.deepEqual(f.authorized, ['mistral.ocr']);
});

test('provider inference rejects stale account revisions before dispatch and decodes RPC bytes', async () => {
  let calls = 0;
  const f = fixture([{ id: 'hf-account', revision: 3, provider: 'huggingface', key: () => 'key', fetch: async () => { calls++; return Response.json({ text: 'ok' }); } }]);
  await assert.rejects(f.service.run({ connectionId: 'hf-account', connectionRevision: 2, task: 'text-classification', model: 'org/model', inputs: 'x' }, AbortSignal.timeout(1000)), /changed or is unavailable/);
  assert.equal(calls, 0);
  const result = await f.service.rpc({ method: 'providerInference.run', ...binding, task: 'automatic-speech-recognition', model: 'org/asr', inputs: { mime: 'audio/flac', base64: Buffer.from('sound').toString('base64') } }, AbortSignal.timeout(1000));
  assert.equal(result.kind, 'json'); assert.equal(calls, 1);
});

