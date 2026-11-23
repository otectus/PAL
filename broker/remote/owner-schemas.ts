/**
 * Wire contracts of the operations an owner phone gains (PAL Everywhere, handoff §8–9). Each operation is
 * enumerated here with a strict schema, its kind and the protocol feature that introduces it; the gateway
 * advertises and enforces them from these descriptors (schemas.ts) and broker/remote/owner.ts implements
 * them on the desktop's own services. Nothing here forwards an arbitrary Core method: a phone can only name
 * these operations, with these fields.
 *
 * Kinds: `read` changes nothing; `mutation` is a reduction or an organisational change that needs no proof
 * (stop, revoke a grant, detach); `signed` needs the exact-action proof every other phone mutation needs.
 */
import { z } from 'zod';

export const ownerFeatures = ['owner.policy.v1', 'workbench.remote.v1', 'artifacts.transfer.v1', 'settings.owner.v1', 'terminal.v1'] as const;
export type OwnerFeature = (typeof ownerFeatures)[number];
/**
 * `stream`: terminal input and resizes. They are bound to a control lease acquired by a signed action and are
 * sequenced by the terminal service itself, so they never enter the command ledger (no keystroke is stored).
 */
export type OwnerKind = 'read' | 'mutation' | 'signed' | 'stream';

const uuid = z.uuid(), revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
/** Broker-issued identifiers (artifacts, versions, roots, change sets, operations, connections). */
const ref = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = uuid, relPath = z.string().max(4096), absPath = z.string().min(1).max(4096).startsWith('/');
const destinations = z.strictObject({ remote: z.boolean(), cloud: z.boolean() });
const researchMode = z.enum(['answer', 'compare', 'check', 'literature']);
const researchScope = z.enum(['web', 'project', 'both']);
const researchPlan = z.array(z.string().min(1).max(500)).max(12);
const researchId = uuid, sourceId = z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/);
const evidenceId = z.string().regex(/^E[1-9][0-9]{0,2}$/), passageId = z.string().regex(/^E[1-9][0-9]{0,2}\.P[1-9][0-9]{0,2}$/);
/** A folder's permissions exactly as the Workbench names them (workspace/roots.ts validPolicy). */
const rootPolicy = z.strictObject({ write: z.boolean().optional(), organize: z.boolean().optional(), hidden: z.boolean().optional(), execute: z.boolean().optional(), destinations: destinations.partial().optional() });
/** Objects the desktop service validates field by field (image requests, change operations); bounded here. */
const bounded = (bytes: number) => z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= bytes, `At most ${bytes} bytes`);
const families = z.strictObject({ files: z.boolean().optional(), images: z.boolean().optional(), analysis: z.boolean().optional(), host: z.boolean().optional() });

const labLanguage = z.enum(['python', 'sql']);
const labInputs = z.array(z.strictObject({ artifactId: uuid, versionId: uuid.optional() })).max(8);
const labCells = z.array(z.strictObject({ name: z.string().min(1).max(120), code: z.string().min(1).max(65536), language: labLanguage })).max(12);
const labProgram = {
  sessionId, sharedPython: z.boolean().optional(), inputs: labInputs.optional(), parameters: bounded(16384).optional(), code: z.string().max(65536),
  language: labLanguage.optional(), steps: labCells.optional(), parentId: uuid.optional(), analysisId: uuid.optional(),
};
type Entry = { schema: z.ZodType; kind: OwnerKind; feature: OwnerFeature; sensitive?: string[] };
const stream = (feature: OwnerFeature, schema: z.ZodType): Entry => ({ schema, kind: 'stream', feature });
const read = (feature: OwnerFeature, schema: z.ZodType): Entry => ({ schema, kind: 'read', feature });
const mutation = (feature: OwnerFeature, schema: z.ZodType): Entry => ({ schema, kind: 'mutation', feature });
const signed = (feature: OwnerFeature, schema: z.ZodType, sensitive?: string[]): Entry => ({ schema, kind: 'signed', feature, ...(sensitive ? { sensitive } : {}) });
const O = 'owner.policy.v1', W = 'workbench.remote.v1', T = 'artifacts.transfer.v1', S = 'settings.owner.v1', X = 'terminal.v1';

