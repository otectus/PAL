import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { ProviderCredentials } from '../broker/credentials.ts';
import type { ChatConnection } from '../broker/connections.ts';
import { MutationProposalBatchSchema, EXTRACTION_CANDIDATE_LIMIT } from '../broker/graph-memory/adapters/ollama.ts';
import { extractionProposals } from '../broker/graph-memory/proposals.ts';
import { bindingSchema, emptyCapabilities, type ResolvedTaskRoute, type StructuredTaskRequest, type TaskProviderAdapter } from '../broker/graph-memory/task-models.ts';
import { TaskConnectionResolver, TaskModelRouter, parseOneJsonObject } from '../broker/graph-memory/task-router.ts';
import { taskProviderAdapters } from '../broker/graph-memory/task-providers.ts';
import { apiJson } from '../broker/api-providers.ts';
import { HttpStatusError } from '../broker/http-retry.ts';

const outputSchema = z.object({ ok: z.literal(true) }).strict();
const jsonSchema = z.toJSONSchema(outputSchema) as Record<string, unknown>;
const request = (overrides: Partial<StructuredTaskRequest<{ ok: true }>> = {}): StructuredTaskRequest<{ ok: true }> => ({
  task: 'assess', sourcePolicy: 'local_only', schemaName: 'fixture', schema: outputSchema, jsonSchema,
  system: 'Return the fixture.', input: 'Synthetic input.', maxOutputTokens: 128, ...overrides,
});

test('task bindings preserve opaque manual model IDs and reject control characters', () => {
  assert.equal(bindingSchema.parse({ connectionRef: 'native:openai', modelId: 'vendor/model.v7', fallbackBindingRefs: [] }).modelId, 'vendor/model.v7');
  assert.throws(() => bindingSchema.parse({ connectionRef: 'native:openai', modelId: 'bad\nmodel' }));
  assert.throws(() => bindingSchema.parse({ connectionRef: 'native:unknown', modelId: 'model' }));
  assert.equal(bindingSchema.parse({ connectionRef: 'native:openai', modelId: 'm', fallbackBindingRefs: [] }).fallbackBindings?.length, 0);
  assert.throws(() => bindingSchema.parse({ connectionRef: 'native:openai', modelId: 'm', fallbackBindingRefs: ['old-ref'] }), /use fallbackBindings/);
  const repeated = { connectionRef: 'default:ollama', modelId: 'm' };
  assert.throws(() => bindingSchema.parse({ ...repeated, fallbackBindings: [{ connectionRef: 'connection:one', modelId: 'other', fallbackBindings: [repeated] }] }), /cycle or repeated/);
  const deep = { connectionRef: 'connection:four', modelId: '4' };
  assert.throws(() => bindingSchema.parse({ connectionRef: 'connection:zero', modelId: '0', fallbackBindings: [{ connectionRef: 'connection:one', modelId: '1', fallbackBindings: [{ connectionRef: 'connection:two', modelId: '2', fallbackBindings: [{ connectionRef: 'connection:three', modelId: '3', fallbackBindings: [deep] }] }] }] }), /3 levels/);
});

