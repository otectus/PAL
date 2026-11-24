/**
 * Broker-owned definitions for hosted conversation providers. Secrets and named-account state do not
 * belong here: this registry describes protocols, public defaults and option validation only.
 */
import { xaiCollectionOptionFields } from './xai-collections.ts';
import { claudeEfforts } from './claude-models.ts';

export const apiProviderIds = [
  'openai', 'anthropic', 'google', 'azure_openai', 'deepseek', 'mistral', 'xai', 'perplexity',
  'openrouter', 'huggingface', 'litellm', 'forge', 'edenai', 'compatible',
] as const;
export type ApiProviderId = typeof apiProviderIds[number];

export type ProviderOperation = 'chat' | 'structured' | 'embed' | 'rerank' | 'search'
  | 'image.generate' | 'image.edit' | 'video.generate' | 'music.generate'
  | 'speech.transcribe' | 'speech.synthesize' | 'realtime' | 'ocr' | 'evaluate';
export type ConversationDialect = 'responses' | 'chat_completions' | 'anthropic_messages'
  | 'gemini_generate_content' | 'perplexity_agent';
export type ProviderAuth = 'bearer' | 'api-key' | 'google-api-key' | 'custom-api-key-header' | 'entra' | 'adc' | 'none';
export type ProviderCapability = 'local-tools' | 'parallel-tools' | 'images' | 'structured-output'
  | 'reasoning' | 'citations' | 'native-search' | 'file-input' | 'streaming' | 'background';
export type CapabilityGate = 'supported' | 'unsupported' | 'model' | 'connection' | 'unknown';

export type ProviderOptionChoice = { id: string; label: string; description?: string };
export type ProviderOptionField = {
  key: string;
  label: string;
  description?: string;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'string-list';
  default?: boolean | number | string | string[];
  required?: boolean;
  choices?: ProviderOptionChoice[];
  min?: number;
  max?: number;
  integer?: boolean;
  operations?: ProviderOperation[];
  variants?: string[];
};
export type ProviderVariant = {
  id: string;
  label: string;
  description?: string;
  baseUrl?: string;
  dialect: ConversationDialect;
  auth?: ProviderAuth[];
  beta?: boolean;
};
export type ProviderCatalog = {
  strategy: 'endpoint' | 'manual' | 'manifest';
  version?: string;
  path?: string;
  manual: boolean;
};
export const perplexityPresets = [
  {id:'fast',label:'Quick answer'}, {id:'low',label:'Light research'}, {id:'medium',label:'Balanced research'},
  {id:'high',label:'Research'}, {id:'xhigh',label:'Extended research'}, {id:'ultra',label:'Maximum research'},
] as const;
export function perplexityRoute(model:string,override?:unknown): {effort:string;model?:never}|{model:string;effort?:never} {
  if (/^(?:sonar|sonar-pro|sonar-reasoning(?:-pro)?|sonar-deep-research)$/i.test(model))
    throw new Error('This Sonar selection is retired. Review a current Agent preset or model.');
  const preset=model.startsWith('preset:')?model.slice(7):undefined;
  const selected=override || preset;
  if(selected!==undefined) {
    if (!perplexityPresets.some(row=>row.id===selected)) throw new Error('Choose an available Perplexity Agent effort');
    return {effort:String(selected)};
  }
  return {model};
}
export type ProviderDefinition = {
  id: ApiProviderId;
  label: string;
  docsUrl: string;
  baseUrl: string;
  dialect: ConversationDialect;
  dialects: ConversationDialect[];
  variants: ProviderVariant[];
  auth: ProviderAuth[];
  catalog: ProviderCatalog;
  operations: ProviderOperation[];
  optionsSchema: ProviderOptionField[];
  capabilities: Record<ProviderCapability, CapabilityGate>;
  lifecycle: 'active' | 'preview' | 'custom';
};

