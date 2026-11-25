/**
 * The models a drop-down can offer for one use: a conversation, embeddings, speech, pictures, video, OCR and so on.
 *
 * A list comes from the account's own catalog. What PAL names itself (the defaults it uses and models named in a
 * provider's documentation) is added where the catalog does not list it, marked as such, so that a service without a
 * catalog still offers something. A list that cannot be loaded is reported beside what is known; it is never an error,
 * because a model can always be entered by its ID.
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { apiModels, catalogOperations, type CatalogOperation } from './api-providers.ts';
import type { Core } from './core.ts';
import { jevModels } from './evaluation-services.ts';
import { googleImageModels } from './media/backends/google.ts';
import { openaiImageModels } from './media/backends/openai.ts';
import { xaiImageModels } from './media/backends/xai.ts';
import { ollamaModels, withOllamaCredential } from './ollama.ts';
import { isApiProvider, providerIds } from './provider-catalog.ts';
import { responseJson } from './provider-http.ts';
import { huggingFaceTasks } from './provider-inference/contracts.ts';
import { speechServerModels } from './speech/recognizers.ts';
import type { ModelOption, Provider } from './types.ts';

/** Sources that are not conversation providers, with the one use each has. */
const services = { voyage: ['embed', 'rerank'], jev: ['evaluate'], whisper: ['speech.transcribe'], 'local-server': ['speech.transcribe'] } as const;
const operations = [...catalogOperations, 'rerank', 'evaluate', 'inference'] as const;
export type ModelUse = typeof operations[number];
const request = z.strictObject({
  provider: z.string().min(1).max(40), connectionId: z.uuid().optional(), operation: z.enum(operations).default('chat'),
  /** A Hugging Face task, for `inference`. */
  task: z.enum(huggingFaceTasks).optional(),
  /** The address of a speech server on this computer. */
  url: z.string().max(200).optional(),
  /** Only what is known without asking a service. */
  known: z.boolean().optional(), refresh: z.boolean().optional(),
});
export type ModelChoices = { models: ModelOption[]; live: boolean; unlisted?: true; problem?: string };
const unlisted = 'This service does not list its models. Enter a model ID.';

/** Voyage has no catalog request; these are the current models of its documentation (checked 2026-11-24). */
const voyageEmbeddings = ['voyage-4-large', 'voyage-4', 'voyage-4-lite', 'voyage-code-4', 'voyage-finance-2', 'voyage-law-2'];
const voyageRerankers = ['rerank-3', 'rerank-3-lite', 'rerank-2.5', 'rerank-2.5-lite'];
/** The models PAL itself falls back to or starts from, by use and provider. */
const named: Partial<Record<ModelUse, Record<string, string[]>>> = {
  embed: { ollama: ['nomic-embed-text'], google: ['gemini-embedding-001'], voyage: voyageEmbeddings },
  rerank: { voyage: voyageRerankers },
  'speech.synthesize': { openai: ['gpt-4o-mini-tts'], openrouter: ['openai/gpt-4o-mini-tts'], mistral: ['voxtral-mini-tts-3-0'] },
  'speech.transcribe': { openai: ['whisper-1'], xai: ['grok-voice-transcribe-2.0'], mistral: ['voxtral-mini-transcribe-3'], openrouter: ['openai/whisper-large-v3'], google: ['gemini-flash-lite-latest'] },
  'image.generate': { openai: openaiImageModels, google: googleImageModels, xai: xaiImageModels },
  'video.generate': { google: ['gemini-omni-1.2-flash'], xai: ['grok-imagine-video'], edenai: ['video/generation_async/bytedance'] },
  'music.generate': { google: ['lyria-3.5'] },
  ocr: { mistral: ['mistral-ocr-latest'] },
};
const option = (id: string, rest: Partial<ModelOption> = {}): ModelOption => ({ id, displayName: id, description: '', efforts: [], defaultEffort: '', isDefault: false, ...rest });
const said = (error: unknown) => String((error as any)?.message || error).replace(/\s+/g, ' ').slice(0, 300);
export const modelChoiceLimits = { keptMs: 10 * 60_000, kept: 64, files: 100 };

/** GGML models of whisper.cpp: beside the one in use, and in the folders its packages and scripts put them. */
export async function whisperModels(current: string | undefined, home = homedir(), data = process.env.XDG_DATA_HOME || join(home, '.local/share'), shared = '/usr/share'): Promise<ModelOption[]> {
  const folders = new Set([...(current?.startsWith('/') ? [dirname(current)] : []), join(data, 'whisper.cpp'), join(data, 'whisper.cpp/models'), join(home, '.cache/whisper'), join(home, 'whisper.cpp/models'), join(shared, 'whisper.cpp/models')]);
  for (const name of await readdir(shared).catch(() => [])) if (name.startsWith('whisper.cpp-model')) folders.add(join(shared, name));
  const found: ModelOption[] = [];
  for (const folder of folders) for (const name of (await readdir(folder).catch(() => [])).sort()) {
    if (found.length >= modelChoiceLimits.files || !/^ggml-.+\.bin$/.test(name) || /^ggml-silero/.test(name)) continue;
    const path = join(folder, name), file = await stat(path).catch(() => undefined);
    if (file?.isFile() && !found.some(row => row.id === path)) found.push(option(path, { displayName: name.replace(/^ggml-|\.bin$/g, ''), detail: `${Math.round(file.size / 1048576)} MiB · ${folder}` }));
  }
  return found;
}

