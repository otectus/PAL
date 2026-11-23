/**
 * Working setups (PAL Everywhere §12.3): a named combination of provider and model (or a saved connection), Workbench
 * families, a style and posture, standing output instructions, collections and skills. Applying one shows the actual
 * changes and anything it depends on that is missing, then makes those changes through the same services a person
 * uses on the desktop: model, families, style and collection bindings. It never grants a permission: a skill must
 * already be enabled (enabling is its own review), and a provider without a key or model is reported, not configured.
 *
 * Exported setups carry names and settings only: no IDs that mean nothing elsewhere, no keys, grants or bindings.
 * The built-ins are editable examples: Save a copy, then change it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Core } from './core.ts';
import { workbenchFamilies, type WorkbenchFamily } from './tools/contracts.ts';

export type Setup = {
  id: string; name: string; description: string; builtin?: boolean; revision: string;
  provider?: string; model?: string; connection?: string;
  families: Partial<Record<WorkbenchFamily, boolean>>;
  style?: string; posture?: string;
  instructions?: string;
  collections: string[];
  skills: string[];
  voice?: string;
};
type Change = { kind: 'model' | 'families' | 'style' | 'posture' | 'instructions' | 'collection' | 'voice'; label: string; from?: string; to: string };
const storeKey = 'setups', limits = { setups: 40, text: 4000, items: 20 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

/** Editable examples (§12.3). Host commands are never on in a built-in: running commands as the desktop account is a deliberate choice. */
export const builtinSetups: Setup[] = [
  { id: 'builtin:developer', name: 'Project developer', description: 'Files, analysis runs and code review in the project folder.', builtin: true, revision: '1',
    families: { files: true, analysis: true }, posture: 'posture:review', collections: [], skills: [],
    instructions: 'When you change files, list each change and how you verified it. Prefer small, reviewable edits.' },
  { id: 'builtin:research', name: 'Research partner', description: 'Project references and evidence-based reports with citations.', builtin: true, revision: '1',
    families: { files: true }, posture: 'posture:research', collections: [], skills: [],
    instructions: 'Cite the sources you used. Keep disagreement between sources visible and say what remains uncertain.' },
  { id: 'builtin:assets', name: 'Asset creator', description: 'Image generation and editing with consistent names and export sizes.', builtin: true, revision: '1',
    families: { files: true, images: true }, collections: [], skills: [],
    instructions: 'Name outputs as <project>-<subject>-<size>.png. State the backend, size and prompt you used for each image.' },
  { id: 'builtin:documents', name: 'Document assistant', description: 'Extraction, editing, translation and reports from documents.', builtin: true, revision: '1',
    families: { files: true, analysis: true }, collections: [], skills: [],
    instructions: 'Keep the original document unchanged; write edits and translations as new versions and say what changed.' },
  { id: 'builtin:companion', name: 'Everyday companion', description: 'Conversation and notes, without project tools.', builtin: true, revision: '1',
    families: {}, collections: [], skills: [] },
];

function text(value: unknown, label: string, max = limits.text) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`${label} is up to ${max} characters without control characters`);
  return value.trim() || undefined;
}
function names(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.items || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) throw new Error(`${label} is a list of up to ${limits.items} names`);
  return [...new Set(value.map(item => item.trim()))];
}
/** A setup from a client: known fields only; families only as on/off switches. */
export function validSetup(p: any): Omit<Setup, 'id' | 'revision'> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid setup');
  for (const key of Object.keys(p)) if (!['id', 'name', 'description', 'provider', 'model', 'connection', 'families', 'style', 'posture', 'instructions', 'collections', 'skills', 'voice', 'revision', 'builtin'].includes(key)) throw new Error(`Unknown setup field: ${key}`);
  const name = text(p.name, 'A setup name', 80);
  if (!name) throw new Error('Name the setup');
  const families = p.families ?? {};
  if (!families || typeof families !== 'object' || Array.isArray(families) || Object.entries(families).some(([key, value]) => !(workbenchFamilies as string[]).includes(key) || typeof value !== 'boolean')) throw new Error('Families are files, images, analysis and host, each on or off');
  const provider = text(p.provider, 'The provider', 40), model = text(p.model, 'The model', 512);
  if (provider && !['ollama', 'openai', 'anthropic', 'google', 'compatible', 'codex', 'claude', 'antigravity'].includes(provider)) throw new Error('Choose a provider PAL supports');
  return { name, description: text(p.description, 'The description', 400) || '', ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(text(p.connection, 'The connection', 80) ? { connection: text(p.connection, 'The connection', 80) } : {}),
    families: Object.fromEntries(Object.entries(families).filter(([, on]) => on === true)) as Setup['families'],
    ...(text(p.style, 'The style', 80) ? { style: text(p.style, 'The style', 80) } : {}), ...(text(p.posture, 'The posture', 80) ? { posture: text(p.posture, 'The posture', 80) } : {}),
    ...(text(p.instructions, 'Instructions') ? { instructions: text(p.instructions, 'Instructions') } : {}),
    collections: names(p.collections, 'Collections'), skills: names(p.skills, 'Skills'), ...(text(p.voice, 'The voice', 200) ? { voice: text(p.voice, 'The voice', 200) } : {}) };
}

