import { apiProviderIds, providerDefinitions, type ApiProviderId,type ProviderDefinition } from './provider-registry.ts';

export const providerIds = ['codex', 'claude', 'ollama', 'antigravity', ...apiProviderIds] as const;
export type ProviderId = typeof providerIds[number];
export type ApiProvider = ApiProviderId;
export const apiProviders: ApiProvider[] = [...apiProviderIds];
export function isApiProvider(value: unknown): value is ApiProvider { return apiProviders.includes(value as ApiProvider); }
export const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex', claude: 'Claude Code', ollama: 'Ollama', antigravity: 'AntiGravity',
  ...Object.fromEntries(apiProviders.map(id => [id, providerDefinitions[id].label])) as Record<ApiProvider, string>,
};

/** Broker-owned UI behavior. Runtime availability and per-model capability gates are reported separately. */
export type ProviderTraits = {
  label: string;
  kind: 'cli' | 'local' | 'api';
  modelRequired: boolean; customModel: boolean;
  effort: boolean;
  images: 'yes' | 'per-model' | 'per-endpoint' | 'no';
  tools: 'cere' | 'native';
  webSearch: boolean;
  importHistory: boolean; resume: boolean;
  queue: boolean;
  configure: boolean;
  billed: boolean;
  remote: 'restricted' | 'withheld';
  remoteNote: string;
} & Partial<Pick<ProviderDefinition,'auth'|'variants'|'operations'|'optionsSchema'|'capabilities'|'docsUrl'|'dialect'|'catalog'>>;

export const providerTraitSchemas = {
  kind: { type: 'enum', values: ['cli', 'local', 'api'] },
  modelRequired: { type: 'boolean' }, customModel: { type: 'boolean' }, effort: { type: 'boolean' },
  images: { type: 'enum', values: ['yes', 'per-model', 'per-endpoint', 'no'] },
  tools: { type: 'enum', values: ['cere', 'native'] }, webSearch: { type: 'boolean' },
  importHistory: { type: 'boolean' }, resume: { type: 'boolean' }, queue: { type: 'boolean' },
  configure: { type: 'boolean' }, billed: { type: 'boolean' },
  remote: { type: 'enum', values: ['restricted', 'withheld'] }, remoteNote: { type: 'string' },
} as const;

const cloudNote = 'Uses the selected account on the desktop; requests may be billed. PAL tools stay limited to this phone’s grants.';
const apiTrait = (id: ApiProvider, changes: Partial<ProviderTraits> = {}): ProviderTraits => ({
  variants:providerDefinitions[id].variants,auth:providerDefinitions[id].auth,operations:providerDefinitions[id].operations,
  optionsSchema:providerDefinitions[id].optionsSchema,capabilities:providerDefinitions[id].capabilities,docsUrl:providerDefinitions[id].docsUrl,
  dialect:providerDefinitions[id].dialect,catalog:providerDefinitions[id].catalog,
  label: providerLabels[id], kind: 'api', modelRequired: true, customModel: true,
  effort: providerDefinitions[id].optionsSchema.some(field => field.key === 'reasoningEffort'),
  images: providerDefinitions[id].capabilities.images === 'connection' ? 'per-endpoint' : providerDefinitions[id].capabilities.images === 'unsupported' ? 'no' : 'per-model',
  tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: false, configure: true, billed: true,
  remote: 'restricted', remoteNote: cloudNote, ...changes,
});

export const providerTraits: Record<ProviderId, ProviderTraits> = {
  codex: { label: providerLabels.codex, kind: 'cli', modelRequired: false, customModel: false, effort: true, images: 'yes', tools: 'native', webSearch: false, importHistory: true, resume: true, queue: false, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs in Codex’s restricted sandbox; its permission requests come to you.' },
  claude: { label: providerLabels.claude, kind: 'cli', modelRequired: false, customModel: false, effort: true, images: 'yes', tools: 'native', webSearch: false, importHistory: true, resume: true, queue: false, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs only with a Claude Code that supports restricted mode; file tools stay in the project and code-running tools are off.' },
  ollama: { label: providerLabels.ollama, kind: 'local', modelRequired: true, customModel: false, effort: false, images: 'per-model', tools: 'cere', webSearch: true, importHistory: false, resume: false, queue: true, configure: true, billed: false,
    remote: 'restricted', remoteNote: 'Runs on the desktop’s granted Ollama server with PAL’s tools limited to this phone’s grants.' },
  antigravity: { label: providerLabels.antigravity, kind: 'cli', modelRequired: false, customModel: false, effort: false, images: 'no', tools: 'native', webSearch: false, importHistory: false, resume: true, queue: false, configure: false, billed: false,
    remote: 'withheld', remoteNote: 'AntiGravity’s headless mode cannot prove restricted execution, so turns start only on the desktop. Its conversations can still be read here.' },
  openai: apiTrait('openai', { images: 'yes' }),
  anthropic: apiTrait('anthropic', { images: 'yes' }),
  google: apiTrait('google', { images: 'yes' }),
  azure_openai: apiTrait('azure_openai'),
  deepseek: apiTrait('deepseek'),
  mistral: apiTrait('mistral'),
  xai: apiTrait('xai'),
  perplexity: apiTrait('perplexity'),
  openrouter: apiTrait('openrouter'),
  huggingface: apiTrait('huggingface'),
  litellm: apiTrait('litellm', { images: 'per-endpoint' }),
  forge: apiTrait('forge', { images: 'per-endpoint' }),
  edenai: apiTrait('edenai'),
  compatible: apiTrait('compatible', { images: 'per-endpoint', remoteNote: 'Uses the endpoint account the desktop granted to this phone; a changed destination needs a new grant.' }),
};