test('strict fallback parsing accepts one optional fence but no prose or trailing object', () => {
  assert.deepEqual(parseOneJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(parseOneJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseOneJsonObject('answer: {"ok":true}'));
  assert.throws(() => parseOneJsonObject('{"ok":true}{"ok":true}'));
});

test('router invokes the budget hook for each generation attempt and rejects a revision changed before apply', async () => {
  let connection: ChatConnection = { id: 'route', kind: 'compatible', name: 'Fixture', revision: 1, created: 1, updated: 1,
    compatible: { baseUrl: 'http://127.0.0.1:9999/v1', label: 'Fixture', requiresKey: false, tools: false, images: false, streaming: false, usage: false, contextLength: 0, maxOutputTokens: 0, processing: 'local' } };
  let calls = 0;
  const adapter: TaskProviderAdapter = { id: 'compatible', describe: () => emptyCapabilities({ completion: 'supported', outputModes: { json_schema: 'supported', tool: 'unsupported', json_object: 'supported', text_json: 'supported' } }),
    async generate(_route, _request, _mode, _repair, _signal, beforeNetworkAttempt) { await beforeNetworkAttempt(); calls++; return { text: calls === 1 ? '{"wrong":true}' : '{"ok":true}', finish: 'complete', model: 'fixture' }; } };
  const resolver = new TaskConnectionResolver({ credentials: { key: () => '', credentialRevision: () => 'credential-1' }, readConnection: () => connection, defaultOllamaHost: () => 'http://127.0.0.1:11434' });
  const router = new TaskModelRouter({ resolver, adapters: [adapter] }), attempts: any[] = [];
  const result = await router.generate({ connectionRef: 'connection:route', modelId: 'manual/model', fallbackBindingRefs: [] }, request({ beforeDispatch: async (route, estimated) => { attempts.push([route.attempt, route.outputMode, route.maxOutputTokens, estimated]); } }), new AbortController().signal);
  assert.deepEqual(result.value, { ok: true }); assert.equal(result.repaired, true); assert.equal(calls, 2); assert.deepEqual(attempts.map(row => row.slice(0, 3)), [[0, 'json_schema', 128], [1, 'json_schema', 128]]);
  assert.ok(attempts[0][3] > Math.ceil(('Return the fixture.'.length + 'Synthetic input.'.length) / 4), 'reservation includes schema and envelope bytes');
  connection = { ...connection, revision: 2 };
  await assert.rejects(router.recheck(result.route), /changed while this request/);
});

test('Ollama metadata reclassifies a loopback cloud alias before policy and budget hooks see private input', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const paths: string[] = [], dispatches: ResolvedTaskRoute[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path === '/api/tags') return Response.json({ models: [{ model: 'opaque:cloud', digest: 'a'.repeat(64), remote_host: 'https://ollama.com' }] });
    if (path === '/api/show') return Response.json({ capabilities: ['completion', 'thinking'], remote_host: 'https://ollama.com' });
    if (path === '/api/chat') { const body = JSON.parse(String(init.body)); assert.match(String(init.body), /private fixture/u); assert.equal(body.think, false); return Response.json({ model: 'opaque:cloud', done: true, done_reason: 'stop', message: { content: '{"ok":true}' } }); }
    throw new Error(`Unexpected ${path}`);
  };
  const resolver = new TaskConnectionResolver({ credentials: { key: () => '' }, readConnection: () => { throw new Error('unused'); }, defaultOllamaHost: () => 'http://127.0.0.1:11434' });
  const router = new TaskModelRouter({ resolver, adapters: taskProviderAdapters() }), binding = { connectionRef: 'default:ollama', modelId: 'opaque', fallbackBindingRefs: [] };
  await assert.rejects(router.generate(binding, request({ input: 'private fixture' }), new AbortController().signal), /Cloud memory model|Local-only/);
  assert.equal(paths.filter(path => path === '/api/chat').length, 0); assert.equal(dispatches.length, 0);
  const result = await router.generate(binding, request({ sourcePolicy: 'cloud_allowed', allowCloud: true, input: 'private fixture', beforeDispatch: async route => { dispatches.push(route); } }), new AbortController().signal);
  assert.deepEqual(result.value, { ok: true }); assert.equal(dispatches[0].processing, 'cloud'); assert.equal(dispatches[0].modelDigest, 'a'.repeat(64)); assert.equal(result.modelDigest,'a'.repeat(64));
});

test('a definitively rejected schema mode falls back on the same route, never another destination', async () => {
  const connection: ChatConnection = { id: 'route', kind: 'compatible', name: 'Fixture', revision: 1, created: 1, updated: 1,
    compatible: { baseUrl: 'http://127.0.0.1:9999/v1', label: 'Fixture', requiresKey: false, tools: false, images: false, streaming: false, usage: false, contextLength: 0, maxOutputTokens: 0, processing: 'local' } };
  const modes: string[] = [];
  const adapter: TaskProviderAdapter = { id: 'compatible', describe: () => emptyCapabilities({ completion: 'supported', outputModes: { json_schema: 'supported', tool: 'unsupported', json_object: 'supported', text_json: 'supported' } }),
    async generate(_route, _request, mode, _repair, _signal, beforeNetworkAttempt) { await beforeNetworkAttempt(); modes.push(mode); if (mode === 'json_schema') throw new HttpStatusError(400, 'Fixture (HTTP 400). rejected'); return { text: '{"ok":true}', finish: 'complete', model: 'fixture' }; } };
  const router = new TaskModelRouter({ resolver: new TaskConnectionResolver({ credentials: { key: () => '' }, readConnection: () => connection, defaultOllamaHost: () => '' }), adapters: [adapter] });
  const result = await router.generate({ connectionRef: 'connection:route', modelId: 'm', fallbackBindingRefs: [] }, request(), new AbortController().signal);
  assert.equal(result.outputMode, 'json_object'); assert.deepEqual(modes, ['json_schema', 'json_object']); assert.equal(result.route.connectionRef, 'connection:route');
});