export class Setups {
  core: Core;
  private previews = new Map<string, { expires: number; setupId: string; sessionId: string; digest: string; changes: Change[] }>();
  constructor(core: Core) { this.core = core; }
  private stored(): { revision: string; items: Setup[] } { return this.core.store.get(storeKey, { revision: '0', items: [] as Setup[] }); }
  list() { const stored = this.stored(); return { revision: stored.revision, supportsStartRevision: true, setups: [...builtinSetups, ...stored.items] }; }
  get(id: string) { const setup = this.list().setups.find(item => item.id === id); if (!setup) throw new Error('This setup no longer exists'); return setup; }
  /** Creates or updates a setup (a built-in is saved as a copy); conflicting edits from two devices are refused. */
  save(p: any) {
    const stored = this.stored();
    if (p?.expectedRevision !== undefined && p.expectedRevision !== stored.revision) throw Object.assign(new Error('Setups changed on another device. Reload them and try again.'), { code: 'REVISION_CONFLICT' });
    const value = validSetup(p.setup), existing = stored.items.find(item => item.id === p.setup?.id);
    if (!existing && stored.items.length >= limits.setups) throw new Error(`Keep at most ${limits.setups} setups`);
    const setup: Setup = { ...value, id: existing?.id || randomUUID(), revision: existing ? String(BigInt(existing.revision) + 1n) : '1' };
    const items = existing ? stored.items.map(item => item.id === setup.id ? setup : item) : [...stored.items, setup];
    this.core.store.set(storeKey, { revision: String(BigInt(stored.revision) + 1n), items }); this.core.changed();
    return setup;
  }
  remove(p: any) {
    const stored = this.stored();
    if (!stored.items.some(item => item.id === p?.id)) throw new Error(String(p?.id || '').startsWith('builtin:') ? 'Built-in setups cannot be deleted' : 'This setup no longer exists');
    this.core.store.set(storeKey, { revision: String(BigInt(stored.revision) + 1n), items: stored.items.filter(item => item.id !== p.id) }); this.core.changed();
    return true;
  }
  /** What applying the setup to this conversation would change, and what it needs that is missing. Nothing changes. */
  preview(p: any, setup = this.get(p?.setupId)) {
    const session = this.core.store.session(p?.sessionId);
    const changes: Change[] = [], unresolved: string[] = [], notes: string[] = [];
    if (setup.provider && setup.provider !== session.provider) unresolved.push(`This setup uses ${setup.provider}; this conversation uses ${session.provider}. Start a new conversation with the setup instead.`);
    else if (setup.model && setup.model !== session.model) {
      const provider: any = (this.core.capabilities as any)[session.provider];
      if (provider?.models?.length && !provider.models.some((model: any) => (model.id || model.name || model) === setup.model)) unresolved.push(`The model ${setup.model} is not available from ${session.provider} right now.`);
      else changes.push({ kind: 'model', label: 'Model', from: session.model || '(default)', to: setup.model });
    }
    const managed = session.provider === 'ollama' || ['openai', 'anthropic', 'google', 'compatible'].includes(session.provider);
    const current = Object.fromEntries(workbenchFamilies.map(family => [family, session.capabilities?.[family] === true]));
    const wanted = Object.fromEntries(workbenchFamilies.map(family => [family, setup.families[family] === true]));
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      if (!managed) unresolved.push('Workbench families apply to Ollama and API conversations.');
      else changes.push({ kind: 'families', label: 'Workbench', from: workbenchFamilies.filter(f => current[f]).join(', ') || 'none', to: workbenchFamilies.filter(f => wanted[f]).join(', ') || 'none' });
    }
    if (wanted.host && !current.host) notes.push('Host commands run as your desktop account. Each command still follows your working profile.');
    if (setup.style) {
      const style = this.core.presets.profiles().find(profile => profile.label === setup.style || profile.id === setup.style);
      if (!style) unresolved.push(`The style “${setup.style}” is not in your styles.`);
      else if (session.behavior?.profileId !== style.id) changes.push({ kind: 'style', label: 'Style', from: session.behavior?.profileId || '(default)', to: style.label });
    }
    if (setup.posture && session.behavior?.postureId !== setup.posture) {
      try { this.core.posture(setup.posture); changes.push({ kind: 'posture', label: 'Posture', from: session.behavior?.postureId || '(none)', to: setup.posture }); }
      catch { unresolved.push(`The posture “${setup.posture}” does not exist.`); }
    }
    if ((setup.instructions || '') !== (session.behavior?.instructions || '') && setup.instructions !== undefined) changes.push({ kind: 'instructions', label: 'Standing instructions', from: session.behavior?.instructions || '(none)', to: setup.instructions });
    const collections = this.core.collections.all(), bound = new Set(this.core.collections.bound(session).map(collection => collection.id));
    for (const name of setup.collections) {
      const collection = collections.find(item => item.name === name || item.id === name);
      if (!collection) unresolved.push(`The collection “${name}” does not exist.`);
      else if (!bound.has(collection.id)) changes.push({ kind: 'collection', label: 'Use collection in this project', to: collection.name });
    }
    const skills = this.core.skills.list();
    for (const name of setup.skills) {
      const enabled = skills.find(skill => (skill.name === name || skill.skillId === name) && skill.status === 'enabled' && (skill.scope === 'personal' || (!!skill.project && (session.cwd === skill.project || session.cwd.startsWith(skill.project + '/')))));
      if (!enabled) unresolved.push(`The skill “${name}” is not enabled for this project. Enable it in Skills; enabling is its own review.`);
    }
    if (setup.voice && setup.voice !== this.core.settings.voice) changes.push({ kind: 'voice', label: 'Speaking voice (all conversations)', from: String(this.core.settings.voice || '(default)'), to: setup.voice });
    const token = randomUUID();
    for (const [key, entry] of this.previews) if (entry.expires < Date.now()) this.previews.delete(key);
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, { expires: Date.now() + 10 * 60_000, setupId: setup.id, sessionId: session.id, digest: digest([setup, session.configRevision || '0', session.behavior || {}, session.capabilities || {}]), changes });
    return { token, setup: { id: setup.id, name: setup.name }, changes, unresolved, notes };
  }
  /** Makes exactly the previewed changes, if neither the setup nor the conversation changed since. */
  async apply(p: any, startingWith?: Setup) {
    const entry = this.previews.get(p?.token); this.previews.delete(p?.token);
    if (!entry || entry.expires < Date.now()) throw new Error('This preview expired. Review the setup again.');
    const setup = startingWith ?? this.get(entry.setupId), session = this.core.store.session(entry.sessionId);
    if (digest([setup, session.configRevision || '0', session.behavior || {}, session.capabilities || {}]) !== entry.digest) throw Object.assign(new Error('The setup or the conversation changed since the preview. Review it again.'), { code: 'REVISION_CONFLICT' });
    const done: string[] = [];
    for (const change of entry.changes) {
      if (change.kind === 'model') { await this.core.configureSession({ id: session.id, model: setup.model, expectedConfigRevision: this.core.store.session(session.id).configRevision || '0' }); done.push('model'); }
      if (change.kind === 'families') { this.core.setCapabilities({ id: session.id, capabilities: Object.fromEntries(workbenchFamilies.map(family => [family, setup.families[family] === true])) }); done.push('families'); }
      if (change.kind === 'style') { const style = this.core.presets.profiles().find(profile => profile.label === setup.style || profile.id === setup.style)!; await this.core.rpc('session.behavior', { id: session.id, profileId: style.id }); done.push('style'); }
      if (change.kind === 'posture') { await this.core.rpc('session.behavior', { id: session.id, postureId: setup.posture }); done.push('posture'); }
      if (change.kind === 'instructions') { await this.core.rpc('session.behavior', { id: session.id, instructions: setup.instructions || '' }); done.push('instructions'); }
      if (change.kind === 'collection') { const collection = this.core.collections.all().find(item => item.name === change.to)!; await this.core.collections.bind({ id: collection.id, target: 'project', sessionId: session.id, bound: true }); done.push('collection ' + collection.name); }
      if (change.kind === 'voice') { await this.core.updateSettings({ voice: setup.voice }); done.push('voice'); }
    }
    this.core.store.activity({ action: 'setup.applied', sessionId: session.id, setup: setup.name, status: 'completed', changes: done.length });
    return { applied: done, session: this.core.store.session(session.id) };
  }
  /**
   * A new conversation in `cwd` with the setup's provider, model and families, then the rest of the setup applied.
   * A setup without a model uses the one chosen with it (`model`), or the provider's default.
   */
  async start(p: any) {
    const setup = this.get(p?.setupId);
    if (p.expectedSetupRevision !== undefined && p.expectedSetupRevision !== setup.revision) throw Object.assign(new Error('This setup changed. Review the new version before starting a conversation.'), { code: 'REVISION_CONFLICT' });
    if (typeof p.cwd !== 'string' || !p.cwd.startsWith('/')) throw new Error('Choose the project folder');
    if (p.model !== undefined && (typeof p.model !== 'string' || !p.model || p.model.length > 512)) throw new Error('Choose a valid model');
    const provider = setup.provider || p.provider || 'ollama';
    const families = Object.fromEntries(workbenchFamilies.filter(family => setup.families[family]).map(family => [family, true]));
    const model = setup.model || p.model;
    const session = await this.core.create({ provider, ...(model ? { model } : {}), cwd: p.cwd, trusted: true, ...(['ollama', 'openai', 'anthropic', 'google', 'compatible'].includes(provider) ? { tools: true, ...(Object.keys(families).length ? { capabilities: families } : {}) } : {}) } as any);
    const preview = this.preview({ setupId: setup.id, sessionId: session.id }, setup);
    const applied = await this.apply({ token: preview.token }, setup);
    return { session: applied.session, applied: applied.applied, unresolved: preview.unresolved, notes: preview.notes };
  }
  /** Names and settings only; never IDs of local items, keys, grants or bindings. */
  export(p: any) {
    const ids: string[] = Array.isArray(p?.ids) ? p.ids : [];
    const chosen = this.list().setups.filter(setup => ids.includes(setup.id));
    if (!chosen.length) throw new Error('Choose setups to export');
    const setups = chosen.map(({ id: _id, revision: _revision, builtin: _builtin, ...rest }) => rest);
    return { text: JSON.stringify({ format: 'pal-setups', schema: 1, created: new Date().toISOString(), setups }, null, 2) + '\n', filename: 'pal-setups.json' };
  }
  /** Imports setups as new entries after validating each; references stay names, resolved when a setup is applied. */
  async import(p: any) {
    if (p?.path !== undefined) {
      if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.includes('\0')) throw new Error('Choose a setups file');
      const info = await stat(p.path);
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('Choose a setups file of up to 256 KB');
      p = { text: await readFile(p.path, 'utf8') };
    }
    if (typeof p?.text !== 'string' || p.text.length > 256 * 1024) throw new Error('Choose a setups file of up to 256 KB');
    let value: any; try { value = JSON.parse(p.text); } catch { throw new Error('This is not a PAL setups file'); }
    if (!['pal-setups', 'cere-setups'].includes(value?.format) || value.schema !== 1 || !Array.isArray(value.setups)) throw new Error('This is not a PAL setups file (format pal-setups, schema 1)');
    const added = value.setups.slice(0, limits.setups).map((item: any) => this.save({ setup: { ...item, id: undefined } }));
    return { added: added.map((setup: Setup) => ({ id: setup.id, name: setup.name })) };
  }
}
