import type { ApiProvider } from '../provider-catalog.ts';
import type { Source } from '../types.ts';

/** Handles split UTF-8, CRLF, comments, heartbeats and multiline SSE data. */
export async function consumeProviderSse(response: Response, receive: (value: any) => void, tick: () => void = () => {}, limit = 8 * 1024 * 1024) {
  if (!response.body) throw new Error('The provider returned an empty stream');
  const decoder = new TextDecoder(); let buffer = '', data: string[] = [], size = 0;
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') return;
    let value: any;
    try { value = JSON.parse(raw); } catch { throw new Error('The provider returned invalid stream data'); }
    receive(value);
  };
  const line = (raw: string) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) dispatch();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  for await (const chunk of response.body) {
    tick(); size += chunk.length;
    if (size > limit) throw new Error('API reply exceeded the size limit');
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  dispatch();
}

export type ProviderCitation = Source & {
  provider: ApiProvider;
  responseId?: string;
  resultId?: string;
  sourceType?: 'web' | 'x' | 'file' | 'document' | 'unknown';
  startOffset?: number;
  endOffset?: number;
  offsetUnit?: 'unicode-code-point' | 'utf16-code-unit' | 'utf8-byte' | 'unknown';
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
function sourceType(value: any): ProviderCitation['sourceType'] {
  const kind = text(value?.source_type || value?.type || value?.kind).toLowerCase();
  if (kind.includes('x_') || kind === 'x' || kind.includes('tweet')) return 'x';
  if (kind.includes('file')) return 'file';
  if (kind.includes('document') || kind.includes('page')) return 'document';
  return kind.includes('web') || kind.includes('url') || kind.includes('citation') || kind.includes('search') ? 'web' : 'unknown';
}

/** Provider payloads use different annotation names; this keeps their identity and offsets without guessing marker numbers. */
export function providerCitations(provider: ApiProvider, value: any, responseId?: string): ProviderCitation[] {
  const candidates: any[] = [];
  const visit = (entry: any, depth: number) => {
    if (!entry || depth > 8) return;
    if (Array.isArray(entry)) { for (const child of entry) visit(child, depth + 1); return; }
    if (typeof entry !== 'object') return;
    const url = text(entry.url || entry.uri || entry.link || entry.source?.url);
    if (url && /^https?:\/\//i.test(url)) candidates.push(entry);
    for (const key of ['annotations', 'citations', 'sources', 'search_results', 'results', 'references', 'citation','annotation','delta','content_block','candidates','groundingMetadata','groundingChunks','web','item']) if (entry[key] !== undefined) visit(entry[key], depth + 1);
    if (entry.response !== undefined) visit(entry.response, depth + 1);
    if (entry.output !== undefined) visit(entry.output, depth + 1);
    if (entry.content !== undefined) visit(entry.content, depth + 1);
  };
  visit(value, 0);
  const seen = new Set<string>();
  return candidates.flatMap(entry => {
    const url = text(entry.url || entry.uri || entry.link || entry.source?.url);
    let parsed:URL;try{parsed=new URL(url);}catch{return [];}
    if(parsed.username||parsed.password||url.length>4096)return [];
    const rawId=entry.result_id??entry.id??entry.source?.id;
    const resultId=Number.isSafeInteger(rawId)?String(rawId):text(rawId).slice(0,200)||undefined;
    const key = `${resultId || ''}\0${url}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const start = entry.start_index ?? entry.start_offset ?? entry.start;
    const end = entry.end_index ?? entry.end_offset ?? entry.end;
    return [{ title: text(entry.title || entry.name || entry.source?.title) || parsed.hostname, url, provider,
      ...(responseId ? { responseId } : {}), ...(resultId ? { resultId } : {}), sourceType: /^(?:www\.)?(?:x\.com|twitter\.com)$/.test(parsed.hostname)&&provider==='xai'?'x':sourceType(entry),
      ...(Number.isSafeInteger(start) && start >= 0 ? { startOffset: start } : {}),
      ...(Number.isSafeInteger(end) && end >= 0 ? { endOffset: end } : {}),
      ...((Number.isSafeInteger(start) || Number.isSafeInteger(end)) ? { offsetUnit: 'unicode-code-point' as const } : {}),
    }];
  });
}

export type NormalizedUsage = {
  inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number; audioTokens?: number;
  searchCalls?: number; toolCalls?: number; source: string; upstream?: Record<string, unknown>;
};
const whole = (...values: unknown[]) => values.find(entry => Number.isSafeInteger(entry) && Number(entry) >= 0) as number | undefined;
/**
 * Everything a request read and wrote, whichever way its provider counts. Claude leaves what its cache held out of the
 * input, and Gemini leaves thinking out of the output and what its own tools read out of the input.
 */
export function providerTokens(usage: any): { inputTokens?: number; outputTokens?: number } {
  if (!usage || typeof usage !== 'object') return {};
  const input = whole(usage.input_tokens, usage.prompt_tokens, usage.inputTokens), output = whole(usage.output_tokens, usage.completion_tokens, usage.outputTokens);
  const cached = whole(usage.input_tokens) === undefined ? 0 : (whole(usage.cache_read_input_tokens) ?? 0) + (whole(usage.cache_creation_input_tokens) ?? 0);
  const prompt = whole(usage.promptTokenCount), written = whole(usage.candidatesTokenCount), thought = whole(usage.thoughtsTokenCount);
  return { inputTokens: input !== undefined ? input + cached : prompt !== undefined ? prompt + (whole(usage.toolUsePromptTokenCount) ?? 0) : undefined,
    outputTokens: output ?? (written !== undefined || thought !== undefined ? (written ?? 0) + (thought ?? 0) : undefined) };
}
export function normalizeProviderUsage(value: any, source: string): NormalizedUsage | undefined {
  const usage = value?.usage || value;
  if (!usage || typeof usage !== 'object') return undefined;
  const result: NormalizedUsage = {
    ...providerTokens(usage),
    cachedTokens: whole(usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cache_read_input_tokens, usage.cachedContentTokenCount, usage.prompt_cache_hit_tokens),
    reasoningTokens: whole(usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens,usage.thoughtsTokenCount),
    audioTokens: whole(usage.input_tokens_details?.audio_tokens, usage.output_tokens_details?.audio_tokens),
    searchCalls: whole(usage.num_search_queries, usage.search_calls,usage.server_tool_use?.web_search_requests), toolCalls: whole(usage.tool_calls), source,
  };
  if (!Object.entries(result).some(([key, entry]) => key !== 'source' && entry !== undefined)) return undefined;
  const bounded = JSON.stringify(usage);
  if (bounded.length <= 16 * 1024) result.upstream = structuredClone(usage);
  return result;
}
