import { apiJson, type ApiAccess } from '../api-providers.ts';
import type { CompatibleEndpoint } from '../types.ts';
import { isCloudModel } from '../ollama.ts';
import { emptyCapabilities, type ProviderTaskResponse, type ResolvedTaskRoute, type StructuredTaskRequest, type TaskModelCapabilities, type TaskOutputMode, type TaskProviderAdapter } from './task-models.ts';

type DispatchRoute = ResolvedTaskRoute & { key(): string; dialect?: 'chat_completions' | 'responses'; runtimeModelId?: string };

function capabilities(outputModes: Partial<TaskModelCapabilities['outputModes']>, catalog: TaskModelCapabilities['catalog'] = 'supported'): TaskModelCapabilities {
  return emptyCapabilities({ completion: 'supported', catalog, outputModes: { json_schema: 'unknown', tool: 'unsupported', json_object: 'unknown', text_json: 'supported', ...outputModes } });
}

function finish(value: unknown): ProviderTaskResponse['finish'] {
  const reason = String(value ?? '').toLowerCase();
  if (['stop', 'end_turn', 'completed'].includes(reason)) return 'complete';
  if (['length', 'max_tokens', 'max_output_tokens', 'incomplete'].includes(reason)) return 'output_limit';
  if (['content_filter', 'safety', 'blocked'].includes(reason)) return 'content_filter';
  if (reason === 'refusal') return 'refusal';
  return 'transport_error';
}

function apiAccess(route: DispatchRoute): ApiAccess {
  if (route.adapterId !== 'compatible') return { key: route.key };
  const endpoint: CompatibleEndpoint = { baseUrl: route.endpoint, label: 'Memory task endpoint', requiresKey: !!route.key(), tools: false, images: false, streaming: false, usage: false, contextLength: 0, maxOutputTokens: 0, processing: route.processing };
  return { key: route.key, endpoint: () => endpoint };
}

function repairInput(request: StructuredTaskRequest<unknown>, repair: boolean) {
  return repair ? `${request.input}\n\nThe previous response failed local validation (INVALID_JSON_OR_SCHEMA). Return one fresh JSON object matching the requested schema.` : request.input;
}

function systemContent(request: StructuredTaskRequest<unknown>, mode: TaskOutputMode) {
  if (mode === 'json_schema' || mode === 'tool') return request.system;
  return `${request.system}\nReturn exactly one JSON object matching this schema. Do not use Markdown or add prose.\nOutput JSON schema: ${JSON.stringify(request.jsonSchema)}`;
}

function openAiBody(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean) {
  const format = mode === 'json_schema' ? { type: 'json_schema', name: request.schemaName, strict: true, schema: request.jsonSchema }
    : mode === 'json_object' ? { type: 'json_object' } : { type: 'text' };
  return { model: route.runtimeModelId ?? route.modelId, instructions: systemContent(request, mode), input: repairInput(request, repair), text: { format }, max_output_tokens: request.maxOutputTokens, store: false };
}

function parseOpenAi(result: any, fallbackModel: string): ProviderTaskResponse {
  if (result.status !== 'completed') return { text: '', finish: result.status === 'incomplete' ? finish(result.incomplete_details?.reason || 'incomplete') : 'transport_error', model: result.model || fallbackModel };
  const content = (Array.isArray(result.output) ? result.output : []).filter((item: any) => item?.type === 'message' && item.role === 'assistant').flatMap((item: any) => Array.isArray(item.content) ? item.content : []);
  if (content.some((item: any) => item?.type === 'refusal')) return { text: '', finish: 'refusal', model: result.model || fallbackModel };
  const text = content.filter((item: any) => item?.type === 'output_text').map((item: any) => String(item.text ?? '')).join('');
  return { text, finish: text ? 'complete' : 'transport_error', model: result.model || fallbackModel,
    usage: { inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens } };
}

class OpenAiTaskAdapter implements TaskProviderAdapter {
  readonly id = 'openai';
  describe() { return capabilities({ json_schema: 'supported', json_object: 'supported' }); }
  async generate(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>) {
    return parseOpenAi(await apiJson('openai', apiAccess(route), 'responses', openAiBody(route, request, mode, repair), signal, {}, 2 * 1024 * 1024, beforeNetworkAttempt), route.modelId);
  }
}

