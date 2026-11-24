/**
 * Looking after a saved account (provider plan §4.3, §4.4 and §10.1): checking it in visible stages, seeing everything that
 * depends on it, and moving those conversations and settings to another account of the same provider before it is removed.
 *
 * The first stages cost nothing: the account is complete, the service accepts it, and its models load. What a service does
 * not let PAL find out for free is said to be unknown, not assumed. Trying a model sends short requests that the service
 * may bill; they run only when asked for, one after another, and are recorded like any other use.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { ApiAdapter, apiGet } from './api-providers.ts';
import { limitedControlled } from './authority.ts';
import type { ChatConnection } from './connections.ts';
import type { Core } from './core.ts';
import { HttpStatusError } from './http-retry.ts';
import { OllamaAdapter, type ManagedConversationAdapter, type OllamaContext, type OllamaTool } from './ollama.ts';
import { isApiProvider, type ApiProvider } from './provider-catalog.ts';
import { getProviderDefinition, resolveProviderEndpoint } from './provider-registry.ts';
import type { ModelOption, Session } from './types.ts';
import { busy } from './execution.ts';

export const connectionTests = ['reply', 'streaming', 'tools', 'images', 'structured'] as const;
export type ConnectionTest = typeof connectionTests[number];
export type CheckStage = { id: string; label: string; state: 'ok' | 'failed' | 'unknown'; detail: string };
export type ConnectionUse = { kind: string; label: string; detail?: string; sessionId?: string;
  /** Moves with the account's conversations and settings; otherwise where to change it. */
  movable: boolean; where?: string };
const labels: Record<string, string> = { configured: 'Set up', account: 'Account', models: 'Models', reply: 'Reply', streaming: 'Streaming', tools: 'Tool call', images: 'Images', structured: 'Structured reply' };
const said = (error: unknown) => String((error as any)?.message || error).replace(/\s+/g, ' ').slice(0, 300);
export const checkLimits = { testMs: 60_000, uses: 200 };
/** A catalog anyone can read says nothing about the account. */
const openCatalog = (provider: string, variant?: string) => provider === 'openrouter' || provider === 'huggingface' && variant !== 'inference';

export class ConnectionTools {
  private core: Core; private checking = new Set<string>();
  /** Seam for tests: how a test conversation reaches its account. */
  adapter = (session: Session, events: (event: any) => void, context: OllamaContext, connection: ChatConnection | undefined, declared: boolean): ManagedConversationAdapter => {
    const hooks: any = { token: '', native() {}, event: events, approve: async () => ({ choice: 'deny' }), personality: () => '' };
    if (session.provider === 'ollama') { const adapter = new OllamaAdapter(session, hooks, context); return adapter; }
    const provider = session.provider as ApiProvider, access = this.core.accountAccess(provider, connection?.id), endpoint = access.endpoint?.();
    // Trying a capability is how a compatible server's declaration is found out, so it is not limited by it here.
    return new ApiAdapter(session, hooks, context, { ...access, canUseImages: () => true, ...(provider === 'compatible' && endpoint && declared ? { endpoint: () => ({ ...access.endpoint!(), tools: true, images: true, streaming: true }) } : {}) });
  };
  constructor(core: Core) { this.core = core; }

