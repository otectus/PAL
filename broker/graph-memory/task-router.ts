import { z } from 'zod';
import { credentialDestination, type ChatConnection } from '../connections.ts';
import { HttpStatusError } from '../http-retry.ts';
import { bindingSchema, assertTaskRouteAllowed, routeFingerprint, StaleTaskRouteError, TaskProviderFinishError, TaskRoutePolicyError,
  type ProcessingClass, type ResolvedTaskRoute, type StructuredTaskRequest, type StructuredTaskResult,
  type TaskModelBinding, type TaskModelCapabilities, type TaskOutputMode, type TaskProviderAdapter } from './task-models.ts';

import { resolveProviderEndpoint } from '../provider-registry.ts';
import { platformAuth } from '../provider-auth.ts';
import type { ApiProvider as CredentialProvider } from '../provider-catalog.ts';
import type { ApiAccess } from '../api-providers.ts';
export interface TaskCredentialSource {
  key(provider: CredentialProvider, origin?: string, credentialRef?: string): string;
  /** Opaque monotonic/random revision. It must never be derived from the key. */
  credentialRevision?(credentialRef: string): string;
  revision?(credentialRef: string): string;
}

export interface TaskConnectionResolverOptions {
  credentials: TaskCredentialSource;
  readConnection(id: string): ChatConnection;
  defaultOllamaHost(): string;
}

type DispatchRoute = ResolvedTaskRoute & { access?:()=>ApiAccess; key(): string; dialect?: 'chat_completions' | 'responses'; runtimeModelId?: string };

function inferredProcessing(endpoint: string): ProcessingClass {
  const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, '');
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? 'local' : 'unknown';
}

function declaredProcessing(endpoint: string, processing: ProcessingClass): ProcessingClass {
  // A remote URL cannot prove processing happens on this computer. Fail closed even if stale data says local.
  return processing === 'local' && inferredProcessing(endpoint) !== 'local' ? 'unknown' : processing;
}

export class TaskConnectionResolver {
  readonly options: TaskConnectionResolverOptions;
  constructor(options: TaskConnectionResolverOptions) { this.options = options; }

  private credentialRevision(ref: string) {
    return this.options.credentials.credentialRevision?.(ref) ?? this.options.credentials.revision?.(ref) ?? 'legacy-unversioned';
  }

  resolve(bindingValue: TaskModelBinding, describe: (adapterId: string, processing: ProcessingClass) => TaskModelCapabilities): DispatchRoute {
    const binding = bindingSchema.parse(bindingValue);
    let base: Omit<DispatchRoute, 'fingerprint' | 'capabilities' | 'modelId'>;
    if (binding.connectionRef === 'default:ollama') {
      const endpoint = this.options.defaultOllamaHost();
      base = { connectionRef: binding.connectionRef, connectionRevision: 0, credentialRef: 'none', credentialRevision: 'none', adapterId: 'ollama', endpoint,
        processing: inferredProcessing(endpoint), key: () => '' };
    } else if (binding.connectionRef.startsWith('native:')) {
      const provider = binding.connectionRef.slice(7) as Exclude<CredentialProvider, 'compatible'>;

      const credentialRef = `provider:${provider}`;
      base = { connectionRef: binding.connectionRef, connectionRevision: 1, credentialRef, credentialRevision: this.credentialRevision(credentialRef), adapterId: provider,
        endpoint: resolveProviderEndpoint(provider).replace(/\/$/,''), processing: 'cloud', key: () => this.options.credentials.key(provider, undefined, credentialRef) };
    } else {
      const id = binding.connectionRef.slice('connection:'.length), connection = this.options.readConnection(id), credentialRef = `connection:${connection.id}`;
      if (connection.kind === 'ollama') {
        const endpoint = connection.ollama!.host;
        base = { connectionRef: binding.connectionRef, connectionRevision: connection.revision, credentialRef, credentialRevision: 'none', adapterId: 'ollama', endpoint,
          processing: declaredProcessing(endpoint, connection.task?.processing ?? inferredProcessing(endpoint)), key: () => '' };
      } else if (connection.kind!=='compatible') {
        const provider=connection.kind, endpoint=connection.compatible!, rev=this.credentialRevision(credentialRef), token=platformAuth(connection);
        const key=()=>this.options.credentials.key(provider,credentialDestination(connection),credentialRef);
        base={connectionRef:binding.connectionRef,connectionRevision:connection.revision,credentialRef,credentialRevision:rev,adapterId:provider,endpoint:endpoint.baseUrl,
          processing:declaredProcessing(endpoint.baseUrl,connection.task?.processing || 'cloud'),key,
          access:()=>({key:token?()=>'platform-identity':key,token,endpoint:()=>endpoint,route:()=>({baseUrl:endpoint.baseUrl,variant:connection.variant,deployment:connection.deployment,apiVersion:connection.apiVersion})})};
      } else {
        const configured=connection.compatible!,endpoint=configured.baseUrl,destination=credentialDestination(connection);
        const key=()=>this.options.credentials.key('compatible',destination,credentialRef);
        base = { connectionRef: binding.connectionRef, connectionRevision: connection.revision, credentialRef, credentialRevision: this.credentialRevision(credentialRef), adapterId: 'compatible', endpoint,
          processing: declaredProcessing(endpoint, connection.task?.processing ?? configured.processing ?? 'unknown'), dialect: connection.task?.dialect ?? 'chat_completions',key,
          access:()=>({key,endpoint:()=>configured,route:()=>({baseUrl:endpoint,variant:connection.task?.dialect==='responses'?'responses':'chat'})}) };
      }
    }
    const withoutCapabilities = { ...base, modelId: binding.modelId };
    const publicBase = { ...withoutCapabilities };
    delete (publicBase as Partial<DispatchRoute>).access;
    delete (publicBase as Partial<DispatchRoute>).key;
    delete (publicBase as Partial<DispatchRoute>).dialect;
    const fingerprint = routeFingerprint(publicBase as Omit<ResolvedTaskRoute, 'fingerprint' | 'capabilities'>);
    return { ...withoutCapabilities, capabilities: describe(withoutCapabilities.adapterId, withoutCapabilities.processing), fingerprint };
  }
}