const nativeComputer:ProviderOptionField={key:'nativeComputer',label:'Reviewed desktop actions',type:'boolean',operations:['chat']};
const hostedWeb:ProviderOptionField={key:'webSearch',label:'Provider-hosted web search',type:'boolean',operations:['chat']};
const chat: ProviderOperation[] = ['chat', 'structured'];
const responseCapabilities: Record<ProviderCapability, CapabilityGate> = {
  'local-tools': 'supported', 'parallel-tools': 'model', images: 'model', 'structured-output': 'model',
  reasoning: 'model', citations: 'model', 'native-search': 'model', 'file-input': 'model',
  streaming: 'supported', background: 'unsupported',
};
const compatibleCapabilities: Record<ProviderCapability, CapabilityGate> = {
  'local-tools': 'connection', 'parallel-tools': 'connection', images: 'connection',
  'structured-output': 'connection', reasoning: 'connection', citations: 'connection',
  'native-search': 'connection', 'file-input': 'connection', streaming: 'connection', background: 'connection',
};
const choice = (id: string, label = id[0].toUpperCase() + id.slice(1)): ProviderOptionChoice => ({ id, label });
const reasoning = (choices = ['low', 'medium', 'high']): ProviderOptionField => ({
  key: 'reasoningEffort', label: 'Reasoning effort', type: 'enum', choices: choices.map(id => choice(id)), operations: chat,
});
const strictSchema: ProviderOptionField = { key: 'strictSchema', label: 'Strict function arguments', type: 'boolean', operations: ['chat','structured'] };

