import { isApiProvider } from '../provider-catalog.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const memoryTasks = ['assess', 'adjudicate', 'extract', 'consolidate', 'rerank'] as const;
export type MemoryTask = typeof memoryTasks[number];
export const processingClasses = ['local', 'remote', 'cloud', 'unknown'] as const;
export type ProcessingClass = typeof processingClasses[number];
export const taskOutputModes = ['json_schema', 'tool', 'json_object', 'text_json'] as const;
export type TaskOutputMode = typeof taskOutputModes[number];
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

const printable = (maximum: number) => z.string().min(1).max(maximum).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value), 'Use printable characters without surrounding whitespace');
const connectionRefSchema = printable(256).refine(value => /^(?:default:ollama|connection:[^:]+)$/u.test(value) || value.startsWith('native:') && value!=='native:compatible' && isApiProvider(value.slice(7)), 'Invalid task connection reference');

export interface TaskModelBinding {
  connectionRef: string;
  modelId: string;
  optionsProfile?: string;
  /** Ordered, explicit fallback routes. Nested fallbacks are bounded and independently authorized. */
  fallbackBindings?: TaskModelBinding[];
  /** Legacy contract shape: only an empty list is accepted; use fallbackBindings for configured fallbacks. */
  fallbackBindingRefs?: string[];
  /** Required on a nested binding before a local/remote route may fall back to cloud. */
  allowCloudFallback?: boolean;
}

function validateBindingTree(value: TaskModelBinding, context: z.RefinementCtx) {
  let count = 0;
  const visit = (binding: TaskModelBinding, depth: number, ancestors: Set<string>, path: (string | number)[]) => {
    count++;
    if (depth > 3) context.addIssue({ code: 'custom', path, message: 'Task model fallbacks may be at most 3 levels deep' });
    if (count > 8) context.addIssue({ code: 'custom', path, message: 'Keep at most 8 task model bindings including fallbacks' });
    const key = JSON.stringify([binding.connectionRef, binding.modelId, binding.optionsProfile ?? '']);
    if (ancestors.has(key)) { context.addIssue({ code: 'custom', path, message: 'Task model fallback cycle or repeated route' }); return; }
    const next = new Set(ancestors); next.add(key);
    (binding.fallbackBindings ?? []).forEach((fallback, index) => visit(fallback, depth + 1, next, [...path, 'fallbackBindings', index]));
  };
  visit(value, 0, new Set(), []);
}

export const bindingSchema: z.ZodType<TaskModelBinding> = z.lazy(() => z.object({
  connectionRef: connectionRefSchema,
  modelId: printable(512),
  optionsProfile: printable(128).optional(),
  fallbackBindings: z.array(bindingSchema).max(4).default([]),
  fallbackBindingRefs: z.array(printable(256)).max(4).refine(values => values.length === 0, 'Named fallback references are unsupported; use fallbackBindings').default([]),
  allowCloudFallback: z.boolean().default(false),
}).strict().superRefine(validateBindingTree));

export interface TaskModelCapabilities {
  completion: CapabilityState;
  thinking: CapabilityState;
  outputModes: Record<TaskOutputMode, CapabilityState>;
  catalog: CapabilityState;
  taskCompatibility: Partial<Record<MemoryTask, CapabilityState>>;
}

export interface ResolvedTaskRoute {
  connectionRef: string;
  connectionRevision: number;
  credentialRef: string;
  credentialRevision: string;
  adapterId: string;
  endpoint: string;
  modelId: string;
  processing: ProcessingClass;
  capabilities: TaskModelCapabilities;
  fingerprint: string;
  modelVersion?: string;
  modelDigest?: string;
}

export interface TaskAttemptRoute extends ResolvedTaskRoute {
  outputMode: TaskOutputMode;
  maxOutputTokens: number;
  attempt: number;
}