/** Settings an owner phone edits, by family: only these keys, each validated by the desktop's own settings code. */
export const settingsFamilies = {
  companion: ['personality', 'assistantName', 'avatar', 'showMemoryCitations', 'sendKey', 'delegationUpdates'],
  appearance: ['desktopProfile', 'interfaceScale', 'topmost', 'scale', 'roaming', 'quiet', 'reducedMotion', 'motionIntensity', 'expressiveCues', 'idleEnergy', 'hidden'],
  voice: ['ttsProvider', 'voice', 'speechEnabled', 'speechProviders', 'speechRate', 'speechPitch', 'speechVolume', 'speechBrief', 'voiceCommands', 'audio', 'transcription'],
  models: ['ollama', 'conversationDefaults', 'compatible'],
  search: ['webSearch'],
  memory: ['memory', 'notesVault'],
  workbench: ['workbench'],
  permissions: ['profile', 'paused', 'bypassCliPermissions', 'bypassComputerPermissions', 'categories', 'grants'],
  scripts: ['scripts'],
  toolServers: ['extensions'],
  customTools: ['customTools'],
  telemetry: ['telemetry', 'responsiveness'],
} as const;
export type SettingsFamily = keyof typeof settingsFamilies;
/** Special keys a terminal client sends by name; the broker's terminal encodes them for the program's current modes. */
export const terminalKeys = ['enter', 'tab', 'backspace', 'escape', 'up', 'down', 'left', 'right', 'insert', 'delete', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
const terminalEvent = z.union([
  z.strictObject({ text: z.string().min(1).max(65_536) }),
  z.strictObject({ paste: z.string().min(1).max(65_536) }),
  z.strictObject({ key: z.enum(terminalKeys), mods: z.number().int().min(0).max(7).optional() }),
  z.strictObject({ char: z.number().int().min(0).max(0x10ffff), mods: z.number().int().min(0).max(7).optional() }),
]);

export const ownerOperations: Record<string, Entry> = {
  // Negotiation (every role): what this client understands. An owner phone acts as an owner only after this.
  'client.features': { schema: z.strictObject({ features: z.array(z.string().max(64)).max(32) }), kind: 'read', feature: O },
  // A phone may always lower its own role (limited or observer); it can never raise it.
  'devices.setSelfRole': { schema: z.strictObject({ role: z.enum(['limited', 'observer']), expectedScopeVersion: revision }), kind: 'mutation', feature: O },

  // Device, profile, power and permissions.
  'owner.access': read(O, z.strictObject({})),
  'owner.profile.set': signed(O, z.strictObject({ profile: z.enum(['desktop', 'review', 'automatic']), expectedProfileRevision: revision })),
  'owner.devices.list': read(O, z.strictObject({})),
  'owner.devices.revoke': signed(O, z.strictObject({ deviceId: uuid })),
  'owner.devices.setRole': signed(O, z.strictObject({ deviceId: uuid, role: z.enum(['limited', 'observer']), expectedScopeVersion: revision })),
  'owner.permissions.get': read(O, z.strictObject({ sessionId: sessionId.optional() })),
  'owner.permissions.revokeGrant': mutation(O, z.strictObject({ category: z.string().max(64), cwd: absPath })),
  'owner.power.start': signed(O, z.strictObject({ sessionIds: z.array(sessionId).min(1).max(8), minutes: z.number().int().min(1).max(480), cli: z.boolean(), computer: z.boolean() })),
  'owner.power.end': mutation(O, z.strictObject({ id: ref })),
  'owner.sessions.capabilities': signed(O, z.strictObject({ sessionId, capabilities: families, expectedConfigRevision: revision })),
  'owner.sessions.delete': signed(O, z.strictObject({ sessionId, expectedRevision: revision })),
  'owner.sessions.branch': signed(O, z.strictObject({ sessionId, text: z.string().min(1).max(100000), provider: z.string().max(32).optional(), model: z.string().max(512).optional() })),
  'owner.sessions.export': read(O, z.strictObject({ sessionId, includeActivity: z.boolean().optional() })),
  'owner.sessions.setFolder': mutation(O, z.strictObject({ sessionId, folderId: z.string().max(100).nullable(), expectedRevision: revision })),
  'owner.folders.list': read(O, z.strictObject({})),
  'owner.folders.save': mutation(O, z.strictObject({ id: z.string().max(100).optional(), name: z.string().min(1).max(80), expectedRevision: revision.optional() })),
  'owner.folders.delete': mutation(O, z.strictObject({ id: z.string().max(100), expectedRevision: revision })),

  // Workbench: folders, files, reviewed changes, artifacts, runs and images of one conversation.
  'workbench.roots': read(W, z.strictObject({ sessionId })),
  'workbench.addRoot': signed(W, z.strictObject({ sessionId, path: absPath, policy: rootPolicy.optional(), primary: z.boolean().optional() })),
  'workbench.conversationRoot': signed(W, z.strictObject({ sessionId, policy: rootPolicy.optional() })),
  'workbench.updateRoot': signed(W, z.strictObject({ sessionId, rootId: ref, policy: rootPolicy, expectedRevision: z.string().max(40), primary: z.boolean().optional() })),
  'workbench.removeRoot': mutation(W, z.strictObject({ sessionId, rootId: ref })),
  'workbench.grantEdits': signed(W, z.strictObject({ sessionId, rootId: ref, minutes: z.number().int().min(1).max(480), maxOperations: z.number().int().min(1).max(500).optional(), maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(), paths: z.array(relPath).max(50).optional() })),
  'workbench.revokeGrant': mutation(W, z.strictObject({ sessionId, id: ref })),
  'workbench.browse': read(W, z.strictObject({ path: absPath.optional(), hidden: z.boolean().optional() })),
  'workbench.files.list': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(500).optional(), hidden: z.boolean().optional() })),
  'workbench.files.stat': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath })),
  'workbench.files.read': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath, startLine: z.number().int().min(1).optional(), lineCount: z.number().int().min(1).max(300).optional() })),
  'workbench.files.text': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath })),
  'workbench.files.find': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath, pattern: z.string().max(500), cursor: z.string().max(4096).optional() })),
  'workbench.files.search': read(W, z.strictObject({ sessionId, rootId: ref, path: relPath, query: z.string().min(1).max(500), mode: z.enum(['literal', 'regex']).optional(), caseSensitive: z.boolean().optional(), cursor: z.string().max(4096).optional() })),
  'workbench.changes.list': read(W, z.strictObject({ sessionId })),
  'workbench.changes.review': read(W, z.strictObject({ sessionId, changeSetId: ref })),
  // A manual edit is the owner's own intent: proposed and (with apply) applied through the same change engine.
  'workbench.changes.propose': signed(W, z.strictObject({ sessionId, operations: z.array(bounded(300_000)).min(1).max(50), reason: z.string().max(500).optional(), apply: z.boolean().optional() })),
  'workbench.changes.apply': signed(W, z.strictObject({ sessionId, changeSetId: ref, digest: z.string().max(200), operations: z.array(z.number().int().min(0).max(1000)).max(1000).optional() })),
  'workbench.changes.decline': mutation(W, z.strictObject({ sessionId, changeSetId: ref })),
  'workbench.changes.undo': signed(W, z.strictObject({ sessionId, changeSetId: ref })),
  'workbench.changes.trash': read(W, z.strictObject({ sessionId })),
  'workbench.artifacts.list': read(W, z.strictObject({ sessionId, kind: z.string().max(40).optional(), source: z.string().max(40).optional(), query: z.string().max(200).optional(), project: z.boolean().optional(), before: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() })),
  'workbench.artifacts.get': read(W, z.strictObject({ sessionId, artifactId: ref })),
  'workbench.artifacts.thumbnail': read(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), size: z.number().int().min(32).max(1024).optional() })),
  'workbench.artifacts.update': mutation(W, z.strictObject({ sessionId, artifactId: ref, name: z.string().min(1).max(200).optional(), pinned: z.boolean().optional(), tags: z.array(z.string().max(40)).max(20).optional(), shared: z.boolean().optional() })),
  'workbench.artifacts.remove': signed(W, z.strictObject({ sessionId, artifactId: ref, scope: z.enum(['artifact', 'version']).optional() })),
  'workbench.artifacts.extract': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), options: bounded(2000).optional() })),
  'workbench.artifacts.useInDraft': mutation(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional() })),
  'workbench.artifacts.export': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref, rootId: ref, path: relPath })),
  'workbench.artifacts.bundle': signed(W, z.strictObject({ sessionId, name: z.string().max(100).optional(), items: z.array(z.strictObject({ artifactId: ref, versionId: ref })).min(1).max(50) })),
  'workbench.operations.list': read(W, z.strictObject({ sessionId, active: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), before: z.string().max(200).optional() })),
  'workbench.operations.get': read(W, z.strictObject({ sessionId, operationId: ref })),
  'workbench.operations.cancel': mutation(W, z.strictObject({ sessionId, operationId: ref })),
  'workbench.operations.retry': signed(W, z.strictObject({ sessionId, operationId: ref, confirmed: z.boolean().optional() })),
  // Code Lab requests deliberately name the conversation.  This gives the remote adapter an
  // unambiguous project boundary before it reaches the shared Workbench service.
  'workbench.codelab.status': read(W, z.strictObject({ sessionId: sessionId.optional() })),
  'workbench.codelab.sample': mutation(W, z.strictObject({ sessionId })),
  'workbench.codelab.grant': signed(W, z.strictObject({ sessionId, minutes: z.number().int().min(1).max(240).optional(), maxRuns: z.number().int().min(1).max(50).optional() })),
  'workbench.codelab.revoke': mutation(W, z.strictObject({ sessionId, id: uuid })),
  'workbench.codelab.preflight': read(W, z.strictObject(labProgram)),
  'workbench.codelab.assist': signed(W, z.strictObject({ sessionId, request: z.string().min(1).max(4000), mode: z.enum(['explain','revise','plan']), code: labProgram.code, language: labLanguage, inputs: labInputs, parameters: labProgram.parameters, analysisId: uuid.optional(), operationId: uuid.optional(), result: z.strictObject({artifactId: uuid, versionId: uuid, row: z.number().int().positive().optional(), column: z.string().max(300).optional()}).optional() }), ['code','request','parameters']),
  'workbench.codelab.open': read(W, z.strictObject({ sessionId, operationId: ref })),
  'workbench.codelab.library': read(W, z.strictObject({ sessionId })),
  'workbench.codelab.load': read(W, z.strictObject({ sessionId, id: ref })),
  'workbench.codelab.export': signed(W, z.strictObject({ sessionId, operationId: ref, outputs: z.array(ref).max(20).optional() })),
  'workbench.codelab.table': read(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref, query: z.string().max(1000).optional(), sort: z.string().max(200).optional(), direction: z.enum(['asc', 'desc']).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() })),
  'workbench.codelab.exportRows': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref, query: z.string().max(1000).optional(), sort: z.string().max(200).optional(), direction: z.enum(['asc', 'desc']).optional(), rows: z.array(z.number().int().positive()).max(500).optional() })),
  'workbench.codelab.schedule': signed(W, z.strictObject({ sessionId, id: ref, days: z.number().int().min(0).max(365) })),
  'workbench.codelab.remove': mutation(W, z.strictObject({ sessionId, id: ref })),
  'workbench.codelab.save': signed(W, z.strictObject({ sessionId, operationId: ref, name: z.string().min(1).max(120) })),
  'workbench.codelab.run': signed(W, z.strictObject({ ...labProgram, purpose: z.string().max(300).optional(), notify: z.boolean().optional(), reuseSteps: z.boolean().optional(), timeoutSeconds: z.number().int().min(1).max(600).optional() }), ['code','steps','parameters']),
  // History is project-wide, but callers must still name a scoped session and its exact project.
  'workbench.operations.history': read(W, z.strictObject({ sessionId, project: ref.optional(), limit: z.number().int().min(1).max(100).optional(), since: z.number().int().nonnegative().optional(), until: z.number().int().nonnegative().optional(), query: z.string().max(500).optional(), kind: z.string().max(80).optional(), state: z.string().max(80).optional(), before: z.string().max(200).optional() })),
  'workbench.operations.compare': read(W, z.strictObject({ sessionId, left: ref, right: ref, key: z.union([z.string().max(1000), z.array(z.string().max(200)).max(20)]).optional(), mode: z.enum(['position']).optional() })),
  'workbench.commands.run': signed(W, z.strictObject({ sessionId, rootId: ref, argv: z.array(z.string().max(4096)).min(1).max(200), cwd: relPath.optional(), network: z.boolean().optional(), timeoutSeconds: z.number().int().min(1).max(3600).optional() })),
  'workbench.images.connections': read(W, z.strictObject({})),
  'workbench.images.capabilities': read(W, z.strictObject({ connectionId: ref, workflowId: ref.optional() })),
  'workbench.images.preview': read(W, z.strictObject({ sessionId, connectionId: ref, workflowId: ref.optional(), request: bounded(64_000) })),
  'workbench.images.generate': signed(W, z.strictObject({ sessionId, connectionId: ref, workflowId: ref.optional(), request: bounded(64_000), acknowledgeBilling: z.boolean().optional() })),
  'workbench.images.transform': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), steps: z.array(bounded(2000)).min(1).max(20) })),
  // A layer or mask is either inline base64 PNG (small) or a committed upload transfer (artifacts.transfer.v1).
  'workbench.images.saveEdit': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), layer: z.string().max(900_000).optional(), layerTransferId: uuid.optional(), recipe: z.string().max(200_000).optional() }).refine(p => !!p.layer !== !!p.layerTransferId, 'Send the edit layer inline or as an upload')),
  'workbench.images.mask': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), mask: z.string().max(900_000).optional(), maskTransferId: uuid.optional() }).refine(p => !!p.mask !== !!p.maskTransferId, 'Send the mask inline or as an upload')),
  'workbench.images.sketch': signed(W, z.strictObject({ sessionId, width: z.number().int().min(16).max(4096), height: z.number().int().min(16).max(4096), background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() })),
  'workbench.images.contactSheet': signed(W, z.strictObject({ sessionId, items: z.array(z.strictObject({ artifactId: ref, versionId: ref })).min(1).max(16) })),
  'workbench.images.inspect': read(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional() })),
  'workbench.images.ocr': read(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), region: bounded(200).optional() })),
  'workbench.images.analyze': signed(W, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), question: z.string().max(2000).optional(), region: bounded(200).optional() })),
  'workbench.references.search': read(W, z.strictObject({ sessionId, query: z.string().max(200) })),
  'workbench.references.preview': read(W, z.strictObject({ sessionId, references: z.array(bounded(2000)).max(20), text: z.string().max(2000).optional() })),
  'workbench.shelf': read(W, z.strictObject({ sessionId })),

  // Transfers: verified, resumable bytes between the phone and the desktop's artifact store.
  'transfers.download': read(T, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional(), variant: z.enum(['original', 'preview']).default('original') })),
  'transfers.read': read(T, z.strictObject({ transferId: uuid, offset: z.number().int().min(0), length: z.number().int().min(1).max(256 * 1024) })),
  'transfers.upload': signed(T, z.strictObject({ sessionId, name: z.string().min(1).max(200), mime: z.string().min(3).max(100), size: z.number().int().min(1).max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), purpose: z.enum(['artifact', 'layer', 'mask']).default('artifact') })),
  'transfers.status': read(T, z.strictObject({ transferId: uuid })),
  // The signed upload already bound the name, size and SHA-256; commit only installs exactly those verified bytes.
  'transfers.commit': mutation(T, z.strictObject({ transferId: uuid, destinations: destinations.optional() })),
  'transfers.abort': mutation(T, z.strictObject({ transferId: uuid })),

  // Owner administration: the same settings, connections, keys, routines and services as the desktop.
  'owner.settings.get': read(S, z.strictObject({})),
  'owner.settings.patch': signed(S, z.strictObject({ expectedRevision: revision, family: z.enum(Object.keys(settingsFamilies) as [SettingsFamily, ...SettingsFamily[]]), values: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 200_000, 'Settings are too large') })),
  'owner.connections.list': read(S, z.strictObject({})),
  'owner.connections.save': signed(S, bounded(20_000)),
  'owner.connections.remove': signed(S, z.strictObject({ id: ref })),
  'owner.connections.models': read(S, z.strictObject({ id: ref })),
  // The key crosses the pinned, authenticated channel once; only its status ever comes back.
  'owner.credentials.set': signed(S, z.strictObject({ provider: z.enum(['openai', 'anthropic', 'google', 'compatible', 'elevenlabs']), connectionId: ref.optional(), key: z.string().max(4096).nullable() }), ['key']),
  'owner.extensions.status': read(S, z.strictObject({})),
  'owner.extensions.restart': mutation(S, z.strictObject({ id: ref })),
  'owner.extensions.secret': signed(S, z.strictObject({ id: ref, name: z.string().min(1).max(100), value: z.string().max(8192).nullable() }), ['value']),
  'owner.extensions.resources': read(S, z.strictObject({ id: ref, cursor: z.string().max(4096).optional() })),
  'owner.extensions.prompts': read(S, z.strictObject({ id: ref })),
  // §14.1: a sign-in the phone starts completes on the phone (its private-use redirect) and is bound to it.
  'owner.extensions.oauthStart': signed(S, z.strictObject({ id: ref, clientId: z.string().min(1).max(300).optional(), clientSecret: z.string().max(1000).optional() }), ['clientSecret']),
  'owner.extensions.oauthComplete': mutation(S, z.strictObject({ state: z.string().min(16).max(200), code: z.string().min(1).max(4096).optional(), error: z.string().max(200).optional() })),
  'owner.extensions.oauthSignOut': signed(S, z.strictObject({ id: ref })),
  'owner.extensions.importPreview': read(S, z.strictObject({ text: z.string().min(2).max(256 * 1024) })),
  'owner.extensions.importApply': signed(S, z.strictObject({ token: uuid, names: z.array(z.string().min(1).max(40)).min(1).max(32) })),
  'owner.extensions.writes': read(S, z.strictObject({})),
  // §12.3 working setups: preview shows the actual changes; apply makes exactly those.
  // §16.1 voice: whether this desktop transcribes, and a push-to-talk note (inline audio, never kept).
  'owner.translate': mutation(S, z.strictObject({ sessionId, targetLanguage: z.string().min(2).max(40), text: z.string().max(120_000).optional(), input: bounded(2000).optional(), glossary: z.array(z.strictObject({ source: z.string().min(1).max(200), target: z.string().max(200) })).max(50).optional() })),
  // §11.1 collection sources PAL snapshots itself, and watched folders.
  'owner.collections.addUrl': signed(S, z.strictObject({ id: ref, url: z.string().min(8).max(2000).startsWith('http') })),
  'owner.collections.addArtifact': signed(S, z.strictObject({ id: ref, sessionId, artifactId: ref, versionId: ref.optional() })),
  'owner.collections.setWatch': mutation(S, z.strictObject({ id: ref, watch: z.boolean() })),
  'owner.tables.preview': read(S, z.strictObject({ sessionId, artifactId: ref.optional(), versionId: ref.optional(), rootId: ref.optional(), path: relPath.optional() })),
  'owner.voice.status': read(S, z.strictObject({})),
  'owner.voice.transcribe': read(S, z.strictObject({ sessionId, mime: z.enum(['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav']), audio: z.string().min(16).max(1_000_000) })),
  'owner.specialists.list': read(S, z.strictObject({})),
  'owner.specialists.save': signed(S, z.strictObject({ specialist: bounded(8000), expectedRevision: revision.optional() })),
  'owner.specialists.delete': signed(S, z.strictObject({ id: ref })),
  'owner.specialists.setConcurrency': signed(S, z.strictObject({ concurrency: z.number().int().min(1).max(4) })),
  'owner.setups.list': read(S, z.strictObject({})),
  'owner.setups.save': signed(S, z.strictObject({ setup: bounded(20_000), expectedRevision: revision.optional() })),
  'owner.setups.delete': signed(S, z.strictObject({ id: ref })),
  'owner.setups.preview': read(S, z.strictObject({ setupId: ref, sessionId })),
  'owner.setups.apply': signed(S, z.strictObject({ token: uuid })),
  'owner.setups.start': signed(S, z.strictObject({ setupId: ref, expectedSetupRevision: revision.optional(), cwd: absPath, provider: z.enum(['ollama', 'openai', 'anthropic', 'google', 'compatible', 'codex', 'claude', 'antigravity']).optional(), model: z.string().min(1).max(512).optional() })),
  'owner.extensions.resolveWrite': signed(S, z.strictObject({ id: uuid, outcome: z.enum(['done', 'not-done']) })),
  'owner.customTools.credential': signed(S, z.strictObject({ id: ref, value: z.string().max(8192).nullable() }), ['value']),
  'owner.schedules.list': read(S, z.strictObject({})),
  'owner.schedules.setEnabled': signed(S, z.strictObject({ id: ref, enabled: z.boolean() })),
  'owner.schedules.delete': signed(S, z.strictObject({ id: ref })),
  'owner.schedules.create': signed(S, z.strictObject({ label: z.string().min(1).max(80), when: bounded(2000), previewToken: z.string().min(1).max(200), unattended: z.literal(true), missed: z.enum(['skip', 'once']).optional() })),
  'owner.schedules.adopt': signed(S, z.strictObject({ id: ref })),
  'owner.recipes.list': read(S, z.strictObject({})),
  // Prepare returns the exact prompt and a short-lived token; creating its draft or schedule names that token.
  'owner.recipes.prepare': read(S, z.strictObject({ sessionId, recipeId: ref, version: z.number().int().min(1).optional(), inputs: bounded(20_000).optional() })),
  'owner.recipes.createDraft': signed(S, z.strictObject({ previewToken: z.string().min(1).max(200), reviewed: z.literal(true) })),
  'owner.results.list': read(S, z.strictObject({ sessionId: sessionId.optional(), limit: z.number().int().min(1).max(200).optional() })),
  'owner.results.verify': signed(S, z.strictObject({ sessionId, scriptId: ref, expectedScript: bounded(20_000), reviewed: z.literal(true) })),
  'owner.collections.list': read(S, z.strictObject({ sessionId: sessionId.optional() })),
  'owner.collections.create': signed(S, z.strictObject({ name: z.string().min(1).max(100), grounding: z.enum(['strict', 'balanced', 'exploratory']).optional(), allowCloud: z.boolean().optional() })),
  'owner.collections.addSource': signed(S, z.strictObject({ id: ref, expectedRevision: revision, path: absPath })),
  'owner.collections.removeSource': signed(S, z.strictObject({ id: ref, expectedRevision: revision, path: absPath })),
  'owner.collections.bind': signed(S, z.strictObject({ id: ref, target: z.enum(['global', 'project', 'session']), sessionId: sessionId.optional(), bound: z.boolean() })),
  'owner.collections.index': signed(S, z.strictObject({ id: ref })),
  'owner.collections.cancel': mutation(S, z.strictObject({})),
  'owner.collections.delete': signed(S, z.strictObject({ id: ref, expectedRevision: revision, confirmed: z.literal(true) })),
  'owner.projects.save': signed(S, bounded(20_000)),
  'owner.models.local': read(S, z.strictObject({})),
  'owner.models.pull': signed(S, z.strictObject({ model: z.string().min(1).max(200) })),
  'owner.models.delete': signed(S, z.strictObject({ model: z.string().min(1).max(200), confirmed: z.literal(true) })),
  'owner.models.cancelPull': mutation(S, z.strictObject({})),
  'owner.jobs.cancel': mutation(S, z.strictObject({ id: ref })),
  'owner.usage.summary': read(S, z.strictObject({ days: z.number().int().min(1).max(366).optional(), sessionId: sessionId.optional() })),
  'owner.usage.setPolicy': signed(S, z.strictObject({ expectedRevision: revision, currency: z.string().regex(/^[A-Z]{3}$/).optional(), monthlyLimit: z.number().min(0).max(1e7).nullable().optional(), warnAt: z.number().min(0).max(1e7).nullable().optional(),
    prices: z.record(z.string().max(220), z.strictObject({ input: z.number().min(0).max(1e6), output: z.number().min(0).max(1e6), image: z.number().min(0).max(1e4).optional() })).optional() })),
  // Skills: imported and reviewed once; enabling is the one approval. Importing never runs anything.
  'owner.skills.list': read(S, z.strictObject({})),
  'owner.skills.review': read(S, z.strictObject({ versionId: uuid })),
  'owner.skills.importRepository': signed(S, z.strictObject({ url: z.string().min(8).max(500).startsWith('https://'), ref: z.string().max(100).optional() })),
  'owner.skills.importPath': signed(S, z.strictObject({ path: absPath })),
  'owner.skills.importArtifact': signed(S, z.strictObject({ sessionId, artifactId: ref, versionId: ref.optional() })),
  'owner.skills.enable': signed(S, z.strictObject({ versionId: uuid, invocation: z.enum(['explicit', 'automatic']).optional(), scope: z.enum(['personal', 'project']).optional(), project: absPath.optional(), expectedRevision: revision })),
  'owner.skills.disable': mutation(S, z.strictObject({ versionId: uuid })),
  'owner.skills.remove': signed(S, z.strictObject({ skillId: z.string().min(1).max(80) })),
  // Research runs: a cited report from sources PAL actually read; the same run from either device.
  // Research is scoped twice: starts/plans/sources name an authorized conversation, and every run operation
  // resolves its run before owner.ts checks that run's conversation. Model-starting or redirecting actions are
  // signed. Pause/stop and library metadata changes are safe reductions/organisation changes.
  'owner.research.sources': read(S, z.strictObject({ sessionId, query: z.string().max(100).optional() })),
  'owner.research.plan': signed(S, z.strictObject({ sessionId, question: z.string().min(5).max(2000), mode: researchMode.optional() })),
  'owner.research.start': signed(S, z.strictObject({
    sessionId, question: z.string().min(5).max(2000), preset: z.enum(['quick', 'thorough']).optional(), mode: researchMode,
    scope: researchScope, sourceIds: z.array(sourceId).max(12), plan: researchPlan.optional(),
    sites: z.array(z.string().min(1).max(253)).max(5).optional(), siteMode: z.enum(['only', 'prefer']).optional(),
    urls: z.array(z.url({ protocol: /^https?$/ }).max(2048)).max(12).optional(), recency: z.enum(['day', 'week', 'month', 'year']).optional(),
    output: z.enum(['brief', 'timeline', 'matrix']).optional(),
    minutes: z.number().int().min(1).max(60).optional(), sources: z.number().int().min(1).max(60).optional(), calls: z.number().int().min(2).max(20).optional(),
    criteria: researchPlan.optional(), parallel: z.boolean().optional(), requestId: uuid,
  })),
  // Omitted/false `project` is the legacy full-run list used by already shipped phones. New clients opt into
  // bounded project summaries and open one run with get.
  'owner.research.list': read(S, z.union([
    z.strictObject({ sessionId: sessionId.optional(), project: z.literal(false).optional() }),
    z.strictObject({ sessionId, project: z.literal(true) }),
  ])),
  'owner.research.get': read(S, z.strictObject({ id: researchId })),
  'owner.research.readReport': read(S, z.strictObject({ id: researchId, versionId: ref.optional() })),
  'owner.research.passage': read(S, z.strictObject({ id: researchId, passageId, versionId: ref.optional() })),
  'owner.research.pause': mutation(S, z.strictObject({ id: researchId })),
  'owner.research.stop': mutation(S, z.strictObject({ id: researchId })),
  'owner.research.refresh': signed(S, z.strictObject({ id: researchId })),
  'owner.research.continue': signed(S, z.strictObject({ id: researchId, focus: z.string().min(1).max(2000).optional() })),
  'owner.research.steer': signed(S, z.strictObject({ id: researchId, focus: z.string().min(1).max(2000) })),
  'owner.research.ask': signed(S, z.strictObject({ id: researchId, question: z.string().min(1).max(2000) })),
  'owner.research.update': mutation(S, z.strictObject({ id: researchId, title: z.string().min(1).max(120).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), monitorDays: z.number().int().min(0).max(365).optional() })),
  'owner.research.export': mutation(S, z.strictObject({ id: researchId, format: z.enum(['markdown', 'csv', 'bibtex', 'json']) })),
  'owner.research.note': mutation(S, z.strictObject({ id: researchId, text: z.string().min(1).max(8000) })),
  'owner.research.exclude': mutation(S, z.strictObject({ id: researchId, evidenceId })),
  'owner.research.resynthesize': signed(S, z.strictObject({ id: researchId })),
  // Canvas: the same isolated preview the desktop shows; frames and typed input only.
  'canvas.status': read(W, z.strictObject({})),
  'canvas.list': read(W, z.strictObject({ sessionId })),
  'canvas.open': signed(W, z.strictObject({ sessionId, rootId: ref, path: relPath, width: z.number().int().min(240).max(2560).optional(), height: z.number().int().min(240).max(2560).optional(), mobile: z.boolean().optional() })),
  'canvas.frame': read(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.input': stream(W, z.strictObject({ sessionId, id: uuid, kind: z.enum(['click', 'type', 'key', 'scroll']), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), text: z.string().max(10_000).optional(), key: z.string().max(20).optional(), deltaY: z.number().min(-5000).max(5000).optional() })),
  'canvas.resize': mutation(W, z.strictObject({ sessionId, id: uuid, width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(2560), mobile: z.boolean().optional() })),
  'canvas.reload': mutation(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.console': read(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.annotate': mutation(W, z.strictObject({ sessionId, id: uuid, x: z.number().min(0).max(1), y: z.number().min(0).max(1), note: z.string().max(2000) })),
  'canvas.annotations': read(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.screenshot': mutation(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.export': mutation(W, z.strictObject({ sessionId, id: uuid })),
  'canvas.close': mutation(W, z.strictObject({ sessionId, id: uuid })),
  // Scratchpad (revisioned, conflict-aware) and the Daybook index; an edit is the owner's own act.
  'owner.notebook.scratchpad': read(S, z.strictObject({ project: absPath })),
  'owner.notebook.save': mutation(S, z.strictObject({ project: absPath, text: z.string().max(200_000), expectedRevision: revision })),
  'owner.notebook.day': read(S, z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), offsetMinutes: z.number().int().min(-900).max(900).optional() })),
  // View desktop: deliberate, visible on the desktop, still frames; input only where this computer allows it.
  'view.start': signed(O, z.strictObject({ output: z.string().max(64).optional() })),
  'view.frame': read(O, z.strictObject({ viewId: uuid, maxWidth: z.number().int().min(320).max(2560).optional() })),
  'view.input': stream(O, z.strictObject({ viewId: uuid, kind: z.enum(['click', 'move', 'type', 'key']), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), text: z.string().max(2000).optional(), key: z.string().max(20).optional(), frameRevision: z.number().int().min(0).optional() })),
  'view.stop': mutation(O, z.strictObject({ viewId: uuid })),
  'owner.health': read(S, z.strictObject({})),
  'owner.backup.status': read(S, z.strictObject({})),
  'owner.backup.create': signed(S, z.strictObject({ includeMemory: z.boolean().optional() })),

  // Terminals: broker-owned PTY sessions on this computer (broker/terminal/service.ts).
  'terminal.profiles': read(X, z.strictObject({})),
  'terminal.create': signed(X, z.strictObject({ shell: z.enum(['bash', 'fish', 'zsh', 'sh', 'default']).default('default'), cwd: absPath.optional(), sessionId: sessionId.optional(), title: z.string().max(80).optional(), rows: z.number().int().min(4).max(300).default(32), cols: z.number().int().min(10).max(500).default(80) })),
  'terminal.list': read(X, z.strictObject({})),
  'terminal.get': read(X, z.strictObject({ terminalId: uuid })),
  'terminal.attach': read(X, z.strictObject({ terminalId: uuid })),
  'terminal.acquireControl': signed(X, z.strictObject({ terminalId: uuid, expectedControllerRevision: revision, rows: z.number().int().min(4).max(300).optional(), cols: z.number().int().min(10).max(500).optional() })),
  'terminal.input': stream(X, z.strictObject({ terminalId: uuid, leaseId: uuid, epoch: z.number().int().min(0), sequence: z.number().int().min(1), events: z.array(terminalEvent).min(1).max(64) })),
  'terminal.inputStatus': read(X, z.strictObject({ terminalId: uuid, leaseId: uuid, epoch: z.number().int().min(0) })),
  'terminal.resize': stream(X, z.strictObject({ terminalId: uuid, leaseId: uuid, rows: z.number().int().min(4).max(300), cols: z.number().int().min(10).max(500) })),
  'terminal.interrupt': mutation(X, z.strictObject({ terminalId: uuid })),
  'terminal.detach': mutation(X, z.strictObject({ terminalId: uuid })),
  'terminal.release': mutation(X, z.strictObject({ terminalId: uuid })),
  'terminal.forget': mutation(X, z.strictObject({ terminalId: uuid })),
  'terminal.close': mutation(X, z.strictObject({ terminalId: uuid })),
  'terminal.history': read(X, z.strictObject({ terminalId: uuid, before: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).default(200) })),
};