test('ordered binding fallbacks recheck privacy and budget, require explicit cloud fallback consent, and never replay uncertain sends', async () => {
  const endpoint = (baseUrl: string, processing: 'local' | 'cloud'): ChatConnection['compatible'] => ({ baseUrl, label: processing, requiresKey: false, tools: false, images: false, streaming: false, usage: false, contextLength: 0, maxOutputTokens: 0, processing });
  const connections: Record<string, ChatConnection> = {
    local: { id: 'local', kind: 'compatible', name: 'Local', revision: 1, created: 1, updated: 1, compatible: endpoint('http://127.0.0.1:9000/v1', 'local') },
    cloud: { id: 'cloud', kind: 'compatible', name: 'Cloud', revision: 1, created: 1, updated: 1, compatible: endpoint('https://cloud.example/v1', 'cloud') },
  };
  const calls: string[] = [], budgets: string[] = [];
  let uncertain = false;
  const adapter: TaskProviderAdapter = { id: 'compatible', describe: () => emptyCapabilities({ completion: 'supported', outputModes: { json_schema: 'supported', tool: 'unsupported', json_object: 'supported', text_json: 'supported' } }),
    async generate(route, _request, _mode, _repair, _signal, beforeNetworkAttempt) { await beforeNetworkAttempt(); calls.push(route.connectionRef); if (route.connectionRef === 'connection:local') { if (uncertain) return { text: '', finish: 'output_limit', model: 'local' }; throw new HttpStatusError(404, 'Local model unavailable (HTTP 404)'); } return { text: '{"ok":true}', finish: 'complete', model: 'cloud' }; } };
  const router = new TaskModelRouter({ resolver: new TaskConnectionResolver({ credentials: { key: () => '' }, readConnection: id => connections[id], defaultOllamaHost: () => '' }), adapters: [adapter] });
  const cloud = { connectionRef: 'connection:cloud', modelId: 'cloud-model', allowCloudFallback: true };
  const binding = { connectionRef: 'connection:local', modelId: 'local-model', fallbackBindings: [cloud] };
  const result = await router.generate(binding, request({ sourcePolicy: 'cloud_allowed', allowCloud: true, beforeDispatch: async route => { budgets.push(route.connectionRef); } }), new AbortController().signal);
  assert.deepEqual(result.value, { ok: true }); assert.deepEqual(calls, ['connection:local', 'connection:cloud']); assert.deepEqual(budgets, calls);
  calls.length = 0; budgets.length = 0;
  await assert.rejects(router.generate({ ...binding, fallbackBindings: [{ ...cloud, allowCloudFallback: false }] }, request({ sourcePolicy: 'cloud_allowed', allowCloud: true }), new AbortController().signal), /Local model unavailable/);
  assert.deepEqual(calls, ['connection:local'], 'unauthorized cloud fallback is never dispatched');
  uncertain = true; calls.length = 0;
  await assert.rejects(router.generate(binding, request({ sourcePolicy: 'cloud_allowed', allowCloud: true }), new AbortController().signal), /output_limit/);
  assert.deepEqual(calls, ['connection:local'], 'a request with an uncertain/partial outcome is never replayed on a fallback');
});