class AnthropicTaskAdapter implements TaskProviderAdapter {
  readonly id = 'anthropic';
  describe() { return capabilities({ json_schema: 'supported', tool: 'supported', json_object: 'unknown' }); }
  async generate(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>): Promise<ProviderTaskResponse> {
    const body: any = { model: route.runtimeModelId ?? route.modelId, max_tokens: request.maxOutputTokens, system: systemContent(request, mode), messages: [{ role: 'user', content: repairInput(request, repair) }] };
    if (mode === 'json_schema') body.output_config = { format: { type: 'json_schema', schema: request.jsonSchema } };
    else if (mode === 'tool') Object.assign(body, { tools: [{ name: 'submit_memory_task', description: 'Return the requested structured data.', input_schema: request.jsonSchema, strict: true }], tool_choice: { type: 'tool', name: 'submit_memory_task', disable_parallel_tool_use: true } });
    const result = await apiJson('anthropic', apiAccess(route), 'messages', body, signal, {}, 2 * 1024 * 1024, beforeNetworkAttempt);
    const content = Array.isArray(result.content) ? result.content : [];
    const tool = mode === 'tool' ? content.find((part: any) => part?.type === 'tool_use' && part.name === 'submit_memory_task') : undefined;
    const state = tool && result.stop_reason === 'tool_use' ? 'complete' : finish(result.stop_reason);
    const text = tool ? JSON.stringify(tool.input) : content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('');
    return { text, finish: state, model: result.model || route.modelId, usage: { inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens } };
  }
}

class GoogleTaskAdapter implements TaskProviderAdapter {
  readonly id = 'google';
  describe() { return capabilities({ json_schema: 'supported', json_object: 'supported' }); }
  async generate(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>): Promise<ProviderTaskResponse> {
    const generationConfig: any = { maxOutputTokens: request.maxOutputTokens };
    if (mode === 'json_schema') Object.assign(generationConfig, { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema });
    else if (mode === 'json_object') generationConfig.responseMimeType = 'application/json';
    const id = encodeURIComponent(route.modelId.replace(/^models\//u, ''));
    const result = await apiJson('google', apiAccess(route), `models/${id}:generateContent`, {
      systemInstruction: { parts: [{ text: systemContent(request, mode) }] }, contents: [{ role: 'user', parts: [{ text: repairInput(request, repair) }] }], generationConfig,
    }, signal, {}, 2 * 1024 * 1024, beforeNetworkAttempt);
    const candidate = result.candidates?.[0], reason = candidate?.finishReason;
    const text = (candidate?.content?.parts ?? []).filter((part: any) => !part?.thought && typeof part?.text === 'string').map((part: any) => part.text).join('');
    const state = reason === 'STOP' ? 'complete' : reason === 'MAX_TOKENS' ? 'output_limit' : ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(reason) ? 'content_filter' : 'transport_error';
    return { text, finish: state, model: result.modelVersion || route.modelId, modelVersion: result.modelVersion,
      usage: { inputTokens: result.usageMetadata?.promptTokenCount, outputTokens: result.usageMetadata?.candidatesTokenCount } };
  }
}

function parseCompatibleChat(result: any, fallbackModel: string): ProviderTaskResponse {
  const choice = result.choices?.[0], message = choice?.message;
  if (message?.refusal) return { text: '', finish: 'refusal', model: result.model || fallbackModel };
  return { text: typeof message?.content === 'string' ? message.content : '', finish: finish(choice?.finish_reason), model: result.model || fallbackModel,
    usage: { inputTokens: result.usage?.prompt_tokens, outputTokens: result.usage?.completion_tokens } };
}

class CompatibleTaskAdapter implements TaskProviderAdapter {
  readonly id = 'compatible';
  describe() { return capabilities({ json_schema: 'unknown', json_object: 'unknown' }, 'unknown'); }
  async generate(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>): Promise<ProviderTaskResponse> {
    if (route.dialect === 'responses') return parseOpenAi(await apiJson('compatible', apiAccess(route), 'responses', openAiBody(route, request, mode, repair), signal, {}, 2 * 1024 * 1024, beforeNetworkAttempt), route.modelId);
    const body: any = { model: route.runtimeModelId ?? route.modelId, stream: false, max_tokens: request.maxOutputTokens, messages: [{ role: 'system', content: systemContent(request, mode) }, { role: 'user', content: repairInput(request, repair) }] };
    if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema } };
    else if (mode === 'json_object') body.response_format = { type: 'json_object' };
    return parseCompatibleChat(await apiJson('compatible', apiAccess(route), 'chat/completions', body, signal, {}, 2 * 1024 * 1024, beforeNetworkAttempt), route.modelId);
  }
}

