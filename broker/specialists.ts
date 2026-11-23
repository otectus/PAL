/**
 * Specialists (PAL Everywhere §17.2): reusable configurations of the narrow helpers (helpers.ts), namely a code
 * reviewer, a researcher, a document editor and a visual critic, run as child operations of the conversation that
 * asks. Each run is an operation with its parent conversation and turn, purpose, inputs, model and output contract,
 * so Activity on the desktop and on phones shows its real state, and Stop on the parent turn or the run's own
 * Cancel ends it.
 *
 * Authority never grows: a specialist has no tools, reads only the inputs the parent chose (re-authorized for the
 * specialist's destination), cannot start specialists, and cannot approve anything. A document editor's edits become
 * a change set in the parent conversation, staged for the person's review and only for files the parent passed. At
 * most `concurrency` specialists run per conversation (default 2, up to 4); paid models respect the monthly budget.
 * Several specialists asked together are merged with attribution; where they disagree, both views stay.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Core } from './core.ts';
import { helperOutput, helperRoles, validHelper, type HelperRole, type HelperSettings } from './helpers.ts';
import { completed, failed, routeAllowed, type ToolResultV1 } from './tools/contracts.ts';

export type SpecialistRole = HelperRole | 'document_editor';
export type Specialist = { id: string; name: string; role: SpecialistRole; description: string; provider?: HelperSettings['provider']; model?: string; instructions?: string; builtin?: boolean; revision: string };
export const specialistRoles: Record<SpecialistRole, string> = { ...helperRoles, document_editor: 'Document editor' };
export const specialistLimits = { concurrency: 2, maxConcurrency: 4, panel: 4, specialists: 30, files: 4 };
export const builtinSpecialists: Specialist[] = [
  { id: 'builtin:reviewer', name: 'Code reviewer', role: 'code_review', description: 'Reviews a pending change set for correctness, risks and missing checks.', builtin: true, revision: '1' },
  { id: 'builtin:researcher', name: 'Researcher', role: 'research_summary', description: 'Summarizes the material you pass, separating what sources state from inference.', builtin: true, revision: '1' },
  { id: 'builtin:editor', name: 'Document editor', role: 'document_editor', description: 'Proposes edits to the text files you pass; they arrive as a change set to review.', builtin: true, revision: '1' },
  { id: 'builtin:critic', name: 'Visual critic', role: 'visual_review', description: 'Reviews images for layout, legibility, contrast and consistency.', builtin: true, revision: '1' },
];
const editorOutput = z.object({ edits: z.array(z.object({ path: z.string().max(4096), content: z.string().max(256 * 1024), reason: z.string().max(1000).optional() })).max(specialistLimits.files), observations: z.array(z.string().max(2000)).max(20).optional() });
const editorSchema = z.toJSONSchema(editorOutput) as Record<string, unknown>; delete editorSchema.$schema;
const storeKey = 'specialists';

export class Specialists {
  core: Core;
  private running = new Map<string, { active: number; waiting: (() => void)[] }>();
  constructor(core: Core) { this.core = core; }
  private stored(): { revision: string; items: Specialist[]; concurrency: number } { return this.core.store.get(storeKey, { revision: '0', items: [] as Specialist[], concurrency: specialistLimits.concurrency }); }
  list() { const stored = this.stored(); return { revision: stored.revision, concurrency: stored.concurrency, specialists: [...builtinSpecialists, ...stored.items], roles: specialistRoles }; }
  get(idOrName: string) {
    const found = this.list().specialists.find(item => item.id === idOrName || item.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!found) throw new Error(`No specialist named ${String(idOrName).slice(0, 80)}`); return found;
  }
  save(p: any) {
    const stored = this.stored(), value = p?.specialist;
    if (p?.expectedRevision !== undefined && p.expectedRevision !== stored.revision) throw Object.assign(new Error('Specialists changed on another device. Reload and try again.'), { code: 'REVISION_CONFLICT' });
    if (!value || typeof value !== 'object') throw new Error('Invalid specialist');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || /[\x00-\x1f]/.test(value.name)) throw new Error('Name the specialist with 1–60 characters');
    if (!(value.role in specialistRoles)) throw new Error(`A specialist is one of: ${Object.values(specialistRoles).join(', ')}`);
    if (value.instructions !== undefined && (typeof value.instructions !== 'string' || value.instructions.length > 2000)) throw new Error('Instructions are up to 2,000 characters');
    const helper = value.provider ? validHelper({ provider: value.provider, model: value.model }) : undefined;
    if (helper && value.role === 'visual_review') throw new Error('A visual critic uses the vision helper set in Settings › Connections');
    const existing = stored.items.find(item => item.id === value.id);
    if (!existing && stored.items.length >= specialistLimits.specialists) throw new Error(`Keep at most ${specialistLimits.specialists} specialists`);
    const specialist: Specialist = { id: existing?.id || randomUUID(), name: value.name.trim(), role: value.role, description: typeof value.description === 'string' ? value.description.slice(0, 400) : '',
      ...(helper ? { provider: helper.provider, model: helper.model } : {}), ...(value.instructions ? { instructions: value.instructions } : {}), revision: existing ? String(BigInt(existing.revision) + 1n) : '1' };
    this.core.store.set(storeKey, { ...stored, revision: String(BigInt(stored.revision) + 1n), items: existing ? stored.items.map(item => item.id === specialist.id ? specialist : item) : [...stored.items, specialist] });
    this.core.changed(); return specialist;
  }
  remove(p: any) {
    const stored = this.stored();
    if (!stored.items.some(item => item.id === p?.id)) throw new Error(String(p?.id || '').startsWith('builtin:') ? 'Built-in specialists cannot be deleted' : 'This specialist no longer exists');
    this.core.store.set(storeKey, { ...stored, revision: String(BigInt(stored.revision) + 1n), items: stored.items.filter(item => item.id !== p.id) }); this.core.changed(); return true;
  }
  setConcurrency(p: any) {
    if (!Number.isInteger(p?.concurrency) || p.concurrency < 1 || p.concurrency > specialistLimits.maxConcurrency) throw new Error(`Run 1–${specialistLimits.maxConcurrency} specialists at a time`);
    const stored = this.stored(); this.core.store.set(storeKey, { ...stored, concurrency: p.concurrency, revision: String(BigInt(stored.revision) + 1n) }); this.core.changed();
    return this.list();
  }
  /** Waits for a slot among this conversation's running specialists. */
  private async slot(sessionId: string, signal: AbortSignal) {
    const entry = this.running.get(sessionId) || { active: 0, waiting: [] };
    this.running.set(sessionId, entry);
    while (entry.active >= this.stored().concurrency) {
      await new Promise<void>((resolve, reject) => { entry.waiting.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    }
    entry.active++;
    return () => { entry.active--; entry.waiting.shift()?.(); if (!entry.active && !entry.waiting.length) this.running.delete(sessionId); };
  }
  /** One specialist task, as a child operation of the parent conversation and turn. */
  async run(sessionId: string, p: { specialist: string; request: string; inputs?: unknown[]; changeSetId?: string; turnId?: string; origin?: 'model' | 'user' }, signal: AbortSignal): Promise<ToolResultV1> {
    const specialist = this.get(p.specialist), session = this.core.store.session(sessionId);
    const helper = specialist.role === 'visual_review' ? this.core.workbench.vision.settings() : specialist.provider ? { provider: specialist.provider, model: specialist.model || '' } as HelperSettings : this.core.workbench.helpers.settings();
    if (helper.provider && helper.provider !== 'ollama') this.core.usage.assertWithinBudget(helper.provider);
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    let operation = this.core.workbench.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'specialist.run', origin: p.origin || 'model', label: `${specialist.name}: ${p.request.slice(0, 80)}`,
      payloadDigest: createHash('sha256').update(JSON.stringify([specialist.id, specialist.revision, p.request, p.inputs || [], p.changeSetId || ''])).digest('hex'),
      witness: { specialist: specialist.id, revision: specialist.revision, route: 'checked per input' }, inputs: [],
      details: { specialist: specialist.name, role: specialistRoles[specialist.role], purpose: p.request.slice(0, 500), provider: helper.provider || '(not set)', model: helper.model || '', outputContract: specialist.role === 'document_editor' ? 'change set for review' : 'observations, suggestions, unresolved' } });
    this.core.workbench.runControllers.set(operation.id, controller);
    const removeJob = this.core.jobs.add('specialist', operation.label, () => controller.abort(new Error('Cancelled')));
    let release: (() => void) | undefined;
    try {
      operation = this.core.workbench.operations.transition(operation.id, 'queued');
      release = await this.slot(sessionId, combined);
      operation = this.core.workbench.operations.transition(operation.id, 'running');
      const result = specialist.role === 'document_editor' ? await this.edit(session.id, specialist, helper as HelperSettings, p.request, p.inputs || [], combined)
        : await this.core.workbench.helpers.run(session.id, specialist.role as HelperRole, p.request, p.inputs || [], p.changeSetId, combined, { ...(specialist.provider ? { helper: helper as HelperSettings } : {}), ...(specialist.instructions ? { instructions: specialist.instructions } : {}) });
      const ok = result.status === 'completed';
      this.core.workbench.operations.transition(operation.id, ok ? 'completed' : 'failed', { ...(ok ? {} : { error: { code: 'specialist', message: String(result.summary || '').slice(0, 300) } }), details: { ...operation.details, summary: String(result.summary || '').slice(0, 500) } });
      return { ...result, summary: `${specialist.name}: ${result.summary}` };
    } catch (error: any) {
      const current = this.core.workbench.operations.get(operation.id);
      if (!['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(current.state)) this.core.workbench.operations.transition(operation.id, current.state === 'queued' ? 'cancelled' : combined.aborted ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : 'failed', { error: { code: 'specialist', message: String(error?.message || error).slice(0, 300) } });
      throw error;
    } finally { release?.(); removeJob(); this.core.workbench.runControllers.delete(operation.id); }
  }
  /** Several specialists on one question, merged with attribution; their disagreements stay visible. */
  async panel(sessionId: string, tasks: { specialist: string; request: string; inputs?: unknown[]; changeSetId?: string }[], turnId: string | undefined, signal: AbortSignal): Promise<ToolResultV1> {
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > specialistLimits.panel) return failed('inputs', `Ask 1–${specialistLimits.panel} specialists at once`, 'explicit');
    const results = await Promise.all(tasks.map(task => this.run(sessionId, { ...task, ...(turnId ? { turnId } : {}) }, signal).catch((error: any) => { if (signal.aborted) throw error; return failed('specialist', String(error?.message || error).slice(0, 300), 'explicit'); })));
    const views = results.map((result, index) => ({ specialist: this.get(tasks[index].specialist).name, status: result.status, summary: result.summary, ...(result.data && typeof result.data === 'object' ? { result: result.data } : {}) }));
    return completed(`${views.filter(view => view.status === 'completed').length} of ${views.length} specialists answered. Each view is attributed; where they differ, both are kept. These are suggestions to check, not verified facts.`, { views });
  }
  /** Document editor: complete new text for each file the parent passed, staged as one change set for review. */
  private async edit(sessionId: string, specialist: Specialist, helper: HelperSettings, request: string, inputs: unknown[], signal: AbortSignal): Promise<ToolResultV1> {
    if (!helper.provider) return failed('unavailable', 'No text helper is set up. The user can choose one in Settings › Connections › Images & analysis, or give this specialist its own model.', 'explicit');
    const files = (inputs as any[]).filter(item => item?.kind === 'file' && typeof item.rootId === 'string' && typeof item.path === 'string').slice(0, specialistLimits.files);
    if (!files.length) return failed('inputs', 'Pass the text files the document editor may edit', 'explicit');
    const route = await this.core.workbench.helpers.route(signal, helper), roots = this.core.workbench.roots.list(sessionId);
    const read: { rootId: string; path: string; version: string; text: string }[] = [];
    for (const file of files) {
      const root = roots.find(item => item.id === file.rootId);
      if (!root) return failed('inputs', 'A file’s folder is no longer part of this conversation', 'explicit');
      if (!routeAllowed(route, root.policy.destinations)) return failed('inputs', `${file.path} is in a folder that may not be sent to this specialist’s destination (${route})`, 'explicit');
      if (!root.policy.write) return failed('inputs', `${root.name} does not allow editing files; change its permissions first`, 'explicit');
      const value: any = await this.core.workbench.dispatch('files.text', { sessionId, rootId: file.rootId, path: file.path });
      read.push({ rootId: file.rootId, path: file.path, version: value.version, text: value.text });
    }
    const prompt = `Role: Document editor. Edit the supplied documents for the request. Change only what the request needs and keep everything else exactly as it is. Return JSON matching this schema: ${JSON.stringify(editorSchema)}. Each edit's content is the complete new text of that file; edit only the files given, using their exact paths.${specialist.instructions ? '\nStanding instructions: ' + specialist.instructions.slice(0, 2000) : ''}\nRequest: ${request.slice(0, 2000)}\n\n` +
      read.map(file => `<document path="${file.path.replace(/"/g, '')}">\n${file.text.replaceAll('</document>', '<\\/document>')}\n</document>`).join('\n\n');
    const { answer } = await this.core.workbench.helpers.ask(helper, prompt, signal, editorSchema);
    let parsed: z.infer<typeof editorOutput> | undefined;
    try { const start = answer.indexOf('{'), end = answer.lastIndexOf('}'); parsed = editorOutput.parse(JSON.parse(answer.slice(start, end + 1))); } catch { return failed('helper', 'The document editor’s answer did not follow the edit structure; nothing was staged.', 'explicit'); }
    const edits = parsed.edits.map(edit => ({ edit, file: read.find(file => file.path === edit.path) })).filter(item => item.file && item.edit.content !== item.file.text);
    const ignored = parsed.edits.filter(edit => !read.some(file => file.path === edit.path)).map(edit => edit.path);
    if (!edits.length) return completed(`${specialist.name} proposed no changes${ignored.length ? ` (it named files it was not given: ${ignored.join(', ')})` : ''}.`, { observations: parsed.observations || [] });
    const set = await this.core.workbench.changes.propose(sessionId, edits.map(({ edit, file }) => ({ kind: 'patch_text', rootId: file!.rootId, path: file!.path, baseVersion: file!.version, content: edit.content })), { reason: `${specialist.name}: ${request}`.slice(0, 500), origin: 'model' }, signal);
    return completed(`${specialist.name} staged a change set for ${edits.length} file${edits.length === 1 ? '' : 's'}; nothing is applied until it is reviewed.${ignored.length ? ` Ignored edits to files it was not given: ${ignored.join(', ')}.` : ''}`,
      { changeSetId: set.id, files: edits.map(({ edit }) => ({ path: edit.path, reason: edit.reason || '' })), observations: parsed.observations || [] });
  }
}
export { helperOutput };
