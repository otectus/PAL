import { resolveProviderEndpoint } from '../provider-registry.ts';
import {OpenRouterImages} from './backends/openrouter.ts';
import { XaiImages, xaiImageModels } from './backends/xai.ts';
/**
 * Image work for every conversation, independent of its chat model: a text-only Ollama conversation can
 * ask a configured image backend for a picture. Manual Workbench actions call the same service.
 *
 * One operation, one visible result: each request gets a durable operation record before anything is
 * sent, a budget reservation, a single submission, and one result card that is updated in place. Outputs
 * are kept as artifacts the moment they arrive. A refusal, a missing image and a corrupt image are
 * different outcomes; a request whose answer was lost is `unknown` and is never sent again by itself.
 */
import { limitedControlled } from '../authority.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from '../paths.ts';
import type { Core } from '../core.ts';
import type { ArtifactStore, ArtifactVersion } from '../artifacts/store.ts';
import { OperationStore, terminalStates, type Operation } from '../operations/store.ts';
import { routeAllowed, routeLabels, type ArtifactRef, type ProcessingRoute } from '../tools/contracts.ts';
import { BackendRefusal, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageReference, type ImageRequest, type ResolvedInputs } from './contracts.ts';
import { OpenAiImages, openaiImageModels } from './backends/openai.ts';
import { GoogleImages, googleImageModels } from './backends/google.ts';
import { analyzeWorkflow, ComfyImages, type ComfyWorkflow } from './backends/comfyui.ts';
import { verifyImage } from './download.ts';
import { changedOutside, inspect, normalizeMask, protectOutside } from './transforms.ts';
import { ExtensionSecrets } from '../extensions.ts';
import sharp from 'sharp';
import { ImageCandidateStore, type UnprotectedCandidate } from './candidates.ts';
import { ImageRecipeStore, type ImageRecipeDraft, type ImageRecipeV1, type WorkflowDependencyCheck } from './recipes.ts';
import { parsePortableRecipe, portableDigest, portableRecipeLimits, type PortableImageRecipeV1, type PortableInput } from './portable-recipes.ts';

/** Connection lists built by the broker itself (workflow imports); only these may carry workflow records. */
export const trustedConnectionLists = new WeakSet<object>();

export type ImageConnection = {
  id: string; name: string; kind: 'openai' | 'google' | 'xai' | 'azure_openai' | 'openrouter' | 'comfyui'; model: string; enabled: boolean;
  /** ComfyUI only: the exact server origin, where it processes, and whether it interrupts by prompt ID. */
  origin?: string; route?: ProcessingRoute; targetedInterrupt?: boolean;
  workflows?: ComfyWorkflow[]; workflowId?: string;
  /** A model may start jobs on this connection without asking each time, up to this many images a day. */
  budget: { imagesPerDay: number; modelMayStart: boolean };
  providerAccountId?:string;
  billingAcknowledged?: boolean;
  /** Optional user-supplied estimate only; PAL never assumes provider prices. */
  estimate?: { perImage: number; currency: string };
  revision: number;
};
export const mediaLimits = { connections: 8, workflows: 16, waitMs: 90_000, deadlineMs: 30 * 60_000, progressMs: 300 };
const uuid = /^[0-9a-f-]{36}$/;