test('unsupported options and remote URLs declared local fail before model dispatch', async () => {
  const remote: ChatConnection = { id: 'remote', kind: 'compatible', name: 'Remote', revision: 1, created: 1, updated: 1,
    compatible: { baseUrl: 'https://remote.example/v1', label: 'Remote', requiresKey: false, tools: false, images: false, streaming: false, usage: false, contextLength: 0, maxOutputTokens: 0, processing: 'local' } };
  let dispatched = false;
  const adapter: TaskProviderAdapter = { id: 'compatible', describe: () => emptyCapabilities({ completion: 'supported' }), async generate() { dispatched = true; return { text: '{"ok":true}', finish: 'complete', model: 'm' }; } };
  const router = new TaskModelRouter({ resolver: new TaskConnectionResolver({ credentials: { key: () => '' }, readConnection: () => remote, defaultOllamaHost: () => '' }), adapters: [adapter] });
  assert.equal(router.resolve({ connectionRef: 'connection:remote', modelId: 'm' }).processing, 'unknown');
  await assert.rejects(router.generate({ connectionRef: 'connection:remote', modelId: 'm' }, request(), new AbortController().signal), /Local-only|Declare where/);
  await assert.rejects(router.generate({ connectionRef: 'connection:remote', modelId: 'm', optionsProfile: 'fast' }, request({ sourcePolicy: 'cloud_allowed' }), new AbortController().signal), /does not support options profile/);
  assert.equal(dispatched, false);
});

test('native and compatible provider adapters use documented envelopes and parse only final answer content', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const matrix = [
    { id: 'openai', endpoint: 'https://api.openai.com/v1', path: '/v1/responses', response: { status: 'completed', model: 'openai-returned', output: [{ type: 'reasoning', summary: [{ text: '{"wrong":true}' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }] } },
    { id: 'anthropic', endpoint: 'https://api.anthropic.com/v1', path: '/v1/messages', response: { stop_reason: 'end_turn', model: 'claude-returned', content: [{ type: 'thinking', thinking: '{"wrong":true}' }, { type: 'text', text: '{"ok":true}' }] } },
    { id: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta', path: '/v1beta/models/manual%2Fmodel:generateContent', response: { modelVersion: 'gemini-returned', candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '{"wrong":true}' }, { text: '{"ok":true}' }] } }] } },
    { id: 'compatible', endpoint: 'https://gateway.example/v1', path: '/v1/chat/completions', response: { model: 'gateway-returned', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', reasoning_content: '{"wrong":true}' } }] } },
  ] as const;
  for (const fixture of matrix) {
    let body: any;
    globalThis.fetch = async (input, init = {}) => { assert.equal(new URL(String(input)).pathname, fixture.path); body = JSON.parse(String(init.body)); return Response.json(fixture.response); };
    const adapter = taskProviderAdapters().find(value => value.id === fixture.id)!;
    const route: any = { connectionRef: `native:${fixture.id}`, connectionRevision: 1, credentialRef: 'ref', credentialRevision: 'rev', adapterId: fixture.id,
      endpoint: fixture.endpoint, modelId: 'manual/model', processing: fixture.id === 'compatible' ? 'local' : 'cloud', capabilities: adapter.describe({ processing: 'cloud' }), fingerprint: 'f', key: () => 'secret', ...(fixture.id === 'compatible' ? { dialect: 'chat_completions' } : {}) };
    const result = await adapter.generate(route, request({ sourcePolicy: 'cloud_allowed', allowCloud: true }) as StructuredTaskRequest<unknown>, 'json_schema', false, new AbortController().signal, async () => {});
    assert.equal(result.text, '{"ok":true}'); assert.equal(result.finish, 'complete');
    if (fixture.id === 'openai') assert.equal(body.text.format.type, 'json_schema');
    if (fixture.id === 'anthropic') assert.equal(body.output_config.format.type, 'json_schema');
    if (fixture.id === 'google') assert.deepEqual(body.generationConfig.responseJsonSchema, jsonSchema);
    if (fixture.id === 'compatible') assert.equal(body.response_format.type, 'json_schema');
  }
});

test('bounded background API transport reauthorizes every HTTP retry attempt', async () => {
  let requests = 0, authorizations = 0;
  const result = await apiJson('openai', { key: () => 'secret', retry: { sleep: async () => {}, log: () => {} }, fetch: async () => ++requests === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true }) },
    'responses', { synthetic: true }, new AbortController().signal, {}, 1024, async () => { authorizations++; });
  assert.deepEqual(result, { ok: true }); assert.equal(requests, 2); assert.equal(authorizations, 2);
});

test('Anthropic schema-bearing tool mode is data-only and parses only the named tool input', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let body: any;
  globalThis.fetch = async (_input, init = {}) => { body = JSON.parse(String(init.body)); return Response.json({ model: 'claude-fixture', stop_reason: 'tool_use', content: [
    { type: 'text', text: '{"wrong":true}' }, { type: 'tool_use', name: 'submit_memory_task', input: { ok: true } },
  ] }); };
  const adapter = taskProviderAdapters().find(value => value.id === 'anthropic')!, route: any = { connectionRef: 'native:anthropic', connectionRevision: 1, credentialRef: 'provider:anthropic', credentialRevision: 'r', adapterId: 'anthropic', endpoint: 'https://api.anthropic.com/v1', modelId: 'claude-fixture', processing: 'cloud', capabilities: adapter.describe({ processing: 'cloud' }), fingerprint: 'f', key: () => 'secret' };
  const result = await adapter.generate(route, request({ sourcePolicy: 'cloud_allowed', allowCloud: true }) as StructuredTaskRequest<unknown>, 'tool', false, new AbortController().signal, async () => {});
  assert.equal(result.text, '{"ok":true}'); assert.equal(result.finish, 'complete'); assert.equal(body.tools[0].name, 'submit_memory_task'); assert.equal(body.tools[0].strict, true);
});

test('connection-scoped credentials support separate same-origin accounts and opaque rotation revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-task-credentials-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = new ProviderCredentials(directory), origin = 'https://gateway.example';
  credentials.update('compatible', 'account-one', origin, 'connection:one');
  credentials.update('compatible', 'account-two', origin, 'connection:two');
  const firstRevision = credentials.credentialRevision('connection:one');
  assert.equal(credentials.key('compatible', origin, 'connection:one'), 'account-one'); assert.equal(credentials.key('compatible', origin, 'connection:two'), 'account-two');
  credentials.update('compatible', 'rotated-one', origin, 'connection:one');
  assert.notEqual(credentials.credentialRevision('connection:one'), firstRevision); assert.equal(credentials.key('compatible', origin, 'connection:one'), 'rotated-one');
  const file = await readFile(join(directory, 'provider-credentials.json'), 'utf8'); assert.ok(file.includes('rotated-one')); assert.ok(!file.includes(firstRevision), 'old opaque revision is replaced with the old secret');
});

