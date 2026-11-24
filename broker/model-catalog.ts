/**
 * What a provider's catalog says about a model, in plain words, and OpenRouter's own lists: which models serve an
 * operation, how hard each can think, and who serves one. Everything here is what the provider states, not measured.
 */
import type { EffortOption, ModelOption } from './types.ts';

const outputs: Record<string, string> = { image: 'images', audio: 'audio', video: 'video', speech: 'speech' };
const inputs: Record<string, string> = { image: 'images', file: 'files', audio: 'audio', video: 'video' };
const listed = (items: string[]) => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);
const named = (items: unknown, names: Record<string, string>) => Array.isArray(items) ? [...new Set(items.map(item => names[String(item)]).filter(Boolean))] : [];
export function tokenCount(value: number): string {
  if (value >= 950_000) return String(Number((value / 1_000_000).toFixed(1))) + 'M';
  return value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
}
/** A price in dollars per token, said per million of them. */
function perMillion(price: string | undefined, discount = 0): string {
  const value = Number(price) * 1_000_000 * (1 - discount);
  if (price === undefined || !Number.isFinite(value) || value < 0) return '';
  const cents = Number(value.toFixed(2)), shown = value > 0 && value < 0.01 ? Number(value.toFixed(5)) : Number(value.toPrecision(3));
  return '$' + (shown === cents && !Number.isInteger(cents) ? cents.toFixed(2) : shown);
}
export function freeModel(pricing?: Record<string, string>): boolean {
  return !!pricing && (pricing.prompt !== undefined || pricing.completion !== undefined) && !Object.values(pricing).some(value => Number(value) > 0);
}
export function priceText(pricing?: Record<string, string>, discount = 0): string {
  if (!pricing) return '';
  if (freeModel(pricing)) return 'free';
  const prompt = perMillion(pricing.prompt, discount), completion = perMillion(pricing.completion, discount);
  return prompt && completion && completion !== '$0' ? `${prompt} in, ${completion} out per 1M tokens` : prompt ? `${prompt} in per 1M tokens` : '';
}
export function modelFacts(model: Pick<ModelOption, 'contextLength' | 'pricing' | 'inputModalities' | 'outputModalities' | 'expires'>): string {
  const reads = named(model.inputModalities, inputs), makes = named(model.outputModalities, outputs);
  return [model.contextLength ? tokenCount(model.contextLength) + ' context' : '', priceText(model.pricing), reads.length ? 'reads ' + listed(reads) : '', makes.length ? 'makes ' + listed(makes) : '', model.expires ? 'ends ' + model.expires : ''].filter(Boolean).join(' · ');
}
export function catalogPricing(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prices = Object.entries(value).filter((pair): pair is [string, string] => /^[a-z0-9_]{1,40}$/.test(pair[0]) && typeof pair[1] === 'string' && /^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(pair[1])).slice(0, 24);
  return prices.length ? Object.fromEntries(prices) : undefined;
}

