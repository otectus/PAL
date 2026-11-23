import { createHash } from 'node:crypto';
import { apiJson, type ApiAccess } from '../../api-providers.ts';
import { ExtractionPolicyError, MutationProposalBatchSchema, SYSTEM_PROMPT, exactOccurrence, EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION, EXTRACTION_PARSER_VERSION } from './ollama.ts';
import type { ExtractionAdapter, ExtractionSource, ExtractionRun } from './contracts.ts';
import type { ApiProvider } from '../../provider-catalog.ts';
import type { ProcessingClass, TaskModelBinding } from '../task-models.ts';
import type { TaskModelRouter } from '../task-router.ts';
import { z } from 'zod';

export class ApiExtractionAdapter implements ExtractionAdapter {
  readonly config: { provider: ApiProvider; model: string; allowCloud: boolean; processing?: ProcessingClass; dialect?: 'chat_completions' | 'responses' };
  readonly access: ApiAccess;
  constructor(config: ApiExtractionAdapter['config'], access: ApiAccess) { this.config = config; this.access = access; }
  private processing(): ProcessingClass {
    const declared = this.config.processing ?? (this.config.provider === 'compatible' ? 'unknown' : 'cloud');
    if (this.config.provider !== 'compatible' || declared !== 'local') return declared;
    const base = this.access.endpoint?.().baseUrl;
    if (!base) return 'unknown';
    const hostname = new URL(base).hostname.replace(/^\[|\]$/gu, '');
    return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? 'local' : 'unknown';
  }
  private authorize() {
    const processing = this.processing();
    if (processing === 'unknown') throw new Error('Declare where the compatible endpoint processes requests before using it for memory');
    if (processing === 'cloud' && !this.config.allowCloud) throw new ExtractionPolicyError('CLOUD_EXTRACTION_DISABLED', 'Enable cloud memory extraction before using this API');
  }
  private async generate(content: string, signal?: AbortSignal) {
    this.authorize();
    const guard = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    const { provider, model } = this.config;
    if (provider === 'anthropic') {
      const result = await apiJson(provider, this.access, 'messages', { model, max_tokens: 4096, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: MutationProposalBatchSchemaJson } } }, guard);
      if (result.stop_reason !== 'end_turn') throw new Error('Claude memory extraction did not finish');
      return { text: (result.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''), model: result.model || model };
    }
    if (provider === 'openai' || provider === 'compatible') {
      const responses = provider === 'openai' || this.config.dialect === 'responses';
      if (responses) {
        const result = await apiJson(provider, this.access, 'responses', { model, instructions: SYSTEM_PROMPT, input: content, text: { format: { type: 'json_schema', name: 'memory_extraction', strict: true, schema: MutationProposalBatchSchemaJson } }, max_output_tokens: 4096, store: false }, guard);
        if (result.status !== 'completed') throw new Error('Memory extraction did not finish');
        const parts = (result.output || []).filter((item: any) => item.type === 'message' && item.role === 'assistant').flatMap((item: any) => item.content || []);
        if (parts.some((part: any) => part.type === 'refusal')) throw new Error('Memory extraction was refused');
        return { text: parts.filter((part: any) => part.type === 'output_text').map((part: any) => part.text || '').join(''), model: result.model || model };
      }
      const result = await apiJson(provider, this.access, 'chat/completions', { model, stream: false, max_tokens: 4096, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }], response_format: { type: 'json_schema', json_schema: { name: 'memory_extraction', strict: true, schema: MutationProposalBatchSchemaJson } } }, guard);
      const choice = result.choices?.[0];
      if (choice?.finish_reason !== 'stop' || choice.message?.refusal) throw new Error('Memory extraction did not finish');
      return { text: typeof choice.message?.content === 'string' ? choice.message.content : '', model: result.model || model };
    }
    const result = await apiJson('google', this.access, `models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: 'user', parts: [{ text: content }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: MutationProposalBatchSchemaJson, maxOutputTokens: 8192 },
    }, guard);
    const candidate = result.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new Error('Gemini memory extraction did not finish');
    return { text: (candidate.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''), model: result.modelVersion || model };
  }
  private identity(model: string) {
    // API vendors expose model IDs, not weight digests. This identifies the route/version only.
    return createHash('sha256').update(JSON.stringify(['api-model-identity-v1', this.config.provider, model])).digest('hex');
  }
  async probe(signal?: AbortSignal) {
    const response = await this.generate('Return exactly {"entities":[],"assertions":[],"statements":[]}.', signal);
    const result = MutationProposalBatchSchema.parse(JSON.parse(response.text));
    if (result.entities.length || result.assertions.length) throw new Error('Extraction capability probe failed');
    return { model: response.model, digest: this.identity(response.model), capabilities: ['completion'] };
  }
  async extract(source: ExtractionSource, signal?: AbortSignal): Promise<ExtractionRun> {
    this.authorize();
    const processing = this.processing();
    if (source.modelRoute !== 'cloud_allowed' && processing !== 'local') throw new ExtractionPolicyError('LOCAL_ONLY_CLOUD_ROUTE', 'Local-only source cannot be sent to this API');
    if ([...source.text].length > 32768) throw new TypeError('Extraction source exceeds the configured input bound');
    const input = JSON.stringify({ sourceRecordId: source.sourceRecordId, sourceRole: source.sourceRole, sourceText: source.text });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.generate(input + (attempt ? '\nReturn a fresh JSON object matching the schema exactly, with exact source quotations.' : ''), signal);
      if (response.text.length > 64000) throw new Error('Extraction response exceeded the configured output bound');
      let parsed: unknown;
      try { parsed = JSON.parse(response.text); } catch { continue; }
      const result = MutationProposalBatchSchema.safeParse(parsed);
      if (!result.success) continue;
      for (const assertion of result.data.assertions) for (const quote of assertion.quotes) {
        if (quote.sourceRecordId !== source.sourceRecordId || !exactOccurrence(source.text, quote.quote, quote.occurrenceIndex)) throw new Error('Extraction model returned a fabricated or mismatched evidence quotation');
      }
      for (const statement of result.data.statements ?? []) if (statement.quote.sourceRecordId !== source.sourceRecordId || !exactOccurrence(source.text, statement.quote.quote, statement.quote.occurrenceIndex)) throw new Error('Extraction model returned a fabricated or mismatched evidence quotation');
      const endpointClass = this.config.provider === 'google' ? 'google_api' : this.config.provider === 'anthropic' ? 'anthropic_api' : this.config.provider === 'openai' ? 'openai_api' : 'compatible_api';
      return { proposals: result.data, model: response.model, modelDigest: this.identity(response.model), endpointClass, promptVersion: EXTRACTION_PROMPT_VERSION, schemaVersion: EXTRACTION_SCHEMA_VERSION, parserVersion: EXTRACTION_PARSER_VERSION };
    }
    throw new Error('Extraction model returned invalid structured proposals after one repair attempt');
  }
}

const MutationProposalBatchSchemaJson = z.toJSONSchema(MutationProposalBatchSchema) as Record<string, unknown>;

/** Extraction compatibility wrapper for the generic task router used by the background service. */
export class RoutedExtractionAdapter implements ExtractionAdapter {
  readonly router: TaskModelRouter;
  readonly binding: TaskModelBinding;
  readonly allowCloud: boolean;
  constructor(router: TaskModelRouter, binding: TaskModelBinding, allowCloud: boolean) { this.router = router; this.binding = binding; this.allowCloud = allowCloud; }
  async probe(signal?: AbortSignal) {
    const result = await this.router.probe(this.binding, this.allowCloud ? 'cloud_allowed' : 'local_only', this.allowCloud, signal ?? AbortSignal.timeout(30_000));
    return { model: result.model, digest: result.modelDigest ?? result.route.fingerprint, capabilities: ['completion', result.outputMode] };
  }
  async extract(source: ExtractionSource, signal?: AbortSignal): Promise<ExtractionRun> {
    const input = JSON.stringify({ sourceRecordId: source.sourceRecordId, sourceRole: source.sourceRole, sourceText: source.text });
    const result = await this.router.generate(this.binding, { task: 'extract', sourcePolicy: source.modelRoute, allowCloud: this.allowCloud,
      schemaName: 'pal_memory_extraction_v1', schema: MutationProposalBatchSchema, jsonSchema: MutationProposalBatchSchemaJson,
      system: SYSTEM_PROMPT, input, maxOutputTokens: 2_048, maxInputCodePoints: 32_768, maxOutputCharacters: 64_000 }, signal ?? AbortSignal.timeout(60_000));
    for (const assertion of result.value.assertions) for (const quote of assertion.quotes) if (quote.sourceRecordId !== source.sourceRecordId || !exactOccurrence(source.text, quote.quote, quote.occurrenceIndex)) throw new Error('Extraction model returned a fabricated or mismatched evidence quotation');
    for (const statement of result.value.statements ?? []) if (statement.quote.sourceRecordId !== source.sourceRecordId || !exactOccurrence(source.text, statement.quote.quote, statement.quote.occurrenceIndex)) throw new Error('Extraction model returned a fabricated or mismatched evidence quotation');
    const endpointClass = result.route.adapterId === 'ollama' ? result.route.processing === 'cloud' ? 'ollama_cloud' : result.route.processing === 'remote' ? 'remote' : 'local'
      : result.route.adapterId === 'openai' ? 'openai_api' : result.route.adapterId === 'google' ? 'google_api' : result.route.adapterId === 'anthropic' ? 'anthropic_api' : 'compatible_api';
    return { proposals: result.value,taskRoute:result.route,outputMode:result.outputMode, model: result.model, modelDigest: result.modelDigest ?? result.route.fingerprint, endpointClass,
      promptVersion: EXTRACTION_PROMPT_VERSION, schemaVersion: EXTRACTION_SCHEMA_VERSION, parserVersion: EXTRACTION_PARSER_VERSION };
  }
}

/** Fixed Gemini endpoint; callers must enforce source eligibility before supplying text. */
export async function googleEmbeddings(access: ApiAccess, model: string, texts: string[], kind: 'query' | 'document', signal: AbortSignal): Promise<number[][]> {
  const id = model.replace(/^models\//, '');
  const response = await apiJson('google', access, `models/${encodeURIComponent(id)}:batchEmbedContents`, {
    requests: texts.map(text => ({ model: `models/${id}`, content: { parts: [{ text }] }, taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' })),
  }, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
  return response.embeddings?.map((e: any) => e.values);
}