export class ModelChoiceList {
  core: Core; fetch: typeof fetch = fetch;
  private kept = new Map<string, { at: number; models: ModelOption[] }>();
  constructor(core: Core) { this.core = core; }

  async choices(params: unknown): Promise<ModelChoices> {
    const p = request.parse(params), service = services[p.provider as keyof typeof services] as readonly string[] | undefined;
    if (service ? !service.includes(p.operation) : !(providerIds as readonly string[]).includes(p.provider)) throw new Error('Choose a provider that offers models for this');
    if (p.operation === 'inference' && (p.provider !== 'huggingface' || !p.task)) throw new Error('Choose a Hugging Face task');
    const suggested = named[p.operation]?.[p.provider] || [];
    const merged = (models: ModelOption[], live: boolean, problem?: string): ModelChoices => ({ live, ...((models as { unlisted?: boolean }).unlisted ? { unlisted: true, problem: unlisted } : problem ? { problem } : {}),
      models: [...models, ...suggested.filter(id => !models.some(model => model.id === id || model.id === id + ':latest')).map(id => option(id, { detail: live ? 'Named by PAL; not in this account’s list' : 'Named by PAL' }))] });
    if (p.provider === 'voyage') return merged([], true);
    // Files on this computer are looked at each time.
    if (p.provider === 'whisper') return merged(await whisperModels(this.core.settings.transcription?.model), true);
    const key = this.key(p), kept = this.kept.get(key), fresh = !p.refresh && kept && Date.now() - kept.at < modelChoiceLimits.keptMs ? kept.models : this.stated(p);
    if (fresh) return merged(fresh, true);
    if (p.known) return merged([], false);
    try {
      const models = await this.load(p);
      // An account changed while its list was on the way has another key; the old list is nobody's.
      if (this.key(p) === key) { this.kept.delete(key); this.kept.set(key, { at: Date.now(), models }); if (this.kept.size > modelChoiceLimits.kept) this.kept.delete(this.kept.keys().next().value!); }
      return merged(models, true);
    } catch (error) { return merged([], false, said(error)); }
  }

  /** What is asked, of which account and with which credential: a changed key or endpoint is another list. */
  private key(p: z.infer<typeof request>) {
    const account = p.connectionId ? this.core.chatConnections.get(p.connectionId) : undefined;
    if (account && account.kind !== p.provider) throw new Error('Choose an account of this provider');
    const credential = this.core.credentials.credentialRevision(account ? 'connection:' + account.id : 'provider:' + p.provider);
    const place = p.provider === 'ollama' && !account ? this.core.settings.ollama.host : p.provider === 'compatible' && !account ? this.core.settings.compatible.baseUrl : '';
    return JSON.stringify([p.provider, p.operation, p.task, p.url, account?.id, account?.revision, credential, place]);
  }
  /** The conversation catalog of a default account is already part of PAL's state. */
  private stated(p: z.infer<typeof request>): ModelOption[] | undefined {
    if (p.operation !== 'chat' || p.connectionId || p.refresh) return undefined;
    const state = this.core.capabilities[p.provider as Provider];
    return state?.modelsStatus === 'ready' ? state.models : undefined;
  }
  private async load(p: z.infer<typeof request>): Promise<ModelOption[]> {
    if (p.provider === 'jev') return (await jevModels(this.core.credentials.key('jev'), this.fetch)).map(row => option(row.name, { detail: [row.description, row.release_date ? 'released ' + row.release_date : ''].filter(Boolean).join(' · ').slice(0, 300) }));
    if (p.provider === 'local-server') return (await speechServerModels(p.url, this.fetch)).map(id => option(id));
    if (p.operation === 'inference') return this.hub(p.task!);
    const operation = p.operation as CatalogOperation;
    if (p.connectionId) return this.core.accountModels(this.core.chatConnections.get(p.connectionId), operation);
    if (p.provider === 'ollama' && operation === 'embed') return withOllamaCredential(this.core.ollamaKey(), () => ollamaModels(this.core.settings.ollama.host, 'embedding'));
    if (operation === 'chat' || !isApiProvider(p.provider)) { if (operation !== 'chat') throw new Error('This provider lists models for conversations only'); return this.core.refreshProviderModels(p.provider as Provider); }
    return apiModels(p.provider, this.core.accountAccess(p.provider), operation);
  }
  /** Public models the Hugging Face service runs for one task. The request names only the task. */
  private async hub(task: string): Promise<ModelOption[]> {
    const url = `https://huggingface.co/api/models?inference_provider=hf-inference&pipeline_tag=${encodeURIComponent(task)}&sort=downloads&limit=60`;
    const rows = await responseJson(await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) }), 2 * 1024 * 1024);
    if (!Array.isArray(rows)) throw new Error('Hugging Face returned an unexpected list');
    return rows.flatMap((row: any) => typeof row?.id === 'string' && /^\w[\w.-]*(?:\/\w[\w.-]*)?$/.test(row.id) && row.id.length <= 200 ? [option(row.id, { detail: Number.isSafeInteger(row.downloads) ? `${Number(row.downloads).toLocaleString('en-US')} downloads a month` : '' })] : []).slice(0, 60);
  }
}
