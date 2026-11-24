import { createHash } from 'node:crypto';
import { huggingFaceTasks, type BinaryInferenceInput, type HuggingFaceInferenceRequest, type HuggingFaceInferenceResult, type MistralOcrPage, type MistralOcrRequest, type MistralOcrResult, type ProviderInferenceRpcRequest } from './contracts.ts';

export type ProviderInferenceAccount = {
  id: string;
  revision: number;
  provider: 'huggingface' | 'mistral';
  key(): string;
  fetch?: typeof fetch;
  /** Named-account endpoint only. HF endpoints must be router.huggingface.co or *.endpoints.huggingface.cloud. */
  baseUrl?: string;
};
export type ProviderInferenceHooks = {
  account(connectionId: string): ProviderInferenceAccount | undefined;
  /** Re-check consent/permissions immediately before every outbound attempt. */
  beforeDispatch(binding: { connectionId: string; connectionRevision: number }, operation: string): void;
  dispatched(binding: { connectionId: string; connectionRevision: number }, operation: string): void;
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
};

const maxJsonBytes = 16 * 1024 * 1024, maxMediaBytes = 64 * 1024 * 1024, maxInputBytes = 50 * 1024 * 1024;
const binaryTasks = new Set(['image-classification', 'object-detection', 'image-segmentation', 'audio-classification', 'automatic-speech-recognition', 'image-to-image']);
const mediaTasks = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'text-to-speech']);
const allowedParameters: Record<string, ReadonlySet<string>> = {
  'feature-extraction': new Set(['truncate', 'truncation', 'prompt_name']),
  'sentence-similarity': new Set([]),
  'text-classification': new Set(['function_to_apply', 'top_k']),
  'token-classification': new Set(['aggregation_strategy', 'ignore_labels', 'stride']),
  'zero-shot-classification': new Set(['candidate_labels', 'hypothesis_template', 'multi_label']),
  'question-answering': new Set([]), 'fill-mask': new Set(['targets', 'top_k']),
  summarization: new Set(['max_length', 'min_length', 'do_sample']), translation: new Set(['src_lang', 'tgt_lang', 'max_length']),
  'table-question-answering': new Set(['sequential']),
  'text-generation': new Set(['max_new_tokens', 'do_sample', 'temperature', 'top_k', 'top_p', 'repetition_penalty', 'return_full_text', 'seed', 'stop']),
  'image-classification': new Set(['top_k']), 'object-detection': new Set(['threshold']), 'image-segmentation': new Set(['threshold', 'mask_threshold', 'overlap_mask_area_threshold']),
  'audio-classification': new Set(['top_k']), 'automatic-speech-recognition': new Set(['return_timestamps']),
  'text-to-image': new Set(['negative_prompt', 'height', 'width', 'num_inference_steps', 'guidance_scale', 'seed']),
  'image-to-image': new Set(['prompt', 'negative_prompt', 'strength', 'num_inference_steps', 'guidance_scale', 'seed']),
  'text-to-video': new Set(['negative_prompt', 'num_frames', 'num_inference_steps', 'guidance_scale', 'seed']),
  'text-to-speech': new Set(['speaker_embeddings', 'voice', 'language']),
};

