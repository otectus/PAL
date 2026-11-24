import { platformAuth } from './provider-auth.ts';
/**
 * Named chat connections (11.1): an Ollama host or an OpenAI-compatible endpoint the user keeps under a
 * name, so a local server, another machine and a gateway can coexist without rewriting Settings. A
 * conversation binds to a connection when it is created; changing which connection is the default affects
 * new conversations only. Keys stay in the credentials store, bound to each endpoint's origin; SQLite
 * holds names, addresses and declarations. Each edit bumps a revision that invalidates stale authority.
 *
 * The first load copies today's Ollama host and compatible endpoint into connections without changing
 * their destinations or copying any key.
 */
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { CompatibleEndpoint, Session } from './types.ts';
import { getProviderDefinition, resolveProviderEndpoint } from './provider-registry.ts';
import { isApiProvider, type ApiProvider } from './provider-catalog.ts';
import { endpointOrigin, validEndpoint } from './compatible-endpoint.ts';
import { ollamaHost } from './ollama.ts';
import type { ProcessingClass } from './graph-memory/task-models.ts';

export type CompatibleTaskDialect = 'chat_completions' | 'responses';
export type TaskConnection = {
  connectionRef: string;
  connectionRevision: number;
  credentialRef: string;
  adapterId: 'ollama' | ApiProvider;
  endpoint: string;
  processing: ProcessingClass;
  dialect?: CompatibleTaskDialect;
};

export type ChatConnection = {
  id: string; kind: 'ollama' | ApiProvider; name: string; revision: number; created: number; updated: number;
  auth?:'entra'|'api-key'|'adc'; variant?: string; deployment?: string; apiVersion?: string; region?:string;underlyingModel?:string;
  /** OpenAI: the organization and project that requests are counted under. */
  organization?: string; project?: string;
  ollama?: { host: string }; compatible?: CompatibleEndpoint; migrated?: boolean;
  task?: { processing?: ProcessingClass; dialect?: CompatibleTaskDialect };
};
export function credentialDestination(connection: ChatConnection) {
  const url = connection.compatible?.baseUrl || '';
  if(connection.kind==='compatible'){
    const origin=endpointOrigin(url),header=connection.compatible?.authHeader;
    return header?JSON.stringify([origin,'api-key-header',header]):origin;
  }
  return JSON.stringify([url, connection.variant || '', connection.deployment || '', connection.apiVersion || '',connection.auth || '']);
}
export const connectionLimits = { connections: 128, name: 60 };
const blankEndpoint: CompatibleEndpoint = { baseUrl: '', label: '', requiresKey: false, tools: false, images: false, streaming: true, usage: false, contextLength: 0, maxOutputTokens: 0 };
const loopback = (value: string) => ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname.replace(/^\[|\]$/gu, ''));