export interface StructuredTaskRequest<T> {
  task: MemoryTask;
  sourcePolicy: 'local_only' | 'cloud_allowed';
  /** Cloud dispatch still requires this explicit curation/extraction authorization. */
  allowCloud?: boolean;
  schemaName: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  system: string;
  input: string;
  maxOutputTokens: number;
  maxInputCodePoints?: number;
  maxOutputCharacters?: number;
  beforeDispatch?: (route: TaskAttemptRoute, estimatedInputTokens: number) => Promise<void>;
}

export type TaskFinishState = 'complete' | 'refusal' | 'content_filter' | 'output_limit' | 'cancelled' | 'timeout' | 'transport_error';
export interface ProviderTaskResponse {
  text: string;
  finish: TaskFinishState;
  model: string;
  modelVersion?: string;
  modelDigest?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TaskProviderAdapter {
  readonly id: string;
  readonly optionsProfiles?: readonly string[];
  describe(route: Pick<ResolvedTaskRoute, 'processing'>): TaskModelCapabilities;
  inspect?(route: ResolvedTaskRoute & { key(): string; dialect?: 'chat_completions' | 'responses' }, signal: AbortSignal): Promise<Partial<ResolvedTaskRoute> & { runtimeModelId?: string }>;
  generate(route: ResolvedTaskRoute & { key(): string; dialect?: 'chat_completions' | 'responses' }, request: StructuredTaskRequest<unknown>, mode: TaskOutputMode, repair: boolean, signal: AbortSignal, beforeNetworkAttempt: () => Promise<void>): Promise<ProviderTaskResponse>;
}

export interface StructuredTaskResult<T> {
  value: T;
  route: ResolvedTaskRoute;
  outputMode: TaskOutputMode;
  model: string;
  modelVersion?: string;
  modelDigest?: string;
  usage?: ProviderTaskResponse['usage'];
  repaired: boolean;
}

export function emptyCapabilities(overrides: Partial<TaskModelCapabilities> = {}): TaskModelCapabilities {
  return {
    completion: 'unknown', thinking: 'unknown', catalog: 'unknown', taskCompatibility: {},
    outputModes: { json_schema: 'unknown', tool: 'unknown', json_object: 'unknown', text_json: 'supported' },
    ...overrides,
  };
}

export function routeFingerprint(value: Omit<ResolvedTaskRoute, 'fingerprint' | 'capabilities'>) {
  return createHash('sha256').update(JSON.stringify([
    'cere-task-route-v1', value.connectionRef, value.connectionRevision, value.credentialRef,
    value.credentialRevision, value.adapterId, value.endpoint, value.modelId, value.processing,
    value.modelVersion ?? '', value.modelDigest ?? '',
  ])).digest('hex');
}

export function assertTaskRouteAllowed(route: ResolvedTaskRoute, sourcePolicy: StructuredTaskRequest<unknown>['sourcePolicy'], allowCloud = false) {
  if (route.processing === 'cloud' && !allowCloud) throw new TaskRoutePolicyError('CLOUD_TASK_DISABLED', 'Cloud memory model use requires explicit task authorization');
  if (sourcePolicy === 'local_only' && route.processing !== 'local') throw new TaskRoutePolicyError('LOCAL_ONLY_ROUTE', 'Local-only memory material cannot be sent to this processing destination');
  if (route.processing === 'unknown') throw new TaskRoutePolicyError('UNKNOWN_PROCESSING', 'Declare where this connection processes requests before using it for memory');
}

export class TaskRoutePolicyError extends Error {
  readonly code: 'CLOUD_TASK_DISABLED' | 'LOCAL_ONLY_ROUTE' | 'UNKNOWN_PROCESSING';
  constructor(code: TaskRoutePolicyError['code'], message: string) { super(message); this.code = code; }
}

export class StaleTaskRouteError extends Error {
  readonly code = 'STALE_TASK_ROUTE';
  constructor() { super('The task connection or credentials changed while this request was running'); }
}

export class TaskProviderFinishError extends Error {
  readonly finish: Exclude<TaskFinishState, 'complete'>;
  constructor(finish: TaskProviderFinishError['finish']) { super(`The memory model did not complete (${finish})`); this.finish = finish; }
}