function boundedText(value: unknown, name: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${name} is invalid`);
  return value.trim();
}
function binding(value: { connectionId: string; connectionRevision: number }) {
  return { connectionId: boundedText(value.connectionId, 'Inference account', 128), connectionRevision: value.connectionRevision };
}
function accountFor(hooks: ProviderInferenceHooks, value: { connectionId: string; connectionRevision: number }, provider: ProviderInferenceAccount['provider']) {
  const bound = binding(value), account = hooks.account(bound.connectionId);
  if (!account || account.provider !== provider || account.revision !== bound.connectionRevision) throw new Error('The selected inference account changed or is unavailable');
  const key = account.key(); if (!key) throw new Error(`Add a key for ${provider === 'huggingface' ? 'Hugging Face' : 'Mistral'} in Settings → Connections`);
  return { bound, account, key };
}
function currentKey(hooks: ProviderInferenceHooks, bound: { connectionId: string; connectionRevision: number }, provider: ProviderInferenceAccount['provider']) {
  return accountFor(hooks, bound, provider).key;
}
function validJson(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('Inference parameters are too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 32_768 || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 1024) return value.map(entry => validJson(entry, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 128) throw new Error('Inference parameters have too many fields');
    return Object.fromEntries(entries.map(([key, entry]) => [boundedText(key, 'Inference parameter name', 128), validJson(entry, depth + 1)]));
  }
  throw new Error('Inference parameters must be bounded JSON');
}
function parameters(task: string, value: Record<string, unknown> | undefined) {
  const checked = validJson(value || {}) as Record<string, unknown>, allowed = allowedParameters[task];
  for (const key of Object.keys(checked)) if (!allowed.has(key)) throw new Error(`${task} does not support parameter “${key}”`);
  return checked;
}
function binary(value: unknown): value is BinaryInferenceInput { return !!value && typeof value === 'object' && Buffer.isBuffer((value as any).data) && typeof (value as any).mime === 'string'; }
function checkBinary(value: BinaryInferenceInput) {
  const mime = boundedText(value.mime, 'Inference input MIME type', 128);
  if (!/^(audio|image)\/[a-z0-9.+-]+$/i.test(mime) || !value.data.length || value.data.length > maxInputBytes) throw new Error('Inference binary input is empty, unsupported, or too large');
  return { mime: mime.toLowerCase(), data: value.data };
}
function structuredInput(value: unknown) {
  const checked = validJson(value);
  if (typeof checked === 'string' && !checked.trim()) throw new Error('Inference text input is empty');
  if (Array.isArray(checked) && (!checked.length || checked.length > 256)) throw new Error('Inference input batch must contain 1 to 256 items');
  if (Buffer.byteLength(JSON.stringify(checked)) > 4 * 1024 * 1024) throw new Error('Structured inference input exceeds its size limit');
  return checked;
}
function hfEndpoint(account: ProviderInferenceAccount, model: string) {
  const id = boundedText(model, 'Hugging Face model', 512);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(id)) throw new Error('Use a provider-deployed Hugging Face model ID');
  if (!account.baseUrl) return { url: `https://router.huggingface.co/hf-inference/models/${id.split('/').map(encodeURIComponent).join('/')}`, provider: 'hf-inference' as const };
  const url = new URL(account.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'router.huggingface.co' || url.hostname.endsWith('.endpoints.huggingface.cloud'))) throw new Error('Hugging Face inference requires an official router or dedicated endpoint URL');
  url.search = ''; url.hash = '';
  if (url.hostname === 'router.huggingface.co') url.pathname = `/hf-inference/models/${id.split('/').map(encodeURIComponent).join('/')}`;
  return { url: url.toString().replace(/\/$/, ''), provider: url.hostname === 'router.huggingface.co' ? 'hf-inference' as const : 'dedicated-endpoint' as const };
}
async function bytes(response: Response, maximum: number) {
  if (!response.body || Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel().catch(() => {}); throw new Error('Inference response is missing or too large'); }
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.byteLength; if (length > maximum) throw new Error('Inference response exceeded its size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks, length);
}
async function json(response: Response) { const value = await bytes(response, maxJsonBytes); try { return JSON.parse(value.toString('utf8')); } catch { throw new Error('Inference provider returned invalid JSON'); } }
function delay(response: Response, attempt: number) { const seconds = Number(response.headers.get('retry-after')); return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : Math.min(250 * 2 ** attempt, 2000); }
async function pause(hooks: ProviderInferenceHooks, milliseconds: number, signal: AbortSignal) {
  if (hooks.sleep) return hooks.sleep(milliseconds, signal);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); timer.unref(); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
}
function providerError(response: Response, loading: boolean) {
  if (response.status === 401) return 'Hugging Face rejected this key';
  if (response.status === 403) return 'This Hugging Face model is gated or the account lacks access';
  if (response.status === 404) return 'This Hugging Face model is not deployed on the selected inference route';
  if (loading) return 'The Hugging Face model is still loading after bounded retries';
  if (response.status === 429) return 'Hugging Face rate or quota limit reached';
  return `Hugging Face inference failed (HTTP ${response.status})`;
}
function finiteVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 65_536 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Hugging Face returned an invalid embedding vector');
  return value as number[];
}
function pooled(value: unknown, mode: 'none' | 'mean' | 'cls') {
  if (!Array.isArray(value) || !value.length) throw new Error('Hugging Face returned invalid feature extraction output');
  if (typeof value[0] === 'number') return finiteVector(value);
  const tokens = (value as unknown[]).map(finiteVector), dimension = tokens[0].length;
  if (!tokens.every(token => token.length === dimension)) throw new Error('Hugging Face returned inconsistent token embedding dimensions');
  if (mode === 'none') throw new Error('Token-level feature extraction cannot be used as one document vector without an explicit pooling mode');
  if (mode === 'cls') return tokens[0];
  return Array.from({ length: dimension }, (_, column) => tokens.reduce((sum, token) => sum + token[column], 0) / tokens.length);
}
function normalize(vector: number[]) { const norm = Math.hypot(...vector); if (!Number.isFinite(norm) || norm === 0) throw new Error('Hugging Face returned a zero or invalid embedding'); return vector.map(value => value / norm); }