const probeSchema = z.object({ schemaVersion: z.literal(1), targetVersionId: z.literal('synthetic-target'), support: z.literal('insufficient'), evidenceIds: z.tuple([z.literal('synthetic-evidence')]), abstain: z.literal(true) }).strict();
const probeJsonSchema = z.toJSONSchema(probeSchema) as Record<string, unknown>;

export type TaskProbeResult = {
  route: ResolvedTaskRoute;
  outputMode: TaskOutputMode;
  checked: { structuredOutput: true; abstention: true; evidenceIds: true; finishState: true };
  model: string;
  modelVersion?: string;
  modelDigest?: string;
};

export class TaskModelRouter {
  private adapters = new Map<string, TaskProviderAdapter>();
  private negotiated = new Map<string, Partial<Record<TaskOutputMode, 'supported' | 'unsupported' | 'unknown'>>>();
  readonly options: { resolver: TaskConnectionResolver; adapters: readonly TaskProviderAdapter[] };
  constructor(options: { resolver: TaskConnectionResolver; adapters: readonly TaskProviderAdapter[] }) {
    this.options = options;
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate task adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  private adapter(id: string) { const adapter = this.adapters.get(id); if (!adapter) throw new Error(`No task adapter is registered for ${id}`); return adapter; }
  private describe = (id: string, processing: ProcessingClass) => {
    const capabilities = structuredClone(this.adapter(id).describe({ processing }));
    return capabilities;
  };
  private dispatch(binding: TaskModelBinding) {
    const route = this.options.resolver.resolve(binding, this.describe);
    const adapter = this.adapter(route.adapterId);
    if (binding.optionsProfile && !adapter.optionsProfiles?.includes(binding.optionsProfile)) throw new Error(`The ${route.adapterId} task adapter does not support options profile “${binding.optionsProfile}”`);
    const cached = this.negotiated.get(route.fingerprint);
    if (cached) Object.assign(route.capabilities.outputModes, cached);
    return route;
  }
  resolve(binding: TaskModelBinding): ResolvedTaskRoute {
    const { access:_access,key: _key, dialect: _dialect, runtimeModelId: _runtimeModelId, ...route } = this.dispatch(binding);
    return route;
  }
  private async prepared(binding: TaskModelBinding, signal: AbortSignal): Promise<DispatchRoute> {
    const configured = this.dispatch(binding), adapter = this.adapter(configured.adapterId);
    const inspected = adapter.inspect ? await adapter.inspect(configured, signal) : {};
    const route = { ...configured, ...inspected, capabilities: inspected.capabilities ?? configured.capabilities } as DispatchRoute;
    const { access:_access,key: _key, dialect: _dialect, runtimeModelId: _runtimeModelId, capabilities: _capabilities, fingerprint: _fingerprint, ...identity } = route;
    route.fingerprint = routeFingerprint(identity);
    const cached = this.negotiated.get(route.fingerprint);
    if (cached) Object.assign(route.capabilities.outputModes, cached);
    return route;
  }
  /** Re-resolve immediately before reviewed apply; route or credential changes reject the old result. */
  async recheck(pinned: ResolvedTaskRoute, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<ResolvedTaskRoute> {
    const currentRoute = await this.prepared({ connectionRef: pinned.connectionRef, modelId: pinned.modelId, fallbackBindingRefs: [] }, signal);
    const { access:_access,key: _key, dialect: _dialect, runtimeModelId: _runtimeModelId, ...current } = currentRoute;
    if (current.fingerprint !== pinned.fingerprint) throw new StaleTaskRouteError();
    return current;
  }
  recordCapabilities(fingerprint: string, modes: Partial<Record<TaskOutputMode, 'supported' | 'unsupported' | 'unknown'>>) {
    this.negotiated.set(fingerprint, { ...(this.negotiated.get(fingerprint) ?? {}), ...modes });
  }

  private mode(route: ResolvedTaskRoute) {
    return (['json_schema', 'tool', 'json_object', 'text_json'] as const).find(mode => route.capabilities.outputModes[mode] === 'supported') ?? 'text_json';
  }

  private unsupportedMode(error: unknown) {
    return error instanceof HttpStatusError && error.status === 400 || error instanceof Error && /failed \(HTTP 400\)/u.test(error.message);
  }

  async probe(binding: TaskModelBinding, sourcePolicy: 'local_only' | 'cloud_allowed', allowCloud: boolean, signal: AbortSignal,
    beforeDispatch?: StructuredTaskRequest<unknown>['beforeDispatch']): Promise<TaskProbeResult> {
    const request = { task: 'assess' as const, sourcePolicy, allowCloud, schemaName: 'pal_memory_probe_v1', schema: probeSchema, jsonSchema: probeJsonSchema,
      system: 'This is a synthetic capability test. Return the requested abstention object and cite only the supplied synthetic evidence ID.',
      input: 'Target synthetic-target has no factual content. Abstain with evidence ID synthetic-evidence.', maxOutputTokens: 256, beforeDispatch };
    const initial = await this.prepared(binding, signal);
    for (const mode of ['json_schema', 'json_object', 'text_json'] as const) {
      if (initial.capabilities.outputModes[mode] === 'unsupported') continue;
      try {
        const result = await this.run(binding, request, signal, mode);
        this.recordCapabilities(result.route.fingerprint, { [mode]: 'supported' });
        return { route: result.route, outputMode: mode, checked: { structuredOutput: true, abstention: true, evidenceIds: true, finishState: true },
          model: result.model, modelVersion: result.modelVersion, modelDigest: result.modelDigest };
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : '';
        if (!/INVALID_JSON_OR_SCHEMA|HTTP 400|failed \(HTTP 400\)/u.test(message)) throw error;
        this.recordCapabilities(initial.fingerprint, { [mode]: 'unsupported' });
      }
    }
    throw new Error('The selected model did not pass any bounded structured-output mode');
  }

  async generate<T>(bindingValue: TaskModelBinding, request: StructuredTaskRequest<T>, signal: AbortSignal): Promise<StructuredTaskResult<T>> {
    const root = bindingSchema.parse(bindingValue), candidates: TaskModelBinding[] = [];
    const append = (binding: TaskModelBinding) => { candidates.push(binding); for (const fallback of binding.fallbackBindings ?? []) append(fallback); };
    append(root);
    let firstError: unknown;
    for (let index = 0; index < candidates.length; index++) {
      const binding = candidates[index];
      try {
        const route = await this.prepared(binding, signal);
        if (index > 0 && route.processing === 'cloud' && binding.allowCloudFallback !== true)
          throw new TaskRoutePolicyError('CLOUD_TASK_DISABLED', 'This fallback binding is not authorized to switch memory processing to cloud');
        return await this.generateBinding(binding, index>0 && !binding.allowCloudFallback ? {...request,allowCloud:false} : request, signal, route);
      } catch (error) {
        signal.throwIfAborted();
        firstError ??= error;
        if (index === candidates.length - 1 || !this.fallbackEligible(error)) throw firstError;
      }
    }
    throw firstError;
  }

  private fallbackEligible(error: unknown) {
    if (error instanceof TaskRoutePolicyError) return true;
    if (error instanceof HttpStatusError) return [400, 401, 403, 404, 429].includes(error.status);
    const code = (error as any)?.code;
    if (['BUDGET_EXHAUSTED', 'INPUT_LIMIT'].includes(code)) return true;
    return error instanceof Error && /(?:key|credentials).*(?:missing|required)|connection no longer exists|No task adapter|supports no usable structured-output mode/iu.test(error.message);
  }

  private async generateBinding<T>(bindingValue: TaskModelBinding, request: StructuredTaskRequest<T>, signal: AbortSignal, preparedRoute?: DispatchRoute): Promise<StructuredTaskResult<T>> {
    const route = preparedRoute ?? await this.prepared(bindingSchema.parse(bindingValue), signal);
    const modes = (['json_schema', 'tool', 'json_object', 'text_json'] as const).filter(mode => route.capabilities.outputModes[mode] === 'supported');
    for (const mode of modes.length ? modes : ['text_json'] as const) {
      try { return await this.run(bindingValue, request, signal, mode); }
      catch (error) {
        signal.throwIfAborted();
        if (!this.unsupportedMode(error) || mode === 'text_json') throw error;
        this.recordCapabilities(route.fingerprint, { [mode]: 'unsupported' });
      }
    }
    throw new Error('The selected model supports no usable structured-output mode');
  }

  private async run<T>(bindingValue: TaskModelBinding, request: StructuredTaskRequest<T>, signal: AbortSignal, forcedMode?: TaskOutputMode): Promise<StructuredTaskResult<T>> {
    const binding = bindingSchema.parse(bindingValue);
    if ([...request.system].length + [...request.input].length > (request.maxInputCodePoints ?? 65_536)) throw new TypeError('Task input exceeds the configured bound');
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 65_536) throw new TypeError('Invalid task output limit');
    const pinnedDispatch = await this.prepared(binding, signal);
    const { access:_access,key: _key, dialect: _dialect, runtimeModelId: _runtimeModelId, ...pinned } = pinnedDispatch;
    const mode = forcedMode ?? this.mode(pinned);
    assertTaskRouteAllowed(pinned, request.sourcePolicy, request.allowCloud);
    const adapter = this.adapter(pinned.adapterId);
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const current = await this.prepared(binding, signal);
      if (current.fingerprint !== pinned.fingerprint) throw new StaleTaskRouteError();
      assertTaskRouteAllowed(current, request.sourcePolicy, request.allowCloud);
      const beforeNetworkAttempt = async () => {
        const fresh = await this.prepared(binding, signal);
        if (fresh.fingerprint !== pinned.fingerprint) throw new StaleTaskRouteError();
        assertTaskRouteAllowed(fresh, request.sourcePolicy, request.allowCloud);
        const schemaCharacters = JSON.stringify(request.jsonSchema).length;
        const repairCharacters = attempt ? 160 : 0;
        // Includes the schema whether carried in the provider envelope or in the fallback prompt,
        // plus bounded message/envelope overhead. This is deliberately conservative.
        const estimatedInputTokens = Math.ceil((request.system.length + request.input.length + request.schemaName.length + schemaCharacters + repairCharacters + 128) / 4);
        await request.beforeDispatch?.({ ...pinned, outputMode: mode, maxOutputTokens: request.maxOutputTokens, attempt }, estimatedInputTokens);
      };
      const response = await adapter.generate(current, request as StructuredTaskRequest<unknown>, mode, attempt === 1, signal, beforeNetworkAttempt);
      await this.recheck(pinned, signal);
      if (response.finish !== 'complete') throw new TaskProviderFinishError(response.finish);
      if (response.text.length > (request.maxOutputCharacters ?? 256_000)) throw new Error('Task response exceeded the configured output bound');
      try {
        const value = request.schema.parse(parseOneJsonObject(response.text));
        return { value, route: pinned, outputMode: mode, model: response.model, modelVersion: response.modelVersion??pinned.modelVersion, modelDigest: response.modelDigest??pinned.modelDigest, usage: response.usage, repaired: attempt === 1 };
      } catch (error) { failure = error instanceof Error ? error : new Error('Task response failed validation'); }
    }
    throw new Error(`Task model returned invalid structured output after one repair attempt${failure ? ': INVALID_JSON_OR_SCHEMA' : ''}`);
  }
}

/** Strict fallback parser: one object, optionally surrounded by one complete JSON code fence. */
export function parseOneJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const value = JSON.parse(candidate);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected one JSON object');
  return value;
}