/** Validates the connection list from a settings patch; revisions bump on any change so old approvals retire. */
export function validConnections(value: unknown, previous: ImageConnection[]): ImageConnection[] {
  if (!Array.isArray(value) || value.length > mediaLimits.connections) throw new Error(`Configure up to ${mediaLimits.connections} image connections`);
  // Workflows are imported and reviewed through their own requests; a settings patch from a client keeps the stored ones.
  const trusted = trustedConnectionLists.has(value);
  return value.map((item: any) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid image connection');
    const kind = item.kind;
    if (!['openai', 'google', 'xai','azure_openai','openrouter', 'comfyui'].includes(kind)) throw new Error('Choose a supported image backend');
    const name = typeof item.name === 'string' && item.name.trim() && item.name.trim().length <= 60 && !/[\x00-\x1f]/.test(item.name) ? item.name.trim() : '';
    if (!name) throw new Error('Name the image connection (up to 60 characters)');
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (kind !== 'comfyui' && (!model || model.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(model))) throw new Error('Choose or type the image model ID');
    let origin: string | undefined;
    if (kind === 'comfyui') {
      let url: URL; try { url = new URL(String(item.origin || '')); } catch { throw new Error('Enter the ComfyUI address, such as http://127.0.0.1:8188'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use the ComfyUI server origin only, such as http://127.0.0.1:8188');
      origin = url.origin;
      if (item.route !== undefined && !['local', 'remote', 'cloud', 'unknown'].includes(item.route)) throw new Error('Choose where the ComfyUI server runs');
    }
    const id = typeof item.id === 'string' && uuid.test(item.id) ? item.id : randomUUID(), before = previous.find(connection => connection.id === id);
    const budget = item.budget || {};
    if (budget.imagesPerDay !== undefined && (!Number.isInteger(budget.imagesPerDay) || budget.imagesPerDay < 0 || budget.imagesPerDay > 500)) throw new Error('A daily image budget is 0–500 (0 means models must always ask)');
    let estimate: ImageConnection['estimate'];
    if (item.estimate === undefined) estimate = before?.estimate;
    else if (item.estimate !== null) {
      if (!item.estimate || typeof item.estimate !== 'object' || !Number.isFinite(item.estimate.perImage) || item.estimate.perImage < 0 || typeof item.estimate.currency !== 'string' || !/^[A-Za-z]{3}$/.test(item.estimate.currency)) throw new Error('An image estimate needs a nonnegative per-image amount and a three-letter currency');
      estimate = { perImage: item.estimate.perImage, currency: item.estimate.currency.toUpperCase() };
    }
    if(item.providerAccountId && (kind==='comfyui'||typeof item.providerAccountId!=='string'||!uuid.test(item.providerAccountId)))throw new Error('Choose a named hosted image account');
    const next: ImageConnection = { id, name, kind, model: kind === 'comfyui' ? '' : model, enabled: item.enabled !== false, ...(item.providerAccountId?{providerAccountId:item.providerAccountId}:{}),
      ...(kind === 'comfyui' ? { origin, route: item.route || (/^(127\.|localhost$|\[?::1\]?$)/.test(new URL(origin!).hostname) ? 'local' : 'remote'), targetedInterrupt: item.targetedInterrupt === true, workflows: trusted && Array.isArray(item.workflows) ? item.workflows : before?.workflows || [], ...(typeof item.workflowId === 'string' ? { workflowId: item.workflowId } : before?.workflowId ? { workflowId: before.workflowId } : {}) } : {}),
      budget: { imagesPerDay: budget.imagesPerDay ?? before?.budget.imagesPerDay ?? 20, modelMayStart: budget.modelMayStart === true },
      ...(item.billingAcknowledged === true || before?.billingAcknowledged ? { billingAcknowledged: true } : {}), ...(estimate ? { estimate } : {}), revision: before?.revision || 1 };
    const material = (c?: ImageConnection) => c ? JSON.stringify([c.kind, c.providerAccountId, c.model, c.origin, c.route, c.targetedInterrupt, c.enabled, c.budget, c.workflowId, c.estimate]) : '';
    if (before && material(before) !== material(next)) next.revision = before.revision + 1;
    return next;
  });
}

type Waiter = { resolve: () => void };
export class MediaService {
  core: Core; artifacts: ArtifactStore; operations: OperationStore; secrets: ExtensionSecrets;
  recipes: ImageRecipeStore; candidates: ImageCandidateStore;
  /** The user's current image selection per conversation, so "this image" means what is selected. */
  selections = new Map<string, ArtifactRef>();
  private controllers = new Map<string, AbortController>();
  private running = new Set<Promise<unknown>>();
  /** Set at shutdown: a dispatched job keeps its recorded state so the next start reconciles it by status. */
  private closing = false;
  private partials = new Map<string, string>();
  private acceptanceTails = new Map<string, Promise<void>>();
  private gpuBusy = false; private gpuQueue: Waiter[] = [];
  private lastProgress = new Map<string, number>();
  fetch: typeof fetch = (...args) => fetch(...args);
  constructor(core: Core, artifacts: ArtifactStore, operations: OperationStore) {
    this.core = core; this.artifacts = artifacts; this.operations = operations;
    this.secrets = new ExtensionSecrets(join(core.store.directory, 'credentials'), 'image-connection-secrets.json');
    this.recipes = new ImageRecipeStore(core.store.directory);
    this.candidates = new ImageCandidateStore(core.store.directory);
    void this.ensureDirectories().catch(() => { /* surfaced by the first recipe/candidate operation */ });
  }
  connections(): ImageConnection[] { return this.core.settings.workbench?.imageConnections || []; }
  connection(id: unknown): ImageConnection {
    const list = this.connections().filter(connection => connection.enabled);
    const found = typeof id === 'string' && id ? list.find(connection => connection.id === id) : list[0];
    if (!found) throw new BackendRefusal('no_connection', list.length ? 'That image connection does not exist or is turned off' : 'No image backend is set up. Add one in Settings → Connections → Images.');
    return found;
  }
  private workflowsDir() { return privateDir(join(this.core.store.directory, 'media', 'workflows')); }
  async graph(workflow: ComfyWorkflow) { return JSON.parse(await readFile(join(this.workflowsDir(), workflow.id + '.json'), 'utf8')); }
  async backend(connection: ImageConnection, workflowId?: string): Promise<ImageBackend> {
    if(connection.kind==='azure_openai'){
      const access=this.azureImageAccess(connection);
      return new OpenAiImages(connection.model,this.imageBase(connection),async()=>access.token?{Authorization:'Bearer '+await access.token()} as Record<string,string>:{'api-key':access.key()});
    }
    if(connection.kind==='openrouter')return new OpenRouterImages(connection.model,this.imageBase(connection)!);
    if (connection.kind === 'openai') return new OpenAiImages(connection.model,this.imageBase(connection));
    if (connection.kind === 'xai') return new XaiImages(connection.model,this.imageBase(connection));
    if (connection.kind === 'google') return new GoogleImages(connection.model,this.imageBase(connection));
    const workflow = (connection.workflows || []).find(item => item.id === (workflowId || connection.workflowId)) || (connection.workflows || [])[0];
    if (!workflow) throw new BackendRefusal('no_workflow', `Import a reviewed workflow for ${connection.name} first`);
    return new ComfyImages({ origin: connection.origin!, route: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt, workflows: connection.workflows || [], token: () => this.secret(connection.id) }, workflow, await this.graph(workflow));
  }
  private backendForSnapshot(connection: ImageConnection, snapshot: NonNullable<ImageRecipeV1['workflow']>, recorded?: ImageRecipeV1['backend']) {
    if (connection.kind !== 'comfyui') throw new BackendRefusal('connection_changed', 'This recipe needs a ComfyUI connection');
    return new ComfyImages({ origin: recorded?.origin || connection.origin!, route: recorded?.serverRoute || connection.route || 'unknown', targetedInterrupt: recorded?.targetedInterrupt ?? !!connection.targetedInterrupt, workflows: [snapshot.workflow], token: () => this.secret(connection.id) }, snapshot.workflow, structuredClone(snapshot.graph));
  }
  private secret(connectionId: string) { try { return this.secrets.values(connectionId).TOKEN || ''; } catch { return ''; } }
  /** A ComfyUI access token, kept in an owner-only file and sent only to that connection's origin. */
  setToken(connectionId: unknown, token: unknown) {
    const connection = this.connection(connectionId);
    if (connection.kind !== 'comfyui') throw new Error('OpenAI and Google connections use the API keys in Settings → Connections');
    this.secrets.set(connection.id, 'TOKEN', typeof token === 'string' ? token : '');
    return { set: !!this.secret(connection.id) };
  }
  private azureImageAccess(c:ImageConnection){
    if(!c.providerAccountId)throw new Error('Select a named Azure OpenAI image deployment');
    const access=this.core.accountAccess('azure_openai',c.providerAccountId),route=access.route?.();
    if(!route?.deployment||route.variant==='legacy'||route.deployment!==c.model)throw new Error('Use the deployment name from the selected Azure OpenAI v1 account as the image model');
    return access;
  }
  private imageBase(c:ImageConnection){
    if(c.kind==='comfyui')return;
    const account=c.providerAccountId?this.core.chatConnections.get(c.providerAccountId,c.kind):undefined;
    if(account?.variant==='vertex')throw new Error('Select a Gemini Developer account for this image operation');
    return resolveProviderEndpoint(c.kind,account?this.core.accountAccess(c.kind,account.id).route?.():undefined);
  }
  private accountWitness(c:ImageConnection){
    if(c.kind==='comfyui')return '';
    const account=c.providerAccountId?this.core.chatConnections.get(c.providerAccountId,c.kind):undefined;
    return [account?.id||c.kind,account?.revision||0,this.core.credentials.credentialRevision(account?'connection:'+account.id:'provider:'+c.kind)].join('/');
  }
  key(c: ImageConnection) {
    if(c.kind==='comfyui')return this.secret(c.id);
    return c.providerAccountId?this.core.accountAccess(c.kind,c.providerAccountId).key():this.core.credentials.key(c.kind);
  }
  private recipeCost(connection: ImageConnection, billed: boolean, count: number): ImageRecipeV1['backend']['cost'] {
    const amount = connection.estimate ? connection.estimate.perImage * count : undefined;
    return { kind: billed ? 'provider-account' : 'own-server', note: billed ? 'May be billed by the configured provider' : 'Runs on the configured server; PAL records no provider charge',
      ...(connection.estimate && Number.isFinite(amount) ? { amount, currency: connection.estimate.currency, source: 'configured estimate' as const } : {}) };
  }
  async capabilities(connectionId?: unknown, workflowId?: string) { const connection = this.connection(connectionId); return { connection: this.publicConnection(connection), capabilities: (await this.backend(connection, workflowId)).describe() }; }
  publicConnection(connection: ImageConnection) {
    const { id, name, kind, model, origin, route, targetedInterrupt, workflowId, budget, billingAcknowledged, estimate, revision, enabled } = connection;
    let hasKey=false;try{hasKey=!!this.key(connection);}catch{}
    return { id, name, kind, model, origin,providerAccountId:connection.providerAccountId, route: kind === 'comfyui' ? route : 'cloud', targetedInterrupt, workflowId, budget, billingAcknowledged: !!billingAcknowledged, estimate, revision, enabled,
      workflows: (connection.workflows || []).map(({ id, name, operation, digest, cloudNodes, unknownNodes, reviewedLocal, bindings }) => ({ id, name, operation, digest: digest.slice(0, 12), cloudNodes, unknownNodes, reviewedLocal, bindings: Object.keys(bindings) })),
      hasKey: hasKey || kind === 'comfyui', suggestions: kind === 'openai' ? openaiImageModels : kind === 'google' ? googleImageModels : kind === 'xai' ? xaiImageModels : [] };
  }

  // ---------- workflows ----------
  async importWorkflow(connectionId: unknown, name: unknown, graph: unknown) {
    const connection = this.connection(connectionId);
    if (connection.kind !== 'comfyui') throw new Error('Workflows belong to ComfyUI connections');
    if ((connection.workflows || []).length >= mediaLimits.workflows) throw new Error(`Keep up to ${mediaLimits.workflows} workflows per server`);
    const parsed = typeof graph === 'string' ? (() => { try { return JSON.parse(graph); } catch { throw new Error('The workflow is not valid JSON'); } })() : graph;
    const analysis = analyzeWorkflow(parsed, typeof name === 'string' && name.trim() ? name.trim() : 'Workflow');
    const workflow: ComfyWorkflow = { ...analysis, id: randomUUID(), reviewedLocal: false, created: Date.now() };
    await writeFile(join(this.workflowsDir(), workflow.id + '.json'), JSON.stringify(parsed), { mode: 0o600, flag: 'wx' });
    await this.saveConnection({ ...connection, workflows: [...(connection.workflows || []), workflow], workflowId: connection.workflowId || workflow.id, revision: connection.revision + 1 });
    let check: unknown = null;
    try { check = await (await this.backend({ ...connection, workflows: [workflow] }, workflow.id) as ComfyImages).check(this.fetch, AbortSignal.timeout(10_000)); } catch (error: any) { check = { error: error.message }; }
    return { workflow, check };
  }
  async reviewWorkflow(connectionId: unknown, workflowId: unknown, p: { reviewedLocal?: unknown; remove?: unknown }) {
    const connection = this.connection(connectionId), workflows = connection.workflows || [], workflow = workflows.find(item => item.id === workflowId);
    if (!workflow) throw new Error('That workflow no longer exists');
    if (p.remove === true) { await rm(join(this.workflowsDir(), workflow.id + '.json'), { force: true }); return this.saveConnection({ ...connection, workflows: workflows.filter(item => item.id !== workflow.id), workflowId: connection.workflowId === workflow.id ? workflows.find(item => item.id !== workflow.id)?.id : connection.workflowId, revision: connection.revision + 1 }); }
    if (typeof p.reviewedLocal !== 'boolean') throw new Error('Say whether the custom nodes run locally');
    return this.saveConnection({ ...connection, workflows: workflows.map(item => item.id === workflow.id ? { ...item, reviewedLocal: p.reviewedLocal as boolean } : item), revision: connection.revision + 1 });
  }
  private async saveConnection(connection: ImageConnection) {
    const list = this.connections().map(item => item.id === connection.id ? connection : item);
    trustedConnectionLists.add(list);
    await this.core.updateSettings({ workbench: { imageConnections: list } });
    return this.publicConnection(connection);
  }
  async test(connectionId: unknown) {
    const connection = this.connection(connectionId), signal = AbortSignal.timeout(15_000);
    if (connection.kind === 'comfyui') return (await this.backend(connection) as ComfyImages).check(this.fetch, signal);
    // A free metadata request: confirms the key works and the model is visible, without making an image.
    const key = this.key(connection);
    if (!key) throw new Error(`Add a ${connection.kind} API key in Settings → Connections`);
    if(connection.kind==='azure_openai'){
      const access=this.azureImageAccess(connection);if(access.token)await access.token();
      return {reachable:null,note:'Deployment configuration is ready. Inference access is checked when an image is requested.'};
    }
    const url = new URL(connection.kind==='openrouter'?'images/models':'models/'+encodeURIComponent(connection.model),this.imageBase(connection));
    const response = await this.fetch(url, { headers: connection.kind !== 'google' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }, redirect: 'error', signal });
    await response.body?.cancel().catch(() => {});
    return { reachable: response.ok, status: response.status, note: response.ok ? 'The key works and the model is listed for your account. No image was made.' : response.status === 404 ? 'The model is not listed for your account.' : 'The provider refused the key or the request.' };
  }

  // ---------- requests ----------
  /** References and masks the conversation may use, decoded and checked; another conversation's image is refused. */
  async resolve(sessionId: string, request: ImageRequest, route: ProcessingRoute): Promise<{ inputs: ResolvedInputs; versions: ArtifactVersion[] }> {
    const versions: ArtifactVersion[] = [], references: ResolvedInputs['references'] = [];
    for (const reference of request.references) {
      const { version, data } = await this.artifacts.bytes(sessionId, reference.artifactId, reference.versionId);
      if (version.kind !== 'image' && version.kind !== 'plot') throw new BackendRefusal('not_image', `${version.name} is not an image`);
      if (!routeAllowed(route, version.policy)) throw new BackendRefusal('destination', `${version.name} may only be processed on ${version.policy.remote ? 'this computer or your own servers' : 'this computer'}; this backend runs on ${routeLabels[route]}.`);
      const facts = await inspect(data);
      if (facts.frames) throw new BackendRefusal('animated', `${version.name} is animated or has several pages; export one frame first`);
      // Masks are drawn on the image as it is displayed, so a backend receives it already oriented.
      const oriented = facts.exifOrientation ? await sharp(data).rotate().png().toBuffer() : data;
      references.push({ bytes: oriented, mime: facts.exifOrientation ? 'image/png' : version.mime, width: facts.width, height: facts.height, role: reference.role === 'edit-base' ? 'target' : reference.role });
      versions.push(version);
    }
    const targets = references.filter(ref => ref.role === 'target');
    if (targets.length > 1) throw new BackendRefusal('invalid', 'Choose exactly one target image');
    const target = targets[0], guides = references.filter(ref => ref.role !== 'target');
    let mask: ResolvedInputs['mask'];
    if (request.mask) {
      if (!target) throw new BackendRefusal('missing_target', 'A mask needs the exact target image it was drawn on');
      const targetRef = request.references.find(ref => ref.role === 'target' || ref.role === 'edit-base')!;
      const { version, data } = await this.artifacts.bytes(sessionId, request.mask.artifactId, request.mask.versionId);
      const exactParent = version.parents.some(parent => parent.relation === 'mask-base' && parent.artifactId === targetRef.artifactId && parent.versionId === targetRef.versionId);
      if (version.provenance.kind !== 'mask' || !exactParent) throw new BackendRefusal('mask_target_mismatch', 'This mask was not drawn on the selected target version; open that exact version and draw the mask again');
      const normalized = await normalizeMask(data, { width: target.width, height: target.height }).catch((error: Error) => { throw new BackendRefusal('mask_mismatch', error.message); });
      mask = { bytes: normalized.bytes, width: target.width, height: target.height }; versions.push(version);
    }
    return { inputs: { references: [...(target ? [target] : []), ...guides], ...(target ? { target } : {}), guides, ...(mask ? { mask } : {}) }, versions };
  }
  validRequest(value: any): ImageRequest {
    if (!value || typeof value !== 'object') throw new BackendRefusal('invalid', 'Describe the image request');
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) throw new BackendRefusal('invalid', 'Write a prompt of up to 8,000 characters');
    if (Array.isArray(value.references) && value.references.length > 16) throw new BackendRefusal('invalid', 'Use up to 16 reference images');
    const references: ImageReference[] = Array.isArray(value.references) ? value.references.map((ref: any): ImageReference => {
      if (!ref || !uuid.test(ref.artifactId) || !uuid.test(ref.versionId)) throw new BackendRefusal('invalid', 'Name each reference by its artifact and version ID');
      return { artifactId: ref.artifactId, versionId: ref.versionId, role: ref.role === 'edit-base' || ref.role === 'target' ? 'target' as const : ['subject', 'composition', 'style'].includes(ref.role) ? ref.role : 'subject' as const };
    }) : [];
    const operation = value.operation || (value.mask ? 'masked-edit' : references.some(ref => ref.role === 'target') ? 'edit' : references.length ? 'reference' : 'generate');
    if (!['generate', 'edit', 'masked-edit', 'extend', 'reference'].includes(operation)) throw new BackendRefusal('invalid', 'Unknown image operation');
    const edit = ['edit', 'masked-edit', 'extend'].includes(operation);
    // Old callers used `edit` and omitted the role. Preserve that contract by treating the first image
    // as the target only for edit operations; reference creation never makes this coercion.
    if (edit && references.length && !references.some(ref => ref.role === 'target')) references[0].role = 'target';
    const targets = references.filter(ref => ref.role === 'target');
    if (edit && targets.length !== 1) throw new BackendRefusal('missing_target', 'Choose exactly one target image to edit');
    if (operation === 'reference' && (!references.length || targets.length)) throw new BackendRefusal('invalid', 'Reference-guided creation needs guide images and no edit target');
    if (operation === 'generate' && references.length) throw new BackendRefusal('invalid', 'Use reference-guided creation when supplying guide images');
    const count = value.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new BackendRefusal('invalid', 'Make 1–4 images at a time');
    const mask = value.mask && uuid.test(value.mask.artifactId) && uuid.test(value.mask.versionId) ? { artifactId: value.mask.artifactId, versionId: value.mask.versionId, ...(Number.isInteger(value.mask.feather) ? { feather: Math.max(0, Math.min(64, value.mask.feather)) } : {}) } : undefined;
    if (operation === 'masked-edit' && !mask) throw new BackendRefusal('missing_reference', 'Choose the mask for this edit');
    if (mask && !edit) throw new BackendRefusal('invalid', 'A mask applies only to an edit target');
    if (value.protectOutside === true && !mask) throw new BackendRefusal('invalid', 'Keeping outside pixels unchanged needs a mask');
    const pick = (key: string, max = 40) => typeof value[key] === 'string' && value[key].length <= max ? value[key] : undefined;
    return { operation, prompt, ...(pick('negativePrompt', 4000) ? { negativePrompt: pick('negativePrompt', 4000) } : {}), references, ...(mask ? { mask } : {}),
      ...(pick('size') ? { size: pick('size') } : {}), ...(pick('aspectRatio') ? { aspectRatio: pick('aspectRatio') } : {}), ...(pick('imageSize') ? { imageSize: pick('imageSize') } : {}),
      format: ['png', 'jpeg', 'webp'].includes(value.format) ? value.format : 'png', ...(['transparent', 'opaque', 'auto'].includes(value.background) ? { background: value.background } : {}),
      ...(pick('quality') ? { quality: pick('quality') } : {}), count, ...(Number.isInteger(value.seed) && value.seed >= 0 && value.seed < 2 ** 32 ? { seed: value.seed } : {}),
      ...(value.protectOutside === true ? { protectOutside: true } : {}), ...(value.partials === true ? { partials: true } : {}) };
  }
  /**
   * Prepares one image operation: validated against the backend's capabilities (unsupported settings are
   * refused or visibly adjusted), inputs resolved and authorized, budget checked. The same request
   * prepared twice yields the same operation, so two clicks start one job.
   */
  async prepare(sessionId: string, raw: unknown, p: { connectionId?: unknown; workflowId?: string; origin: Operation['origin']; turnId?: string; workflowSnapshot?: NonNullable<ImageRecipeV1['workflow']>; replayOf?: string }) {
    const session = this.core.store.session(sessionId);
    if (session.temporary) throw new BackendRefusal('temporary', 'Temporary conversations stay text-only');
    if (limitedControlled(session)) throw new BackendRefusal('remote', 'Images are started from the desktop or an owner phone');
    if (this.core.settings.paused) throw new BackendRefusal('paused', 'PAL actions are paused');
    const connection = this.connection(p.connectionId), backend = p.workflowSnapshot ? this.backendForSnapshot(connection, p.workflowSnapshot) : await this.backend(connection, p.workflowId), capabilities = backend.describe();
    const request = this.validRequest(raw);
    const { request: validated, adjustments } = backend.validate(request);
    if (validated.mask && capabilities.maskBehavior === 'none' && !validated.protectOutside) throw new BackendRefusal('unsupported_parameter', 'This backend has no mask input; turn on keeping pixels outside the selection unchanged');
    const { inputs, versions } = await this.resolve(sessionId, validated, capabilities.route);
    const workflowDigest = backend instanceof ComfyImages ? backend.workflow.digest : '';
    const digest = OperationStore.digest({ sessionId, connection: connection.id, revision: connection.revision, account:this.accountWitness(connection), workflow: workflowDigest, request: validated });
    const existing = this.operations.findPrepared(sessionId, digest);
    if (existing) return { operation: existing, capabilities, adjustments, duplicate: true };
    if (connection.budget.imagesPerDay && this.operations.imagesToday(connection.id) + validated.count > connection.budget.imagesPerDay && p.origin !== 'user')
      throw new BackendRefusal('budget', `${connection.name}’s daily budget of ${connection.budget.imagesPerDay} images is used up. Raise it in Settings, or start it yourself from the Workbench.`);
    let workflowSnapshot: ImageRecipeV1['workflow'];
    if (backend instanceof ComfyImages) {
      const checked: any = await backend.check(this.fetch, AbortSignal.timeout(15_000));
      const dependencies: WorkflowDependencyCheck = { checkedAt: Date.now(), version: String(checked.version || 'unknown'), missingNodes: Array.isArray(checked.missingNodes) ? checked.missingNodes.map(String) : [], missingModels: Array.isArray(checked.missingModels) ? checked.missingModels.map(String) : [] };
      if (dependencies.missingNodes.length || dependencies.missingModels.length) throw new BackendRefusal('missing_dependency', `The workflow is missing ${[...dependencies.missingNodes, ...dependencies.missingModels].slice(0, 8).join(', ')}`);
      workflowSnapshot = { workflow: structuredClone(backend.workflow), graph: structuredClone(backend.graph), snapshotDigest: this.recipes.graphDigest(backend.graph), dependencies };
    }
    const recipeDraft: ImageRecipeDraft = { schema: 1, sessionId, request: structuredClone(validated),
      backend: { connectionId: connection.id, connectionRevision: connection.revision, kind: connection.kind, model: capabilities.model, route: capabilities.route, ...(connection.kind === 'comfyui' ? { origin: connection.origin, serverRoute: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt } : {}), billed: capabilities.billed,
        cost: this.recipeCost(connection, capabilities.billed, validated.count) },
      output: { destination: 'conversation-artifacts', count: validated.count, format: validated.format }, ...(workflowSnapshot ? { workflow: workflowSnapshot } : {}) };
    const recipe = await this.recipes.create(recipeDraft);
    // Recipe persistence is asynchronous. A concurrent identical prepare may have published its
    // operation while this one was writing; re-check before creating a second operation/submission.
    const raced = this.operations.findPrepared(sessionId, digest);
    if (raced) { await this.recipes.remove(recipe.recipeId); return { operation: raced, capabilities, adjustments, duplicate: true }; }
    const operation = this.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: validated.operation === 'generate' || validated.operation === 'reference' ? 'image.generate' : 'image.edit', origin: p.origin,
      label: (validated.operation === 'generate' || validated.operation === 'reference' ? 'Image: ' : 'Image edit: ') + validated.prompt.slice(0, 80), payloadDigest: digest,
      witness: { route: capabilities.route, account:this.accountWitness(connection), connectionRevision: connection.revision, recipe: recipe.digest, ...(workflowSnapshot ? { workflow: workflowSnapshot.snapshotDigest, dependenciesCheckedAt: workflowSnapshot.dependencies.checkedAt } : {}), inputs: versions.map(version => ({ id: version.versionId, policy: version.policyId })) },
      inputs: validated.references.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, purpose: ref.role })),
      backend: { connectionId: connection.id, kind: connection.kind, model: capabilities.model, ...(connection.kind === 'comfyui' ? { workflow: backend instanceof ComfyImages ? backend.workflow.id : p.workflowId || connection.workflowId } : {}), revision: connection.revision, route: capabilities.route },
      details: { request: { ...validated, prompt: validated.prompt.slice(0, 2000) }, adjustments, billed: capabilities.billed, notes: capabilities.notes, recipe: { schema: 1, recipeId: recipe.recipeId, digest: recipe.digest }, ...(p.replayOf ? { replayOf: p.replayOf } : {}) } });
    return { operation, capabilities, adjustments, duplicate: false, inputs, recipe };
  }
  async recipe(sessionId: string, selector: { operationId?: unknown; recipeId?: unknown }): Promise<ImageRecipeV1> {
    let recipeId = selector.recipeId;
    if (selector.operationId !== undefined) {
      const operation = this.operations.get(selector.operationId);
      if (operation.sessionId !== sessionId) throw new Error('That image operation belongs to another conversation');
      recipeId = (operation.details?.recipe as any)?.recipeId;
    }
    const recipe = await this.recipes.get(recipeId);
    if (recipe.sessionId !== sessionId) throw new Error('That image recipe belongs to another conversation');
    return recipe;
  }
  async prepareReplay(sessionId: string, recipeId: unknown, p: { origin: Operation['origin']; turnId?: string; overrides?: { prompt?: unknown; count?: unknown } }) {
    const source = await this.recipe(sessionId, { recipeId });
    const raw: any = structuredClone(source.request), overrides = p.overrides || {};
    if (overrides.prompt !== undefined) raw.prompt = overrides.prompt;
    if (overrides.count !== undefined) raw.count = overrides.count;
    return this.prepare(sessionId, raw, { connectionId: source.backend.connectionId, origin: p.origin, ...(p.turnId ? { turnId: p.turnId } : {}), ...(source.workflow ? { workflowSnapshot: source.workflow } : {}), replayOf: source.recipeId });
  }
  private hashMatches(sessionId: string, hash: string) {
    const matches: ArtifactVersion[] = [];
    for (const row of this.artifacts.store.db.prepare('SELECT data FROM artifact_versions WHERE sha256=? ORDER BY created DESC').all(hash)) {
      const version = JSON.parse(String(row.data)) as ArtifactVersion;
      try { matches.push(this.artifacts.version(sessionId, version.artifactId, version.versionId)); } catch { /* another conversation does not grant access */ }
    }
    return matches;
  }
  async exportPortableRecipe(sessionId: string, recipeId: unknown, p: { includeInputs?: boolean } = {}) {
    const recipe = await this.recipe(sessionId, { recipeId }), inputs: PortableInput[] = [];
    let aggregate = 0;
    const add = async (inputId: string, role: PortableInput['role'], artifactId: string, versionId: string) => {
      const { version, data } = await this.artifacts.bytes(sessionId, artifactId, versionId);
      if (p.includeInputs) {
        aggregate += data.length;
        if (aggregate > portableRecipeLimits.aggregateAssetBytes) throw new Error('The selected recipe inputs exceed the 100 MiB portable-asset limit');
      }
      inputs.push({ inputId, role: role === 'edit-base' ? 'target' : role, artifactId, versionId, sha256: version.sha256, mime: version.mime, name: version.name, bytes: version.bytes,
        ...(p.includeInputs ? { asset: { encoding: 'base64', data: data.toString('base64') } as const } : {}) });
    };
    for (const [index, ref] of recipe.request.references.entries()) await add(`ref-${index + 1}`, ref.role, ref.artifactId, ref.versionId);
    if (recipe.request.mask) await add('mask', 'mask', recipe.request.mask.artifactId, recipe.request.mask.versionId);
    const request = recipe.request;
    const unsigned: Omit<PortableImageRecipeV1, 'digest'> = { kind: 'pal.image-recipe', schema: 1, exportedAt: Date.now(),
      request: { operation: request.operation, prompt: request.prompt.trim(), ...(request.negativePrompt ? { negativePrompt: request.negativePrompt.trim() } : {}), ...(request.size ? { size: request.size } : {}), ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}), ...(request.imageSize ? { imageSize: request.imageSize } : {}), format: request.format,
        ...(request.background ? { background: request.background } : {}), ...(request.quality ? { quality: request.quality } : {}), count: request.count, ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(request.protectOutside ? { protectOutside: true } : {}), ...(request.partials ? { partials: true } : {}), ...(request.mask?.feather !== undefined ? { maskFeather: request.mask.feather } : {}) },
      inputs, backend: { kind: recipe.backend.kind, model: recipe.backend.model, route: recipe.backend.route, billed: recipe.backend.billed, cost: recipe.backend.cost }, output: recipe.output,
      ...(recipe.workflow ? { workflow: { name: recipe.workflow.workflow.name, graph: structuredClone(recipe.workflow.graph), sourceDigest: recipe.workflow.snapshotDigest } } : {}) };
    const portable: PortableImageRecipeV1 = { ...unsigned, digest: portableDigest(unsigned) }, json = JSON.stringify(portable, null, 2);
    return { name: `image-recipe-${recipe.recipeId.slice(0, 8)}.pal-image.json`, mime: 'application/vnd.pal.image-recipe+json', json, digest: portable.digest, bytes: Buffer.byteLength(json), inputs: inputs.length, includesAssets: p.includeInputs === true };
  }
  async inspectPortableRecipe(sessionId: string, value: unknown, p: { connectionId: unknown }) {
    if (typeof p.connectionId !== 'string' || !p.connectionId) throw new Error('Choose the destination image connection explicitly');
    const portable = parsePortableRecipe(value), connection = this.connection(p.connectionId);
    if (connection.kind !== portable.backend.kind) throw new BackendRefusal('destination', `Choose a ${portable.backend.kind} image connection for this recipe`);
    const inputReview = portable.inputs.map(input => { const matches = this.hashMatches(sessionId, input.sha256); return { inputId: input.inputId, role: input.role, name: input.name, sha256: input.sha256, embedded: !!input.asset, exactMatches: matches.map(version => ({ artifactId: version.artifactId, versionId: version.versionId, name: version.name })) }; });
    let workflow: any, dependencies: WorkflowDependencyCheck | undefined;
    if (portable.workflow) {
      const analysis = analyzeWorkflow(portable.workflow.graph, portable.workflow.name), reviewed = { ...analysis, id: randomUUID(), reviewedLocal: false, created: Date.now() };
      const backend = new ComfyImages({ origin: connection.origin!, route: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt, workflows: [reviewed], token: () => this.secret(connection.id) }, reviewed, structuredClone(portable.workflow.graph));
      const checked: any = await backend.check(this.fetch, AbortSignal.timeout(15_000));
      dependencies = { checkedAt: Date.now(), version: String(checked.version || 'unknown'), missingNodes: (checked.missingNodes || []).map(String), missingModels: (checked.missingModels || []).map(String) };
      workflow = { name: reviewed.name, operation: reviewed.operation, cloudNodes: reviewed.cloudNodes, unknownNodes: reviewed.unknownNodes, requiresLocalReview: reviewed.unknownNodes.length > 0, dependencies };
    }
    return { digest: portable.digest, backend: { connectionId: connection.id, name: connection.name, kind: connection.kind }, request: portable.request, inputs: inputReview, ...(workflow ? { workflow } : {}), ready: inputReview.every(input => input.exactMatches.length || input.embedded) && !(dependencies?.missingNodes.length || dependencies?.missingModels.length), submitted: false };
  }
  async importPortableRecipe(sessionId: string, value: unknown, p: { connectionId: unknown; expectedDigest: string; inputMap?: Record<string, { artifactId: string; versionId: string }>; reviewedChangedInputs?: string[]; importEmbeddedInputs?: string[]; reviewedLocal?: boolean }) {
    const portable = parsePortableRecipe(value);
    if (p.expectedDigest !== portable.digest) throw new Error('The recipe changed after review; inspect it again');
    if (typeof p.connectionId !== 'string' || !p.connectionId) throw new Error('Choose the destination image connection explicitly');
    const connection = this.connection(p.connectionId);
    if (connection.kind !== portable.backend.kind) throw new BackendRefusal('destination', `Choose a ${portable.backend.kind} image connection for this recipe`);
    const changed = new Set(p.reviewedChangedInputs || []), embedded = new Set(p.importEmbeddedInputs || []), map = p.inputMap || {};
    const resolved = new Map<string, ArtifactVersion>(), pendingAssets: PortableInput[] = [];
    for (const input of portable.inputs.filter(input => input.role !== 'mask')) {
      const explicit = map[input.inputId]; let version: ArtifactVersion | undefined;
      if (explicit) {
        version = this.artifacts.version(sessionId, explicit.artifactId, explicit.versionId);
        if (version.sha256 !== input.sha256 && !changed.has(input.inputId)) throw new Error(`Input ${input.inputId} differs from the exported version and needs explicit review`);
      } else version = this.hashMatches(sessionId, input.sha256)[0];
      if (!version) {
        if (!input.asset || !embedded.has(input.inputId)) throw new Error(`Map input ${input.inputId} to an authorized image, or explicitly import its embedded asset`);
        await verifyImage(Buffer.from(input.asset.data, 'base64')); pendingAssets.push(input); continue;
      }
      if (version.kind !== 'image' && version.kind !== 'plot') throw new Error(`Mapped input ${input.inputId} is not an image`);
      resolved.set(input.inputId, version);
    }
    let workflowSnapshot: ImageRecipeV1['workflow'], backend: ImageBackend;
    if (portable.workflow) {
      const analysis = analyzeWorkflow(portable.workflow.graph, portable.workflow.name);
      if (analysis.unknownNodes.length && typeof p.reviewedLocal !== 'boolean') throw new Error('Review whether this imported workflow’s custom nodes process locally');
      const workflow = { ...analysis, id: randomUUID(), reviewedLocal: p.reviewedLocal === true, created: Date.now() };
      const comfy = new ComfyImages({ origin: connection.origin!, route: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt, workflows: [workflow], token: () => this.secret(connection.id) }, workflow, structuredClone(portable.workflow.graph));
      const checked: any = await comfy.check(this.fetch, AbortSignal.timeout(15_000));
      const dependencies: WorkflowDependencyCheck = { checkedAt: Date.now(), version: String(checked.version || 'unknown'), missingNodes: (checked.missingNodes || []).map(String), missingModels: (checked.missingModels || []).map(String) };
      if (dependencies.missingNodes.length || dependencies.missingModels.length) throw new BackendRefusal('missing_dependency', `The imported workflow is missing ${[...dependencies.missingNodes, ...dependencies.missingModels].slice(0, 8).join(', ')}`);
      workflowSnapshot = { workflow, graph: structuredClone(portable.workflow.graph), snapshotDigest: this.recipes.graphDigest(portable.workflow.graph), dependencies }; backend = comfy;
    } else backend = await this.backend(connection);
    // Nothing above mutates state. Embedded assets are installed only after destination, workflow and
    // remap review have all succeeded, and remain local-only unless the user later changes permission.
    for (const input of pendingAssets) {
      const data = Buffer.from(input.asset!.data, 'base64');
      const version = await this.artifacts.install({ sessionId, bytes: data, mime: input.mime, name: input.name, source: 'user-import', provenance: { kind: 'portable-recipe-input', recipeDigest: portable.digest, inputId: input.inputId } });
      resolved.set(input.inputId, version);
    }
    const refs = portable.inputs.filter(input => input.role !== 'mask').map(input => { const version = resolved.get(input.inputId)!; return { artifactId: version.artifactId, versionId: version.versionId, role: input.role === 'edit-base' ? 'target' : input.role }; });
    const maskInput = portable.inputs.find(input => input.role === 'mask'); let mask: { artifactId: string; versionId: string; feather?: number } | undefined;
    if (maskInput) {
      let data: Buffer;
      const explicit = map[maskInput.inputId], exact = explicit ? this.artifacts.version(sessionId, explicit.artifactId, explicit.versionId) : this.hashMatches(sessionId, maskInput.sha256)[0];
      if (explicit && exact.sha256 !== maskInput.sha256 && !changed.has(maskInput.inputId)) throw new Error('The mapped mask differs from the exported mask and needs explicit review');
      if (exact) data = (await this.artifacts.bytes(sessionId, exact.artifactId, exact.versionId)).data;
      else if (maskInput.asset && embedded.has(maskInput.inputId)) data = Buffer.from(maskInput.asset.data, 'base64');
      else throw new Error('Map the mask to an authorized image, or explicitly import its embedded asset');
      const target = refs.find(ref => ref.role === 'target'); if (!target) throw new Error('An imported mask needs an exact target mapping');
      const { data: targetBytes } = await this.artifacts.bytes(sessionId, target.artifactId, target.versionId), targetFacts = await inspect(targetBytes), normalized = await normalizeMask(data, { width: targetFacts.width, height: targetFacts.height });
      const version = await this.artifacts.install({ sessionId, bytes: normalized.bytes, mime: 'image/png', name: maskInput.name, source: 'derived', parents: [{ artifactId: target.artifactId, versionId: target.versionId, relation: 'mask-base' }], provenance: { kind: 'mask', base: target.versionId, importedRecipe: portable.digest, width: targetFacts.width, height: targetFacts.height, coverage: Math.round(normalized.coverage * 1000) / 10 } });
      mask = { artifactId: version.artifactId, versionId: version.versionId, ...(portable.request.maskFeather !== undefined ? { feather: portable.request.maskFeather } : {}) };
    }
    const raw = { ...portable.request, references: refs, ...(mask ? { mask } : {}) }, request = this.validRequest(raw), validated = backend.validate(request), capabilities = backend.describe();
    const recipeDraft: ImageRecipeDraft = { schema: 1, sessionId, request: structuredClone(validated.request), backend: { connectionId: connection.id, connectionRevision: connection.revision, kind: connection.kind, model: capabilities.model, route: capabilities.route,
      ...(connection.kind === 'comfyui' ? { origin: connection.origin, serverRoute: connection.route || 'unknown', targetedInterrupt: !!connection.targetedInterrupt } : {}), billed: capabilities.billed, cost: this.recipeCost(connection, capabilities.billed, validated.request.count) },
      output: { destination: 'conversation-artifacts', count: validated.request.count, format: validated.request.format }, ...(workflowSnapshot ? { workflow: workflowSnapshot } : {}) };
    const recipe = await this.recipes.create(recipeDraft);
    return { recipe, adjustments: validated.adjustments, importedInputs: pendingAssets.map(input => input.inputId), submitted: false };
  }
  /** Starts a prepared operation once. Approval (when needed) has already happened. */
  async start(operationId: string, waitMs = 0) {
    let operation = this.operations.get(operationId);
    if (operation.state !== 'prepared' && operation.state !== 'awaiting_approval') return operation;
    const connection = this.connection(operation.backend!.connectionId);
    if (connection.revision !== operation.backend!.revision || operation.witness.account!==undefined && operation.witness.account!==this.accountWitness(connection)) { this.operations.transition(operation.id, 'expired', { error: { code: 'connection_changed', message: 'The image connection changed after this was prepared; prepare it again' } }); throw new BackendRefusal('connection_changed', 'The image connection changed; nothing was sent'); }
    const count = Number((operation.details?.request as any)?.count) || 1;
    this.operations.reserve(operation, { images: count });
    operation = this.operations.transition(operation.id, 'queued', { reservation: { images: count, state: 'held' } });
    const controller = new AbortController(); this.controllers.set(operation.id, controller);
    // The outcome is recorded on the operation itself; this promise only tracks that the work ended.
    const finished: Promise<unknown> = this.execute(operation.id, controller.signal).catch(() => {}).finally(() => { this.controllers.delete(operationId); this.running.delete(finished); });
    this.running.add(finished);
    this.card(operation);
    if (waitMs > 0) await Promise.race([finished, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
    return this.operations.get(operation.id);
  }
  /** One local GPU-heavy job at a time; cloud jobs run alongside. */
  private async gpuSlot(local: boolean, signal: AbortSignal) {
    if (!local) return () => {};
    if (this.gpuBusy) await new Promise<void>((resolve, reject) => { const waiter = { resolve }; this.gpuQueue.push(waiter); signal.addEventListener('abort', () => { this.gpuQueue = this.gpuQueue.filter(item => item !== waiter); reject(signal.reason); }, { once: true }); });
    this.gpuBusy = true;
    if (this.core.settings.workbench?.lowMemory) await this.core.jobs.yieldToForeground(signal).catch(() => {});
    return () => { this.gpuBusy = false; this.gpuQueue.shift()?.resolve(); };
  }
  private async operationRecipe(operation: Operation) {
    const recipeId = (operation.details?.recipe as any)?.recipeId;
    const recipe = await this.recipes.get(recipeId);
    if (recipe.sessionId !== operation.sessionId || recipe.digest !== (operation.details?.recipe as any)?.digest) throw new Error('The operation’s image recipe no longer matches');
    return recipe;
  }
  /** Results are discovered by operation and output index as well as from the operation record, closing
   * the small crash window between publishing immutable artifact bytes and persisting the result list. */
  private installedResults(operation: Operation, recipe: ImageRecipeV1) {
    const found = this.artifacts.store.db.prepare("SELECT data FROM artifact_versions WHERE json_extract(data,'$.operationId')=? ORDER BY created").all(operation.id)
      .map(row => JSON.parse(String(row.data)) as ArtifactVersion)
      .filter(version => version.provenance.kind === 'generation' && version.provenance.recipeDigest === recipe.digest)
      .sort((a, b) => Number(a.provenance.outputIndex) - Number(b.provenance.outputIndex));
    const refs = new Map<string, ArtifactRef>();
    for (const ref of operation.results) refs.set(ref.versionId, ref);
    for (const version of found) refs.set(version.versionId, { artifactId: version.artifactId, versionId: version.versionId, purpose: 'generated' });
    return [...refs.values()];
  }
  private generatedVersions(operationId: string) {
    return this.artifacts.store.db.prepare("SELECT data FROM artifact_versions WHERE json_extract(data,'$.operationId')=? ORDER BY created").all(operationId).map(row => JSON.parse(String(row.data)) as ArtifactVersion);
  }
  private acceptedCandidateVersion(operationId: string, recipeDigest: string, candidateId: string) {
    return this.generatedVersions(operationId).find(version => version.provenance.kind === 'generation' && version.provenance.recipeDigest === recipeDigest && version.provenance.candidateId === candidateId);
  }
  private async withAcceptanceLock<T>(operationId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.acceptanceTails.get(operationId) || Promise.resolve();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate); this.acceptanceTails.set(operationId, tail);
    await previous;
    try { return await run(); }
    finally { release(); if (this.acceptanceTails.get(operationId) === tail) this.acceptanceTails.delete(operationId); }
  }
  private async installGenerated(operation: Operation, recipe: ImageRecipeV1, connection: Pick<ImageConnection, 'kind' | 'name'>, request: ImageRequest, inputs: ResolvedInputs, versions: ArtifactVersion[], image: { bytes: Buffer; mime: string; index: number; revisedPrompt?: string }, p: { recovered?: boolean; acceptUnprotected?: boolean; candidateId?: string } = {}) {
    if (p.acceptUnprotected && p.candidateId) {
      const existing = this.acceptedCandidateVersion(operation.id, recipe.digest, p.candidateId);
      if (existing) return { version: existing };
    } else if (!p.acceptUnprotected) {
      const existing = this.generatedVersions(operation.id)
        .find(version => version.provenance.kind === 'generation' && version.provenance.recipeDigest === recipe.digest && Number(version.provenance.outputIndex) === image.index && !version.provenance.candidateId);
      if (existing) return { version: existing };
    }
    const verified = await verifyImage(image.bytes);
    let bytes = verified.bytes, mime = verified.mime, protection = '';
    if (!p.acceptUnprotected && request.protectOutside && inputs.target && inputs.mask) {
      try {
        bytes = await protectOutside(inputs.target.bytes, bytes, inputs.mask.bytes, request.mask?.feather || 0);
        if (await changedOutside(inputs.target.bytes, bytes, inputs.mask.bytes)) throw Object.assign(new Error('Protected-region verification found changed pixels outside the mask'), { code: 'protection_failed' });
        mime = 'image/png'; protection = 'Pixels outside the selection were restored from the original; the exact target version was verified unchanged';
      } catch (error: any) {
        if (error?.code === 'unaligned') {
          const candidate = await this.candidates.put(operation.id, image.index, verified.bytes, verified.mime, error.message);
          return { candidate };
        }
        throw new BackendRefusal('protection_failed', String(error?.message || error));
      }
    } else if (p.acceptUnprotected) protection = 'User explicitly accepted this unprotected provider candidate after it could not be aligned to the target';
    const parents = [
      ...request.references.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, relation: ref.role === 'target' || ref.role === 'edit-base' ? 'target' : `${ref.role}-guide` })),
      ...(request.mask ? [{ artifactId: request.mask.artifactId, versionId: request.mask.versionId, relation: 'mask' }] : []),
    ];
    const version = await this.artifacts.install({ sessionId: operation.sessionId, bytes, mime, name: `${request.operation === 'generate' || request.operation === 'reference' ? 'image' : 'edit'}-${operation.id.slice(0, 8)}-${image.index + 1}.${mime.slice(6)}`,
      source: 'model-generation', operationId: operation.id, turnId: operation.turnId, policy: this.artifacts.inherit(operation.sessionId, versions.map(v => ({ artifactId: v.artifactId, versionId: v.versionId }))), parents,
      provenance: { kind: 'generation', backend: connection.kind, connection: connection.name, model: recipe.backend.model, route: recipe.backend.route, prompt: request.prompt.slice(0, 4000),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}), parameters: JSON.stringify({ size: request.size, aspectRatio: request.aspectRatio, imageSize: request.imageSize, quality: request.quality, format: request.format, background: request.background, seed: request.seed, count: request.count }),
        recipe: { schema: 1, recipeId: recipe.recipeId }, recipeDigest: recipe.digest, outputIndex: image.index, ...(p.candidateId ? { candidateId: p.candidateId } : {}), ...(protection ? { protection } : {}), operationId: operation.id } });
    return { version };
  }
  async acceptUnprotected(sessionId: string, operationId: unknown, candidateId: unknown): Promise<ArtifactVersion> {
    const initial = this.operations.get(operationId);
    if (initial.sessionId !== sessionId) throw new Error('That image operation belongs to another conversation');
    if (typeof candidateId !== 'string') throw new Error('That unprotected candidate is not available for this operation');
    return this.withAcceptanceLock(initial.id, async () => {
    let operation = this.operations.get(initial.id);
    if (operation.sessionId !== sessionId) throw new Error('That image operation belongs to another conversation');
    const candidates = ((operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []), candidate = candidates.find(item => item.candidateId === candidateId);
    if (!candidate) throw new Error('That unprotected candidate is not available for this operation');
    if (candidate.accepted) { await this.candidates.remove(operation.id, candidate.candidateId); return this.artifacts.version(sessionId, candidate.accepted.artifactId, candidate.accepted.versionId); }
    const recipe = await this.operationRecipe(operation);
    const savedConnection = this.connections().find(item => item.id === recipe.backend.connectionId);
    const connection: Pick<ImageConnection, 'kind' | 'name'> = savedConnection || { kind: recipe.backend.kind, name: `${recipe.backend.kind} connection (removed)` };
    const { inputs, versions } = await this.resolve(sessionId, recipe.request, 'local');
    const recovered = this.acceptedCandidateVersion(operation.id, recipe.digest, candidate.candidateId);
    const installed = recovered ? { version: recovered } : await this.candidates.read(operation.id, candidate).then(bytes => this.installGenerated(operation, recipe, connection, recipe.request, inputs, versions, { bytes, mime: candidate.mime, index: candidate.index }, { acceptUnprotected: true, candidateId: candidate.candidateId }));
    if (!installed.version) throw new Error('The candidate could not be accepted');
    // Re-read under the operation lock after artifact publication. This preserves acceptances already
    // recorded for other candidates and repairs the crash window after install but before this update.
    operation = this.operations.get(operation.id);
    const latestCandidates = ((operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []).map(item => item.candidateId === candidate.candidateId ? { ...item, accepted: { artifactId: installed.version!.artifactId, versionId: installed.version!.versionId } } : item);
    const ref = { artifactId: installed.version.artifactId, versionId: installed.version.versionId, purpose: 'generated' };
    const results = operation.results.some(item => item.versionId === ref.versionId) ? operation.results : [...operation.results, ref];
    operation = this.operations.transition(operation.id, operation.state, { results, details: { ...operation.details, unprotectedCandidates: latestCandidates, acceptedUnprotected: true } });
    await this.candidates.remove(operation.id, candidate.candidateId);
    return installed.version;
    });
  }
  async previewCandidate(sessionId: string, operationId: unknown, candidateId: unknown) {
    const operation = this.operations.get(operationId);
    if (operation.sessionId !== sessionId) throw new Error('That image operation belongs to another conversation');
    const candidate = ((operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []).find(item => item.candidateId === candidateId);
    if (!candidate) throw new Error('That unprotected candidate is not available for this operation');
    let bytes: Buffer;
    try { bytes = await this.candidates.read(operation.id, candidate); }
    catch (error) {
      const latest = this.operations.get(operation.id), accepted = ((latest.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []).find(item => item.candidateId === candidate.candidateId)?.accepted;
      if (!accepted) throw error;
      bytes = (await this.artifacts.bytes(sessionId, accepted.artifactId, accepted.versionId)).data;
    }
    const verified = await verifyImage(bytes);
    const thumbnail = await sharp(verified.bytes).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return { data: 'data:image/png;base64,' + thumbnail.toString('base64') };
  }
  private async execute(operationId: string, signal: AbortSignal) {
    let operation = this.operations.get(operationId), dispatched = false, release = () => {};
    const removeJob = this.core.jobs.add('image', operation.label, () => { void this.cancel(operationId); }, () => operation.progress?.max ? { done: operation.progress.value || 0, total: operation.progress.max } : undefined);
    let results: ArtifactRef[] = [];
    try {
      const recipe = await this.operationRecipe(operation), connection = this.connection(operation.backend!.connectionId);
      const backend = recipe.workflow ? this.backendForSnapshot(connection, recipe.workflow, recipe.backend) : await this.backend(connection, operation.backend!.workflow);
      const request = { ...recipe.request, connectionId: connection.id, connectionRevision: connection.revision, adjustments: (operation.details!.adjustments as string[]) || [] };
      results = this.installedResults(operation, recipe);
      if (backend instanceof ComfyImages) {
        const checked: any = await backend.check(this.fetch, AbortSignal.timeout(15_000));
        const missing = [...(Array.isArray(checked.missingNodes) ? checked.missingNodes : []), ...(Array.isArray(checked.missingModels) ? checked.missingModels : [])].map(String);
        if (missing.length) throw new BackendRefusal('missing_dependency', `The snapshotted workflow is missing ${missing.slice(0, 8).join(', ')}`);
        operation = this.operations.update(operation.id, { details: { ...operation.details, dispatchDependencyCheck: { checkedAt: Date.now(), version: String(checked.version || 'unknown'), missing: [] } } });
      }
      release = await this.gpuSlot(operation.backend!.route === 'local' && connection.kind === 'comfyui', signal);
      const { inputs, versions } = await this.resolve(operation.sessionId, request, operation.backend!.route);
      operation = this.operations.transition(operation.id, 'dispatching');
      const context = {
        signal, fetch: this.fetch, key: () => this.key(connection),
        // Authorization is checked again immediately before anything leaves the broker.
        beforeDispatch: () => {
          signal.throwIfAborted();
          if (this.core.settings.paused) throw new BackendRefusal('paused', 'PAL actions were paused before sending');
          const current = this.connection(connection.id);
          if (current.revision !== connection.revision || operation.witness.account!==undefined && operation.witness.account!==this.accountWitness(current)) throw new BackendRefusal('connection_changed', 'The image connection changed before sending');
          for (const version of versions) if (!routeAllowed(operation.backend!.route, this.artifacts.version(operation.sessionId, version.artifactId, version.versionId).policy)) throw new BackendRefusal('destination', 'An input’s processing permission changed before sending');
        },
        dispatched: (remoteId?: string) => {
          dispatched = true;
          if (remoteId) operation = this.operations.update(operation.id, { remoteId, details: { ...operation.details, activeRemoteId: remoteId, remoteStartIndex: results.length } });
        },
      };
      for await (const event of backend.run(request, inputs, context)) {
        if (event.type === 'accepted' && operation.state === 'dispatching') { operation = this.operations.transition(operation.id, 'running', event.remoteId ? { remoteId: event.remoteId } : {}); this.card(operation); }
        else if (event.type === 'queued') operation = this.progress(operation, { note: `Queued${event.position ? ' (position ' + event.position + ')' : ''}` });
        else if (event.type === 'progress') operation = this.progress(operation, { value: event.value, max: event.max, note: event.note });
        else if (event.type === 'partial') { this.partials.set(operation.id, 'data:image/png;base64,' + (await verifyImage(event.bytes).then(v => v.bytes, () => Buffer.alloc(0))).toString('base64')); operation = this.progress(operation, { note: `Preview ${event.index + 1} (provisional)` }); }
        else if (event.type === 'usage') { operation = this.operations.update(operation.id, { usage: { ...operation.usage, ...event.usage } }); this.operations.recordUsage(operation, event.usage, connection.kind); }
        else if (event.type === 'text') operation = this.operations.update(operation.id, { details: { ...operation.details, backendText: event.text.slice(0, 2000) } });
        else if (event.type === 'continuation') operation = this.operations.update(operation.id, { details: { ...operation.details, continuation: event.id } });
        else if (event.type === 'warning') operation = this.operations.update(operation.id, { details: { ...operation.details, warnings: [...((operation.details?.warnings as string[]) || []), event.message].slice(-10) } });
        else if (event.type === 'image') {
          // Verification, strict protection, provenance and persistence are shared with restart recovery.
          const installed = await this.installGenerated(operation, recipe, connection, request, inputs, versions, event);
          if (installed.candidate) {
            const candidates = [...((operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []), installed.candidate];
            operation = this.operations.update(operation.id, { details: { ...operation.details, unprotectedCandidates: candidates } });
          } else if (installed.version) {
            const ref = { artifactId: installed.version.artifactId, versionId: installed.version.versionId, purpose: 'generated' };
            if (!results.some(item => item.versionId === ref.versionId)) results.push(ref);
            operation = this.operations.transition(operation.id, operation.state, { results, details: { ...operation.details, produced: results.length } });
            this.card(operation);
          }
        }
      }
      if (((operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []).some(candidate => !candidate.accepted))
        throw new BackendRefusal('protection_alignment', 'The provider result could not be aligned to the target. It was held as an unprotected candidate and was not added to the conversation; accept it explicitly to keep it.');
      if (!results.length) throw new BackendRefusal('no_image', 'The backend finished without an image');
      operation = this.operations.transition(operation.id, 'completed', { results });
      this.operations.settle(operation.id, 'settled');
      this.partials.delete(operation.id);
      this.core.emit('notice', { kind: 'complete', sessionId: operation.sessionId, text: results.length === 1 ? 'Image ready' : `${results.length} images ready` });
    } catch (error: any) {
      // Shutting down: nothing is decided here. A dispatched job stays recorded as it was, for reconciliation.
      if (this.closing) { if (!dispatched && !terminalStates.includes(this.operations.get(operationId).state)) this.operations.transition(operationId, 'interrupted', { recovery: 'PAL closed before this was sent; nothing was sent.' }); return; }
      const current = this.operations.get(operationId);
      const known = error instanceof BackendRefusal || !dispatched;
      const cancelled = signal.aborted;
      let state: Operation['state'] = cancelled ? (dispatched ? 'unknown' : 'cancelled') : known ? 'failed' : 'unknown';
      if (cancelled && dispatched && current.cancellation?.confirmed) state = 'cancelled';
      const message = cancelled ? (current.cancellation?.note || 'Stopped') : String(error?.message || error).slice(0, 600);
      if (!terminalStates.includes(current.state)) {
        const from = current.state;
        if (from === 'queued' && state === 'unknown') state = 'cancelled';
        operation = this.operations.transition(current.id, from === 'cancel_requested' && state === 'failed' ? 'failed' : state, { results, error: { code: error?.code || (cancelled ? 'cancelled' : 'failed'), message } });
      }
      // A known refusal or a stop before sending costs nothing to the local budget; an uncertain one stays counted.
      this.operations.settle(operationId, state === 'unknown' ? 'unknown' : results.length ? 'settled' : 'released');
    } finally { release(); removeJob(); if (!this.core.closed) this.card(this.operations.get(operationId)); }
  }
  private progress(operation: Operation, progress: { value?: number; max?: number; note?: string }) {
    // Progress is coalesced to a few updates a second; it never invents a percentage.
    const now = Date.now();
    if (now - (this.lastProgress.get(operation.id) || 0) < mediaLimits.progressMs && !progress.note) return operation;
    this.lastProgress.set(operation.id, now);
    return this.operations.update(operation.id, { progress: { ...progress, at: now } });
  }
  /** Cancels owned work as far as the backend can confirm; the outcome says which. */
  async cancel(operationId: unknown) {
    const operation = this.operations.get(operationId);
    if (terminalStates.includes(operation.state)) return operation;
    if (['prepared', 'awaiting_approval', 'queued'].includes(operation.state)) {
      this.controllers.get(operation.id)?.abort(new Error('Cancelled before sending'));
      if (!terminalStates.includes(this.operations.get(operation.id).state)) this.operations.transition(operation.id, 'cancelled', { cancellation: { requested: Date.now(), confirmed: true, note: 'Cancelled before it was sent' } });
      this.operations.settle(operation.id, 'released');
      return this.operations.get(operation.id);
    }
    let result = { confirmed: false, note: 'PAL stopped waiting; the backend may still finish this request, which may be billed.' };
    try {
      if (operation.remoteId && operation.backend) {
        const recipe = await this.operationRecipe(operation).catch(() => undefined), connection = this.connection(operation.backend.connectionId);
        const backend = recipe?.workflow ? this.backendForSnapshot(connection, recipe.workflow, recipe.backend) : await this.backend(connection, operation.backend.workflow);
        if (backend.cancel) result = await backend.cancel(operation.remoteId, { fetch: this.fetch, signal: AbortSignal.timeout(15_000) });
      }
    } catch (error: any) { result = { confirmed: false, note: 'The backend could not be asked to cancel: ' + error.message }; }
    if (this.core.closed) return operation;
    const current = this.operations.get(operation.id);
    if (!terminalStates.includes(current.state)) this.operations.transition(current.id, 'cancel_requested', { cancellation: { requested: Date.now(), confirmed: result.confirmed, note: result.note } });
    this.controllers.get(operation.id)?.abort(new Error(result.note));
    return this.operations.get(operation.id);
  }
  /** After a restart: jobs with a backend ID are checked by status; nothing is submitted again. */
  async reconcile(operation: Operation) {
    try {
      const recipe = await this.operationRecipe(operation), connection = this.connection(operation.backend!.connectionId);
      const backend = recipe.workflow ? this.backendForSnapshot(connection, recipe.workflow, recipe.backend) : await this.backend(connection, operation.backend!.workflow);
      if (!backend.query || !operation.remoteId) return;
      const status = await backend.query(operation.remoteId, { fetch: this.fetch, signal: AbortSignal.timeout(20_000) });
      let current = this.operations.get(operation.id);
      if (status.state === 'completed') {
        if (!status.images?.length) {
          this.operations.transition(current.id, 'failed', { error: { code: 'no_image', message: 'The recovered workflow finished without an image at its declared output' }, recovery: 'Checked after a restart; nothing was submitted again.' });
          this.operations.settle(operation.id, 'settled');
          return;
        }
        const { inputs, versions } = await this.resolve(operation.sessionId, recipe.request, recipe.backend.route);
        const results = this.installedResults(current, recipe), start = Number(current.details?.remoteStartIndex) || 0;
        for (const [index, image] of status.images.entries()) {
          const installed = await this.installGenerated(current, recipe, connection, recipe.request, inputs, versions, { ...image, index: start + index }, { recovered: true });
          if (installed.candidate) {
            const candidates = [...((current.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []), installed.candidate];
            current = this.operations.update(current.id, { details: { ...current.details, unprotectedCandidates: candidates } });
          } else if (installed.version && !results.some(item => item.versionId === installed.version!.versionId)) results.push({ artifactId: installed.version.artifactId, versionId: installed.version.versionId, purpose: 'generated' });
        }
        const candidates = ((current.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []).filter(item => !item.accepted);
        const complete = results.length >= recipe.output.count && !candidates.length;
        const message = candidates.length ? 'Recovered the provider output, but strict mask protection could not align it. It remains a private candidate until explicitly accepted.'
          : complete ? 'Recovered after a restart by checking its status; nothing was submitted again.'
            : `Recovered ${results.length} of ${recipe.output.count} requested images. The remaining member was not submitted again after restart.`;
        this.operations.transition(current.id, complete ? 'completed' : 'failed', { results, details: { ...current.details, produced: results.length, reconciling: false }, ...(!complete ? { error: { code: candidates.length ? 'protection_alignment' : 'incomplete_after_restart', message } } : {}), recovery: message });
        this.operations.settle(operation.id, 'settled');
      } else if (status.state === 'failed') { this.operations.transition(current.id, 'failed', { error: { code: 'workflow_failed', message: status.error || 'failed' }, recovery: 'Checked after a restart.' }); this.operations.settle(operation.id, 'released'); }
      else if (status.state === 'missing') { this.operations.transition(current.id, 'unknown', { recovery: 'After a restart, the backend no longer lists this job; its outcome is unknown and it was not sent again.' }); this.operations.settle(operation.id, 'unknown'); }
      else { this.operations.update(current.id, { details: { ...current.details, reconciling: true, observable: status.state } }); if (!this.controllers.has(current.id)) void this.follow(current.id); }
    } catch (error: any) {
      const current = this.operations.get(operation.id);
      if (!terminalStates.includes(current.state) && !operation.details?.recipe && ['running', 'dispatching', 'cancel_requested'].includes(current.state)) {
        this.operations.transition(current.id, 'unknown', { recovery: 'This job predates replayable image recipes, so PAL could not safely reconstruct its completion after restart. It was not submitted again.', error: { code: 'legacy_recovery', message: String(error?.message || error).slice(0, 300) } });
        this.operations.settle(current.id, 'unknown');
      } else this.operations.update(operation.id, { details: { ...current.details, reconciling: false, reconcileError: String(error?.message || error).slice(0, 300) } });
    }
    finally { this.card(this.operations.get(operation.id)); }
  }
  /** Keeps checking a recovered job that is still queued or running, by status only. */
  private async follow(operationId: string) {
    const operation = this.operations.get(operationId);
    const controller = new AbortController(); this.controllers.set(operationId, controller);
    try {
      for (let attempt = 0; attempt < 1800 && !controller.signal.aborted; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000).unref());
        const current = this.operations.get(operationId);
        if (terminalStates.includes(current.state)) return;
        await this.reconcile(current);
        if (terminalStates.includes(this.operations.get(operationId).state)) return;
      }
    } finally { this.controllers.delete(operationId); void operation; }
  }
  partial(operationId: string) { return this.partials.get(operationId) || ''; }
  /** One result card per operation, updated in place: repeated polls never add another. */
  card(operation: Operation) {
    try {
      const states: Record<string, string> = { prepared: 'Prepared', awaiting_approval: 'Waiting for your approval', queued: 'Queued', dispatching: 'Sending', running: 'Generating', cancel_requested: 'Cancelling',
        completed: 'Complete', failed: 'Failed', cancelled: 'Cancelled', declined: 'Declined', expired: 'Expired', interrupted: 'Interrupted', unknown: 'Outcome unknown' };
      const lines = [`${operation.label}`, `${states[operation.state] || operation.state}${operation.backend ? ' · ' + (this.connections().find(c => c.id === operation.backend!.connectionId)?.name || operation.backend.kind) + ' · ' + routeLabels[operation.backend.route] : ''}`];
      if (operation.error && operation.state !== 'completed') lines.push(operation.error.message);
      if (operation.cancellation?.note && operation.state !== 'completed') lines.push(operation.cancellation.note);
      if (operation.recovery) lines.push(operation.recovery);
      if ((operation.details?.adjustments as string[] | undefined)?.length) lines.push('Adjusted: ' + (operation.details!.adjustments as string[]).join('; '));
      this.core.putMessage({ id: `${operation.sessionId}:op:${operation.id}`, sessionId: operation.sessionId, role: 'workbench', kind: 'operation', operationId: operation.id, time: operation.created,
        text: lines.join('\n'), ...(operation.results.length ? { artifacts: operation.results.slice(0, 16) } : {}) });
    } catch { /* the conversation is gone */ }
  }
  /** The user's selected image in a conversation, so "this image" resolves to it and to nothing else. */
  select(sessionId: string, ref: unknown) {
    if (ref === null) { this.selections.delete(sessionId); return true; }
    const value = ref as ArtifactRef;
    const version = this.artifacts.version(sessionId, value?.artifactId, value?.versionId);
    this.selections.set(sessionId, { artifactId: version.artifactId, versionId: version.versionId, purpose: 'selected' });
    return true;
  }
  cancelAll() { for (const controller of this.controllers.values()) controller.abort(new Error('PAL is closing')); }
  /** Stops waiting on every job, leaves dispatched ones recorded for reconciliation, and settles before the store closes. */
  async close(boundMs = 3000) {
    this.closing = true; this.cancelAll();
    await Promise.race([Promise.allSettled([...this.running]), new Promise(resolve => setTimeout(resolve, boundMs).unref())]);
  }
  async removeSession(sessionId: string) {
    const operationIds = this.artifacts.store.db.prepare('SELECT id FROM operations WHERE session_id=?').all(sessionId).map(row => String(row.id));
    await Promise.all([this.recipes.removeSession(sessionId), this.candidates.removeOperations(operationIds)]);
  }
  async ensureDirectories() {
    await mkdir(this.workflowsDir(), { recursive: true });
    await Promise.all([this.recipes.ensure(), this.candidates.ensure()]);
    const sessions = new Set(this.artifacts.store.db.prepare('SELECT id FROM sessions').all().map(row => String(row.id)));
    const operationRows = this.artifacts.store.db.prepare('SELECT id,data FROM operations').all(), operations = new Set(operationRows.map(row => String(row.id)));
    await Promise.all([this.recipes.collectSessions(sessions), this.candidates.collectOperations(operations)]);
    for (const row of operationRows) {
      try {
        const operation = JSON.parse(String(row.data)) as Operation;
        for (const candidate of (operation.details?.unprotectedCandidates as UnprotectedCandidate[] | undefined) || []) if (candidate.accepted) await this.candidates.remove(operation.id, candidate.candidateId);
      } catch { /* malformed operations are handled by their authoritative store */ }
    }
  }
  capabilitiesSummary(capabilities: ImageCapabilities) {
    const state = (value: { state: string; note?: string }) => value.state + (value.note ? ` (${value.note})` : '');
    return { backend: capabilities.backend, model: capabilities.model, processes: routeLabels[capabilities.route], billed: capabilities.billed, generate: state(capabilities.generate), edit: state(capabilities.edit), mask: state(capabilities.mask), maskBehavior: capabilities.maskBehavior,
      references: capabilities.maxReferences, formats: capabilities.formats, transparency: state(capabilities.transparency), sizes: capabilities.sizes, ...(capabilities.customSize ? { customSize: capabilities.customSize } : {}),
      ...(capabilities.aspectRatios ? { aspectRatios: capabilities.aspectRatios } : {}), ...(capabilities.imageSizes ? { imageSizes: capabilities.imageSizes } : {}), ...(capabilities.qualities ? { qualities: capabilities.qualities } : {}),
      maxCount: capabilities.maxCount, seed: state(capabilities.seed), negativePrompt: state(capabilities.negativePrompt), notes: capabilities.notes };
  }
}