const outputSchema:ProviderOptionField={key:'outputSchema',label:'Reply JSON Schema',description:'A JSON object schema for the final reply.',type:'string',operations:['chat','structured']};
export const providerDefinitions: Readonly<Record<ApiProviderId, ProviderDefinition>> = {
  openai: {
    id: 'openai', label: 'OpenAI API', docsUrl: 'https://developers.openai.com/api/docs/guides/migrate-to-responses',
    baseUrl: 'https://api.openai.com/v1/', dialect: 'responses', dialects: ['responses'],
    variants: [{ id: 'responses', label: 'Responses', dialect: 'responses' }], auth: ['bearer'],
    catalog: { strategy: 'endpoint', path: 'models', manual: true },
    operations: [...chat, 'embed', 'search', 'image.generate', 'image.edit', 'speech.transcribe', 'speech.synthesize', 'realtime'],
    optionsSchema: [{key:'providerCode',label:'Run code in an OpenAI container',type:'boolean',operations:chat},
      {key:'vectorStoreIds',label:'Search these OpenAI vector stores',type:'string-list',operations:chat},nativeComputer,hostedWeb,reasoning(['minimal', 'low', 'medium', 'high', 'xhigh']), strictSchema, outputSchema, { key: 'store', label: 'Store provider response', type: 'boolean', default: false, operations: chat }],
    capabilities: { ...responseCapabilities, citations: 'supported', 'native-search': 'model', background: 'model' }, lifecycle: 'active',
  },
  anthropic: {
    id: 'anthropic', label: 'Claude API', docsUrl: 'https://platform.claude.com/docs/en/build-with-claude/streaming',
    baseUrl: 'https://api.anthropic.com/v1/', dialect: 'anthropic_messages', dialects: ['anthropic_messages'],
    variants: [{ id: 'messages', label: 'Messages', dialect: 'anthropic_messages' }], auth: ['api-key'],
    catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'search'],
    optionsSchema: [nativeComputer,hostedWeb,
      {key:'webFetch',label:'Open web pages on Claude’s servers',description:'Only addresses you wrote or its own search found.',type:'boolean',operations:chat},
      {key:'providerCode',label:'Run code on Claude’s servers',description:'In a container without internet access. Files it makes are kept with the conversation.',type:'boolean',operations:chat},
      {key:'promptCaching',label:'Prompt caching',description:'Reuses the unchanged start of a request for a few minutes. Writing it costs a little more, reading it much less.',type:'boolean',operations:chat},
      {key:'adaptiveThinking',label:'Think before answering',description:'For models that decide how much to think. Claude 5 does this on its own.',type:'boolean',operations:chat},
      reasoning([...claudeEfforts]), strictSchema, outputSchema,
      { key: 'thinkingBudget', label: 'Thinking token budget', description: 'For Claude 4.6 and earlier. Later models choose for themselves.', type: 'number', min: 1024, max: 128000, integer: true, operations: chat }],
    capabilities: { ...responseCapabilities, citations: 'supported', 'native-search': 'model' }, lifecycle: 'active',
  },
  google: {
    id: 'google', label: 'Google Gemini', docsUrl: 'https://ai.google.dev/gemini-api/docs',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', dialect: 'gemini_generate_content', dialects: ['gemini_generate_content'],
    variants: [
      { id: 'developer', label: 'Gemini Developer API', dialect: 'gemini_generate_content', auth: ['google-api-key'] },
      { id: 'vertex', label: 'Vertex AI', dialect: 'gemini_generate_content', auth: ['adc'] },
    ], auth: ['google-api-key', 'adc'], catalog: { strategy: 'endpoint', path: 'models?pageSize=1000', manual: true },
    operations: [...chat, 'embed', 'search', 'image.generate', 'image.edit', 'video.generate', 'music.generate', 'speech.transcribe', 'speech.synthesize', 'realtime'],
    optionsSchema: [hostedWeb,
      {key:'urlContext',label:'Read web pages named in the conversation',description:'Google opens up to 20 public pages for a request.',type:'boolean',operations:chat},
      {key:'providerCode',label:'Run code on Google’s servers',description:'Python for up to 30 seconds. Figures it draws are kept with the conversation.',type:'boolean',operations:chat},
      reasoning(['minimal', 'low', 'medium', 'high']), strictSchema,outputSchema],
    capabilities: { ...responseCapabilities, citations: 'supported', 'native-search': 'model' }, lifecycle: 'active',
  },
  azure_openai: {
    id: 'azure_openai', label: 'Azure OpenAI', docsUrl: 'https://learn.microsoft.com/azure/ai-foundry/model-inference/concepts/endpoints',
    baseUrl: '', dialect: 'responses', dialects: ['responses', 'chat_completions'],
    variants: [
      { id: 'v1', label: 'OpenAI v1', description: 'Implicit API versioning at /openai/v1', dialect: 'responses', auth: ['api-key', 'entra'] },
      { id: 'legacy', label: 'Legacy deployment API', dialect: 'chat_completions', auth: ['api-key', 'entra'] },
    ], auth: ['api-key', 'entra'], catalog: { strategy: 'manual', manual: true },
    operations: [...chat, 'embed', 'image.generate','image.edit', 'speech.transcribe', 'speech.synthesize', 'realtime'],
    optionsSchema: [reasoning(['minimal', 'low', 'medium', 'high']), strictSchema,outputSchema], capabilities: { ...responseCapabilities }, lifecycle: 'active',
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', docsUrl: 'https://api-docs.deepseek.com/api/create-response/',
    baseUrl: 'https://api.deepseek.com/', dialect: 'responses', dialects: ['responses', 'chat_completions'],
    variants: [{ id: 'responses', label: 'Responses', dialect: 'responses' }, { id: 'chat', label: 'Chat Completions', dialect: 'chat_completions' }],
    auth: ['bearer'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat],
    optionsSchema: [reasoning(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']), strictSchema, outputSchema, { key: 'thinking', label: 'Thinking mode', type: 'boolean', variants: ['chat'], operations: chat }],
    capabilities: { ...responseCapabilities, reasoning: 'supported' }, lifecycle: 'active',
  },
  mistral: {
    id: 'mistral', label: 'Mistral AI', docsUrl: 'https://docs.mistral.ai/inference/conversations/responses',
    baseUrl: 'https://api.mistral.ai/v1/', dialect: 'responses', dialects: ['responses', 'chat_completions'],
    variants: [{ id: 'responses', label: 'Responses', dialect: 'responses' }, { id: 'chat', label: 'Chat Completions', dialect: 'chat_completions' }],
    auth: ['bearer'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed', 'ocr', 'speech.transcribe','speech.synthesize'],
    optionsSchema: [reasoning(['low', 'medium', 'high']), strictSchema, outputSchema, { key: 'parallelToolCalls', label: 'Parallel tool calls', type: 'boolean', operations: chat }],
    capabilities: { ...responseCapabilities, 'file-input': 'model' }, lifecycle: 'active',
  },
  xai: {
    id: 'xai', label: 'Grok (xAI)', docsUrl: 'https://docs.x.ai/developers/rest-api-reference/inference/responses',
    baseUrl: 'https://api.x.ai/v1/', dialect: 'responses', dialects: ['responses'],
    variants: [{ id: 'responses', label: 'Responses', dialect: 'responses' }], auth: ['bearer'],
    catalog: { strategy: 'endpoint', path: 'models', manual: true },
    operations: [...chat, 'embed', 'search', 'image.generate', 'image.edit', 'video.generate', 'speech.transcribe', 'speech.synthesize', 'realtime'],
    optionsSchema: [reasoning(['low', 'high']), strictSchema, outputSchema, ...xaiCollectionOptionFields, { key: 'webSearch', label: 'Web Search', type: 'boolean', operations: chat }, { key: 'xSearch', label: 'X Search', type: 'boolean', operations: chat },
      {key:'allowedDomains',label:'Web Search domains',type:'string-list',operations:chat},
      {key:'xHandles',label:'X accounts to search',type:'string-list',operations:chat},
      {key:'fromDate',label:'Earliest X post (YYYY-MM-DD)',type:'string',operations:chat},
      {key:'toDate',label:'End date, exclusive (YYYY-MM-DD)',type:'string',operations:chat},
      {key:'providerCode',label:'Run code on xAI',type:'boolean',operations:chat}, { key: 'store', label: 'Store provider response', type: 'boolean', default: false, operations: chat }],
    capabilities: { ...responseCapabilities, citations: 'supported', 'native-search': 'supported' }, lifecycle: 'active',
  },
  perplexity: {
    id: 'perplexity', label: 'Perplexity', docsUrl: 'https://docs.perplexity.ai/docs/agent-api/quickstart',
    baseUrl: 'https://api.perplexity.ai/v1/', dialect: 'perplexity_agent', dialects: ['perplexity_agent'],
    variants: [{ id: 'agent', label: 'Agent API', dialect: 'perplexity_agent' }], auth: ['bearer'],
    catalog: { strategy: 'manifest', version:'2026-11', manual: true }, operations: [...chat, 'search', 'embed'],
    optionsSchema: [{key:'fetchPages',label:'Fetch pages on Perplexity',type:'boolean',operations:chat},hostedWeb,reasoning(['fast', 'low', 'medium', 'high', 'xhigh', 'ultra']), { key: 'searchDomains', label: 'Search domains', type: 'string-list', operations: ['chat', 'search'] }, { key: 'searchRecency', label: 'Search recency', type: 'enum', choices: ['day', 'week', 'month', 'year'].map(id => choice(id)), operations: ['chat', 'search'] }],
    capabilities: { ...responseCapabilities, citations: 'supported', 'native-search': 'supported', background: 'supported' }, lifecycle: 'active',
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', docsUrl: 'https://openrouter.ai/docs/api/api-reference/responses/create-a-response',
    baseUrl: 'https://openrouter.ai/api/v1/', dialect: 'responses', dialects: ['responses', 'chat_completions'],
    variants: [{ id: 'responses', label: 'Responses', dialect: 'responses' }, { id: 'chat', label: 'Chat Completions', dialect: 'chat_completions' }],
    auth: ['bearer'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed', 'image.generate', 'image.edit', 'speech.synthesize', 'speech.transcribe'],
    optionsSchema: [reasoning(['low', 'medium', 'high']), strictSchema, outputSchema, { key: 'allowedProviders', label: 'Allowed upstream providers', type: 'string-list', operations: chat }, { key: 'preferredProviders', label: 'Preferred upstream providers', type: 'string-list', operations: chat }, { key: 'allowFallbacks', label: 'Allow provider fallback', type: 'boolean', default: true, operations: chat }, { key: 'zeroDataRetention', label: 'Require zero data retention', type: 'boolean', operations: chat }],
    capabilities: { ...responseCapabilities, citations: 'model' }, lifecycle: 'active',
  },
  huggingface: {
    id: 'huggingface', label: 'Hugging Face', docsUrl: 'https://huggingface.co/docs/inference-providers/index',
    baseUrl: 'https://router.huggingface.co/v1/', dialect: 'chat_completions', dialects: ['chat_completions', 'responses'],
    variants: [
      { id: 'router', label: 'Inference Router', dialect: 'chat_completions', auth: ['bearer'] },
      { id: 'inference', label: 'Inference endpoint', description: 'A task-specific or dedicated endpoint', dialect: 'responses', auth: ['bearer'], beta: true },
    ], auth: ['bearer'], catalog: { strategy: 'endpoint', path: 'models', manual: true },
    operations: [...chat, 'embed', 'image.generate', 'speech.transcribe'], optionsSchema: [strictSchema, outputSchema, { key: 'servingProvider', label: 'Serving provider', type: 'string', variants: ['router'], operations: chat }],
    capabilities: { ...responseCapabilities, 'local-tools': 'model', streaming: 'model' }, lifecycle: 'active',
  },
  litellm: {
    id: 'litellm', label: 'LiteLLM', docsUrl: 'https://docs.litellm.ai/docs/proxy/quick_start',
    baseUrl: '', dialect: 'chat_completions', dialects: ['chat_completions', 'responses'],
    variants: [{ id: 'proxy', label: 'Proxy / Gateway', dialect: 'chat_completions' }, { id: 'bridge', label: 'Managed local bridge', dialect: 'chat_completions', baseUrl: 'http://127.0.0.1/litellm-bridge/v1/' }],
    auth: ['bearer', 'none'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed'],
    optionsSchema: [reasoning(['low', 'medium', 'high']), strictSchema,outputSchema], capabilities: { ...compatibleCapabilities }, lifecycle: 'active',
  },
  forge: {
    id: 'forge', label: 'TensorBlock Forge', docsUrl: 'https://github.com/TensorBlock/forge',
    baseUrl: 'https://api.forge.tensorblock.co/v1/', dialect: 'chat_completions', dialects: ['chat_completions'],
    variants: [{ id: 'hosted', label: 'Forge hosted', dialect: 'chat_completions' }, { id: 'self-hosted', label: 'Self-hosted Forge', dialect: 'chat_completions' }],
    auth: ['bearer'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed'], optionsSchema: [strictSchema,outputSchema],
    capabilities: { ...compatibleCapabilities }, lifecycle: 'active',
  },
  edenai: {
    id: 'edenai', label: 'Eden AI', docsUrl: 'https://www.edenai.co/docs/api-reference/chat/chat-completions',
    baseUrl: 'https://api.edenai.run/v3/', dialect: 'chat_completions', dialects: ['chat_completions'],
    variants: [{ id: 'v3', label: 'V3 gateway', dialect: 'chat_completions' }], auth: ['bearer'],
    catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed', 'video.generate'],
    optionsSchema: [strictSchema, outputSchema, { key: 'allowedProviders', label: 'Allowed upstream providers', type: 'string-list', operations: chat }, { key: 'allowFallbacks', label: 'Allow provider fallback', type: 'boolean', default: true, operations: chat }, { key: 'zeroDataRetention', label: 'Require zero data retention', type: 'boolean', operations: chat }, { key: 'qualityCost', label: 'Quality / cost preference', type: 'number', min: 0, max: 10, integer: true, operations: chat }],
    capabilities: { ...responseCapabilities, 'local-tools': 'supported', 'parallel-tools': 'model' }, lifecycle: 'active',
  },
  compatible: {
    id: 'compatible', label: 'Compatible endpoint', docsUrl: '', baseUrl: '', dialect: 'chat_completions', dialects: ['chat_completions', 'responses'],
    variants: [{ id: 'chat', label: 'Chat Completions', dialect: 'chat_completions' }, { id: 'responses', label: 'Responses', dialect: 'responses' }],
    auth: ['bearer', 'custom-api-key-header', 'none'], catalog: { strategy: 'endpoint', path: 'models', manual: true }, operations: [...chat, 'embed'], optionsSchema: [],
    capabilities: { ...compatibleCapabilities }, lifecycle: 'custom',
  },
};

export const providerImportAliases: Readonly<Record<string, ApiProviderId>> = {
  azure_openai: 'azure_openai', deepseek_api: 'deepseek', mistral_ai: 'mistral', x_ai: 'xai',
  open_router: 'openrouter', huggingface_api: 'huggingface', huggingface_router: 'huggingface',
  local_ai: 'compatible', litellm: 'litellm', forge: 'forge', edenai: 'edenai', perplexity: 'perplexity',
};

export function providerDefinition(value: unknown): ProviderDefinition | undefined {
  return typeof value === 'string' ? providerDefinitions[value as ApiProviderId] : undefined;
}
export function getProviderDefinition(value: unknown): ProviderDefinition {
  const definition = providerDefinition(value);
  if (!definition) throw new Error('Choose a supported API provider');
  return definition;
}

export type ProviderOptionContext = { variant?: string; operation?: ProviderOperation };
export function validateProviderOptions(provider: ApiProviderId, value: unknown, context: ProviderOptionContext = {}): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider options must be an object');
  const definition = getProviderDefinition(provider), result: Record<string, unknown> = {};
  const allowed = new Map(definition.optionsSchema.filter(field =>
    (!field.variants?.length || !!context.variant && field.variants.includes(context.variant))
    && (!field.operations?.length || !context.operation || field.operations.includes(context.operation))).map(field => [field.key, field]));
  for (const [key, option] of Object.entries(value)) {
    const field = allowed.get(key);
    if (!field) throw new Error(`${definition.label} does not support option “${key}”${context.variant ? ` for ${context.variant}` : ''}`);
    if (field.type === 'boolean' && typeof option !== 'boolean') throw new Error(`${field.label} must be on or off`);
    if (field.type === 'string' && (typeof option !== 'string' || !option.trim())) throw new Error(`${field.label} must be text`);
    if (field.type === 'number' && (typeof option !== 'number' || !Number.isFinite(option) || field.integer && !Number.isInteger(option) || field.min !== undefined && option < field.min || field.max !== undefined && option > field.max)) throw new Error(`${field.label} is outside its supported range`);
    if (field.type === 'enum' && (typeof option !== 'string' || !field.choices?.some(choice => choice.id === option))) throw new Error(`Choose a supported ${field.label.toLowerCase()}`);
    if (field.type === 'string-list' && (!Array.isArray(option) || option.length > 64 || option.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 256))) throw new Error(`${field.label} must be a list of non-empty values`);
    result[key] = field.type === 'string' ? (option as string).trim() : field.type === 'string-list' ? (option as string[]).map(entry => entry.trim()) : option;
  }
  if(result.vectorStoreIds && ((result.vectorStoreIds as string[]).length>8||(result.vectorStoreIds as string[]).some(id=>!/^vs_[a-zA-Z0-9_-]{1,128}$/.test(id))))throw new Error('Choose up to eight valid OpenAI vector store IDs belonging to this account');
  if(result.outputSchema){
    try{const raw=String(result.outputSchema);if(raw.length>8192)throw Error();
      const schema=JSON.parse(raw);if(schema?.type!=='object'||!schema.properties||Array.isArray(schema.properties)||typeof schema.properties!=='object')throw Error();
      result.outputSchema=JSON.stringify(schema);
    }catch{throw new Error('Enter an object JSON Schema with properties, up to 8192 characters');}
  }
  if(provider==='xai'){
    const domains=result.allowedDomains as string[]|undefined,handles=result.xHandles as string[]|undefined;
    if(domains && (domains.length>5 || domains.some(d=>!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d))))throw new Error('Choose up to five valid Web Search domains');
    if(handles && (handles.length>10 || handles.some(h=>!/^@?[A-Za-z0-9_]{1,15}$/.test(h))))throw new Error('Choose up to ten valid X handles');
    if(handles)result.xHandles=handles.map(h=>h.replace(/^@/,''));
    for(const key of ['fromDate','toDate'])if(result[key]){
      const value=String(result[key]),time=Date.parse(value+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0,10)!==value)throw new Error('Use a valid date in YYYY-MM-DD format');
    }
    if(result.fromDate && result.toDate && String(result.fromDate)>=String(result.toDate))throw new Error('The end date must follow the start date');
  }
  for (const field of allowed.values()) if (field.required && !(field.key in result)) throw new Error(`${field.label} is required`);
  return result;
}

export type CapabilityContext = { variant?: string; modelCapabilities?: readonly string[]; connectionCapabilities?: readonly string[] };
export function providerSupports(provider: ApiProviderId, capability: ProviderCapability, context: CapabilityContext = {}): boolean | Exclude<CapabilityGate, 'supported' | 'unsupported'> {
  const gate = getProviderDefinition(provider).capabilities[capability];
  if (gate === 'supported') return true;
  if (gate === 'unsupported') return false;
  if (gate === 'model' && context.modelCapabilities) return context.modelCapabilities.includes(capability);
  if (gate === 'connection' && (context.connectionCapabilities||context.modelCapabilities)) return !!(context.connectionCapabilities?.includes(capability)||context.modelCapabilities?.includes(capability));
  return gate;
}

export function resolveProviderDialect(provider: ApiProviderId, context: { variant?: string; preferred?: ConversationDialect } = {}): ConversationDialect {
  const definition = getProviderDefinition(provider);
  if (context.preferred && definition.dialects.includes(context.preferred)) return context.preferred;
  if (context.variant) {
    const variant = definition.variants.find(entry => entry.id === context.variant);
    if (!variant) throw new Error(`${definition.label} does not have a “${context.variant}” connection variant`);
    return variant.dialect;
  }
  return definition.dialect;
}

export function resolveProviderEndpoint(provider: ApiProviderId, route: { baseUrl?: string; variant?: string; apiVersion?: string } = {}): string {
  const definition = getProviderDefinition(provider);
  const variant = route.variant ? definition.variants.find(entry => entry.id === route.variant) : undefined;
  if (route.variant && !variant) throw new Error(`${definition.label} does not have a “${route.variant}” connection variant`);
  let base = route.baseUrl?.trim() || variant?.baseUrl || definition.baseUrl;
  if (!base) throw new Error(`Set the ${definition.label} endpoint in Settings → Connections`);
  base = base.replace(/\/+$/, '') + '/';
  if(provider==='azure_openai'){
    const legacy=route.variant==='legacy',url=new URL(base);
    if(url.search||url.hash)throw new Error('Enter the Azure resource endpoint without a query or fragment');
    if(!legacy && /\/openai\/deployments\//.test(url.pathname))throw new Error('Select the legacy API for a deployment-specific Azure endpoint');
    url.pathname=url.pathname.replace(/\/openai(?:\/v1)?\/$/,'/');
    if(!legacy)url.pathname+='openai/v1/';
    base=url.href;
  }
  if (route.apiVersion) base += (base.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(route.apiVersion);
  return base;
}
