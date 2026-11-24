import { evaluateInput, jevEvaluate } from './evaluation-services.ts';
import { apiProviders, providerIds, type ApiProvider, isApiProvider } from './provider-catalog.ts';
/**
 * The Workbench: files, artifacts, images and runs attached to a conversation. This facade owns the
 * services and is Core's single entry point for them: the tool registry, the interface's RPCs, session
 * clean-up, restart recovery and shutdown. Authorization stays in one place per service; Core only routes.
 */
import { registerCanvasTools } from './canvas-tools.ts';
import { registerSkillTools } from './skill-tools.ts';
import { limitedControlled, ownerControlled } from './authority.ts';
import { ImageSets } from './artifacts/image-sets.ts';
import { similarImages, selectColour, extendedCanvas, cutout, difference, credentials, deliver, deliverySample } from './artifacts/image-studio.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Core } from './core.ts';
import type { OllamaMessage, OllamaTool } from './ollama.ts';
import type { Session } from './types.ts';
import { completed, declined, failed, routeAllowed, sessionCapabilities, sourcePolicy, workspaceLimits, type DestinationPolicy, type ProcessingRoute, type ToolResultV1 } from './tools/contracts.ts';
import { rm, open, rename, link, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { ToolRegistry } from './tools/registry.ts';
import { confinementProblem, WorkspaceError } from './workspace/fsclient.ts';
import { addPrivateLocation, sessionRoute } from './workspace/policy.ts';
import { WorkspaceRoots, type WorkspaceRoot } from './workspace/roots.ts';
import { ChangeSets, type ChangeSet } from './workspace/changes.ts';
import { find, list, readable, readExcerpt, readText, search, statPath } from './workspace/files.ts';
import { registerFileTools } from './workspace/tools.ts';
import { normalizePath } from './workspace/policy.ts';
import { ArtifactStore, safeName } from './artifacts/store.ts';
import { OperationStore, terminalStates } from './operations/store.ts';
import { TimedMedia } from './media/timed.ts';
import { Recordings } from './media/recordings.ts';
import { Documents } from './documents/service.ts';
import { registerAccountTools } from './accounts/tools.ts';
import { registerCodeTools } from './code-context/tools.ts';
import { Pins } from './workspace/pins.ts';
import { Kernels } from './execution/kernels.ts';
import { MediaService, validConnections, type ImageConnection } from './media/service.ts';
import { Vision, analysisImage, type VisionSettings } from './media/vision.ts';
import { registerImageTools, describeOperation } from './media/tools.ts';
import { BackendRefusal } from './media/contracts.ts';
import { contactSheet, flattenAnnotations, inspect, normalizeMask, transform, validSteps, blankCanvas } from './media/transforms.ts';
import type { ArtifactRef } from './tools/contracts.ts';
import { assist } from './execution/assistance.ts';
import { AnalysisLibrary } from './execution/analyses.ts';
import { compareResultTables } from './execution/compare-results.ts';
import { Execution } from './execution/codelab.ts';
import { Extractor } from './artifacts/extract.ts';
import { registerAnalysisTools } from './execution/tools.ts';
import { References, referenceSchema } from './workspace/references.ts';
import { Helpers, helperRoles, validHelper, type HelperSettings, type HelperRole } from './helpers.ts';

/** Workbench settings: image connections, the vision helper, OCR, Code Lab and the low-memory profile. */
export type WorkbenchSettings = { jevModel?:string; imageConnections: ImageConnection[]; vision: VisionSettings; helper?: HelperSettings; ocr: { languages: string }; codeLab: { enabled: boolean }; lowMemory: boolean };
export const defaultWorkbenchSettings: WorkbenchSettings = { imageConnections: [], vision: { provider: '', model: '' }, helper: { provider: '', model: '' }, ocr: { languages: 'eng' }, codeLab: { enabled: false }, lowMemory: false };
export function validWorkbenchSettings(patch: unknown, current: WorkbenchSettings): WorkbenchSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid Workbench settings');
  const p = patch as Record<string, any>, next = structuredClone(current);
  for (const key of Object.keys(p)) if (!['imageConnections', 'vision', 'helper', 'jevModel','ocr', 'codeLab', 'lowMemory'].includes(key)) throw new Error('Unknown Workbench setting: ' + key);
  if ('jevModel' in p) next.jevModel=z.string().max(128).regex(/^[a-zA-Z0-9._:-]*$/).parse(p.jevModel);
  if ('helper' in p) next.helper = validHelper(p.helper);
  if ('imageConnections' in p) next.imageConnections = validConnections(p.imageConnections, current.imageConnections);
  if ('vision' in p) {
    const v = p.vision;
    if (!v || typeof v !== 'object' || !['', 'ollama', ...apiProviders].includes(v.provider ?? '') || (v.model !== undefined && (typeof v.model !== 'string' || v.model.length > 200 || /[\x00-\x1f]/.test(v.model)))) throw new Error('Choose a vision helper provider and model');
    next.vision=validHelper(v);
    if (next.vision.provider && !next.vision.model) throw new Error('Choose the vision helper’s model');
  }
  if ('ocr' in p) { if (typeof p.ocr?.languages !== 'string' || !/^[a-z_]{3,}(\+[a-z_]{3,}){0,4}$/.test(p.ocr.languages)) throw new Error('OCR languages are Tesseract codes such as eng or eng+deu'); next.ocr = { languages: p.ocr.languages }; }
  if ('codeLab' in p) { if (typeof p.codeLab?.enabled !== 'boolean' || Object.keys(p.codeLab).some(key => key !== 'enabled')) throw new Error('Invalid Code Lab setting'); next.codeLab = { enabled: p.codeLab.enabled }; }
  if ('lowMemory' in p) { if (typeof p.lowMemory !== 'boolean') throw new Error('Invalid low-memory setting'); next.lowMemory = p.lowMemory; }
  return next;
}

export type EditGrant = { id: string; sessionId: string; rootId: string; rootRevision: number; paths: string[]; created: number; expires: number; maxOperations: number; maxBytes: number; usedOperations: number; usedBytes: number };

