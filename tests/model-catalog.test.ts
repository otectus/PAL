import assert from 'node:assert/strict';
import test from 'node:test';
import { apiModels, type ApiAccess } from '../broker/api-providers.ts';
import { compactModels, freeModel, modelEndpoints, modelFacts, priceText, tokenCount } from '../broker/model-catalog.ts';
import type { ModelOption } from '../broker/types.ts';

const entry = (id: string, more: Record<string, unknown> = {}) => ({ id, name: 'Name of ' + id, description: 'What it is. '.repeat(80), context_length: 200_000, architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
  pricing: { prompt: '0.000003', completion: '0.000015', overrides: [{ prompt: '1' }] }, top_provider: { max_completion_tokens: 64_000 }, supported_parameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens'],
  endpoints: ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/messages', '/api/v1/responses'], expiration_date: null, ...more });
async function catalog(entries: any[], operation?: any) {
  const paths: string[] = [], access = { key: () => 'k', route: () => ({}), fetch: async (url: any) => { paths.push(String(url).replace('https://openrouter.ai/api/v1/', '')); return Response.json({ data: entries }); } } as unknown as ApiAccess;
  return { models: await apiModels('openrouter', access, operation), paths };
}

test('a catalog says its limits and prices in plain words', () => {
  assert.deepEqual([128, 8192, 131_072, 200_000, 999_999, 1_048_576, 2_097_152].map(tokenCount), ['128', '8K', '131K', '200K', '1M', '1M', '2.1M']);
  assert.equal(priceText({ prompt: '0.000003', completion: '0.000015' }), '$3 in, $15 out per 1M tokens');
  assert.equal(priceText({ prompt: '0.0000001', completion: '0.0000025' }), '$0.10 in, $2.50 out per 1M tokens');
  assert.equal(priceText({ prompt: '0.000000075', completion: '0.0000003' }), '$0.075 in, $0.30 out per 1M tokens');
  assert.equal(priceText({ prompt: '0.0000000012', completion: '0' }), '$0.0012 in per 1M tokens');
  assert.equal(priceText({ prompt: '0.00000002', completion: '0' }), '$0.02 in per 1M tokens', 'an embedding model makes no reply to pay for');
  assert.equal(priceText({ prompt: '0.000003', completion: '0.000015' }, 0.5), '$1.50 in, $7.50 out per 1M tokens');
  assert.equal(priceText({ prompt: '0', completion: '0' }), 'free'); assert.equal(freeModel({ prompt: '0', completion: '0', request: '0.01' }), false, 'a price for each request is a price');
  assert.equal(freeModel({}), false); assert.equal(freeModel(undefined), false); assert.equal(priceText(undefined), '');
  assert.equal(modelFacts({ contextLength: 200_000, pricing: { prompt: '0', completion: '0' }, inputModalities: ['text', 'image', 'audio', 'file', 'something new'], outputModalities: ['text', 'image'], expires: '2026-12-31' }), '200K context · free · reads images, audio and files · makes images · ends 2026-12-31');
  assert.equal(modelFacts({}), '');
});

test('OpenRouter offers for a conversation only what can hold one, with each model’s own efforts', async () => {
  const { models, paths } = await catalog([
    entry('anthropic/claude', { reasoning: { supported_efforts: ['max', 'high', 'none', 'made-up'] } }),
    entry('google/gemini:batch', { endpoints: ['/api/v1/batches'] }),
    entry('openai/painter', { architecture: { input_modalities: ['text'], output_modalities: ['image', 'text'] }, endpoints: ['/api/v1/chat/completions', '/api/v1/responses', '/api/v1/images'] }),
    entry('openrouter/auto', { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] }, pricing: { prompt: '-1', completion: '-1' } }),
    entry('small/plain:free', { supported_parameters: ['max_tokens', 'temperature'], pricing: { prompt: '0', completion: '0' }, expiration_date: '2026-12-31', context_length: 8192 }),
    entry('older/entry', { endpoints: undefined, supported_parameters: undefined, expiration_date: 'soon' }),
  ]);
  assert.deepEqual(paths, ['models']);
  assert.deepEqual(models.map(model => model.id), ['anthropic/claude', 'older/entry', 'openrouter/auto', 'small/plain:free']);
  const by = (id: string) => models.find(model => model.id === id)!;
  assert.deepEqual(by('anthropic/claude').efforts.map(effort => [effort.id, effort.displayName]), [['none', 'Off'], ['high', 'High'], ['max', 'Maximum']]);
  assert.equal(by('anthropic/claude').detail, '200K context · $3 in, $15 out per 1M tokens · reads images and files'); assert.equal(by('anthropic/claude').pricing?.overrides, undefined);
  assert.equal(by('anthropic/claude').description.length, 600); assert.equal(by('anthropic/claude').maxOutputTokens, 64_000);
  assert.deepEqual(by('small/plain:free').efforts, [], 'a model that does not reason is not asked to'); assert.equal(by('small/plain:free').free, true); assert.equal(by('small/plain:free').detail, '8K context · free · reads images and files · ends 2026-12-31');
  assert.ok(by('older/entry').efforts.length, 'an entry that does not say keeps the provider’s own choices'); assert.equal(by('older/entry').expires, undefined);
  assert.equal(by('openrouter/auto').pricing, undefined, 'a price that depends on the model it picks is not shown as one'); assert.doesNotMatch(by('openrouter/auto').detail!, /makes|\$/);
});

