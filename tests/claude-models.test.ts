import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiAdapter, apiModels } from '../broker/api-providers.ts';
import { claudeRefusal, claudeRules, claudeVersion, withoutReasoning } from '../broker/claude-models.ts';
import { computerTool, computerToolName, frameResult } from '../broker/provider-computer.ts';
import { temporalGuidance } from '../broker/temporal-context.ts';
import type { OllamaMessage, OllamaTool } from '../broker/ollama.ts';
import type { RequestTime } from '../broker/temporal-context.ts';
import type { ApiProvider } from '../broker/provider-catalog.ts';
import type { Session } from '../broker/types.ts';

const tool: OllamaTool = { type: 'function', function: { name: 'check', description: 'Check a value', parameters: { type: 'object', properties: { value: { type: 'string' } } } } };
const sse = (events: any[]) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const block = (index: number, content_block: any, deltas: any[] = []) => [{ type: 'content_block_start', index, content_block }, ...deltas.map(delta => ({ type: 'content_block_delta', index, delta })), { type: 'content_block_stop', index }];
const thinking = (index: number, signature: string) => block(index, { type: 'thinking', thinking: '' }, [{ type: 'signature_delta', signature }]);
const text = (index: number, value: string) => block(index, { type: 'text', text: '' }, [{ type: 'text_delta', text: value }]);
const call = (index: number, id: string) => block(index, { type: 'tool_use', id, name: 'check', input: {} }, [{ type: 'input_json_delta', partial_json: '{"value":"yes"}' }]);
const stop = (reason: string) => [{ type: 'message_delta', delta: { stop_reason: reason } }, { type: 'message_stop' }];
const answer = (value: string, signature?: string) => [...(signature ? thinking(0, signature) : []), ...text(signature ? 1 : 0, value), ...stop('end_turn')];

async function fixture(t: any, p: { provider?: ApiProvider; model: string; options?: Record<string, unknown>; tools?: OllamaTool[] | (() => OllamaTool[]); modelOptions?: any; temporal?: () => RequestTime; route?: any; effort?: string; captureFiles?: any; call?: (name: string, args: any) => Promise<any>; personality?: () => string }, reply: (request: { url: string; init: any; body: any }, index: number) => Response) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-claude-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const output: any[] = [], requests: { url: string; init: any; body: any }[] = []; let history: OllamaMessage[] = [];
  const session = { id: 'claude-test', provider: p.provider || 'anthropic', nativeId: null, title: 'Test', cwd: tmpdir(), mode: 'managed', status: 'idle', created: 0, updated: 0, draft: '', scroll: 0, model: p.model, ...(p.effort ? { effort: p.effort } : {}), api: { tools: true, options: p.options || {} } } as unknown as Session;
  const adapter = new ApiAdapter(session, { token: 'test', native() {}, event: (e: any) => output.push(e), approve: async () => ({ choice: 'deny' }), personality: p.personality || (() => '') } as any, {
    load: () => structuredClone(history), save: (messages: OllamaMessage[]) => { history = structuredClone(messages); }, tools: () => typeof p.tools === 'function' ? p.tools() : p.tools ?? [tool],
    call: p.call || (async () => ({ ok: true })), options: () => p.modelOptions || {}, ...(p.temporal ? { temporal: p.temporal } : {}),
  } as any, { key: () => 'test-secret', route: () => p.route || {}, ...(p.captureFiles ? { captureFiles: p.captureFiles } : {}), retry: { maxRetries: 0 } as any, fetch: async (url, init) => { const request = { url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined }; requests.push(request); return reply(request, requests.length - 1); } });
  t.after(() => adapter.close());
  const send = async (message: string) => { await adapter.send(message); await adapter.task; };
  return { adapter, output, requests, send, history: () => history, last: () => output.at(-1) };
}
const signatures = (body: any) => body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'thinking').map((part: any) => part.signature) : []);