export class Workbench {
  readonly imageSets = new ImageSets(this);
  core: Core;
  registry = new ToolRegistry();
  roots: WorkspaceRoots;
  changes: ChangeSets;
  artifacts: ArtifactStore;
  operations: OperationStore;
  media: MediaService;
  timedMedia: TimedMedia;
  recordings: Recordings;
  documents: Documents;
  kernels: Kernels;
  pins: Pins;
  vision: Vision;
  execution: Execution;
  analyses: AnalysisLibrary;
  extractor: Extractor;
  references: References;
  helpers: Helpers;
  /** Prepared images a tool asked to show the conversation model, consumed by the media bridge. */
  mediaInputs = new Map<string, Buffer>();
  /** Cancels a running analysis or command by operation ID (Code Lab registers its runs here). */
  runControllers = new Map<string, AbortController>();
  /** Code Lab runs and commands in flight; closing waits for them to record their outcome. */
  private activeRuns = new Set<Promise<unknown>>();
  track<T>(task: Promise<T>): Promise<T> { this.activeRuns.add(task); const done = () => { this.activeRuns.delete(task); }; task.then(done, done); return task; }
  /** False while restart recovery runs inside Core's constructor: no state is published until then. */
  private ready = false;
  /** Counts artifact changes so open browsers know to reload. */
  private artifactRevision = 0;
  // An empty Files pane is a normal state. Refresh it when folders change, including on a phone.
  private rootsRevision = 0;
  /** Empty when confined file access works here; otherwise the reason, shown wherever files are offered. */
  problem = '';
  private probed = false;
  private routes = new Map<string, { route: ProcessingRoute; evidence: string; at: number }>();
  private evidence = new Map<string, number>();
  private grants = new Map<string, EditGrant>();
  private expiryTimers = new Map<string, NodeJS.Timeout>();
  constructor(core: Core) {
    this.core = core;
    addPrivateLocation(core.store.directory);
    this.roots = new WorkspaceRoots(core.store, (root, reason) => this.rootChanged(root, reason));
    this.changes = new ChangeSets(core.store, this.roots);
    this.changes.changed = () => { if (this.ready && !core.closed) core.changed(); };
    this.changes.observed = (sessionId, set, paths) => this.observed(sessionId, set, paths);
    this.artifacts = new ArtifactStore(core.store);
    this.artifacts.changed = () => { this.artifactRevision++; if (this.ready && !core.closed) core.changed(); };
    this.operations = new OperationStore(core.store);
    this.operations.changed = () => { if (this.ready && !core.closed) core.changed(); };
    this.timedMedia=new TimedMedia(core);
    this.recordings = new Recordings(this);
    this.documents = new Documents(this);
    this.kernels = new Kernels(this);
    this.pins = new Pins(this);
    this.media = new MediaService(core, this.artifacts, this.operations);
    this.vision = new Vision(core, this.artifacts);
    this.execution = new Execution(this);
    this.analyses = new AnalysisLibrary(this);
    this.extractor = new Extractor(core.store.directory);
    this.references = new References(this);
    this.helpers = new Helpers(this);
    this.changes.artifactBytes = (sessionId, artifactId, versionId) => this.artifacts.bytes(sessionId, artifactId, versionId);
    this.changes.exported = (sessionId, artifactId, versionId, destination) => { try { this.artifacts.recordExport(this.artifacts.version(sessionId, artifactId, versionId), destination); } catch { /* the artifact went away after the export */ } };
    registerFileTools(this);
    registerImageTools(this);
    registerAnalysisTools(this);
    registerSkillTools(this);
    registerCanvasTools(this);
    this.registerKnowledgeTools();
    this.registerHelperTool();
    this.registerSpecialistTools();
    this.registerTranslationTool();
    this.registerDocumentTool();
    registerAccountTools(this);
    this.registerHistoryTool();
    registerCodeTools(this);
    this.changes.recover();
    void this.artifacts.recover();
    // Outstanding operations never resume by themselves; a backend job with an ID is checked by status.
    const reconcile = this.operations.recover(operation => (operation.backend?.kind === 'comfyui' || ['video.generate','music.generate'].includes(operation.kind)) && !!operation.remoteId);
    this.ready = true;
    for (const operation of reconcile) setImmediate(() => { if (!core.closed && operation.backend?.kind==='comfyui') void this.media.reconcile(operation); });
    void this.probe();
  }
  /** One tool for the narrow helpers: a role, a request, and inputs the conversation can already see. */
  private registerHelperTool() {
    this.registry.register({
      name:'jev_evaluate',family:'analysis',core:false,effects:{network:true,spend:true},input:evaluateInput,
      description:'Ask the configured Jev service to evaluate named probability, choice and score questions about supplied text.',
      available:session=>this.core.settings.workbench.jevModel && this.core.credentials.key('jev') && !session.remote && this.knownRoute(session.id)==='cloud'?'':'Configure Jev for cloud analysis in Workbench',
      run:async({sessionId,signal},input)=>{
        const model=this.core.settings.workbench.jevModel!;
        const allow=await this.core.approval(sessionId,{kind:'provider',title:'Send this evaluation to Jev?',detail:JSON.stringify(input),choices:['allow','deny']});
        if(allow.choice!=='allow')return failed('declined','Evaluation declined','never');
        signal.throwIfAborted();
        const result=await jevEvaluate(this.core.credentials.key('jev'),model,input,signal);
        this.core.store.db.prepare('INSERT INTO usage_records VALUES(?,?,?,?,?)').run(randomUUID(),sessionId,'',Date.now(),JSON.stringify({calls:1,source:'jev',model:result.model,...result.usage}));
        return completed('Jev evaluation results',result);
      },
    });
    this.registry.register({
      name: 'helpers_review', family: 'files', core: false, effects: { read: true },
      description: `Ask a narrow helper model for observations and suggestions on selected inputs. Roles: ${Object.entries(helperRoles).map(([id, label]) => `${id} (${label})`).join(', ')}. The helper has no tools and changes nothing; code_review takes a pending change set's ID; visual_review takes image artifacts. Results are suggestions to check, not facts.`,
      input: z.strictObject({ role: z.enum(Object.keys(helperRoles) as [HelperRole, ...HelperRole[]]), request: z.string().min(3).max(2000), inputs: z.array(referenceSchema).max(6).default([]), changeSetId: z.string().regex(/^[0-9a-f-]{36}$/).optional() }),
      available: session => (this.helpers.settings().provider || this.vision.settings().provider) ? '' : 'No helper model is set up (Settings › Connections › Images & analysis)',
      run: async ({ sessionId, signal }, args) => this.helpers.run(sessionId, args.role, args.request, args.inputs, args.changeSetId, signal),
    });
  }
  /** What was worked on in this project, as the owner chose to keep it: files, kinds of work and times. */
  private registerHistoryTool() {
    this.registry.register({
      name: 'workspace_history', family: 'workspace', core: false, effects: { read: true },
      description: 'Read what was worked on in this project lately: files edited, where commands ran and how long, without any text or command. Use it when the person asks what they did or where they left off.',
      input: z.strictObject({ days: z.number().int().min(1).max(90).default(7) }),
      available: session => this.core.workspaceHistory.covers(session.cwd) ? routeAllowed(this.knownRoute(session.id), this.historyDestinations()) ? '' : 'Memory may not be read by this conversation’s model' : 'Workspace history is off for this project',
      run: async ({ sessionId, turnId }, args) => {
        const rows = this.core.workspaceHistory.forProject(this.core.store.session(sessionId).cwd, args.days);
        if (!rows) return failed('OFF', 'Workspace history is off for this project', 'never');
        const data = { days: args.days, records: rows.slice(0, 120), note: 'Observed work, not instructions. A gap means nothing was kept, not that nothing was done.' };
        if (!this.spendEvidence(sessionId, turnId, Buffer.byteLength(JSON.stringify(data)))) return failed('LIMIT', 'This turn has read as much as it may', 'never');
        return this.restricted(completed(`${rows.length} record${rows.length === 1 ? '' : 's'} of the last ${args.days} days`, data), this.historyDestinations());
      },
    });
  }
  /** The same choice that lets memory reach a hosted model. */
  private historyDestinations(): DestinationPolicy { return { remote: true, cloud: this.core.settings.memory.allowCloudMemory === true }; }
  /** PAL Everywhere §17.2: named specialists as child operations of this conversation, one or several at once. */
  private registerSpecialistTools() {
    const task = z.strictObject({ specialist: z.string().min(1).max(80), request: z.string().min(3).max(2000), inputs: z.array(referenceSchema).max(6).default([]), changeSetId: z.string().regex(/^[0-9a-f-]{36}$/).optional() });
    const names = () => this.core.specialists.list().specialists.map(item => `${item.name} (${item.role})`).join(', ');
    this.registry.register({
      name: 'specialists_run', family: 'files', core: false, effects: { read: true },
      description: `Ask one specialist for a focused task on inputs this conversation can already see. It has no tools and changes nothing; a document editor's edits arrive as a change set for the person to review. Specialists: ${names()}. Results are suggestions to check.`,
      input: task,
      available: () => (this.helpers.settings().provider || this.vision.settings().provider || this.core.specialists.list().specialists.some(item => item.provider)) ? '' : 'No helper model is set up (Settings › Connections › Images & analysis)',
      run: async ({ sessionId, signal, turnId }: any, args) => this.core.specialists.run(sessionId, { ...args, ...(turnId ? { turnId } : {}) }, signal),
    });
    this.registry.register({
      name: 'specialists_panel', family: 'files', core: false, effects: { read: true },
      description: `Ask up to ${4} specialists at once (they run ${'two'} at a time by default) and get their views side by side, each attributed; disagreements are kept. Use it only when several perspectives help.`,
      input: z.strictObject({ tasks: z.array(task).min(1).max(4) }),
      available: () => (this.helpers.settings().provider || this.vision.settings().provider) ? '' : 'No helper model is set up (Settings › Connections › Images & analysis)',
      run: async ({ sessionId, signal, turnId }: any, args) => this.core.specialists.panel(sessionId, args.tasks, turnId, signal),
    });
  }
  /** PAL Everywhere §16.3: translation into a new linked file (documents) or text (selections). */
  private registerTranslationTool() {
    this.registry.register({
      name: 'translate', family: 'files', core: false, effects: { read: true },
      description: 'Translate a text, or a text file or document this conversation can see, into a language, keeping its structure (headings, lists, tables; code is left as is) and an optional glossary. A document becomes a new linked file; the original is never changed.',
      input: z.strictObject({ targetLanguage: z.string().min(2).max(40), text: z.string().max(120_000).optional(), input: referenceSchema.optional(), glossary: z.array(z.strictObject({ source: z.string().min(1).max(200), target: z.string().max(200) })).max(50).optional() }),
      available: () => this.helpers.settings().provider ? '' : 'No helper model is set up (Settings › Connections › Images & analysis)',
      run: async ({ sessionId, signal }, args) => this.core.translation.run({ sessionId, ...args }, signal),
    });
  }
  /** §15.2: a document for other people. It becomes a new file of this conversation; nothing is sent or overwritten. */
  private registerDocumentTool() {
    this.registry.register({
      name: 'documents_export', family: 'files', core: false, effects: { read: true },
      description: 'Make a PDF, Word or web page from Markdown you write, or from a text file, table or transcript this conversation can see. It becomes a new file of this conversation that the person can save.',
      input: z.strictObject({ format: z.enum(['pdf', 'docx', 'html', 'md']), title: z.string().max(200).optional(), markdown: z.string().min(1).max(200_000).optional(), input: referenceSchema.optional(), page: z.enum(['A4', 'Letter']).optional() }),
      available: session => session.temporary ? 'Temporary conversations do not keep files' : '',
      run: async ({ sessionId, signal }, args) => {
        const input = args.input, source = args.markdown !== undefined ? { markdown: args.markdown } : input?.kind === 'artifact' ? { artifactId: input.artifactId, versionId: input.versionId } : input?.kind === 'file' ? { rootId: input.rootId, path: input.path } : undefined;
        if (!source || args.markdown !== undefined && input) return failed('inputs', 'Give either the Markdown or one file', 'explicit');
        if (input) {
          // The model may only turn into a document what it may read itself.
          const route = (await this.route(sessionId, signal)).route;
          const policy = input.kind === 'artifact' ? this.artifacts.version(sessionId, input.artifactId, input.versionId).policy : this.roots.get(sessionId, (input as any).rootId).policy.destinations;
          if (!routeAllowed(route, policy)) return failed('inputs', 'That file may not be processed by this conversation’s model', 'explicit');
        }
        const version = await this.documents.render(sessionId, { ...source, format: args.format, ...(args.title ? { title: args.title } : {}), ...(args.page ? { page: args.page } : {}) }, signal);
        return completed(`${version.name} is ready (${version.bytes} bytes).`, { name: version.name, mime: version.mime, bytes: version.bytes }, { artifacts: [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'document' }] } as any);
      },
    });
  }
  private registerKnowledgeTools() {
    this.registry.register({
      name: 'knowledge_search', family: 'knowledge', core: true, effects: { read: true },
      description: 'Search the document collections bound to this conversation and get excerpts with their sources and locations (pages, sheets, rows, sections). Use it to fetch evidence when you need it.',
      input: z.strictObject({ query: z.string().min(2).max(1000) }),
      available: session => this.core.collections.bound(session).length ? '' : 'No document collection is bound to this conversation',
      run: async ({ sessionId, signal, turnId }, args) => {
        const session = this.core.store.session(sessionId);
        const route = (await this.route(sessionId, signal)).route === 'local' ? 'local' as const : 'cloud' as const;
        const packet = await this.core.collections.context(session, args.query, 2400, route, signal);
        if (!packet.text) return completed(packet.detail?.withheld?.length ? `Nothing could be used: ${packet.detail.withheld.join(', ')} ${packet.detail.withheld.length === 1 ? 'does' : 'do'} not allow this conversation’s model.` : 'No excerpt matched. That does not prove the documents never mention it.', { collections: packet.detail?.collections || [], withheld: packet.detail?.withheld || [] });
        if (!this.spendEvidence(sessionId, turnId, Buffer.byteLength(packet.text))) return failed('evidence-budget', 'This turn already received the most content PAL releases in one turn', 'never');
        const body = JSON.parse(packet.text.replace(/^<pal_document_data>\n|\n<\/pal_document_data>$/g, '').replaceAll('<\\/pal_document_data>', '</pal_document_data>'));
        return completed(`${body.items.length} excerpt${body.items.length === 1 ? '' : 's'} from ${packet.detail.sources.length} source${packet.detail.sources.length === 1 ? '' : 's'}. ${body.how_to_answer}`, { items: body.items, grounding: body.grounding, note: body.note });
      },
    });
  }
  /** Images tools need the Images family; generation additionally needs a configured backend, checked when called. */
  imagesAvailable(session: Session) {
    if (!sessionCapabilities(session).images) return 'Images is not turned on for this conversation';
    return this.core.settings.paused ? 'PAL actions are paused' : '';
  }
  /**
   * The media bridge: images a tool result asked to show the conversation model, re-authorized for the
   * model's current route before they are attached.
   */
  async mediaFor(sessionId: string, refs: ArtifactRef[], signal: AbortSignal) {
    const session = this.core.store.session(sessionId), route = (await sessionRoute(session, this.core.settings, signal, this.core.chatConnections.endpoint(session))).route, images: string[] = [];
    for (const ref of refs.slice(0, 4)) {
      const version = this.artifacts.version(sessionId, ref.artifactId, ref.versionId);
      if (!routeAllowed(route, version.policy)) continue;
      const key = `${ref.artifactId}:${ref.versionId}:${sessionId}`;
      const prepared = this.mediaInputs.get(key) || (await analysisImage((await this.artifacts.bytes(sessionId, ref.artifactId, ref.versionId)).data)).bytes;
      this.mediaInputs.delete(key);
      images.push(prepared.toString('base64'));
    }
    return images;
  }
  async cancelRun(operationId: string) {
    const operation = this.operations.get(operationId);
    if (terminalStates.includes(operation.state)) return operation;
    const controller = this.runControllers.get(operationId);
    if (!controller) return this.operations.get(operationId);
    // A run still waiting for its turn (a queued specialist) ends at once: nothing was sent.
    if (operation.state === 'queued') { controller.abort(new Error('Cancelled by the user')); return this.operations.transition(operation.id, 'cancelled', { cancellation: { requested: Date.now(), confirmed: true, note: 'Cancelled before it started' } }); }
    if (!terminalStates.includes(operation.state)) this.operations.transition(operation.id, 'cancel_requested', { cancellation: { requested: Date.now(), confirmed: false, note: 'Stopping the run' } });
    controller.abort(new Error('Cancelled by the user'));
    return this.operations.get(operationId);
  }
  /** §11.3: what a person can see about a conversation's reach before its next message; counts and names, never content. */
  async contextFacts(session: Session, signal: AbortSignal) {
    const managed = session.provider === 'ollama' || isApiProvider(session.provider);
    const route = managed ? await this.route(session.id, signal).then(value => ({ route: value.route, evidence: value.evidence }), () => ({ route: 'unknown' as const, evidence: '' })) : { route: 'cloud' as const, evidence: 'The provider’s own command-line program decides where it sends this conversation' };
    const families = managed ? this.families(session) : new Set<string>(), { usable, unavailable } = this.registry.availability(session, families), offered = managed ? this.registry.advertise(session, families) : [];
    const skills = this.core.skills.list().filter(skill => skill.status === 'enabled' && (skill.scope === 'personal' || (!!skill.project && (session.cwd === skill.project || session.cwd.startsWith(skill.project + '/')))));
    const helpers = this.operations.usage(session.id).filter((row: any) => /^(helper|specialist|vision|translation)/.test(String(row.kind || '')));
    return { route, tools: { offered: offered.length, available: usable.length, unavailable: unavailable.length, tokens: Math.ceil(Buffer.byteLength(JSON.stringify(offered)) / 2), families: [...families].sort() },
      skills: skills.map(skill => ({ name: skill.name, scope: skill.scope })).slice(0, 24), helpers: { calls: helpers.reduce((sum: number, row: any) => sum + (Number(row.calls) || 1), 0), models: [...new Set(helpers.map((row: any) => String(row.model || '')).filter(Boolean))].slice(0, 6) }, pinned: this.pins.describe(session) };
  }
  async probe() { this.problem = await confinementProblem(); this.probed = true; if (!this.core.closed) this.core.changed(); return this.problem; }

  // ---------- tools ----------
  /** Workbench families this conversation may use right now: selected, not paused, not withheld by its style. */
  families(session: Session) {
    const selected = sessionCapabilities(session), families = new Set<string>();
    if (this.core.settings.paused) return families;
    for (const family of ['files', 'images', 'analysis'] as const) if (selected[family] && !this.core.withheld(session.id, family)) families.add(family);
    // Host commands follow the style's analysis ceiling: a style that withholds running code withholds them too.
    if (selected.host && !this.core.withheld(session.id, 'analysis')) families.add('host');
    if (families.has('images') || families.has('analysis') || families.has('host')) families.add('operations');
    // On-demand collection evidence follows the collections' own binding and consent rules.
    if (!session.temporary && ownerControlled(session) && !this.core.withheld(session.id, 'memory') && this.core.collections.bound(session).length) families.add('knowledge');
    // Workspace history covers this conversation's project only while the owner keeps it (workspace-history.ts).
    if (!session.temporary && ownerControlled(session) && !this.core.withheld(session.id, 'memory') && this.core.memory.active() && this.core.workspaceHistory?.covers(session.cwd)) families.add('workspace');
    if (!session.temporary && ownerControlled(session) && this.core.code?.enabled(session.cwd)) families.add('code');
    // Accounts the owner let assistants use in this project; each tool checks the model's route and the account again.
    if (!this.core.withheld(session.id, 'extensions') && this.core.accounts?.any(session)) families.add('accounts');
    // Enabled skills for this conversation's scope; which of them the model may load is decided per request (skills.ts).
    if (!session.temporary && this.core.skills.list().some(v => v.status === 'enabled' && (v.scope === 'personal' || (!!v.project && (session.cwd === v.project || session.cwd.startsWith(v.project + '/')))))) families.add('skills');
    return families;
  }
  tools(sessionId: string): OllamaTool[] {
    const session = this.core.store.session(sessionId);
    if (!this.core.toolCalling(session)) return [];
    return this.registry.advertise(session, this.families(session));
  }
  /** Refreshes what advertising needs (confinement, the model's processing route) before each request. */
  async prepare(sessionId: string, signal: AbortSignal) {
    const session = this.core.store.session(sessionId);
    if (!this.families(session).size) return;
    if (!this.probed) await this.probe();
    await this.route(sessionId, signal).catch(() => {});
  }
  async route(sessionId: string, signal?: AbortSignal) {
    const session = this.core.store.session(sessionId);
    const route = await sessionRoute(session, this.core.settings, signal, this.core.chatConnections.endpoint(session));
    this.routes.set(sessionId, { ...route, at: Date.now() });
    return route;
  }
  /** The last known route, for synchronous advertising; unknown until checked, which is never treated as local. */
  knownRoute(sessionId: string): ProcessingRoute { return this.routes.get(sessionId)?.route || 'unknown'; }
  async call(sessionId: string, name: string, args: unknown, signal: AbortSignal): Promise<ToolResultV1> {
    const session = this.core.store.session(sessionId);
    return this.registry.call(session, this.families(session), name, args, signal);
  }
  filesAvailable(session: Session, need: 'read' | 'change') {
    if (!sessionCapabilities(session).files) return 'Files is not turned on for this conversation';
    if (this.problem) return this.problem;
    if (!this.probed) return 'Checking file access';
    if (need === 'change' && this.core.withheld(session.id, 'fileChanges')) return 'This conversation’s style withholds file changes';
    const route = this.knownRoute(session.id), roots = this.roots.list(session.id);
    if (!roots.length) return 'No workspace folder is chosen for this conversation';
    const readable = roots.filter(root => routeAllowed(route, root.policy.destinations));
    if (!readable.length) return 'No workspace folder allows this conversation’s model to read its contents';
    if (need === 'change' && !readable.some(root => root.policy.write || root.policy.organize)) return 'No workspace folder allows changes';
    return '';
  }
  /** Bounds the file content released to the model in one turn, before its own context budget applies. */
  spendEvidence(sessionId: string, turnId: string, bytes: number) {
    const key = sessionId + '\n' + turnId, used = this.evidence.get(key) || 0;
    if (used + bytes > workspaceLimits.turnEvidenceBytes) return false;
    this.evidence.delete(key); this.evidence.set(key, used + bytes);
    while (this.evidence.size > 200) this.evidence.delete(this.evidence.keys().next().value!);
    return true;
  }
  restricted<T extends object>(result: T, policy: DestinationPolicy): T { Object.defineProperty(result, sourcePolicy, { value: policy, enumerable: false }); return result; }
  /**
   * The working history as this request may carry it: content read under a destination policy that
   * does not allow the model's current route is replaced by a note, so switching from a local model to a
   * cloud one cannot carry earlier private file content along.
   */
  async restrict(sessionId: string, messages: OllamaMessage[], signal: AbortSignal) {
    if (!messages.some(message => message.restricted)) return { messages, withheld: 0 };
    const route = (await this.route(sessionId, signal)).route;
    let withheld = 0;
    const visible = messages.map(message => {
      if (!message.restricted || routeAllowed(route, message.restricted)) return message;
      withheld++;
      return { ...message, content: '[Workspace content withheld: its folder does not allow this model’s processing destination. Ask the user to read it again with a permitted model.]', images: undefined };
    });
    return { messages: visible, withheld };
  }

  // ---------- change sets ----------
  /** A model proposal: staged, then decided by an edit grant or the user's review. Never applied otherwise. */
  async proposeAndDecide(sessionId: string, turnId: string, operations: unknown[], reason: string, signal: AbortSignal): Promise<ToolResultV1> {
    const set = await this.changes.propose(sessionId, operations, { reason, origin: 'model', turnId }, signal);
    const review = this.changes.review(set.id);
    if (!set.complete) {
      this.changes.retire(set.id, 'declined');
      return failed('too_large_to_review', `These changes are too large to review completely (${set.incompleteReason}). Propose smaller change sets.`, 'explicit');
    }
    const files = review.operations.map(op => op.from ? `${op.from} → ${op.path}` : op.path);
    const card = { id: `${sessionId}:changes:${set.id}`, sessionId, role: 'workbench', kind: 'changes', changeSetId: set.id, time: Date.now(),
      text: `Proposed changes (${set.totals.operations}): ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}\n${reason}` };
    this.core.putMessage(card);
    const grant = this.grantFor(sessionId, set);
    let decidedBy: 'user' | 'grant' = 'grant', selection: number[] | undefined;
    if (!grant) {
      decidedBy = 'user';
      const pending = this.core.approval(sessionId, { kind: 'changeset', title: `Review ${set.totals.operations} file change${set.totals.operations === 1 ? '' : 's'}?`,
        detail: `${reason}\n\n${files.slice(0, 20).join('\n')}${files.length > 20 ? `\n…and ${files.length - 20} more` : ''}\n\nOpen the review to see every change before accepting.`,
        choices: ['allow', 'deny'], fields: { changeSetId: set.id, digest: set.digest, reviewComplete: true, operations: set.totals.operations } });
      const approval = [...this.core.approvals.values()].find(item => item.value.fields?.changeSetId === set.id);
      if (approval) {
        const timer = setTimeout(() => { if (this.core.approvals.has(approval.value.id)) this.core.answer({ id: approval.value.id, choice: 'deny', expired: true }, true); }, Math.max(0, set.expires - Date.now()));
        timer.unref(); this.expiryTimers.set(set.id, timer);
      }
      const answer = await pending;
      clearTimeout(this.expiryTimers.get(set.id)); this.expiryTimers.delete(set.id);
      if (answer.choice !== 'allow') {
        const status = answer.expired ? 'expired' : answer.revoked ? 'revoked' : 'declined';
        this.changes.retire(set.id, status);
        this.core.putMessage({ ...card, text: card.text + `\n${status === 'declined' ? (answer.cancelled ? 'Stopped before review' : 'Declined') : status === 'expired' ? 'Expired before review' : 'Retired: folder permissions changed'}` });
        return declined(status === 'declined' ? (answer.cancelled ? 'The turn was stopped before the user reviewed these changes; nothing was changed.' : 'The user declined these changes; nothing was changed.') : status === 'expired' ? 'The review expired after 15 minutes; nothing was changed.' : 'Folder permissions changed while the review waited; nothing was changed.', { changeSetId: set.id, status });
      }
      if (answer.digest !== undefined && answer.digest !== set.digest) return failed('review_mismatch', 'The accepted review does not match these changes; nothing was changed.', 'never');
      if (answer.operations !== undefined) selection = answer.operations;
    }
    const authorize = () => {
      const current = this.core.store.session(sessionId);
      if (this.core.settings.paused) throw new WorkspaceError('paused', 'PAL actions were paused; nothing more was changed');
      if (!sessionCapabilities(current).files) throw new WorkspaceError('revoked', 'Files was turned off for this conversation; nothing more was changed');
      if (decidedBy === 'grant' && !this.grantFor(sessionId, set, true)) throw new WorkspaceError('revoked', 'The edit permission ended; nothing more was changed');
    };
    const result = await this.changes.apply(set.id, { digest: set.digest, operations: selection, decidedBy, authorize, signal });
    if (decidedBy === 'grant' && grant) { grant.usedOperations += set.totals.operations; grant.usedBytes += set.totals.bytes; this.core.changed(); }
    const lines = result.results.filter(item => item.outcome.state !== 'skipped' || item.outcome.message !== 'Not selected');
    const committed = result.results.filter(item => item.outcome.state === 'committed').length;
    this.core.putMessage({ ...card, text: card.text + `\n${result.status === 'applied' ? 'Applied' : result.status === 'partial' ? 'Partly applied' : result.status === 'unknown' ? 'Outcome unknown' : 'Not applied'} · ${decidedBy === 'grant' ? 'by your edit permission' : 'after your review'}` });
    return completed(`${result.status === 'applied' ? 'Applied' : result.status === 'partial' ? 'Partly applied' : result.status === 'unknown' ? 'Outcome unknown for' : 'Not applied:'} ${committed} of ${set.totals.operations} operation${set.totals.operations === 1 ? '' : 's'}${decidedBy === 'grant' ? ' under the user’s edit permission' : ' after the user’s review'}.`, {
      changeSetId: set.id, status: result.status, decidedBy,
      operations: lines.map(item => ({ index: item.index, path: item.path, change: item.label, outcome: item.outcome.state, ...(item.outcome.message ? { message: item.outcome.message } : {}), ...(item.outcome.sha256 ? { version: 'sha256:' + item.outcome.sha256 } : {}) })),
    });
  }
  /** An active edit grant that covers every operation of this change set, if any. */
  grantFor(sessionId: string, set: ChangeSet, ignoreUsage = false): EditGrant | undefined {
    if (set.origin !== 'model') return;
    const operations = this.changes.operations(set.id).map(item => item.operation);
    if (!operations.every(op => op.kind === 'create_text' || op.kind === 'patch_text' || (op.kind === 'mkdir' && op.implied))) return;
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId || grant.expires <= Date.now()) continue;
      let root: WorkspaceRoot; try { root = this.roots.get(sessionId, grant.rootId); } catch { continue; }
      if (root.revision !== grant.rootRevision || !root.policy.write) continue;
      if (!operations.every(op => op.rootId === grant.rootId && grant.paths.some(prefix => !prefix || op.path === prefix || op.path.startsWith(prefix + '/')))) continue;
      if (!ignoreUsage && (grant.usedOperations + operations.length > grant.maxOperations || grant.usedBytes + set.totals.bytes > grant.maxBytes)) continue;
      return grant;
    }
  }
  grantEdits(p: any) {
    const root = this.roots.get(p.sessionId, p.rootId);
    if (!root.policy.write) throw new Error(`${root.name} does not allow edits; turn on “Create and edit text files” first`);
    const minutes = p.minutes ?? 30, maxOperations = p.maxOperations ?? 20, maxBytes = p.maxBytes ?? 256 * 1024;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('An edit permission lasts 1–240 minutes');
    if (!Number.isInteger(maxOperations) || maxOperations < 1 || maxOperations > 100) throw new Error('Allow 1–100 operations');
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('Allow up to 1 MiB of changed text');
    const paths = Array.isArray(p.paths) && p.paths.length ? p.paths.map((path: unknown) => normalizePath(path, root.path)) : [''];
    if (paths.length > 20) throw new Error('Choose up to 20 paths');
    const time = Date.now(), grant: EditGrant = { id: randomUUID(), sessionId: p.sessionId, rootId: root.id, rootRevision: root.revision, paths, created: time, expires: time + minutes * 60_000, maxOperations, maxBytes, usedOperations: 0, usedBytes: 0 };
    this.grants.set(grant.id, grant); this.core.store.activity({ action: 'workspace.grantEdits', sessionId: p.sessionId, root: root.name, minutes, maxOperations }); this.core.changed();
    return grant;
  }
  revokeGrant(id: unknown) { const removed = typeof id === 'string' && this.grants.delete(id); if (removed) this.core.changed(); return removed; }
  activeGrants(sessionId?: string) { return [...this.grants.values()].filter(grant => grant.expires > Date.now() && (!sessionId || grant.sessionId === sessionId)); }
  /** A root's permissions changed or it was removed: its pending reviews and edit grants are retired. */
  private rootChanged(root: WorkspaceRoot, reason: string) {
    this.rootsRevision++;
    if (reason === 'added') { if (!this.core.closed) this.core.changed(); return; }
    for (const set of this.changes.pendingFor(root.id)) {
      const approval = [...this.core.approvals.values()].find(item => item.value.fields?.changeSetId === set.id);
      if (approval) this.core.answer({ id: approval.value.id, choice: 'deny', revoked: true }, true);
      else this.changes.retire(set.id, 'revoked');
    }
    for (const grant of [...this.grants.values()]) if (grant.rootId === root.id) this.grants.delete(grant.id);
    this.routes.delete(root.sessionId);
    if (!this.core.closed) this.core.changed();
  }
  private observed(sessionId: string, set: ChangeSet, paths: string[]) {
    const time = Date.now();
    for (const path of paths) this.core.workflows.observeEdit(path, time, 'workspace');
    this.core.store.activity({ action: 'workspace.change', sessionId, changeSetId: set.id, status: set.status, decidedBy: set.decidedBy, files: paths.length });
    try { if (!this.core.store.temporary(sessionId)) this.core.workflows.observeAction(sessionId, 'files.change', { changeSetId: set.id, reason: set.reason.slice(0, 200) }, { paths: paths.slice(0, 50) }); } catch { /* A conversation without results keeps its activity record. */ }
  }

  // ---------- interface ----------
  /** Small enough for every state snapshot: counts and IDs, never trees, contents or media. */
  /**
   * What a scheduled run of this conversation may use, for the schedule's authorization envelope: absent
   * when the conversation does not use the Workbench, so schedules made before it are unaffected.
   */
  envelope(session: Session) {
    const capabilities = sessionCapabilities(session), roots = this.roots.list(session.id);
    if (!Object.values(capabilities).some(Boolean) && !roots.length) return undefined;
    const settings = this.core.settings.workbench;
    return { capabilities, roots: roots.map(root => ({ id: root.id, path: root.path, revision: root.revision, policy: root.policy })).sort((a, b) => a.id.localeCompare(b.id)),
      imageConnections: (settings.imageConnections || []).map((connection: any) => ({ id: connection.id, kind: connection.kind, enabled: connection.enabled, model: connection.model || '', budget: connection.budget || null, revision: connection.revision || '' })),
      codeLab: !!settings.codeLab?.enabled, vision: settings.vision || null };
  }
  /**
   * The project shelf: one view over things that keep their own storage and authority. Shared and pinned
   * files, collections bound to the project, accepted capsule decisions and tasks, other conversations and
   * saved recipes. Listing them shares nothing; using one adds a reference to the next message only.
   */
  async shelf(session: Session) {
    const project = session.cwd, db = this.core.store.db;
    const sharedIds = db.prepare("SELECT DISTINCT artifact_id AS id FROM artifact_refs WHERE owner_kind='project' AND owner_id=?").all(project).map(row => String(row.id));
    const pinnedRows = db.prepare('SELECT data FROM artifacts WHERE project=? ORDER BY updated DESC LIMIT 200').all(project).map(row => JSON.parse(String(row.data))).filter((item: any) => item.pinned && this.artifacts.authorized(session.id, item.id));
    const shared = sharedIds.map(id => { try { return this.artifacts.artifact(id); } catch { return null; } }).filter(Boolean) as any[];
    const artifacts = [...new Map([...shared, ...pinnedRows].map((item: any) => [item.id, item])).values()].slice(0, 60).map((item: any) => ({ id: item.id, name: item.name, kind: item.kind, latestVersionId: item.latestVersionId, pinned: item.pinned, shared: sharedIds.includes(item.id), here: item.sessionId === session.id }));
    const capsule = this.core.store.get<any>('capsule:' + project, null);
    const tasks = (capsule?.tasks || []).filter((task: any) => task.state === 'accepted' || task.state === 'active').slice(0, 30).map((task: any) => ({ id: task.id, text: String(task.text).slice(0, 300), state: task.state }));
    const conversations = this.core.store.sessions().filter(other => other.id !== session.id && !other.temporary && other.cwd === project).slice(0, 30).map(other => ({ id: other.id, title: other.title || 'Conversation', provider: other.provider, updated: other.updated || 0 }));
    const recipes = ((await this.core.workflows.dispatch('recipes.list', {})) as any).recipes.slice(0, 40).map((recipe: any) => ({ id: recipe.id, name: recipe.name, version: recipe.version, builtin: !!recipe.builtin, workbench: !!recipe.workbench }));
    return { project, artifacts, collections: this.core.collections.bound(session).map(collection => ({ id: collection.id, name: collection.name, allowCloud: !!collection.allowCloud })),
      capsule: capsule ? { goal: String(capsule.goal || '').slice(0, 500), decisions: (capsule.decisions || []).slice(0, 20), constraints: (capsule.constraints || []).slice(0, 20), tasks } : null, conversations, recipes };
  }
  summary() {
    const pending = this.core.store.db.prepare("SELECT id,session_id FROM change_sets WHERE status='pending' ORDER BY created DESC LIMIT 50").all().map(row => ({ changeSetId: String(row.id), sessionId: String(row.session_id) }));
    const active = this.operations.active().slice(0, 50).map(operation => ({ operationId: operation.id, sessionId: operation.sessionId, kind: operation.kind, state: operation.state }));
    return { problem: this.problem, checked: this.probed, artifactRevision: this.artifactRevision, rootsRevision: this.rootsRevision, pendingChanges: pending, activeOperations: active, imageConnections: this.media.connections().filter(c => c.enabled).length, grants: this.activeGrants().map(({ id, sessionId, rootId, paths, expires, maxOperations, usedOperations, maxBytes, usedBytes }) => ({ id, sessionId, rootId, paths, expires, maxOperations, usedOperations, maxBytes, usedBytes })) };
  }
  static readOnly = ['workspace.roots', 'workspace.grants', 'files.list', 'files.stat', 'files.read', 'files.text', 'files.table', 'files.find', 'files.search', 'changes.list', 'changes.review', 'changes.trash',
    'shelf.get', 'references.search', 'references.pin', 'references.preview', 'artifacts.list', 'artifacts.get', 'artifacts.derived', 'artifacts.thumbnail', 'artifacts.file', 'images.connections', 'images.capabilities', 'operations.list', 'operations.get', 'operations.partial', 'operations.usage', 'operations.history', 'operations.compare', 'codelab.status', 'codelab.table', 'codelab.preflight', 'codelab.open', 'codelab.library', 'codelab.load'];
  private session(id: unknown) {
    if (typeof id !== 'string') throw new Error('Choose a conversation');
    const session = this.core.store.session(id);
    if (session.temporary) throw new Error('Temporary conversations stay text-only; files are unavailable');
    if (limitedControlled(session)) throw new Error('A limited phone controls this conversation; its files are managed on the desktop or an owner phone');
    return session;
  }
  private async rootFor(p: any) { const session = this.session(p.sessionId), root = this.roots.get(session.id, p.rootId); return { session, root }; }
  async dispatch(method: string, p: any): Promise<any> {
    switch (method) {
      case 'shelf.get': return this.shelf(this.session(p.sessionId));
      case 'references.search': { const session = this.session(p.sessionId); return { candidates: await this.references.search(session, p.query) }; }
      // §11.3: sources kept beside every message of a conversation or project.
      case 'references.pins': return this.pins.describe(this.session(p.sessionId));
      case 'references.keep': return this.pins.add(this.session(p.sessionId), p);
      case 'references.unkeep': return this.pins.remove(this.session(p.sessionId), p.id);
      case 'references.pin': return this.references.pin(this.session(p.sessionId), p.ref);
      case 'references.preview': return this.references.preview(this.session(p.sessionId), p.references, typeof p.text === 'string' ? p.text.slice(0, 2000) : '', AbortSignal.timeout(20_000));
      case 'workspace.roots': {
        const session = this.session(p.sessionId);
        return { problem: this.problem, roots: await Promise.all(this.roots.list(session.id).map(async root => ({ ...root, status: await this.roots.status(root) }))), grants: this.activeGrants(session.id) };
      }
      case 'workspace.addRoot': this.session(p.sessionId); return this.roots.add(p.sessionId, p.path, p.policy, p.primary);
      case 'workspace.conversationRoot': this.session(p.sessionId); return this.roots.conversationRoot(p.sessionId, p.policy);
      case 'workspace.updateRoot': this.session(p.sessionId); return this.roots.update(p.sessionId, p.rootId, p.policy, p.expectedRevision, p.primary);
      case 'workspace.removeRoot': this.session(p.sessionId); return this.roots.remove(p.sessionId, p.rootId);
      case 'workspace.grantEdits': this.session(p.sessionId); return this.grantEdits(p);
      case 'workspace.revokeGrant': return this.revokeGrant(p.id);
      case 'workspace.grants': return this.activeGrants(this.session(p.sessionId).id);
      // The person at the desktop browses and previews directly; model-only limits (destinations, the turn budget) do not apply.
      case 'files.list': { const { root } = await this.rootFor(p); return list(root, normalizePath(p.path, root.path), { cursor: p.cursor, limit: p.limit, hidden: p.hidden === true || root.policy.hidden }); }
      case 'codelab.inputFile': {
        const { session, root } = await this.rootFor(p), rel = normalizePath(p.path, root.path);
        readable(root, rel);
        const file = await readText(root, rel);
        if (p.version && p.version !== file.version) throw new Error('The file changed. Reload its preview before analyzing this version.');
        const value = await this.artifacts.install({ sessionId: session.id, bytes: file.bytes, name: rel.split('/').pop()!, source: 'user-import',
          policy: root.policy.destinations, provenance: {kind:'workspace-snapshot', root:root.id, path:rel, version:file.version} });
        return {artifactId:value.artifactId, versionId:value.versionId};
      }
      case 'files.stat': { const { root } = await this.rootFor(p); return statPath(root, normalizePath(p.path, root.path)); }
      case 'files.read': { const { root } = await this.rootFor(p); return readExcerpt(root, normalizePath(p.path, root.path), { startLine: p.startLine, lineCount: Math.min(Number(p.lineCount) || 300, 300) }); }
      case 'files.table': {
        // §15.2: a table's columns and types before analysis, with the same path and readability checks as reading it.
        const { root } = await this.rootFor(p), rel = normalizePath(p.path, root.path);
        readable(root, rel);
        const file = await readText(root, rel);
        if (file.binary) throw new Error('This is not a text table');
        const { previewTable } = await import('./table-preview.ts');
        return { name: rel.split('/').pop(), ...previewTable(file.text, rel) };
      }
      case 'files.text': {
        // The whole text for the Workbench editor, bounded by what one proposal may stage.
        const { root } = await this.rootFor(p), rel = normalizePath(p.path, root.path);
        readable(root, rel);
        const file = await readText(root, rel);
        if (file.binary) throw new Error('This is not UTF-8 text; open it in another application');
        if (file.size > workspaceLimits.proposalBytes) throw new Error('This file is larger than 256 KiB, the most PAL edits in one change; open it in your editor');
        return { path: rel, version: file.version, text: file.text, newline: file.newline, endsWithNewline: file.endsWithNewline, size: file.size };
      }
      case 'files.find': { const { root } = await this.rootFor(p); return find(root, normalizePath(p.path, root.path), String(p.pattern || ''), { cursor: p.cursor }); }
      case 'files.search': { const { root } = await this.rootFor(p); return search(root, normalizePath(p.path, root.path), p.query, { mode: p.mode === 'regex' ? 'regex' : 'literal', caseSensitive: p.caseSensitive === true, cursor: p.cursor }); }
      case 'changes.list': return this.changes.list(this.session(p.sessionId).id).map(set => ({ ...set, pendingApproval: [...this.core.approvals.values()].some(item => item.value.fields?.changeSetId === set.id) }));
      case 'changes.review': { const review = this.changes.review(p.id); this.session(review.sessionId); return { ...review, approvalId: [...this.core.approvals.values()].find(item => item.value.fields?.changeSetId === review.id)?.value.id || '' }; }
      case 'changes.propose': { const session = this.session(p.sessionId); const set = await this.changes.propose(session.id, p.operations, { reason: p.reason || 'Edited in the Workbench', origin: 'user' }); return this.changes.review(set.id); }
      case 'changes.apply': {
        const set = this.changes.get(p.id); this.session(set.sessionId);
        // A model's proposal is decided through its approval, so the waiting turn hears the outcome.
        const approval = [...this.core.approvals.values()].find(item => item.value.fields?.changeSetId === set.id);
        if (approval) { this.core.answer({ id: approval.value.id, choice: 'allow', digest: p.digest, ...(p.operations ? { operations: p.operations } : {}) }); return { decided: true, changeSetId: set.id }; }
        return this.changes.apply(set.id, { digest: p.digest, operations: p.operations, decidedBy: 'user', authorize: () => { this.session(set.sessionId); } });
      }
      case 'changes.decline': {
        const set = this.changes.get(p.id); this.session(set.sessionId);
        const approval = [...this.core.approvals.values()].find(item => item.value.fields?.changeSetId === set.id);
        if (approval) { this.core.answer({ id: approval.value.id, choice: 'deny' }); return true; }
        this.changes.retire(set.id, 'declined'); return true;
      }
      case 'changes.undo': { const set = this.changes.get(p.id); this.session(set.sessionId); return this.changes.undo(set.id); }
      case 'changes.trash': return this.changes.trashItems(this.session(p.sessionId).id);
      case 'changes.purge': { const session = this.session(p.sessionId); if (p.confirmed !== true) throw new Error('Confirm permanent deletion'); return this.changes.purge(p.trashId, session.id); }
      default: return this.dispatchMedia(method, p);
    }
  }
  async startUserImage(p:any, replaying=false, bind?:(operationId:string)=>void) {
    const session = this.session(p.sessionId);
    const replay = replaying ? await this.media.recipe(session.id, {recipeId:p.recipeId}) : null;
    const connection = this.media.connection(replay?.backend.connectionId || p.connectionId);
    const billed = replay ? replay.backend.billed : (await this.media.backend(connection,p.workflowId)).describe().billed;
    if (billed && !connection.billingAcknowledged && p.acknowledgeBilling !== true) throw Object.assign(new Error(`${connection.name} may bill your account for each image. Confirm once to continue.`), { code: 'ACKNOWLEDGE_BILLING' });
    if (p.acknowledgeBilling === true && !connection.billingAcknowledged) await this.core.updateSettings({ workbench: { imageConnections: this.media.connections().map(item => item.id === connection.id ? { ...item, billingAcknowledged: true } : item) } });
    const prepared = replay ? await this.media.prepareReplay(session.id,replay.recipeId,{origin:'user',overrides:p.overrides}) : await this.media.prepare(session.id, p.request, { connectionId: connection.id, workflowId: p.workflowId, origin: 'user' });
    bind?.(prepared.operation.id);
    if (prepared.duplicate) return { ...describeOperation(prepared.operation), duplicate: true };
    return describeOperation(await this.media.start(prepared.operation.id));
  }
  private async recognizeImage(sessionId:string, artifactId:string, versionId:string, region?:import('./media/vision.ts').Region, keepTranscript=false) {
    const {version,data} = await this.artifacts.bytes(sessionId,artifactId,versionId);
    const prepared = await analysisImage(data,region);
    const {ocr} = await import('./media/vision.ts');
    const result = await ocr(prepared.bytes,this.core.settings.workbench?.ocr?.languages || 'eng',AbortSignal.timeout(60_000));
    const scaleX = prepared.sourceWidth / prepared.width, scaleY = prepared.sourceHeight / prepared.height;
    const lines = result.slice(0,4000).map(line => ({...line, box:{
      left: (region?.left || 0) + Math.floor(line.box.left * scaleX), top: (region?.top || 0) + Math.floor(line.box.top * scaleY),
      width: Math.ceil(line.box.width * scaleX), height: Math.ceil(line.box.height * scaleY)
    }}));
    this.artifacts.version(sessionId,artifactId,version.versionId);
    if (!region) this.core.store.db.prepare(`INSERT INTO image_analysis(version_id,ocr,boxes) VALUES(?,?,?)
      ON CONFLICT(version_id) DO UPDATE SET ocr=excluded.ocr, boxes=excluded.boxes`).run(version.versionId,
      lines.map(l => l.text).join(' ').slice(0,500000), JSON.stringify(lines.map(l => l.box)));
    if (keepTranscript) {
      const transcript=await this.artifacts.install({sessionId, name:version.name+' OCR.txt',
        bytes:Buffer.from(lines.map(l=>l.text).join('\n')),mime:'text/plain',source:'derived',policy:version.policy,
        parents:[{artifactId:version.artifactId,versionId:version.versionId,relation:'ocr'}],
        provenance:{kind:'ocr',sourceVersion:version.versionId,...(region?{region}:{})}});
      return {lines,image:prepared.note,transcript};
    }
    return { lines, image:prepared.note };
  }
  private async dispatchMedia(method: string, p: any): Promise<any> {
    const owned = (operationId: unknown) => { const operation = this.operations.get(operationId); this.session(operation.sessionId); return operation; };
    switch (method) {
      case 'artifacts.list': { const session = this.session(p.sessionId); return this.artifacts.list(session.id, { kind: p.kind, source: p.source, query: p.query, project: p.project === true, scope: p.scope, collection: p.collection, before: p.before, limit: p.limit }); }
      case 'artifacts.get': {
        const session = this.session(p.sessionId), artifact = this.artifacts.artifact(p.artifactId), versions = this.artifacts.versions(session.id, artifact.id);
        return { artifact, versions: await Promise.all(versions.map(async version => ({ ...version, available: await this.artifacts.available(version), exports: this.artifacts.exports(version) }))) };
      }
      case 'artifacts.thumbnail': return { data: await this.artifacts.thumbnail(this.session(p.sessionId).id, p.artifactId, p.versionId, p.size) };
      // The interface previews the verified file directly; the model never sees this location.
      case 'artifacts.file': { const { version } = await this.artifacts.bytes(this.session(p.sessionId).id, p.artifactId, p.versionId); return { path: this.artifacts.objectPath(version.sha256), mime: version.mime, name: version.name, bytes: version.bytes, image: version.image || null }; }
      case 'artifacts.update': return this.artifacts.update(this.session(p.sessionId).id, p.artifactId, p);
      case 'artifacts.remove': return this.artifacts.removeFromSession(this.session(p.sessionId).id, p.artifactId, p.scope ?? 'artifact');
      case 'artifacts.derived': { const session = this.session(p.sessionId); const artifact = this.artifacts.artifact(p.artifactId); if (!this.artifacts.authorized(session.id, artifact.id)) throw new Error('That artifact is not available in this conversation'); return { derived: this.artifacts.derivedIn(session.id, artifact.id).map(id => { const item = this.artifacts.artifact(id); return { id, name: item.name, kind: item.kind }; }) }; }
      case 'artifacts.import': {
        // A file the user chose (dialog or drop): a private snapshot; the original is never touched again.
        const session = this.session(p.sessionId);
        if (typeof p.path !== 'string' || !p.path.startsWith('/')) throw new Error('Choose a file');
        const { readFile, stat } = await import('node:fs/promises');
        const info = await stat(p.path); if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('Choose a regular file up to 100 MiB');
        const bytes = await readFile(p.path), name = p.path.split('/').pop() || 'file';
        // With an artifact ID, the file comes back from an external editor as that artifact's next version.
        const base = p.artifactId ? this.artifacts.version(session.id, p.artifactId, p.versionId) : undefined;
        const version = await this.artifacts.install({ sessionId: session.id, bytes, name, source: base ? 'derived' : 'user-import', policy: base ? base.policy : validDestinations(p.destinations),
          ...(base ? { artifactId: base.artifactId, parents: [{ artifactId: base.artifactId, versionId: base.versionId, relation: 'external-edit' }] } : {}), provenance: { kind: base ? 'external-edit' : 'import', name: safeName(name) } });
        return version;
      }
      case 'artifacts.saveAs': {
        // A location the user picked in the save dialog: written there once, never kept in sync.
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId);
        if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.length > 4096) throw new Error('Choose where to save it');
        const { writeFile } = await import('node:fs/promises');
        await writeFile(p.path, data, { flag: p.replace === true ? 'w' : 'wx', mode: 0o644 }).catch((error: any) => { if (error?.code === 'EEXIST') throw new Error('A file already exists there; confirm replacing it'); throw error; });
        this.artifacts.recordExport(version, p.path);
        return { path: p.path, bytes: data.length };
      }
      case 'artifacts.export': {
        // Into a workspace folder as a reviewed change set, like any other new file.
        const session = this.session(p.sessionId);
        const set = await this.changes.propose(session.id, [{ kind: 'export', rootId: p.rootId, path: p.path, artifactId: p.artifactId, versionId: p.versionId }], { reason: 'Export from the Workbench', origin: 'user' });
        return this.changes.review(set.id);
      }
      case 'artifacts.extract': {
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId);
        const result = await this.extractor.extract(this.artifacts, session.id, version, data, extractOptions(p.options));
        return { ...result.extraction, units: result.extraction.units.slice(0, 200), extractionArtifact: { artifactId: result.artifact.artifactId, versionId: result.artifact.versionId }, reused: result.reused };
      }
      case 'artifacts.useInDraft': {
        // Attaches the verified bytes to the composer as an ordinary attachment.
        const session = this.session(p.sessionId), { version } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId);
        const asset = await this.core.attachments.import(session.id, this.artifacts.objectPath(version.sha256), this.core.imageRefusal(session));
        this.core.changed();
        return { ...asset, name: version.name };
      }
      case 'artifacts.bundle': {
        const session = this.session(p.sessionId);
        if (!Array.isArray(p.items) || !p.items.length || p.items.length > 50) throw new Error('Choose 1–50 artifacts to bundle');
        const { zipFilesAsync } = await import('./artifacts/zip.ts');
        const entries: { name: string; data: Buffer }[] = [], manifest: any[] = [], used = new Set<string>();
        for (const item of p.items) {
          const { version, data } = await this.artifacts.bytes(session.id, item.artifactId, item.versionId);
          let name = safeName(version.name); for (let n = 2; used.has(name); n++) name = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
          used.add(name); entries.push({ name, data });
          manifest.push({ file: name, artifactId: version.artifactId, versionId: version.versionId, sha256: version.sha256, bytes: version.bytes, mime: version.mime, created: new Date(version.createdAt).toISOString(), source: version.source });
        }
        entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ created: new Date().toISOString(), items: manifest }, null, 2)) });
        const bytes = await zipFilesAsync(entries), policy = this.artifacts.inherit(session.id, p.items);
        return this.artifacts.install({ sessionId: session.id, bytes, name: safeName(p.name, 'bundle') + '.zip', mime: 'application/zip', source: 'derived', policy, parents: p.items.map((item: any) => ({ ...item, relation: 'bundled' })), provenance: { kind: 'bundle', items: manifest.length } });
      }
      // §15.2: documents for other people.
      case 'documents.formats': return { formats: this.documents.formats(), templates: this.documents.templates() };
      case 'documents.fill': return this.documents.fill(this.session(p.sessionId).id, p);
      case 'documents.save': return this.documents.save(this.session(p.sessionId).id, p);
      case 'documents.render': return this.documents.render(this.session(p.sessionId).id, p);
      // §16.3: recordings with time-coded transcripts, corrections, subtitles and clips.
      case 'recordings.list': return this.recordings.list(this.session(p.sessionId).id, p);
      case 'recordings.open': return this.recordings.open(this.session(p.sessionId).id, p);
      case 'recordings.cues': return this.recordings.page(this.session(p.sessionId).id, p);
      case 'recordings.transcribe': return describeForUi(this.recordings.transcribe(this.session(p.sessionId).id, p));
      case 'recordings.correct': return this.recordings.correct(this.session(p.sessionId).id, p);
      case 'recordings.subtitles': return this.recordings.subtitles(this.session(p.sessionId).id, p);
      case 'recordings.clip': return describeForUi(await this.recordings.clip(this.session(p.sessionId).id, p));
      case 'images.kits': return this.imageSets.library(this.session(p.sessionId).id);
      case 'images.saveKit':
      case 'images.saveSet': return this.imageSets.save(this.session(p.sessionId).id,p,method === 'images.saveSet');
      case 'images.openSet': return this.imageSets.open(this.session(p.sessionId).id,p);
      case 'images.renderSet': return this.imageSets.render(this.session(p.sessionId).id,p);
      case 'images.previewMember':
      case 'images.renderMember':
      case 'images.approveMember': return this.imageSets.member(this.session(p.sessionId).id,p,method==='images.previewMember'?'preview':method==='images.renderMember'?'render':'approve');
      case 'images.connections': return { connections: this.media.connections().map(connection => this.media.publicConnection(connection)), vision: this.vision.settings() };
      case 'images.capabilities': { const value = await this.media.capabilities(p.connectionId, p.workflowId); return { ...value, summary: this.media.capabilitiesSummary(value.capabilities) }; }
      case 'images.test': return this.media.test(p.connectionId);
      case 'images.setToken': return this.media.setToken(p.connectionId, p.token);
      case 'images.importWorkflow': {
        // A workflow file the user chose in the dialog, read once and bounded; or the graph itself.
        if (typeof p.path === 'string') {
          const { readFile, stat } = await import('node:fs/promises');
          if (!p.path.startsWith('/') || (await stat(p.path)).size > 2 * 1024 * 1024) throw new Error('Choose a workflow file up to 2 MB');
          return this.media.importWorkflow(p.connectionId, p.name || p.path.split('/').pop()!.replace(/\.json$/i, ''), await readFile(p.path, 'utf8'));
        }
        return this.media.importWorkflow(p.connectionId, p.name, p.graph);
      }
      case 'images.reviewWorkflow': return this.media.reviewWorkflow(p.connectionId, p.workflowId, p);
      case 'images.select': return this.media.select(this.session(p.sessionId).id, p.ref ?? null);
      case 'images.exportRecipe': {
        const session = this.session(p.sessionId);
        if (typeof p.path !== 'string' || !isAbsolute(p.path)) throw new Error('Choose a destination file');
        const payload = await this.media.exportPortableRecipe(session.id,p.recipeId,{includeInputs:p.includeInputs===true});
        const stage = join(dirname(p.path),'.pal-image-recipe-'+randomUUID());
        await writeFile(stage,payload.json,{flag:'wx',mode:0o600});
        try {
          if (p.replace===true) await rename(stage,p.path);
          else await link(stage,p.path);
        } finally {await rm(stage,{force:true});}
        return {path:p.path,bytes:payload.bytes};
      }
      case 'images.inspectRecipeFile':
      case 'images.importRecipeFile': {
        const session = this.session(p.sessionId);
        if (typeof p.path!=='string' || !isAbsolute(p.path)) throw new Error('Choose an image recipe file');
        const file=await open(p.path,'r');
        let json:string;
        try {
          const info=await file.stat();
          if (!info.isFile() || info.size>140*1024*1024) throw new Error('Choose a recipe file up to 140 MiB');
          json=await file.readFile('utf8');
        } finally {await file.close();}
        return method==='images.inspectRecipeFile' ? this.media.inspectPortableRecipe(session.id,json,p) : this.media.importPortableRecipe(session.id,json,p);
      }
      case 'images.recipe': return this.media.recipe(this.session(p.sessionId).id,p);
      case 'images.previewCandidate': return this.media.previewCandidate(this.session(p.sessionId).id,p.operationId,p.candidateId);
      case 'images.acceptUnprotected': return this.media.acceptUnprotected(this.session(p.sessionId).id,p.operationId,p.candidateId);
      case 'images.replay':
      case 'images.generate': return this.startUserImage(p, method==='images.replay');
      case 'images.preview': {
        // Validation only: what would be sent and what would be adjusted, before the user commits.
        const session = this.session(p.sessionId), connection = this.media.connection(p.connectionId), backend = await this.media.backend(connection, p.workflowId);
        const request = this.media.validRequest(p.request), { request: validated, adjustments } = backend.validate(request);
        await this.media.resolve(session.id, validated, backend.describe().route);
        return { request: validated, adjustments, capabilities: this.media.capabilitiesSummary(backend.describe()),
          ...(connection.estimate ? {estimate:{currency:connection.estimate.currency,perImage:connection.estimate.perImage,total:connection.estimate.perImage * validated.count}} : {}) };
      }
      case 'images.transform': {
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId), result = await transform(data, validSteps(p.steps));
        return this.artifacts.install({ sessionId: session.id, artifactId: version.artifactId, bytes: result.bytes, mime: result.mime, name: version.name.replace(/\.[a-z]+$/i, '') + '.' + result.mime.slice(6), source: 'derived', policy: version.policy,
          parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'transform' }], provenance: { kind: 'transform', steps: JSON.stringify(p.steps).slice(0, 2000), notes: result.notes } });
      }
      case 'images.markup':
      case 'images.saveEdit': {
        // The editor's flattened annotations become a new version; the recipe (shapes, labels) is kept with it so it stays editable.
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId);
        const layer = decodePng(p.layer), flattened = await flattenAnnotations(data, layer);
        if (method === 'images.markup') return this.artifacts.install({sessionId:session.id,bytes:flattened,mime:'image/png',name:'Markup guide for '+version.name,
          source:'derived',policy:version.policy,parents:[{artifactId:version.artifactId,versionId:version.versionId,relation:'instruction-guide'}],provenance:{kind:'markup-guide'}});
        return this.artifacts.install({ sessionId: session.id, artifactId: version.artifactId, bytes: flattened, mime: 'image/png', name: version.name.replace(/\.[a-z]+$/i, '') + '.png', source: 'derived', policy: version.policy,
          parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'annotated' }], provenance: { kind: 'annotation', recipe: typeof p.recipe === 'string' ? p.recipe.slice(0, 200_000) : '' } });
      }
      case 'images.mask': {
        // A painted mask kept as its own artifact, bound to the exact version and size it was drawn on.
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId), facts = await inspect(data);
        const mask = await normalizeMask(decodePng(p.mask), { width: facts.width, height: facts.height });
        return this.artifacts.install({ sessionId: session.id, bytes: mask.bytes, mime: 'image/png', name: `mask for ${version.name.replace(/\.[a-z]+$/i, '')}.png`, source: 'derived', policy: version.policy, label: 'mask',
          parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'mask-base' }], provenance: { kind: 'mask', base: version.versionId, width: facts.width, height: facts.height, coverage: Math.round(mask.coverage * 1000) / 10 } });
      }
      case 'images.sketch': { const session = this.session(p.sessionId); return this.artifacts.install({ sessionId: session.id, bytes: await blankCanvas(p.width, p.height, typeof p.background === 'string' && /^#[0-9a-f]{6}$/i.test(p.background) ? p.background : '#ffffff'), mime: 'image/png', name: 'sketch.png', source: 'user-import', provenance: { kind: 'sketch' } }); }
      case 'images.contactSheet': {
        const session = this.session(p.sessionId);
        if (!Array.isArray(p.items) || !p.items.length || p.items.length > 16) throw new Error('Choose 1–16 images');
        const images = await Promise.all(p.items.map(async (item: any) => { const { version, data } = await this.artifacts.bytes(session.id, item.artifactId, item.versionId); return { bytes: data, label: version.name }; }));
        return this.artifacts.install({ sessionId: session.id, bytes: await contactSheet(images), mime: 'image/png', name: 'contact sheet.png', source: 'derived', policy: this.artifacts.inherit(session.id, p.items), parents: p.items.map((item: any) => ({ ...item, relation: 'sheet' })), provenance: { kind: 'contact-sheet', items: p.items.length } });
      }
      case 'images.inspect': { const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId); return { ...(await inspect(data)), provenance: version.provenance }; }
      case 'images.ocr': return this.recognizeImage(this.session(p.sessionId).id, p.artifactId, p.versionId, p.region, p.keepTranscript===true);
      case 'images.indexText': {
        const session = this.session(p.sessionId);
        const page = this.artifacts.list(session.id, { kind:'image', scope:p.scope, before:p.before, limit:4 });
        let indexed = 0, skipped = 0;
        for (const image of page.artifacts) {
          if (this.core.store.db.prepare("SELECT 1 FROM image_analysis WHERE version_id=? AND boxes IS NOT NULL").get(image.latestVersionId)) { skipped++; continue; }
          try { await this.recognizeImage(session.id, image.id, image.latestVersionId); indexed++; }
          catch (e:any) { if (['unavailable','missing_language'].includes(e.code)) throw e; skipped++; }
        }
        return { indexed, skipped, before:page.before };
      }
      case 'images.similar': return similarImages(this.artifacts,this.session(p.sessionId).id,p,p.scope);
      case 'images.deliverySample': return deliverySample(this.artifacts,this.session(p.sessionId).id,p);
      case 'images.deliveryPreview':
      case 'images.deliver': {
        const sessionId=this.session(p.sessionId).id;
        return deliver(this.artifacts,sessionId,p,method==='images.deliveryPreview',
          async recipeId=>(await this.media.exportPortableRecipe(sessionId,recipeId)).json);
      }
      case 'images.credentials': {
        const {version,data} = await this.artifacts.bytes(this.session(p.sessionId).id,p.artifactId,p.versionId);
        return credentials(data,version.image?.format || '');
      }
      case 'images.difference': {
        const id = this.session(p.sessionId).id;
        const [a,b] = await Promise.all([p,p.other].map(r => this.artifacts.bytes(id,r.artifactId,r.versionId)));
        return difference(a.data,b.data);
      }
      case 'images.selectColour': {
        const {data} = await this.artifacts.bytes(this.session(p.sessionId).id,p.artifactId,p.versionId);
        const png = await selectColour(data,p.point,p.tolerance,p.invert === true,p.mode === 'subject');
        return { overlay:'data:image/png;base64,' + png.toString('base64') };
      }
      case 'images.region':
      case 'images.cutout':
      case 'images.extend': {
        const sessionId = this.session(p.sessionId).id, {version,data} = await this.artifacts.bytes(sessionId,p.artifactId,p.versionId);
        const parent = {artifactId:version.artifactId,versionId:version.versionId};
        const install = (bytes:Buffer, kind:string, name:string, extra:Record<string,unknown> = {}) => this.artifacts.install({
          sessionId,bytes,name,mime:'image/png',source:'derived',policy:version.policy,
          parents:[{...parent,relation:kind}],provenance:{kind,...extra}});
        if (method === 'images.region') {
          const result = await transform(data,validSteps([{...p.region,op:'crop'}]));
          return install(result.bytes,'region','Region of '+version.name,{region:p.region});
        }
        if (method === 'images.cutout') return install(await cutout(data,decodePng(p.mask)),'cutout','Cutout of '+version.name);
        const result = await extendedCanvas(data,p.ratio);
        const target = await install(result.bytes,'extension-base','Expanded '+version.name,{ratio:p.ratio,sourceBounds:result.sourceBounds});
        const mask = await this.artifacts.install({sessionId,bytes:result.mask,name:'Expansion mask.png',mime:'image/png',source:'derived',policy:target.policy,
          parents:[{artifactId:target.artifactId,versionId:target.versionId,relation:'mask-base'}],label:'mask',
          provenance:{kind:'mask',base:target.versionId}});
        return {target,mask};
      }
      case 'images.analyze': {
        // The person asks the configured helper directly; the same permission check applies.
        const session = this.session(p.sessionId), { version, data } = await this.artifacts.bytes(session.id, p.artifactId, p.versionId);
        const plan = await this.vision.plan(session.id, version);
        if (plan.via === 'none') throw new Error(plan.reason);
        if (plan.via === 'conversation' && !this.vision.settings().provider) throw new Error('Ask in the conversation: its model can look at the image. No separate vision helper is set.');
        const helperRoute = await this.vision.helperRoute();
        if (!routeAllowed(helperRoute, version.policy)) throw new Error('The vision helper’s processing location is not allowed for this image');
        const prepared = await analysisImage(data, p.region);
        return { answer: await this.vision.ask(prepared.bytes, String(p.question || 'Describe this image.'), AbortSignal.timeout(120_000), () => {}), helper: this.vision.settings(), image: prepared.note };
      }
      case 'operations.list': return this.operations.list(this.session(p.sessionId).id, { active: p.active === true, limit: p.limit, before: p.before }).map(op => {
        const row=describeForUi(op);
        if (op.kind === 'codelab.run' || op.kind.startsWith('command.')) {
          const { stdout, stderr, cells, ...details } = row.details;
          row.details = { ...details, stdout: String(stdout || '').slice(-2000), stderr: String(stderr || '').slice(-2000) };
        }
        return row;
      });
      case 'operations.get': {
        if (typeof p.id === 'string' && this.core.research.library.has(p.id)) {
          const run = this.core.research.get(p.id);
          this.session(run.sessionId);
          return { operationId: run.id, researchId: run.id, sessionId: run.sessionId, kind: 'research.run', label: run.title || run.question,
            state: run.state, summary: run.summary, created: run.created, updated: run.updated, error: run.error, results: run.report ? [run.report] : [],
            inputs: [], details: { sourceCount: run.evidence.length, pageReads: run.pageReads, modelCalls: run.callsUsed }, events: run.activity.slice(-50) };
        }
        const operation = owned(p.id);
        const source = operation.turnId ? this.core.store.sessionDatabase(operation.sessionId)
          .prepare("SELECT id FROM messages WHERE session_id=? AND json_extract(data,'$.turnId')=? AND json_extract(data,'$.role')='user' ORDER BY rowid LIMIT 1")
          .get(operation.sessionId, operation.turnId) : undefined;
        return { ...describeForUi(operation), ...(source ? { originatingMessageId:String(source.id) } : {}),
          ...(operation.witness.root ? {witness:{root:operation.witness.root}} : {}), cancellationDetail:operation.cancellation, events: this.operations.events(operation.id) };
      }
      case 'operations.partial': owned(p.id); return { data: this.media.partial(p.id) };
      case 'operations.usage': return this.operations.usage(this.session(p.sessionId).id);
      case 'operations.check': {
        // The person asks PAL to look again: status only, never a new submission.
        const operation = owned(p.id);
        if (['video.generate', 'music.generate'].includes(operation.kind)) return describeForUi(await this.timedMedia.rpc('poll', { sessionId: operation.sessionId, id: operation.id }));
        if (!operation.remoteId || operation.backend?.kind !== 'comfyui') throw new Error('Only a ComfyUI job with a known ID can be checked; other providers answer once');
        await this.media.reconcile(operation); return describeForUi(this.operations.get(operation.id));
      }
      case 'operations.cancel': { const operation = owned(p.id); if (['video.generate', 'music.generate'].includes(operation.kind)) return describeForUi(await this.timedMedia.rpc('cancel', { sessionId: operation.sessionId, id: operation.id })); return describeForUi(['codelab.run', 'command.run', 'command.host', 'specialist.run', 'export', 'extraction'].includes(operation.kind) ? await this.cancelRun(operation.id) : await this.media.cancel(operation.id)); }
      case 'operations.retry': {
        // A retry the user asks for is a new operation linked to the uncertain one, never a replay of it.
        const previous = owned(p.id);
        if (!['failed', 'unknown', 'interrupted', 'cancelled', 'expired'].includes(previous.state) || !previous.kind.startsWith('image.')) throw new Error('Only a finished image request can be tried again');
        if (previous.state === 'unknown' && p.confirmed !== true) throw Object.assign(new Error('The earlier request may have completed and been billed. Confirm to send a new one.'), { code: 'CONFIRM_RETRY' });
        const prepared = await this.media.prepare(previous.sessionId, { ...(previous.details?.request as object), count: (previous.details?.request as any)?.count || 1 }, { connectionId: previous.backend?.connectionId, workflowId: previous.backend?.workflow, origin: 'user' });
        const operation = this.operations.update(prepared.operation.id, { details: { ...prepared.operation.details, retryOf: previous.id } });
        return describeOperation(await this.media.start(operation.id));
      }
      case 'operations.history': {
        const session = this.session(p.sessionId);
        const ids = p.project === true ? this.analyses.projectSessions(session.id) : [session.id];
        const scoped = Array.isArray(p.allowedSessions) ? ids.filter(id => p.allowedSessions.includes(id)) : ids;
        const operations = this.operations.history(scoped, p).map(op => {
          const row = describeForUi(op);
          return { ...row, details: { durationMs: row.details.durationMs, exitCode: row.details.exitCode }, cursor: op.created + ':' + op.id };
        });
        const research = this.core.research.library.history(scoped, p);
        return [...operations, ...research].sort((a, b) => b.created - a.created || b.operationId.localeCompare(a.operationId))
          .slice(0, Math.min(100, Math.max(1, Number(p.limit) || 50)));
      }
      case 'operations.compare': {
        const ids = this.analyses.projectSessions(this.session(p.sessionId).id);
        const left = this.operations.get(p.left), right = this.operations.get(p.right);
        if (![left,right].every(op => ids.includes(op.sessionId))) throw new Error('Compare runs in the same project');
        const values = (op: typeof left) => {
          const files = (refs: ArtifactRef[]) => refs.map(ref => {
            try { const v = this.artifacts.version(op.sessionId, ref.artifactId, ref.versionId); return { name: v.name, sha256: v.sha256 }; }
            catch { return { missing: ref.versionId }; }
          });
          return { purpose: op.label, state: op.state, code: files(op.inputs.filter(r => r.purpose === 'code')),
            inputs: files(op.inputs.filter(r => r.purpose !== 'code')), parameters: op.details?.parameters ?? op.details?.request ?? {},
            runtime: op.details?.runtime ?? op.backend, exitCode: op.details?.exitCode, durationMs: op.details?.durationMs,
            outputs: files(op.results), changedFiles: op.details?.changedFiles, usage: op.usage, error: op.error?.message };
        };
        const a = values(left), b = values(right);
        const differences = (Object.keys(a) as (keyof typeof a)[]).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          .map(field => ({ field, before: a[field] ?? null, after: b[field] ?? null }));
        const key = typeof p.key === 'string' ? p.key.split(',').map((s: string) => s.trim()).filter(Boolean) : p.key;
        const tables = await compareResultTables(this.artifacts, left, right, { keys: key, mode: p.mode });
        return { left: left.id, right: right.id, differences, ...tables };
      }
      case 'codelab.status': return this.execution.status(p.sessionId ? this.session(p.sessionId).id : undefined);
      case 'codelab.run': return this.execution.launch(this.session(p.sessionId).id, { ...p, origin: 'user', approval: 'user', signal: undefined, turnId: undefined });
      // §15.2: an analysis session keeps its variables between cells until the person ends it.
      case 'codelab.session': return this.kernels.status(this.session(p.sessionId).id);
      case 'codelab.sessionStart': return this.kernels.start(this.session(p.sessionId).id, p);
      case 'codelab.sessionRun': {
        const session = this.session(p.sessionId);
        return new Promise((resolve, reject) => {
          this.kernels.run(session.id, { code: p.code, inputs: p.inputs, purpose: p.purpose, timeoutSeconds: p.timeoutSeconds, origin: 'user', approval: 'user', accepted: operation => resolve(describeForUi(operation)) }).catch(reject);
        });
      }
      case 'codelab.sessionInterrupt': return this.kernels.interrupt(this.session(p.sessionId).id);
      case 'codelab.sessionClear': return this.kernels.clear(this.session(p.sessionId).id);
      case 'codelab.sessionRestart': return this.kernels.restart(this.session(p.sessionId).id);
      case 'codelab.sessionStop': return this.kernels.stop(this.session(p.sessionId).id);
      case 'codelab.sessionNotebook': return this.kernels.notebook(this.session(p.sessionId).id);
      case 'codelab.grant': return this.execution.grantRuns({ ...p, sessionId: this.session(p.sessionId).id });
      case 'codelab.revoke': {
        if (p.sessionId && this.execution.grants.get(p.id)?.sessionId !== this.session(p.sessionId).id) throw new Error('Choose a grant from this conversation');
        const removed = this.execution.grants.delete(p.id); this.core.changed(); return removed;
      }
      case 'codelab.assist': this.session(p.sessionId); return this.track(assist(this, p));
      case 'codelab.preflight': return this.analyses.preflight(this.session(p.sessionId).id, p);
      case 'codelab.sample': return this.analyses.sample(this.session(p.sessionId).id);
      case 'codelab.open': return this.analyses.open(this.session(p.sessionId).id, p.operationId);
      case 'codelab.save': return this.analyses.save(this.session(p.sessionId).id, p.operationId, p.name);
      case 'codelab.library': return this.analyses.list(this.session(p.sessionId).id);
      case 'codelab.load': return this.analyses.load(this.session(p.sessionId).id, p.id);
      case 'codelab.remove': return this.analyses.remove(this.session(p.sessionId).id, p.id);
      case 'codelab.schedule': return this.analyses.schedule(this.session(p.sessionId).id, p.id, p.days, p.authorizerDeviceId);
      case 'codelab.export': return this.analyses.export(this.session(p.sessionId).id, p.operationId, p.outputs);
      case 'codelab.table': case 'codelab.exportRows': return this.analyses.table({ ...p, sessionId: this.session(p.sessionId).id }, method === 'codelab.exportRows');
      case 'commands.run': {
        const session = this.session(p.sessionId), root = this.roots.get(session.id, p.rootId);
        // A refusal (folder permission, isolation, arguments) is answered here. Once it starts, the run reports itself.
        return new Promise((resolve, reject) => {
          this.execution.command(session.id, root, { argv: p.argv, cwd: p.cwd ? normalizePath(p.cwd, root.path) : '', network: p.network === true, timeoutSeconds: p.timeoutSeconds, origin: 'user',
            started: operation => resolve(describeOperation(operation)) }).catch(reject);
        });
      }
      default: throw new Error('Unknown Workbench request');
    }
  }
  /** A deleted conversation's roots, change sets, staged bytes, operations and private workspace go with it. */
  removeSession(sessionId: string) {
    for (const grant of this.execution.grants.values()) if (grant.sessionId === sessionId) this.execution.grants.delete(grant.id);
    this.registry.forgetSession(sessionId); this.routes.delete(sessionId); this.media.selections.delete(sessionId);
    void this.artifacts.removeSession(sessionId).catch(() => {});
    void this.media.removeSession(sessionId).catch(() => {});
    this.kernels.removeSession(sessionId);
    this.pins.removeSession(sessionId);
    this.operations.removeSession(sessionId);
    for (const grant of [...this.grants.values()]) if (grant.sessionId === sessionId) this.grants.delete(grant.id);
    this.changes.removeSession(sessionId);
    // PAL's own conversation workspace is removed with the conversation; folders the user chose are untouched.
    for (const path of this.roots.removeSession(sessionId)) void rm(path, { recursive: true, force: true }).catch(() => {});
  }
  async close() {
    this.extractor.close();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer); this.expiryTimers.clear(); this.grants.clear();
    for (const controller of this.runControllers.values()) controller.abort(new Error('PAL is closing'));
    await this.kernels.close();
    // Stopped runs still record that they were interrupted; give them a bounded moment to do so.
    if (this.activeRuns.size) await Promise.race([Promise.allSettled([...this.activeRuns]), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    await this.timedMedia.close();await this.media.close();
  }
}

/** Processing destinations for an imported file: the user's explicit choice, local only otherwise. */
function validDestinations(value: unknown): DestinationPolicy {
  if (value === undefined) return { remote: false, cloud: false };
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Object.keys(v).some(key => !['remote', 'cloud'].includes(key)) || Object.values(v).some(flag => typeof flag !== 'boolean')) throw new Error('Invalid processing destinations');
  return { remote: v.remote === true || v.cloud === true, cloud: v.cloud === true };
}
function decodePng(value: unknown) {
  if (typeof value !== 'string' || value.length > 80 * 1024 * 1024) throw new Error('Invalid image data');
  const base64 = value.startsWith('data:image/png;base64,') ? value.slice(22) : value;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('Invalid image data');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The editor layer must be a PNG');
  return bytes;
}
function describeForUi(operation: import('./operations/store.ts').Operation) {
  return { ...describeOperation(operation), sessionId: operation.sessionId, turnId: operation.turnId, parentId: operation.parentId, groupId: operation.groupId, kind: operation.kind, origin: operation.origin, created: operation.created, updated: operation.updated, backend: operation.backend || null, details: operation.details || {}, usage: operation.usage || null, results: operation.results, inputs: operation.inputs, remote: !!operation.remoteId };
}

/** Extraction options a client or model may set: page range, CSV delimiter, hidden sheets. */
export function extractOptions(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const v = value as Record<string, unknown>;
  if (typeof v !== 'object' || Object.keys(v).some(key => !['fromPage', 'toPage', 'delimiter', 'includeHidden'].includes(key))) throw new Error('Invalid extraction options');
  const out: Record<string, unknown> = {};
  for (const key of ['fromPage', 'toPage']) if (v[key] !== undefined) { if (!Number.isInteger(v[key]) || (v[key] as number) < 1) throw new Error('Pages are numbered from 1'); out[key] = v[key]; }
  if (v.delimiter !== undefined) { if (![',', '\t', ';', '|'].includes(v.delimiter as string)) throw new Error('The delimiter is a comma, tab, semicolon or bar'); out.delimiter = v.delimiter; }
  if (v.includeHidden !== undefined) { if (typeof v.includeHidden !== 'boolean') throw new Error('Invalid hidden-sheet choice'); out.includeHidden = v.includeHidden; }
  return out;
}