async function boundedJson(response: Response, maximum = 2 * 1024 * 1024): Promise<any> {
  let text = ''; const decoder = new TextDecoder();
  if (!response.body) throw new Error('Ollama returned an empty task response');
  for await (const chunk of response.body) { text += decoder.decode(chunk, { stream: true }); if (text.length > maximum) throw new Error('Ollama task response exceeded the size limit'); }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new Error('Ollama returned invalid response JSON'); }
}

class OllamaTaskAdapter implements TaskProviderAdapter {
  readonly id = 'ollama';
  describe(route: Pick<ResolvedTaskRoute, 'processing'>) {
    return route.processing === 'local' ? capabilities({ json_schema: 'supported', json_object: 'supported' })
      : route.processing === 'cloud' ? capabilities({ json_schema: 'unsupported', json_object: 'unsupported' })
      : capabilities({ json_schema: 'unknown', json_object: 'unknown' }, 'unknown');
  }
  async inspect(route: DispatchRoute, signal: AbortSignal) {
    const base = new URL(route.endpoint), request = async (path: string, body?: unknown) => {
      const url = new URL(base); url.pathname = `${base.pathname.replace(/\/$/u, '')}/api/${path}`;
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Ollama ${path} inspection failed (HTTP ${response.status})`); }
      return boundedJson(response);
    };
    try {
      const tags = await request('tags').catch(() => ({ models: [] }));
      const aliases = [route.modelId, `${route.modelId}:cloud`, `${route.modelId}-cloud`];
      const tag = aliases.map(id => tags.models?.find((entry: any) => entry?.model === id || entry?.name === id)).find(Boolean);
      const runtimeModelId = tag?.model || tag?.name || route.modelId;
      const shown = await request('show', { model: runtimeModelId });
      const cloud = isCloudModel(runtimeModelId, tag, shown);
      const processing = cloud ? 'cloud' : route.processing;
      const digest = typeof tag?.digest === 'string' && /^[a-f0-9]{64}$/iu.test(tag.digest) ? tag.digest.toLowerCase() : undefined;
      const described = this.describe({ processing });
      if (Array.isArray(shown.capabilities) && shown.capabilities.includes('tools')) described.outputModes.tool = 'supported';
      if (Array.isArray(shown.capabilities) && shown.capabilities.includes('thinking') || shown.thinking && typeof shown.thinking === 'object') described.thinking = 'supported';
      return { processing, modelVersion: runtimeModelId, modelDigest: digest, runtimeModelId,
        capabilities: described };
    } catch (error) {
      signal.throwIfAborted();
      // No personal input has been sent. Without current model metadata an opaque alias may be cloud-backed.
      return { processing: 'unknown' as const, capabilities: this.describe({ processing: 'unknown' }) };
    }
  }
  async generate(route: DispatchRoute, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>): Promise<ProviderTaskResponse> {
    const url = new URL(route.endpoint); url.pathname = `${url.pathname.replace(/\/$/u, '')}/api/chat`;
    const body: any = { model: route.runtimeModelId ?? route.modelId, stream: false, messages: [{ role: 'system', content: systemContent(request, mode) }, { role: 'user', content: repairInput(request, repair) }], options: { temperature: 0, num_predict: request.maxOutputTokens } };
    if (route.capabilities.thinking === 'supported') body.think = false;
    if (mode === 'json_schema') body.format = request.jsonSchema; else if (mode === 'json_object') body.format = 'json';
    else if (mode === 'tool') Object.assign(body, { tools: [{ type: 'function', function: { name: 'submit_memory_task', description: 'Return the requested structured data.', parameters: request.jsonSchema } }] });
    await beforeNetworkAttempt();
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Ollama task request failed (HTTP ${response.status})`); }
    const result = await boundedJson(response), reason = result.done_reason || (result.done === false ? 'incomplete' : 'stop');
    const call = mode === 'tool' ? result.message?.tool_calls?.find((item: any) => item?.function?.name === 'submit_memory_task') : undefined;
    const text = call ? JSON.stringify(call.function.arguments ?? {}) : String(result.message?.content ?? '');
    return { text, finish: call ? 'complete' : finish(reason), model: result.model || route.modelId, modelVersion: result.model,
      usage: { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count } };
  }
}

export function taskProviderAdapters(): TaskProviderAdapter[] {
  return [new OllamaTaskAdapter(), new OpenAiTaskAdapter(), new AnthropicTaskAdapter(), new GoogleTaskAdapter(), new CompatibleTaskAdapter()];
}