test('each Claude generation is asked only for what it takes', () => {
  assert.deepEqual(claudeVersion('claude-opus-5-5'), { family: 'opus', version: 5.5 });
  assert.deepEqual(claudeVersion('claude-sonnet-4-5-20250929'), { family: 'sonnet', version: 4.5 });
  assert.deepEqual(claudeVersion('claude-3-5-sonnet-20241022'), { family: 'sonnet', version: 3.5 });
  assert.deepEqual(claudeVersion('anthropic/claude-fable-5-2'), { family: 'fable', version: 5.2 });
  assert.equal(claudeVersion('some-proxy-model'), undefined);
  const row = (model: string) => { const r = claudeRules(model); return [r.thinking, r.budget, r.sampling, r.efforts.length, r.computer, r.bound, r.forcedTool]; };
  assert.deepEqual(row('claude-opus-5-5'), ['adaptive', false, false, 5, 'toolset', true, false]);
  assert.deepEqual(row('claude-fable-5-2'), row('claude-opus-5-5'));
  assert.deepEqual(row('claude-sonnet-5-5'), row('claude-opus-5-5'));
  assert.deepEqual(row('claude-haiku-5-5'), row('claude-opus-5-5'));
  assert.deepEqual(row('claude-opus-9'), row('claude-opus-5-5'), 'a newer model is treated like the newest known one');
  assert.deepEqual(row('claude-opus-5'), ['adaptive', false, false, 5, 'toolset', false, true]);
  assert.deepEqual(row('claude-sonnet-5'), ['adaptive', false, false, 5, 'computer_20251124', false, true]);
  assert.deepEqual(row('claude-opus-4-8'), ['adaptive', false, false, 5, 'computer_20251124', false, true]);
  assert.deepEqual(row('claude-sonnet-4-6'), ['adaptive', true, true, 4, 'computer_20251124', false, true]);
  assert.deepEqual(row('claude-opus-4-5-20251101'), ['budget', true, true, 3, 'computer_20251124', false, true]);
  assert.deepEqual(row('claude-haiku-4-5'), ['budget', true, true, 0, 'computer_20250124', false, true]);
  assert.deepEqual(row('some-proxy-model'), ['unknown', true, true, 3, 'computer_20251124', false, true], 'an unrecognized name is not refused anything');
});
test('what a model does not take is said before anything is sent', async t => {
  assert.match(claudeRefusal('claude-opus-5-5', { temperature: 0.4 })!, /does not take a temperature/);
  assert.match(claudeRefusal('claude-sonnet-5', { thinkingBudget: 4096 })!, /choose a reasoning effort/);
  assert.match(claudeRefusal('claude-haiku-4-5', { adaptiveThinking: true })!, /token budget/);
  assert.match(claudeRefusal('claude-opus-4-6', { adaptiveThinking: true, thinkingBudget: 2048 })!, /either/);
  assert.match(claudeRefusal('claude-haiku-4-5', { effort: 'high' })!, /does not take a reasoning effort/);
  assert.match(claudeRefusal('claude-opus-4-5', { effort: 'max' })!, /low, medium, high/);
  for (const [model, p] of [['claude-opus-4-6', { temperature: 0.4, thinkingBudget: 2048 }], ['claude-opus-5-5', { effort: 'max', adaptiveThinking: true }], ['some-proxy-model', { temperature: 1, effort: 'high' }]] as const) assert.equal(claudeRefusal(model, p as any), undefined, model);
  for (const p of [{ model: 'claude-opus-5-5', modelOptions: { temperature: 0.2 } }, { model: 'claude-opus-5-5', options: { thinkingBudget: 2048 } }]) {
    const f = await fixture(t, p as any, () => { throw new Error('nothing may be sent'); });
    await f.send('Hi'); assert.equal(f.requests.length, 0); assert.equal(f.last().type, 'error');
  }
  const adaptive = await fixture(t, { model: 'claude-opus-4-8', options: { adaptiveThinking: true }, effort: 'xhigh' }, () => sse(answer('Hi')));
  await adaptive.send('Hi'); assert.deepEqual(adaptive.requests[0].body.thinking, { type: 'adaptive' }); assert.deepEqual(adaptive.requests[0].body.output_config, { effort: 'xhigh' });
  // An effort saved with the options is used like one chosen for the conversation, which comes first.
  const saved = await fixture(t, { model: 'claude-opus-5-5', options: { reasoningEffort: 'max' } }, () => sse(answer('Hi'))); await saved.send('Hi'); assert.deepEqual(saved.requests[0].body.output_config, { effort: 'max' });
  const gemini = await fixture(t, { provider: 'google', model: 'gemini-4-hydrogen', options: { reasoningEffort: 'low' }, effort: 'high', tools: [] }, () => sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }])); await gemini.send('Hi'); assert.deepEqual(gemini.requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
});
test('the catalog’s own effort levels and image support decide, for every family', async () => {
  const levels = (...on: string[]) => ({ supported: on.length > 0, ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(id => [id, { supported: on.includes(id) }])) });
  const models = await apiModels('anthropic', { key: () => 'k', fetch: async () => Response.json({ data: [
    { id: 'claude-fable-5-2', display_name: 'Fable', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, effort: levels('low', 'medium', 'high', 'xhigh', 'max') } },
    { id: 'claude-text-only', display_name: 'Text', capabilities: { image_input: { supported: false }, effort: levels('low') } },
    { id: 'claude-haiku-4-5', display_name: 'Haiku' },
  ] }) });
  const of = (id: string) => models.find(model => model.id === id)!;
  assert.deepEqual(of('claude-fable-5-2').efforts!.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max']); assert.ok(of('claude-fable-5-2').capabilities!.includes('images'));
  assert.deepEqual(of('claude-text-only').efforts!.map(effort => effort.id), ['low']); assert.ok(of('claude-text-only').capabilities!.includes('no-images'));
  assert.deepEqual(of('claude-haiku-4-5').efforts, []);
});
test('reasoning goes back only where the request still fits it', async t => {
  let clock = 0;
  const temporal = (): RequestTime => { const sample = `<pal_time_context version="1">\nsample: ${++clock}\n</pal_time_context>`; return { get text() { return sample; }, minimal: false, snapshot: {} as any, detail: {} as any, refresh: () => undefined }; };
  const turn = (index: number) => index === 0 || index === 3 ? sse([...thinking(0, 'turn-' + index), ...call(1, 'call-' + index), ...stop('tool_use')]) : index === 1 ? sse([...thinking(0, 'turn-1'), ...call(1, 'call-1b'), ...stop('tool_use')]) : sse(answer('Done', 'turn-' + index));
  const bound = await fixture(t, { model: 'claude-opus-5-5', temporal }, (_request, index) => turn(index));
  await bound.send('First'); await bound.send('Second');
  const sent = bound.requests.map(request => signatures(request.body));
  assert.deepEqual(sent.slice(0, 3), [[], ['turn-0'], ['turn-0', 'turn-1']], 'within a turn the reasoning goes back');
  assert.deepEqual(sent[3], [], 'the next turn is built again, so no earlier reasoning fits it'); assert.deepEqual(sent[4], ['turn-3']);
  const clocks = bound.requests.map(request => /sample: (\d+)/.exec(request.body.system)![1]);
  assert.deepEqual([clocks[0], clocks[1], clocks[2]], ['1', '1', '1'], 'the turn keeps its first reading'); assert.notEqual(clocks[3], clocks[0]);
  // The stored history keeps everything, for a model that can read it.
  assert.deepEqual(signatures({ messages: bound.history().map(message => ({ content: message.providerData })) }), ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']);
  clock = 0;
  const free = await fixture(t, { model: 'claude-opus-4-8', temporal }, (_request, index) => turn(index));
  await free.send('First'); await free.send('Second');
  assert.deepEqual(signatures(free.requests[3].body), ['turn-0', 'turn-1', 'turn-2'], 'a model that does not bind reasoning keeps it');
  assert.notEqual(/sample: (\d+)/.exec(free.requests[0].body.system)![1], /sample: (\d+)/.exec(free.requests[1].body.system)![1], 'and reads the clock again for every request');
});
test('reasoning is left out from where the request before it changed within a turn', async t => {
  const second: OllamaTool = { type: 'function', function: { name: 'later', description: 'Offered later', parameters: { type: 'object', properties: {} } } };
  let offered = [tool];
  const f = await fixture(t, { model: 'claude-fable-5-2', tools: () => offered }, (_request, index) => {
    if (index === 1) offered = [tool, second];
    return index < 4 ? sse([...thinking(0, 'step-' + index), ...call(1, 'call-' + index), ...stop('tool_use')]) : sse(answer('Done', 'step-4'));
  });
  await f.send('Go');
  assert.deepEqual(f.requests.map(request => request.body.tools.length), [1, 1, 2, 2, 2]);
  assert.deepEqual(f.requests.map(request => signatures(request.body)), [[], ['step-0'], [], ['step-2'], ['step-2', 'step-3']], 'what was made before the change stays out, what was made after it goes back');
  assert.deepEqual(f.requests.at(-1)!.body.messages.flatMap((message: any) => message.content).filter((part: any) => part.type === 'tool_use').map((part: any) => part.id), ['call-0', 'call-1', 'call-2', 'call-3'], 'tool calls and their results always go back');
});
test('a refusal of bound reasoning is answered once without it, and only that refusal', async t => {
  const refusal = () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block.' } }, { status: 400 });
  // A model the rules do not know: its first refusal teaches what to do.
  const learned = await fixture(t, { model: 'some-proxy-model' }, (request, index) => index === 0 ? sse(answer('One', 'first')) : signatures(request.body).length ? refusal() : sse(answer('Again', 'next-' + index)));
  await learned.send('First'); await learned.send('Second'); await learned.send('Third');
  assert.equal(learned.output.filter(event => event.type === 'error').length, 0);
  assert.deepEqual(learned.requests.map(request => signatures(request.body).length), [0, 1, 0, 0], 'one refused request, one without reasoning, and none refused after that');
  const other = await fixture(t, { model: 'some-proxy-model' }, (_request, index) => index === 0 ? sse(answer('One', 'first')) : Response.json({ error: { message: 'max_tokens is too large' } }, { status: 400 }));
  await other.send('First'); await other.send('Second');
  assert.equal(other.requests.length, 2); assert.match(other.last().text, /HTTP 400/); assert.doesNotMatch(other.last().text, /max_tokens/, 'an error body is not shown');
  const stubborn = await fixture(t, { model: 'some-proxy-model' }, (_request, index) => index === 0 ? sse(answer('One', 'first')) : refusal());
  await stubborn.send('First'); await stubborn.send('Second');
  assert.equal(stubborn.requests.length, 3, 'never more than one answer to a refusal'); assert.equal(stubborn.last().type, 'error');
});
test('a paused turn of Claude’s own tools goes on as one reply', async t => {
  const accepted: string[] = [];
  const f = await fixture(t, { model: 'claude-opus-5-5', options: { webSearch: true, providerCode: true }, tools: [] }, (_request, index) => index === 0
    ? sse([{ type: 'message_start', message: { container: { id: 'container_1' } } }, ...text(0, 'Looking. '), ...block(1, { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: {} }, [{ type: 'input_json_delta', partial_json: '{"query":"pal"}' }]), ...block(2, { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [{ type: 'web_search_result', title: 'PAL', url: 'https://pal.example/', encrypted_content: 'x' }] }), ...block(3, { type: 'server_tool_use', id: 'srv-2', name: 'bash_code_execution', input: {} }, [{ type: 'input_json_delta', partial_json: '{"command":"python a.py"}' }]), ...stop('pause_turn')])
    : sse([...block(0, { type: 'bash_code_execution_tool_result', tool_use_id: 'srv-2', content: { type: 'bash_code_execution_result', stdout: '3', stderr: '', return_code: 0, content: [] } }), ...text(1, 'Found it.'), ...stop('end_turn')]));
  f.adapter.hooks.event = event => { f.output.push(event); };
  await f.adapter.send('Search', [], { onAccepted: () => accepted.push('accepted') } as any); await f.adapter.task;
  assert.equal(f.requests.length, 2); assert.equal(f.last().type, 'complete');
  const second = f.requests[1].body;
  assert.deepEqual(second.messages.at(-1).content.map((part: any) => part.type), ['text', 'server_tool_use', 'web_search_tool_result', 'server_tool_use'], 'the reply so far goes back as it was, with no message from anyone else');
  assert.equal(second.messages.at(-1).role, 'assistant'); assert.deepEqual(second.messages.at(-1).content[1].input, { query: 'pal' }); assert.equal(second.container, 'container_1'); assert.equal(f.requests[0].body.container, undefined);
  assert.equal(f.history().at(-1)!.content, 'Looking. Found it.');
  assert.deepEqual(f.history().at(-1)!.providerData!.map((part: any) => part.type), ['text', 'server_tool_use', 'web_search_tool_result', 'server_tool_use', 'bash_code_execution_tool_result', 'text']);
  assert.equal(f.output.filter(event => event.type === 'message').length, 1); assert.deepEqual(f.output.find(event => event.type === 'message').data.sources.map((source: any) => source.url), ['https://pal.example/']);
  const steps = f.output.filter(event => event.data?.hosted).map(event => event.text);
  assert.deepEqual(steps, ['Claude API · web search · pal · started', 'Claude API · web search · 1 results', 'Claude API · code · python a.py · started', 'Claude API · code · finished']);
  const endless = await fixture(t, { model: 'claude-opus-5-5', options: { webSearch: true }, tools: [] }, () => sse([...text(0, 'Still '), ...stop('pause_turn')]));
  await endless.send('Search'); assert.equal(endless.requests.length, 6); assert.match(endless.last().text, /paused its own tools too often/);
});
test('Claude’s hosted tools are declared as documented, and their files are handed over', async t => {
  const captured: any[] = [];
  const f = await fixture(t, { model: 'claude-sonnet-5-5', options: { webSearch: true, webFetch: true, providerCode: true }, tools: [], captureFiles: async (files: any) => { captured.push(files); return { files: [{ artifactId: 'a', versionId: 'v', name: 'chart.png' }], notes: ['One file was not kept (empty).'] }; } }, () => sse([
    ...block(0, { type: 'bash_code_execution_tool_result', tool_use_id: 's', content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 0, content: [{ type: 'bash_code_execution_output', file_id: 'file_1' }] } }), ...text(1, 'Made a chart.'), ...stop('end_turn')]));
  await f.send('Chart it');
  assert.deepEqual(f.requests[0].body.tools.map((entry: any) => entry.type), ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20260521']);
  const fetchTool = f.requests[0].body.tools[1];
  assert.deepEqual(fetchTool.url_sources, { client_tool_results: { type: 'none' } }, 'an address a local tool returned is never opened there'); assert.deepEqual(fetchTool.citations, { enabled: true });
  assert.deepEqual(captured, [[{ kind: 'anthropic', id: 'file_1' }]]);
  const saved = f.output.find(event => event.id?.endsWith('-hosted-files')); assert.equal(saved.text, 'Saved chart.png · One file was not kept (empty).'); assert.deepEqual(saved.data.artifacts, [{ artifactId: 'a', versionId: 'v', purpose: 'Claude API output' }]);
  const structured = await fixture(t, { model: 'claude-sonnet-5-5', options: { webFetch: true, outputSchema: '{"type":"object","properties":{"a":{"type":"string"}}}' }, tools: [] }, () => sse(answer('{}')));
  await structured.send('Hi'); assert.equal(structured.requests[0].body.tools[0].citations, undefined, 'citations and a reply schema cannot be asked for together');
  const plain = await fixture(t, { model: 'claude-sonnet-5-5', tools: [] }, () => sse(answer('Hi'))); await plain.send('Hi'); assert.equal(plain.requests[0].body.tools, undefined, 'nothing hosted unless chosen');
  const failing = await fixture(t, { model: 'claude-sonnet-5-5', options: { providerCode: true }, tools: [], captureFiles: async () => { throw new Error('network'); } }, () => sse([...block(0, { type: 'bash_code_execution_tool_result', tool_use_id: 's', content: { content: [{ file_id: 'file_2' }] } }), ...text(1, 'Made it.'), ...stop('end_turn')]));
  await failing.send('Go'); assert.equal(failing.last().type, 'complete', 'a reply is never lost with its files'); assert.match(failing.output.find(event => event.id?.endsWith('-hosted-files')).text, /could not be saved/);
});
test('the reviewed computer uses the tool its model accepts', async t => {
  const frame = { image: Buffer.from('png').toString('base64') };
  const step = (index: number, part: any) => block(index, { type: 'tool_use', input: {}, ...part });
  const f = await fixture(t, { model: 'claude-opus-5-5', options: { nativeComputer: true }, tools: [computerTool], call: async (name, args) => { assert.equal(name, computerToolName); if (args.items[0].action === 'type') throw new Error('The user declined desktop input'); return { shared: true, [frameResult]: frame }; } }, (_request, index) => index === 0
    ? sse([...step(0, { id: 'shot', name: 'screenshot', toolset_name: 'computer' }), ...stop('tool_use')]) : index === 1
    ? sse([...block(0, { type: 'tool_use', id: 'typed', name: 'type', toolset_name: 'computer', input: {} }, [{ type: 'input_json_delta', partial_json: '{"text":"hello"}' }]), ...stop('tool_use')]) : sse(answer('Done')));
  await f.send('Look');
  const declared = f.requests[0].body.tools[0];
  assert.equal(declared.type, 'computer_toolset_20260801'); assert.equal(declared.name, undefined); assert.equal(declared.display_width_px, undefined);
  assert.deepEqual(Object.entries(declared.configs).filter(([, value]: any) => value.enabled !== false), [], 'only withheld actions are named'); for (const name of ['zoom', 'scroll', 'left_click_drag', 'hold_key']) assert.deepEqual(declared.configs[name], { enabled: false });
  assert.deepEqual(f.requests[0].body.tool_choice, { type: 'auto', disable_parallel_tool_use: true }); assert.equal(f.requests[0].init.headers['anthropic-beta'], undefined);
  const result = f.requests[1].body.messages.at(-1).content[0]; assert.equal(result.toolset_name, 'computer'); assert.equal(result.is_error, undefined); assert.equal(result.content[0].type, 'image');
  const refused = f.requests[2].body.messages.at(-1).content[0]; assert.equal(refused.toolset_name, 'computer'); assert.equal(refused.is_error, true); assert.match(refused.content, /declined/);
  for (const [model, type, beta] of [['claude-opus-4-8', 'computer_20251124', 'computer-use-2025-11-24'], ['claude-haiku-4-5', 'computer_20250124', 'computer-use-2025-01-24']]) {
    const earlier = await fixture(t, { model, options: { nativeComputer: true }, tools: [computerTool] }, () => sse(answer('Hi'))); await earlier.send('Look');
    assert.deepEqual(earlier.requests[0].body.tools[0], { type, name: 'computer', display_width_px: 1024, display_height_px: 768 }); assert.equal(earlier.requests[0].init.headers['anthropic-beta'], beta); assert.equal(earlier.requests[0].body.tool_choice, undefined);
  }
});
test('prompt caching keeps the changing clock out of the reused text', async t => {
  let clock = 0; const temporal = (): RequestTime => ({ text: 'clock ' + ++clock, minimal: false, snapshot: {} as any, detail: {} as any, refresh: () => undefined });
  const f = await fixture(t, { model: 'claude-opus-4-8', options: { promptCaching: true }, temporal }, (_request, index) => index === 0 ? sse([...call(0, 'call-0'), ...stop('tool_use')]) : sse(answer('Done')));
  await f.send('Go');
  const [first, second] = f.requests.map(request => request.body);
  assert.deepEqual(first.cache_control, { type: 'ephemeral' }); assert.equal(first.system.length, 2); assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral' }); assert.equal(first.system[1].cache_control, undefined);
  assert.ok(!first.system[0].text.includes(temporalGuidance)); assert.ok(first.system[1].text.startsWith(temporalGuidance)); assert.match(first.system[1].text, /clock 1/);
  assert.deepEqual(second.system, first.system, 'the turn keeps its first reading, so the reused text stays the same');
  const off = await fixture(t, { model: 'claude-opus-4-8' }, () => sse(answer('Hi'))); await off.send('Hi'); assert.equal(typeof off.requests[0].body.system, 'string'); assert.equal(off.requests[0].body.cache_control, undefined);
});
test('a reply cut inside a hosted step does not send the step back without its result', async t => {
  const f = await fixture(t, { model: 'claude-opus-5-5', options: { webSearch: true }, tools: [] }, (_request, index) => index === 0 ? sse([...text(0, 'Looking'), ...block(1, { type: 'server_tool_use', id: 'srv-9', name: 'web_search', input: {} }), ...stop('model_context_window_exceeded')]) : sse(answer('Hi')));
  await f.send('Search'); assert.equal(f.last().type, 'complete'); assert.match(f.output.find(event => event.type === 'message').text, /output limit/);
  await f.send('Go on'); assert.doesNotMatch(JSON.stringify(f.requests[1].body.messages), /srv-9/);
});
test('reasoning can be taken out of a reply without touching the rest', () => {
  assert.deepEqual(withoutReasoning([{ type: 'thinking' }, { type: 'text', text: 'a' }, { type: 'redacted_thinking' }, { type: 'tool_use', id: 'x' }]), [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }]);
});