export class ChatConnections {
  core: Core;
  private dependencyChecks = new Set<(connection: ChatConnection) => string | undefined>();
  constructor(core: Core) { this.core = core; this.migrate(); this.bindLegacyCredential(); }
  private rows(): ChatConnection[] { return this.core.store.db.prepare('SELECT data FROM provider_connections ORDER BY rowid').all().map(row => JSON.parse(String(row.data))); }
  list() { return this.rows(); }
  /** Lets background subsystems prevent deletion without coupling connections to their tables. */
  addDependencyCheck(check: (connection: ChatConnection) => string | undefined) { this.dependencyChecks.add(check); return () => this.dependencyChecks.delete(check); }
  get(id: unknown, kind?: ChatConnection['kind']): ChatConnection {
    const found = this.rows().find(row => row.id === id);
    if (!found) throw new Error('That connection no longer exists. Choose another in Settings › Connections.');
    if (kind && found.kind !== kind) throw new Error(`That connection is ${found.kind === 'ollama' ? 'an Ollama host' : 'a compatible endpoint'}, not for this provider`);
    return found;
  }
  private write(connection: ChatConnection) {
    this.core.store.db.prepare('INSERT INTO provider_connections (id, kind, revision, data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data')
      .run(connection.id, connection.kind, connection.revision, JSON.stringify(connection));
  }
  /** Copies the configured Ollama host and compatible endpoint once; destinations and keys are unchanged. */
  private migrate() {
    if (this.core.store.get('chatConnectionsMigrated', false)) return;
    const now = Date.now(), settings = this.core.settings;
    this.core.store.transaction(() => {
      if (settings.ollama?.host) this.write({ id: randomUUID(), kind: 'ollama', name: settings.ollama.host.includes('127.0.0.1') || settings.ollama.host.includes('localhost') ? 'Ollama on this computer' : `Ollama at ${new URL(settings.ollama.host).host}`, revision: 1, created: now, updated: now, ollama: { host: ollamaHost(settings.ollama.host) }, migrated: true });
      if (settings.compatible?.baseUrl) this.write({ id: randomUUID(), kind: 'compatible', name: settings.compatible.label || new URL(settings.compatible.baseUrl).host, revision: 1, created: now, updated: now, compatible: { ...settings.compatible }, migrated: true });
      this.core.store.set('chatConnectionsMigrated', true);
    });
  }
  private bindLegacyCredential() {
    const original = this.rows().find(row => row.kind === 'compatible' && row.migrated && row.compatible?.baseUrl);
    if (original) this.core.credentials.bindLegacyCompatible(`connection:${original.id}`, endpointOrigin(original.compatible!.baseUrl));
  }
  /** Keeps the default connections (the Settings host and endpoint) in step with Settings. */
  syncDefault(kind: ChatConnection['kind'], settings: import('./types.ts').Settings) {
    const current = this.rows().find(row => row.kind === kind && row.migrated), now = Date.now();
    if (kind === 'ollama' && !settings.ollama?.host || kind === 'compatible' && !settings.compatible?.baseUrl) return;
    const value = kind === 'ollama' ? { ollama: { host: ollamaHost(settings.ollama.host) } } : { compatible: { ...settings.compatible } };
    this.write({ id: current?.id || randomUUID(), kind, name: current?.name || (kind === 'ollama' ? 'Ollama (Settings default)' : settings.compatible.label || new URL(settings.compatible.baseUrl).host), revision: (current?.revision || 0) + 1, created: current?.created || now, updated: now, ...value, ...(current?.task ? { task: current.task } : {}), migrated: true });
  }
  /** Adds or edits one connection; an edit needs the revision the person saw. */
  save(p: any, notify=true): ChatConnection {
    if (!p || typeof p !== 'object') throw new Error('Invalid connection');
    const existing = p.id !== undefined ? this.get(p.id) : undefined;
    if (existing && p.expectedRevision !== existing.revision) throw new Error('This connection changed elsewhere. Review it again.');
    const kind = existing?.kind || p.kind;
    if (kind !== 'ollama' && !isApiProvider(kind)) throw new Error('Choose a registered conversation provider');
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > connectionLimits.name || /[\x00-\x1f\x7f]/.test(p.name)) throw new Error('Name the connection with 1–60 printable characters');
    if (!existing && this.rows().length >= connectionLimits.connections) throw new Error(`Keep at most ${connectionLimits.connections} connections`);
    const now = Date.now();
    const processing = p.processing ?? existing?.task?.processing;
    if (processing !== undefined && !['local', 'remote', 'cloud', 'unknown'].includes(processing)) throw new Error('Choose where this connection processes requests');
    const dialect = p.dialect ?? (kind==='compatible'&&p.variant?(p.variant==='responses'?'responses':'chat_completions'):existing?.task?.dialect);
    if (dialect !== undefined && !['chat_completions', 'responses'].includes(dialect)) throw new Error('Choose Chat Completions or Responses for this compatible endpoint');
    if (kind !== 'compatible' && dialect !== undefined) throw new Error('An Ollama connection does not use an OpenAI-compatible dialect');
    const dedicated = isApiProvider(kind) && kind !== 'compatible';
    const definition = isApiProvider(kind) ? getProviderDefinition(kind) : undefined;
    const variant = p.variant ?? existing?.variant;
    if (variant && !definition?.variants.some((v: any) => (v.id ?? v) === variant)) throw new Error('Choose a registered provider variant');
    const auth=p.auth ?? existing?.auth;
    if (auth!==undefined && !(kind==='azure_openai' && ['entra','api-key'].includes(auth) || kind==='google' && variant==='vertex' && auth==='adc')) throw new Error('Choose a supported account authentication method');
    const deployment = p.deployment ?? existing?.deployment, apiVersion = p.apiVersion ?? existing?.apiVersion;
    for (const field of [deployment, apiVersion]) if (field && (kind !== 'azure_openai' || typeof field !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(field))) throw new Error('Invalid Azure deployment or API version');
    const region=p.region??existing?.region,underlyingModel=p.underlyingModel??existing?.underlyingModel;
    const organization=p.organization??existing?.organization,project=p.project??existing?.project;
    if(organization&&(kind!=='openai'||typeof organization!=='string'||!/^org-[A-Za-z0-9_-]{1,64}$/.test(organization)))throw new Error('Enter an OpenAI organization ID, such as org-abc123');
    if(project&&(kind!=='openai'||typeof project!=='string'||!/^proj_[A-Za-z0-9_-]{1,64}$/.test(project)))throw new Error('Enter an OpenAI project ID, such as proj_abc123');
    if(region&&(kind!=='azure_openai'||typeof region!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(region)))throw new Error('Enter a valid Azure region name');
    if(underlyingModel&&(kind!=='azure_openai'||typeof underlyingModel!=='string'||!/^[a-zA-Z0-9._:/-]{1,160}$/.test(underlyingModel)))throw new Error('Enter a valid Azure underlying model ID');
    const defaults = dedicated ? {...blankEndpoint, requiresKey: true, baseUrl: resolveProviderEndpoint(kind, {baseUrl:p.endpoint?.baseUrl || existing?.compatible?.baseUrl, variant}), ...(kind==='litellm'&&variant==='bridge'?{tools:true,streaming:false,usage:true}:{})} : blankEndpoint;
    const next: ChatConnection = { id: existing?.id || randomUUID(), kind, name: p.name.trim(), revision: (existing?.revision || 0) + 1, created: existing?.created || now, updated: now,
      ...(auth ? {auth} : {}), ...(variant ? {variant} : {}), ...(deployment ? {deployment} : {}), ...(apiVersion ? {apiVersion} : {}),...(region?{region}:{}),...(underlyingModel?{underlyingModel}:{}),...(organization?{organization}:{}),...(project?{project}:{}),
      ...(kind === 'ollama' ? { ollama: { host: ollamaHost(p.host ?? existing?.ollama?.host) } } : { compatible: validEndpoint({ ...(p.endpoint || {}), ...(dedicated ? {baseUrl:defaults.baseUrl} : {}), label: p.name.trim() }, existing?.compatible || defaults, kind==='compatible') }),
      ...((processing !== undefined || dialect !== undefined) ? { task: { ...(processing !== undefined ? { processing } : {}), ...(kind === 'compatible' ? { dialect: dialect ?? 'chat_completions' } : {}) } } : {}) };
    if (kind !== 'ollama' && !next.compatible!.baseUrl) throw new Error('Enter the endpoint’s base URL');
    const taskEndpoint = kind === 'ollama' ? next.ollama!.host : next.compatible!.baseUrl;
    if (next.task?.processing === 'local' && !loopback(taskEndpoint)) throw new Error('Only a loopback connection can process on this computer; choose own server, cloud, or unknown');
    platformAuth(next);
    this.write(next);
    if(notify)this.core.changed();
    return next;
  }
  /** A connection in use stays until its conversations move or are deleted. */
  remove(id: unknown) {
    const connection = this.get(id), bound = this.core.store.sessions().filter(session => session.connectionId === connection.id);
    if (bound.length) throw new Error(`${bound.length} conversation${bound.length === 1 ? ' uses' : 's use'} this connection. Move or delete ${bound.length === 1 ? 'it' : 'them'} first.`);
    for (const check of this.dependencyChecks) { const reason = check(connection); if (reason) throw new Error(reason); }
    this.core.store.transaction(()=>{
      this.core.store.db.prepare('DELETE FROM provider_connections WHERE id=?').run(connection.id);
      this.core.credentials.removeAccount(connection.id);
    });
    this.core.changed();
    return true;
  }
  /** The compatible endpoint a conversation uses: its connection's, or the one in Settings for older ones. */
  endpoint(session?: Session): CompatibleEndpoint {
    this.bindLegacyCredential();
    if (session?.connectionId && session.provider === 'compatible') {
      // A conversation never falls back to another destination when its own connection is gone.
      const connection = this.rows().find(row => row.id === session.connectionId && row.kind === 'compatible');
      if (!connection?.compatible) throw new Error('This conversation’s connection no longer exists. Move it to another connection in its model settings.');
      return connection.compatible;
    }
    return this.core.settings.compatible;
  }
  /** A key-free, task-neutral route descriptor. The credential store resolves credentialRef separately. */
  taskConnection(id: unknown): TaskConnection {
    this.bindLegacyCredential();
    const connection = this.get(id);
    if (connection.kind === 'ollama') {
      const endpoint = connection.ollama!.host;
      const inferred: ProcessingClass = loopback(endpoint) ? 'local' : 'unknown';
      return { connectionRef: `connection:${connection.id}`, connectionRevision: connection.revision, credentialRef: `connection:${connection.id}`, adapterId: 'ollama', endpoint,
        processing: connection.task?.processing === 'local' && !loopback(endpoint) ? 'unknown' : connection.task?.processing ?? inferred };
    }
    const declared = connection.task?.processing ?? connection.compatible!.processing ?? (connection.kind === 'compatible' ? 'unknown' : 'cloud');
    return { connectionRef: `connection:${connection.id}`, connectionRevision: connection.revision, credentialRef: `connection:${connection.id}`, adapterId: connection.kind, endpoint: connection.compatible!.baseUrl,
      processing: declared === 'local' && !loopback(connection.compatible!.baseUrl) ? 'unknown' : declared, dialect: connection.task?.dialect ?? 'chat_completions' };
  }
  /** For the interface: no keys, only whether the endpoint's origin has one. */
  snapshot() {
    this.bindLegacyCredential();
    return this.rows().map(connection => ({ id: connection.id, kind: connection.kind, name: connection.name, revision: connection.revision, migrated: !!connection.migrated,
      ...(connection.kind==='xai'?{managementKeySet:!!this.core.credentials.key('xai_management','https://management-api.x.ai','connection:'+connection.id+':xai-management')}:{}),
      ...(connection.ollama ? { host: connection.ollama.host } : {}),
      ...(connection.compatible ? { endpoint: { ...connection.compatible }, auth:connection.auth, variant: connection.variant, deployment:connection.deployment, apiVersion:connection.apiVersion,region:connection.region,underlyingModel:connection.underlyingModel,organization:connection.organization,project:connection.project, keySet: !!platformAuth(connection) || connection.kind !== 'ollama' && !!this.core.credentials.key(connection.kind, credentialDestination(connection), `connection:${connection.id}`) } : {}),
      task: this.taskConnection(connection.id),
      conversations: this.core.store.sessions().filter(session => session.connectionId === connection.id).length }));
  }
}