export class ProviderInferenceService {
  readonly hooks: ProviderInferenceHooks;
  constructor(hooks: ProviderInferenceHooks) { this.hooks = hooks; }

  async run(request: HuggingFaceInferenceRequest, signal: AbortSignal, beforeAttempt?: () => void): Promise<HuggingFaceInferenceResult> {
    if (!huggingFaceTasks.includes(request.task)) throw new Error('Choose a supported Hugging Face inference task');
    const { bound, account } = accountFor(this.hooks, request, 'huggingface'), endpoint = hfEndpoint(account, request.model), operation = `huggingface.${request.task}`;
    const params = parameters(request.task, request.parameters), binaries = Array.isArray(request.inputs) && request.inputs.length > 0 && request.inputs.every(binary) ? request.inputs.map(checkBinary) : binary(request.inputs) ? [checkBinary(request.inputs)] : undefined;
    if (binaryTasks.has(request.task) !== !!binaries) throw new Error(`${request.task} requires ${binaryTasks.has(request.task) ? 'original image or audio bytes' : 'structured text input'}`);
    if (binaries && binaries.length > 8) throw new Error('Hugging Face inference supports at most 8 binary inputs per request');
    const body = binaries ? JSON.stringify({ inputs: binaries.length === 1 ? binaries[0].data.toString('base64') : binaries.map(input => input.data.toString('base64')), ...(Object.keys(params).length ? { parameters: params } : {}) })
      : JSON.stringify({ inputs: structuredInput(request.inputs), ...(Object.keys(params).length ? { parameters: params } : {}) });
    if (Buffer.byteLength(body) > maxInputBytes * 4 / 3 + 1024 * 1024) throw new Error('Hugging Face inference request is too large');
    let response!: Response;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted(); beforeAttempt?.(); this.hooks.beforeDispatch(bound, operation);
      const key = currentKey(this.hooks, bound, 'huggingface');
      const pending = (account.fetch || fetch)(endpoint.url, { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Wait-For-Model': 'true' }, body });
      this.hooks.dispatched(bound, operation);
      response = await pending;
      if (response.ok) break;
      const loading = response.status === 503;
      await response.body?.cancel().catch(() => {});
      if (!loading || attempt === 3) throw new Error(providerError(response, loading));
      await pause(this.hooks, delay(response, attempt), signal);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (mediaTasks.has(request.task) && contentType && contentType !== 'application/json') return { kind: 'media', task: request.task, model: request.model, servingProvider: endpoint.provider, mime: contentType, bytes: await bytes(response, maxMediaBytes) };
    const output = await json(response);
    if (request.task !== 'feature-extraction') return { kind: 'json', task: request.task, model: request.model, servingProvider: endpoint.provider, output: validJson(output) };
    const mode = request.pooling;
    if (!mode) throw new Error('Choose none, mean, or CLS pooling for Hugging Face feature extraction');
    const expected = Array.isArray(request.inputs) ? request.inputs.length : 1;
    const raw = expected > 1 ? output : [output], vectors = (raw as unknown[]).map(value => pooled(value, mode)).map(vector => request.normalize ? normalize(vector) : vector);
    const dimension = vectors[0]?.length;
    if (!dimension || vectors.length !== expected || !vectors.every(vector => vector.length === dimension)) throw new Error('Hugging Face returned the wrong embedding count or dimensions');
    return { kind: 'embeddings', task: 'feature-extraction', model: request.model, servingProvider: endpoint.provider, vectors, dimension, pooling: mode, normalized: request.normalize === true };
  }

  async mistralOcr(request: MistralOcrRequest, signal: AbortSignal, beforeAttempt?: () => void): Promise<MistralOcrResult> {
    const { bound, account } = accountFor(this.hooks, request, 'mistral'), operation = 'mistral.ocr';
    const name = boundedText(request.file?.name, 'OCR source name', 512), mime = boundedText(request.file?.mime, 'OCR source MIME type', 128).toLowerCase(), file = request.file?.bytes;
    if (!Buffer.isBuffer(file) || !file.length || file.length > maxInputBytes || !/^(application\/(pdf|vnd\.|msword|octet-stream)|image\/(png|jpeg|jpg|webp|avif))/.test(mime)) throw new Error('Mistral OCR source file is empty, unsupported, or exceeds 50 MiB');
    const model = request.model ? boundedText(request.model, 'Mistral OCR model', 256) : 'mistral-ocr-latest';
    const pages = request.pages;
    if (Array.isArray(pages) && (pages.length > 1000 || pages.some(page => !Number.isInteger(page) || page < 0))) throw new Error('Mistral OCR pages are invalid');
    if (typeof pages === 'string' && (!/^[0-9,-]+$/.test(pages) || pages.length > 4096)) throw new Error('Mistral OCR page range is invalid');
    const document = { type: mime.startsWith('image/') ? 'image_url' : 'document_url', [mime.startsWith('image/') ? 'image_url' : 'document_url']: `data:${mime};base64,${file.toString('base64')}` };
    const body = { model, document, ...(pages !== undefined ? { pages } : {}), ...(request.tableFormat ? { table_format: request.tableFormat } : {}), include_image_base64: request.includeImages === true,
      include_blocks: request.includeBlocks !== false, extract_header: request.extractHeader === true, extract_footer: request.extractFooter === true,
      ...(request.confidence ? { confidence_scores_granularity: request.confidence } : {}) };
    const base = account.baseUrl || 'https://api.mistral.ai/v1/'; const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'api.mistral.ai') throw new Error('Mistral OCR requires the official Mistral API account endpoint');
    const root = url.pathname.replace(/\/+$/, ''); url.pathname = root.endsWith('/v1') ? `${root}/ocr` : `${root}/v1/ocr`; url.search = ''; url.hash = '';
    signal.throwIfAborted(); beforeAttempt?.(); this.hooks.beforeDispatch(bound, operation); const key = currentKey(this.hooks, bound, 'mistral');
    const pending = (account.fetch || fetch)(url, { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    this.hooks.dispatched(bound, operation);
    const response = await pending;
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(response.status === 401 || response.status === 403 ? 'Mistral rejected this key or OCR access' : `Mistral OCR failed (HTTP ${response.status})`); }
    const output = await json(response), rawPages = output?.pages;
    if (!Array.isArray(rawPages) || rawPages.length > 1000) throw new Error('Mistral OCR returned invalid pages');
    const seen = new Set<number>(), normalized: MistralOcrPage[] = rawPages.map((page: any) => {
      const index = page?.index; if (!Number.isInteger(index) || index < 0 || seen.has(index)) throw new Error('Mistral OCR returned invalid page ordering'); seen.add(index);
      const markdown = typeof page.markdown === 'string' && page.markdown.length <= 2 * 1024 * 1024 ? page.markdown : (() => { throw new Error('Mistral OCR returned an invalid page'); })();
      const images = Array.isArray(page.images) && page.images.length <= 1000 ? page.images.map((image: any) => ({ id: boundedText(image.id, 'OCR image ID', 512), ...(Number.isFinite(image.top_left_x) && Number.isFinite(image.top_left_y) && Number.isFinite(image.bottom_right_x) && Number.isFinite(image.bottom_right_y) ? { box: { left: image.top_left_x, top: image.top_left_y, right: image.bottom_right_x, bottom: image.bottom_right_y } } : {}), ...(typeof image.image_base64 === 'string' && image.image_base64.length <= 16 * 1024 * 1024 ? { data: image.image_base64 } : {}) })) : [];
      return { index, markdown, ...(typeof page.header === 'string' ? { header: page.header.slice(0, 256 * 1024) } : {}), ...(typeof page.footer === 'string' ? { footer: page.footer.slice(0, 256 * 1024) } : {}),
        ...(page.dimensions && typeof page.dimensions === 'object' ? { dimensions: { ...(Number.isFinite(page.dimensions.dpi) ? { dpi: page.dimensions.dpi } : {}), ...(Number.isFinite(page.dimensions.width) ? { width: page.dimensions.width } : {}), ...(Number.isFinite(page.dimensions.height) ? { height: page.dimensions.height } : {}) } } : {}), images,
        tables: Array.isArray(page.tables) ? validJson(page.tables) as unknown[] : [], blocks: Array.isArray(page.blocks) ? validJson(page.blocks) as unknown[] : [] };
    }).sort((a, b) => a.index - b.index);
    return { kind: 'mistral-ocr', model: typeof output.model === 'string' ? output.model : model, source: { name, mime, bytes: file.length, sha256: createHash('sha256').update(file).digest('hex'), originalFile: true }, pages: normalized,
      ...(output.document_annotation !== undefined ? { documentAnnotation: validJson(output.document_annotation) } : {}), usage: { ...(Number.isFinite(output.usage_info?.pages_processed) ? { pagesProcessed: output.usage_info.pages_processed } : {}), ...(Number.isFinite(output.usage_info?.doc_size_bytes) ? { documentBytes: output.usage_info.doc_size_bytes } : {}) } };
  }

  async rpc(request: ProviderInferenceRpcRequest, signal: AbortSignal) {
    const decode = (value: string) => { if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Inference binary input is not valid base64'); return Buffer.from(value, 'base64'); };
    if (request.method === 'providerInference.run') {
      const { method: _method, inputs, ...rest } = request;
      const binaryInput = (value: any) => typeof value === 'object' && value && 'base64' in value ? { mime: value.mime, data: decode(value.base64) } : value;
      const decoded = Array.isArray(inputs) ? inputs.map(binaryInput) : binaryInput(inputs);
      return this.run({ ...rest, inputs: decoded } as HuggingFaceInferenceRequest, signal);
    }
    if (request.method === 'providerInference.mistralOcr') { const { method: _method, file, ...rest } = request; return this.mistralOcr({ ...rest, file: { name: file.name, mime: file.mime, bytes: decode(file.base64) } }, signal); }
    throw new Error('Unknown provider inference operation');
  }
}