  async check(params: unknown): Promise<{ stages: CheckStage[]; models: { id: string; name: string }[]; unlisted: boolean; checkedAt: number; found?: Record<string, boolean> }> {
    const p = z.strictObject({ connectionId: z.uuid().optional(), provider: z.string().max(40).optional(), model: z.string().trim().max(512).optional(), tests: z.array(z.enum(connectionTests)).max(connectionTests.length).default([]), paid: z.boolean().default(false) }).parse(params);
    const connection = p.connectionId ? this.core.chatConnections.get(p.connectionId) : undefined, provider = connection?.kind || p.provider || '';
    if (provider !== 'ollama' && !isApiProvider(provider)) throw new Error('Choose an account to check');
    if (p.tests.length && !p.paid) throw new Error('Trying a model sends requests that may be billed. Confirm to send them.');
    if (p.tests.length && !p.model) throw new Error('Choose a model to try');
    const key = connection?.id || provider; if (this.checking.has(key)) throw new Error('This account is already being checked');
    this.checking.add(key);
    const stages: CheckStage[] = [], add = (id: string, state: CheckStage['state'], detail: string) => { stages.push({ id, label: labels[id], state, detail }); };
    let models: ModelOption[] = [], unlisted = false; const found: Record<string, boolean> = {};
    try {
      // Set up: an address this provider allows and, where one is needed, a credential for it.
      try { add('configured', 'ok', this.configured(provider, connection)); } catch (error) { add('configured', 'failed', said(error)); return { stages, models: [], unlisted, checkedAt: Date.now() }; }
      try {
        models = connection ? await this.core.accountModels(connection) : await this.core.refreshProviderModels(provider as any);
        unlisted = (models as { unlisted?: boolean }).unlisted === true;
        await this.account(provider, connection, unlisted, add);
        add('models', unlisted ? 'unknown' : models.length ? 'ok' : 'failed', unlisted ? 'This service does not list its models. Enter a model ID.' : models.length === 1 ? '1 model' : `${models.length} models`);
      } catch (error) {
        const status = error instanceof HttpStatusError ? error.status : 0;
        add('account', status === 401 || status === 403 || !status ? 'failed' : 'unknown', said(error)); add('models', 'failed', 'Not loaded.');
      }
      for (const test of p.tests) {
        try { await this.core.usage.assertWithinBudget(provider); const result = await this.attempt(test, provider, connection, p.model!); found[test] = result.ok; add(test, result.ok ? 'ok' : 'failed', result.detail); }
        catch (error) { found[test] = false; add(test, 'failed', said(error)); }
        // A service that refuses the plain request refuses the rest for the same reason.
        if (test === 'reply' && !found.reply) break;
      }
    } finally { this.checking.delete(key); }
    return { stages, models: models.slice(0, 400).map(model => ({ id: model.id, name: model.displayName || model.id })), unlisted, checkedAt: Date.now(), ...(p.tests.length ? { found } : {}) };
  }
  private configured(provider: string, connection?: ChatConnection): string {
    if (provider === 'ollama') return connection?.ollama?.host || this.core.settings.ollama.host;
    const id = provider as ApiProvider, access = this.core.accountAccess(id, connection?.id);
    if (connection?.kind === 'litellm' && connection.variant === 'bridge') return 'LiteLLM on this computer';
    const route = access.route?.() || {}, base = resolveProviderEndpoint(id, { ...route, baseUrl: route.baseUrl || access.endpoint?.().baseUrl, apiVersion: undefined }), keyless = (id === 'compatible' || id === 'litellm') && access.endpoint?.()?.requiresKey === false;
    if (!keyless && !access.token && !access.key()) throw new Error('No credential is saved for this account.');
    return new URL(base).origin + (keyless ? ' · no key needed' : access.token ? ' · this computer’s identity' : ' · a saved or environment key');
  }
  private async account(provider: string, connection: ChatConnection | undefined, unlisted: boolean, add: (id: string, state: CheckStage['state'], detail: string) => void) {
    if (provider === 'ollama') return add('account', 'ok', 'The server answered.');
    if (provider === 'openrouter') {
      // Its model list is public; its key has a page of its own.
      try { await apiGet('openrouter', this.core.accountAccess('openrouter', connection?.id), 'key', AbortSignal.timeout(20_000)); return add('account', 'ok', 'The key was accepted.'); }
      catch (error) { const status = error instanceof HttpStatusError ? error.status : 0; return add('account', status === 401 || status === 403 ? 'failed' : 'unknown', status === 404 ? 'This service cannot be asked without sending a message.' : said(error)); }
    }
    if (unlisted || openCatalog(provider, connection?.variant) || getProviderDefinition(provider).catalog.strategy !== 'endpoint') return add('account', 'unknown', 'This service cannot be asked without sending a message.');
    if ((provider === 'compatible' || provider === 'litellm') && this.core.accountAccess(provider, connection?.id).endpoint?.()?.requiresKey === false) return add('account', 'ok', 'The server answered.');
    add('account', 'ok', 'The service accepted it.');
  }
  /** One short conversation that is not kept anywhere, through the same adapter every conversation uses. */
  private async attempt(test: ConnectionTest, provider: string, connection: ChatConnection | undefined, model: string): Promise<{ ok: boolean; detail: string }> {
    const tool: OllamaTool = { type: 'function', function: { name: 'pal_check', description: 'Confirms that tools work. Call it once with the value "ready".', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } };
    const schema = JSON.stringify({ type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }), definition = isApiProvider(provider) ? getProviderDefinition(provider) : undefined;
    if (test === 'structured' && !definition?.optionsSchema.some(field => field.key === 'outputSchema')) return { ok: false, detail: 'This provider has no reply schema.' };
    const session = { id: 'connection-check', provider, nativeId: null, title: '', cwd: homedir(), mode: 'managed', status: 'idle', created: 0, updated: 0, draft: '', scroll: 0, model,
      ...(connection ? { connectionId: connection.id, connectionRevision: connection.revision } : {}), ...(provider === 'ollama' ? { ollama: { host: connection?.ollama?.host || this.core.settings.ollama.host, tools: test === 'tools' } } : { api: { tools: test === 'tools', ...(test === 'structured' ? { options: { outputSchema: schema } } : {}) } }) } as unknown as Session;
    const events: any[] = [], calls: any[] = []; let history: any[] = [], usage: any;
    const context: OllamaContext = { load: () => history, save: messages => { history = messages; }, tools: () => test === 'tools' ? [tool] : [], call: async (name, args) => { calls.push({ name, args }); return { ok: true }; }, options: () => ({}), plan: plan => { if (plan.reported) usage = plan.reported; } };
    const adapter = this.adapter(session, event => events.push(event), context, connection, test === 'tools' || test === 'images' || test === 'streaming'), timer = setTimeout(() => void adapter.interrupt().catch(() => {}), checkLimits.testMs); timer.unref();
    let folder = '';
    try {
      let picture = '';
      const prompt = test === 'tools' ? 'Call pal_check once with the value "ready", then answer with the single word done.' : test === 'images' ? 'What colour fills this picture? Answer with one word.' : test === 'structured' ? 'Answer with the word ready.' : test === 'streaming' ? 'Count from one to twenty in words, separated by commas.' : 'Answer with the single word ready.';
      if (test === 'images') { folder = await mkdtemp(join(tmpdir(), 'pal-check-')); picture = join(folder, 'square.png'); await writeFile(picture, await sharp({ create: { width: 96, height: 96, channels: 3, background: '#d01020' } }).png().toBuffer(), { mode: 0o600 }); }
      await adapter.send(prompt, picture ? [picture] : []); await adapter.task;
    } finally { clearTimeout(timer); await adapter.close().catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }); }
    if (usage) this.core.store.db.prepare('INSERT INTO usage_records VALUES (?,?,?,?,?)').run(randomUUID(), '', '', Date.now(), JSON.stringify({ kind: 'check', calls: 1, source: provider, model, status: 'reported', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }));
    const failed = events.find(event => event.type === 'error'), answer = String(events.findLast(event => event.type === 'message')?.text || '').trim(), short = answer.replace(/\s+/g, ' ').slice(0, 80);
    if (failed) return { ok: false, detail: said(failed.text) };
    if (!events.some(event => event.type === 'complete')) return { ok: false, detail: 'It did not finish within a minute.' };
    if (test === 'streaming') { const parts = events.filter(event => event.type === 'delta').length; return { ok: parts > 1, detail: parts > 1 ? `The reply arrived in ${parts} parts.` : 'The reply arrived in one part.' }; }
    if (test === 'tools') return { ok: calls.some(call => call.name === 'pal_check'), detail: calls.length ? 'The model called the tool and went on.' : 'The model answered without calling the tool.' };
    if (test === 'images') return { ok: /\bred\b|crimson|scarlet/i.test(answer), detail: `It said “${short}”.` };
    if (test === 'structured') { try { return { ok: typeof JSON.parse(answer).word === 'string', detail: 'The reply followed the schema.' }; } catch { return { ok: false, detail: `It said “${short}”.` }; } }
    return { ok: answer.length > 0, detail: `It said “${short}”.` };
  }

  /** Everything that would stop working, or be moved, with this account. */
  uses(id: unknown): { connection: { id: string; name: string; kind: string }; uses: ConnectionUse[]; total: number; targets: { id: string; name: string }[]; conversations: number } {
    const connection = this.core.chatConnections.get(id), settings = this.core.settings, uses: ConnectionUse[] = [], sessions = this.core.store.sessions().filter(session => session.connectionId === connection.id);
    const add = (kind: string, label: string, movable: boolean, extra: Partial<ConnectionUse> = {}) => uses.push({ kind, label, movable, ...extra });
    for (const session of sessions) add('conversation', session.title || 'Untitled session', true, { sessionId: session.id, ...(session.archived ? { detail: 'Archived' } : busy(session) ? { detail: 'Working now' } : {}) });
    const mine = new Set(sessions.map(session => session.id));
    for (const item of this.core.schedules.list()) if (mine.has(item.sourceSessionId)) add('schedule', item.label || 'Routine', false, { sessionId: item.sourceSessionId, where: 'It pauses when its conversation moves. Review it again under Workflows.' });
    if (settings.workbench.helper?.connectionId === connection.id) add('helper', 'Text helper', true);
    if (settings.workbench.vision?.connectionId === connection.id) add('vision', 'Vision helper', true);
    for (const item of settings.workbench.imageConnections) if (item.providerAccountId === connection.id) add('images', item.name, true, { detail: 'Image service' });
    if (settings.hostedVoice?.connectionId === connection.id) add('voice', 'Spoken voice', true);
    if (settings.transcription?.connectionId === connection.id) add('transcription', 'Voice input', true);
    if (settings.memory.extractionConnectionId === connection.id) add('extraction', 'Memory extraction', true);
    if (settings.memory.embeddingConnectionId === connection.id) add('embedding', 'Memory embeddings', false, { where: 'Changing it indexes memory again. Choose another account in Settings › Knowledge.' });
    if (this.core.memory.service.usesBinding('connection:' + connection.id)) add('memory-task', 'Memory review tasks', false, { where: 'Choose another account under Memory review in Settings › Knowledge.' });
    for (const setup of this.core.setups.list().setups) if (!setup.builtin && setup.connection === connection.name && setup.provider === connection.kind) add('setup', setup.name, true, { detail: 'Saved setup' });
    for (const item of this.core.specialists.list().specialists) if (item.connectionId === connection.id) add('specialist', item.name, true, { detail: 'Specialist' });
    const running = this.core.store.db.prepare("SELECT data FROM provider_research_jobs WHERE json_extract(data,'$.connectionId')=? AND json_extract(data,'$.status') IN ('unknown','queued','in_progress','cancelling')").all(connection.id);
    for (const row of running) add('research', String(JSON.parse(String(row.data)).prompt || 'Research').slice(0, 120), false, { where: 'Wait for it, or stop it in Workbench › Research.' });
    const targets = this.core.chatConnections.list().filter(row => row.kind === connection.kind && row.id !== connection.id).map(row => ({ id: row.id, name: row.name }));
    return { connection: { id: connection.id, name: connection.name, kind: connection.kind }, uses: uses.slice(0, checkLimits.uses), total: uses.length, targets, conversations: sessions.length };
  }
  /** Moves what can move to another account of the same provider. Each conversation’s readable history goes there with its next message. */
  async reassign(params: unknown): Promise<{ moved: number; problems: string[] }> {
    const p = z.strictObject({ id: z.uuid(), to: z.uuid(), reviewed: z.literal(true) }).parse(params);
    const from = this.core.chatConnections.get(p.id), to = this.core.chatConnections.get(p.to, from.kind), problems: string[] = []; let moved = 0;
    if (from.id === to.id) throw new Error('Choose another account');
    for (const session of this.core.store.sessions().filter(session => session.connectionId === from.id)) {
      try {
        if (limitedControlled(session)) throw new Error('Detach it from the phone first');
        await this.core.configureSession({ id: session.id, model: session.model, connectionId: to.id, destinationReviewed: true, ...(session.api?.options ? { providerOptions: session.api.options } : {}) });
        moved++;
      } catch (error) { problems.push(`${session.title || 'Untitled session'}: ${said(error)}`); }
    }
    const settings = this.core.settings, patch: any = {}, workbench: any = {};
    if (settings.workbench.helper?.connectionId === from.id) workbench.helper = { ...settings.workbench.helper, connectionId: to.id };
    if (settings.workbench.vision?.connectionId === from.id) workbench.vision = { ...settings.workbench.vision, connectionId: to.id };
    if (settings.workbench.imageConnections.some(item => item.providerAccountId === from.id)) workbench.imageConnections = settings.workbench.imageConnections.map(item => item.providerAccountId === from.id ? { ...item, providerAccountId: to.id } : item);
    if (Object.keys(workbench).length) patch.workbench = workbench;
    if (settings.hostedVoice?.connectionId === from.id) patch.hostedVoice = { ...settings.hostedVoice, connectionId: to.id };
    if (settings.transcription?.connectionId === from.id) patch.transcription = { connectionId: to.id };
    if (settings.memory.extractionConnectionId === from.id) patch.memory = { extractionConnectionId: to.id };
    for (const [key, value] of Object.entries(patch)) try { await this.core.updateSettings({ [key]: value } as any); moved++; } catch (error) { problems.push(said(error)); }
    for (const setup of this.core.setups.list().setups) if (!setup.builtin && setup.connection === from.name && setup.provider === from.kind) try { this.core.setups.save({ setup: { ...setup, connection: to.name } }); moved++; } catch (error) { problems.push(said(error)); }
    for (const item of this.core.specialists.list().specialists) if (item.connectionId === from.id) try { this.core.specialists.save({ specialist: { ...item, connectionId: to.id } }); moved++; } catch (error) { problems.push(said(error)); }
    return { moved, problems: problems.slice(0, 20) };
  }
}