test('Gemini’s own tools run beside PAL’s only where the model allows it', async t => {
  const parts = (...value: any[]) => sse([{ candidates: [{ content: { role: 'model', parts: value }, finishReason: 'STOP' }] }]);
  const early = await fixture(t, { provider: 'google', model: 'gemini-2.5-pro', options: { urlContext: true } }, () => { throw new Error('nothing may be sent'); });
  await early.send('Hi'); assert.equal(early.requests.length, 0); assert.match(early.last().text, /cannot use Google’s own tools and PAL’s tools/);
  const alone = await fixture(t, { provider: 'google', model: 'gemini-2.5-pro', options: { webSearch: true, urlContext: true, providerCode: true }, tools: [] }, () => parts({ text: 'Hi' }));
  await alone.send('Hi'); assert.deepEqual(alone.requests[0].body.tools, [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }]); assert.equal(alone.requests[0].body.toolConfig, undefined);
  const captured: any[] = [], image = Buffer.from('not really a picture').toString('base64');
  const f = await fixture(t, { provider: 'google', model: 'gemini-4-hydrogen', options: { providerCode: true, urlContext: true }, captureFiles: async (files: any) => { captured.push(...files); return { files: [{ artifactId: 'a', versionId: 'v', name: 'gemini-figure-1.png' }], notes: [] }; } }, (_request, index) => index === 0
    ? sse([{ candidates: [{ content: { role: 'model', parts: [{ toolCall: { toolType: 'URL_CONTEXT', id: 't1' }, thoughtSignature: 'sig' }, { toolResponse: { id: 't1' } }, { functionCall: { id: 'f1', name: 'check', args: { value: 'yes' } }, thoughtSignature: 'sig-2' }] }, urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://pal.example/page', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }, { retrievedUrl: 'https://blocked.example/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_UNSAFE' }] }, finishReason: 'STOP' }] }])
    : parts({ executableCode: { language: 'PYTHON', code: 'print(1)' } }, { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } }, { inlineData: { mimeType: 'image/png', data: image } }, { text: 'One.' }));
  await f.send('Run it');
  assert.deepEqual(f.requests[0].body.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' }, includeServerSideToolInvocations: true });
  assert.deepEqual(f.requests[1].body.contents.at(-2).parts.slice(0, 2), [{ toolCall: { toolType: 'URL_CONTEXT', id: 't1' }, thoughtSignature: 'sig' }, { toolResponse: { id: 't1' } }], 'everything the model returned goes back as it was');
  const steps = f.output.filter(event => event.data?.hosted).map(event => event.text);
  assert.ok(steps.includes('Google Gemini · web page · read · https://pal.example/page')); assert.ok(steps.includes('Google Gemini · web page · not read · https://blocked.example/')); assert.ok(steps.some(step => step.startsWith('Google Gemini · code · started\nprint(1)'))); assert.ok(steps.some(step => step.startsWith('Google Gemini · code · finished\n1')));
  assert.deepEqual(captured, [{ kind: 'inline', mime: 'image/png', data: image }]);
});
test('an OpenAI account can name its organization and project, and files its code made are handed over', async t => {
  const captured: any[] = [];
  const f = await fixture(t, { provider: 'openai', model: 'gpt-5.2', options: { providerCode: true }, tools: [], route: { organization: 'org-work', project: 'proj_pal' }, captureFiles: async (files: any) => { captured.push(...files); return { files: [], notes: [] }; } }, () => sse([{ type: 'response.output_text.delta', delta: 'Done' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [{ type: 'container_file_citation', container_id: 'cntr_1', file_id: 'cfile_1', filename: 'table.csv' }] }] }] } }]));
  await f.send('Run it');
  assert.equal(f.requests[0].init.headers['OpenAI-Organization'], 'org-work'); assert.equal(f.requests[0].init.headers['OpenAI-Project'], 'proj_pal');
  assert.deepEqual(captured, [{ kind: 'openai', container: 'cntr_1', id: 'cfile_1', name: 'table.csv' }]);
  const plain = await fixture(t, { provider: 'xai', model: 'grok-5', tools: [], route: { organization: 'org-work' } }, () => sse([{ type: 'response.output_text.delta', delta: 'Hi' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }] } }]));
  await plain.send('Hi'); assert.equal(plain.requests[0].init.headers['OpenAI-Organization'], undefined);
});