/** OpenRouter keeps one list per kind of service; its ordinary list holds only models that write text. */
const lists: Record<string, { path: string; endpoints?: string[] }> = {
  embed: { path: 'models?output_modalities=embeddings', endpoints: ['/api/v1/embeddings'] },
  'speech.transcribe': { path: 'models?output_modalities=transcription', endpoints: ['/api/v1/audio/transcriptions'] },
  'speech.synthesize': { path: 'models?output_modalities=speech', endpoints: ['/api/v1/audio/speech'] },
  'image.generate': { path: 'images/models' },
  chat: { path: 'models', endpoints: ['/api/v1/chat/completions', '/api/v1/responses'] },
};
export const openRouterList = (operation: string) => (lists[operation] || lists.chat).path;
/** Whether a list of its own already decided what its models are for. */
export const openRouterSorted = (operation: string) => operation in lists && operation !== 'chat';
/** A `:batch` model, for one, takes only batch jobs: offering it for a conversation would fail every message. */
export function openRouterServes(entry: any, operation: string): boolean {
  const wanted = (lists[operation] || lists.chat).endpoints;
  if (!wanted || !Array.isArray(entry?.endpoints)) return true;
  return wanted.some(path => entry.endpoints.includes(path)) && !(operation === 'chat' && entry.endpoints.some((path: unknown) => path === '/api/v1/images' || path === '/api/v1/videos'));
}
const levels: [string, string][] = [['none', 'Off'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Maximum']];
/** The efforts one model takes; none for a model that does not reason; undefined when its entry does not say. */
export function openRouterEfforts(entry: any): EffortOption[] | undefined {
  const named = entry?.reasoning?.supported_efforts;
  if (Array.isArray(named)) return levels.filter(([id]) => named.includes(id)).map(([id, displayName]) => ({ id, displayName, description: '' }));
  if (!Array.isArray(entry?.supported_parameters)) return undefined;
  return entry.reasoning || entry.supported_parameters.some((name: unknown) => name === 'reasoning' || name === 'reasoning_effort') ? undefined : [];
}

/** Who serves one OpenRouter model. `slug` is what the allowed and preferred upstream providers are named by. */
export type ModelEndpoint = { provider: string; slug: string; detail: string; available: boolean; parameters: string[] };
export async function modelEndpoints(model: unknown, get: (path: string) => Promise<any>): Promise<ModelEndpoint[]> {
  if (typeof model !== 'string' || model.length > 200 || !/^~?[\w.-]+\/[\w.:~-]+$/.test(model)) throw new Error('Choose a model from OpenRouter’s list');
  const [author, slug] = model.split('/'), value = await get(`models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`);
  if (!Array.isArray(value?.data?.endpoints)) throw new Error('OpenRouter did not say who serves this model');
  return value.data.endpoints.slice(0, 64).flatMap((entry: any): ModelEndpoint[] => {
    if (typeof entry?.provider_name !== 'string' || !entry.provider_name) return [];
    const discount = typeof entry.discount === 'number' ? entry.discount : typeof entry.pricing?.discount === 'number' ? entry.pricing.discount : 0;
    const uptime = typeof entry.uptime_last_1d === 'number' && entry.uptime_last_1d >= 0 && entry.uptime_last_1d <= 100 ? Number(entry.uptime_last_1d.toFixed(1)) + '% up in the last day' : '';
    const quantization = typeof entry.quantization === 'string' && /^[a-z0-9]{2,12}$/.test(entry.quantization) && entry.quantization !== 'unknown' ? entry.quantization : '';
    const context = Number.isSafeInteger(entry.context_length) && entry.context_length > 0 ? tokenCount(entry.context_length) + ' context' : '', output = Number.isSafeInteger(entry.max_completion_tokens) && entry.max_completion_tokens > 0 ? tokenCount(entry.max_completion_tokens) + ' reply' : '';
    return [{ provider: entry.provider_name.slice(0, 80), slug: typeof entry.tag === 'string' && /^[\w./-]{1,80}$/.test(entry.tag) ? entry.tag : '', available: entry.status === undefined || entry.status === 0,
      detail: [context, output, priceText(catalogPricing(entry.pricing), discount > 0 && discount < 1 ? discount : 0), quantization, uptime].filter(Boolean).join(' · '),
      parameters: Array.isArray(entry.supported_parameters) ? entry.supported_parameters.filter((item: unknown): item is string => typeof item === 'string' && item.length <= 60).slice(0, 60) : [] }];
  });
}

/**
 * A catalog small enough for one message to a phone, which takes a megabyte at most. What a list needs comes first:
 * the price and parameter tables stay on the desktop, then descriptions go, then the end of the list.
 */
export function compactModels(models: readonly ModelOption[], budget: number): { items: ModelOption[]; cut: boolean } {
  const brief = (model: ModelOption, words: number): ModelOption => {
    const { pricing: _pricing, supportedParameters: _parameters, inputModalities: _inputs, outputModalities: _outputs, ...rest } = model;
    return { ...rest, description: String(rest.description || '').slice(0, words) };
  };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  for (const words of [400, 0]) { const items = models.map(model => brief(model, words)); if (size(items) <= budget) return { items, cut: false }; }
  const items: ModelOption[] = []; let used = 2;
  for (const model of models) { const row = brief(model, 0), bytes = size(row) + 1; if (used + bytes > budget) return { items, cut: true }; used += bytes; items.push(row); }
  return { items, cut: false };
}