test('each kind of OpenRouter service has its own list', async () => {
  const spoken = entry('a/voice-one', { architecture: { input_modalities: ['text'], output_modalities: ['speech'] }, endpoints: ['/api/v1/audio/speech'], supported_parameters: [] });
  for (const [operation, path, row] of [['embed', 'models?output_modalities=embeddings', entry('a/vectors', { endpoints: ['/api/v1/embeddings'], supported_parameters: [] })], ['speech.synthesize', 'models?output_modalities=speech', spoken],
    ['speech.transcribe', 'models?output_modalities=transcription', entry('a/ears', { endpoints: ['/api/v1/audio/transcriptions'] })], ['image.generate', 'images/models', entry('a/brush', { endpoints: '/api/v1/images/models/a/brush/endpoints', supported_parameters: { size: {} } })]] as const) {
    const { models, paths } = await catalog([row], operation); assert.deepEqual(paths, [path]); assert.deepEqual(models.map(model => model.id), [row.id], operation);
    if (operation !== 'embed') assert.doesNotMatch(models[0].detail || '', /\$/, 'a price whose unit is not tokens is not given in tokens');
  }
  assert.deepEqual((await catalog([spoken], 'embed')).models, [], 'a list is not trusted to hold only its own kind');
});

test('who serves a model is asked for by its exact name and read with care', async () => {
  const asked: string[] = [], answer = (endpoints: any) => async (path: string) => { asked.push(path); return { data: { endpoints } }; };
  const served = await modelEndpoints('anthropic/claude-sonnet-5', answer([
    { provider_name: 'Anthropic', tag: 'anthropic', context_length: 1_000_000, max_completion_tokens: 128_000, pricing: { prompt: '0.000002', completion: '0.00001', discount: 0 }, quantization: 'unknown', status: 0, uptime_last_1d: 99.94, supported_parameters: ['tools', 7] },
    { provider_name: 'Elsewhere', tag: 'elsewhere/fp8; drop', context_length: 'big', pricing: { prompt: '0.000002', completion: '0.00001', discount: 0.25 }, quantization: 'fp8', status: -2, uptime_last_1d: null, supported_parameters: 'none' },
    { tag: 'nameless' }, null ]));
  assert.deepEqual(asked, ['models/anthropic/claude-sonnet-5/endpoints']);
  assert.deepEqual(served, [
    { provider: 'Anthropic', slug: 'anthropic', available: true, detail: '1M context · 128K reply · $2 in, $10 out per 1M tokens · 99.9% up in the last day', parameters: ['tools'] },
    { provider: 'Elsewhere', slug: '', available: false, detail: '$1.50 in, $7.50 out per 1M tokens · fp8', parameters: [] } ]);
  await modelEndpoints('~anthropic/claude-latest:free', answer([])); assert.equal(asked.at(-1), 'models/~anthropic/claude-latest%3Afree/endpoints');
  for (const bad of ['', 'plain', '../../keys', 'a/b/c', 'a/b?x=1', 'a/..%2f', 7, 'a/' + 'b'.repeat(300)]) await assert.rejects(modelEndpoints(bad, answer([])), /Choose a model/, String(bad));
  await assert.rejects(modelEndpoints('a/b', async () => ({ error: 'x' })), /did not say/);
});

test('a catalog fits one message to a phone', () => {
  const models = Array.from({ length: 900 }, (_, index): ModelOption => ({ id: `maker/model-${index}`, displayName: `Model ${index}`, description: 'x'.repeat(600), detail: '200K context', efforts: [], defaultEffort: '', isDefault: false, pricing: { prompt: '1' }, supportedParameters: ['tools'], inputModalities: ['text'], outputModalities: ['text'], contextLength: 200_000, capabilities: ['images'] }));
  const roomy = compactModels(models, 850_000); assert.equal(roomy.cut, false); assert.equal(roomy.items.length, 900); assert.equal(roomy.items[0].description.length, 400); assert.equal(roomy.items[0].detail, '200K context'); assert.ok(!('pricing' in roomy.items[0]) && !('supportedParameters' in roomy.items[0]));
  const tight = compactModels(models, 300_000); assert.equal(tight.items.length, 900); assert.equal(tight.items[0].description, '');
  const short = compactModels(models, 50_000); assert.equal(short.cut, true); assert.ok(short.items.length > 200 && short.items.length < 900); assert.ok(Buffer.byteLength(JSON.stringify(short.items)) <= 50_000); assert.equal(short.items[0].id, 'maker/model-0');
  assert.equal(models[0].description.length, 600, 'the desktop’s own list is not changed'); assert.deepEqual(compactModels([], 10), { items: [], cut: false });
});