test('a legacy compatible key is available only to its migrated origin and connection account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cere-legacy-credentials-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = new ProviderCredentials(directory), origin = 'https://gateway.example';
  credentials.update('compatible', 'legacy-key', origin); credentials.bindLegacyCompatible('connection:original', origin);
  assert.equal(credentials.key('compatible', origin, 'connection:original'), 'legacy-key');
  assert.equal(credentials.key('compatible', origin, 'connection:other-account'), '');
  assert.equal(credentials.key('compatible', 'https://different.example', 'connection:original'), '');
});

test('extraction statements and hints round-trip and assertions plus statements share the 32-candidate cap', () => {
  const assertion = { subjectRef: 'user', predicate: 'PREFERS_TOOL', object: { entityRef: 'tool' }, qualifiers: {}, polarity: 'positive' as const, modality: 'actual' as const,
    epistemicType: 'explicit_user' as const, operation: 'asserts' as const, temporal: { expression: null, interpretation: null, uncertain: false },
    quotes: [{ sourceRecordId: 'source', quote: 'Use Ruff.', occurrenceIndex: 0 }], durabilityHint: 0.8, importanceHint: 0.7 };
  const batch = { entities: [{ temporaryRef: 'user', kind: 'USER', aliases: ['User'] }, { temporaryRef: 'tool', kind: 'TOOL', aliases: ['Ruff'] }], assertions: [assertion],
    statements: [{ category: 'project_convention' as const, modality: 'actual' as const, quote: { sourceRecordId: 'source', quote: 'Use Ruff.', occurrenceIndex: 0 } }] };
  assert.equal(MutationProposalBatchSchema.parse(batch).statements?.length, 1);
  const rows = extractionProposals({ proposals: batch, model: 'm', modelDigest: 'd', endpointClass: 'local', promptVersion: 'p', schemaVersion: 1, parserVersion: 'v' }, 'source');
  assert.deepEqual(rows[0].extractor_hints, { importance: 0.7, durability: 0.8 }); assert.deepEqual(rows[1].statement, { category: 'project_convention', modality: 'actual' });
  assert.equal(EXTRACTION_CANDIDATE_LIMIT, 32);
  assert.equal(MutationProposalBatchSchema.safeParse({ ...batch, assertions: Array(32).fill(assertion), statements: batch.statements }).success, false);
});
