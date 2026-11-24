/**
 * Accounts (PAL Everywhere §14): GitHub, Google and Microsoft, connected with apps the owner registered. An account's
 * sign-in belongs to the application; who may use it is decided per use. Nothing is cached, so nothing has to be kept
 * apart or erased later: a read goes to the service, and what is kept is an ordinary file of a conversation.
 *
 * Assistants see an account only when the owner let them read it, for the projects and the kinds of model chosen, and
 * every change they prepare waits for a person who sees exactly what will be written. No bypass answers that.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Core } from '../core.ts';
import type { Session } from '../types.ts';
import { ExtensionSecrets } from '../extensions.ts';
import { remoteError } from '../execution.ts';
import { ownerControlled } from '../authority.ts';
import { safeName } from '../artifacts/store.ts';
import { localOnly, routeAllowed, routeLabels, type DestinationPolicy } from '../tools/contracts.ts';
import { AccountError, AccountHttp, type Transport } from './http.ts';
import { AccountOAuth, endpoints, providers, scopes, type AccountProvider, type AccountService, type AccountTokens, type OAuthClient, type ServiceAccess } from './oauth.ts';
import type { CalendarAdapter, Credentials, DriveAdapter, Identity, MailAdapter, WriteContext, Written } from './adapter.ts';
import { describeWrite, GitHub, repository, validWrite } from './github.ts';
import type { Delivery } from '../schedules.ts';
import { googleCalendar, googleDrive, googleIdentity, googleMail, googleOrigins } from './google.ts';
import { graphOrigin, microsoftCalendar, microsoftDrive, microsoftIdentity, microsoftMail } from './microsoft.ts';
import { describeRecurrence, emailAddress, validEvent, type EventInput, type EventTime } from './events.ts';
import { validMail, type MailMessage } from './mail.ts';
import { Outbox, type AccountWrite, type WritePayload } from './outbox.ts';

export type Account = { id: string; provider: AccountProvider; label: string; clientId: string; tenant?: string; host?: string; services: Partial<Record<AccountService, ServiceAccess>>; granted?: Partial<Record<AccountService, ServiceAccess>>; ai: 'off' | 'read' | 'write'; destinations: DestinationPolicy; projects: string[] | null; method?: 'device' | 'browser' | 'token'; subject?: string; login?: string; signedInAt?: number; problem?: string; created: number; revision: string };
type Flow = { id: string; accountId: string; kind: 'device' | 'browser'; client: OAuthClient; services: Account['services']; expires: number; state: 'waiting' | 'done' | 'failed'; message?: string; merged?: string; userCode?: string; address?: string; complete?: string; url?: string; deviceCode?: string; interval?: number; timer?: NodeJS.Timeout; oauthState?: string; verifier?: string; redirect?: string; deviceId?: string };
export type AccountOptions = { transport?: Transport; endpoints?: typeof endpoints; private?: boolean; origins?: { google: typeof googleOrigins; graph: string } };
export const accountServiceLimits = { accounts: 12, flowMs: 15 * 60_000, results: 30, agendaDays: 92, modelBytes: 48 * 1024 };
const services: AccountService[] = ['github', 'calendar', 'mail', 'drive'];
const serviceNames: Record<AccountService, string> = { github: 'GitHub', calendar: 'calendar', mail: 'mail', drive: 'files' };
const rank = { read: 1, write: 2 } as const;
const least = (a: ServiceAccess | undefined, b: ServiceAccess | undefined): ServiceAccess | undefined => !a || !b ? undefined : rank[a] < rank[b] ? a : b;
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const day = 86400_000;

export class Accounts {
  core: Core; secrets: ExtensionSecrets; outbox: Outbox; oauth: AccountOAuth;
  private transport?: Transport; private private = false;
  private flows = new Map<string, Flow>(); private refreshing = new Map<string, Promise<string>>(); private listener?: { server: Server; port: number };
  origins = { google: googleOrigins, graph: graphOrigin };
  /** Only a test's own code replaces these, with a local stand-in for the services. */
  static defaults: AccountOptions = {};
  constructor(core: Core, options: AccountOptions = Accounts.defaults) {
    this.core = core; if (options.origins) this.origins = options.origins; if (options.transport) this.transport = options.transport; this.private = options.private === true;
    this.oauth = new AccountOAuth(options); this.secrets = new ExtensionSecrets(join(core.store.directory, 'credentials'), 'account-secrets.json');
    core.store.db.exec('CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.outbox = new Outbox(core.store, { perform: (write, context) => this.perform(write, context), look: (write, context) => this.look(write, context), check: write => this.writable(write) });
    this.outbox.changed = () => this.changed();
  }
  private revision = 0; private counted?: ReturnType<Accounts['count']>;
  private changed() { this.revision++; this.counted = undefined; if (!this.core.closed) this.core.changed(); }
  /** For the interface: how many accounts and open writes there are, never what is in them. */
  summary() { return this.counted ??= this.count(); }
  private count() { const all = this.rows(); return { accounts: all.length, signedIn: all.filter(account => this.tokens(account.id)).length, waiting: this.outbox.list({ states: ['draft', 'unknown', 'failed'] }).length, revision: this.revision }; }

  // ---------- accounts ----------
  private rows(): Account[] { return this.core.store.db.prepare('SELECT data FROM accounts').all().map(row => JSON.parse(String(row.data)) as Account).sort((a, b) => a.created - b.created); }
  account(id: unknown): Account { const row = typeof id === 'string' ? this.core.store.db.prepare('SELECT data FROM accounts WHERE id=?').get(id) : undefined; if (!row) throw new Error('This account no longer exists'); return JSON.parse(String(row.data)); }
  private put(account: Account) { const next = { ...account, revision: String(BigInt(account.revision || '0') + 1n) }; this.core.store.db.prepare('INSERT OR REPLACE INTO accounts VALUES (?,?)').run(next.id, JSON.stringify(next)); this.changed(); return next; }
  private tokens(id: string): AccountTokens | undefined { try { const value = this.secrets.values(id).TOKENS; return value ? JSON.parse(value) : undefined; } catch { return undefined; } }
  private client(account: Account): OAuthClient { const secret = (() => { try { return this.secrets.values(account.id).CLIENT_SECRET; } catch { return undefined; } })(); return { clientId: account.clientId, ...(secret ? { clientSecret: secret } : {}), ...(account.tenant ? { tenant: account.tenant } : {}), ...(account.host ? { host: account.host } : {}) }; }
  /** What the account can do now: what was chosen, as far as the sign-in allows it. */
  access(account: Account, service: AccountService): ServiceAccess | undefined { return this.tokens(account.id) ? least(account.services[service], account.granted?.[service]) : undefined; }
  dto(account: Account) {
    const signedIn = !!this.tokens(account.id), needs = services.filter(service => account.services[service] && (!account.granted?.[service] || rank[account.services[service]!] > rank[account.granted[service]!]));
    return { id: account.id, provider: account.provider, providerLabel: providers[account.provider].label, label: account.label, clientId: account.clientId, ...(account.tenant ? { tenant: account.tenant } : {}), ...(account.host ? { host: account.host } : {}), secretSet: !!this.client(account).clientSecret, services: account.services, access: Object.fromEntries(services.flatMap(service => { const value = this.access(account, service); return value ? [[service, value]] : []; })), ai: account.ai, destinations: account.destinations, projects: account.projects, revision: account.revision, ...(account.method ? { method: account.method } : {}), ...(account.login ? { login: account.login } : {}), ...(account.signedInAt ? { signedInAt: account.signedInAt } : {}),
      state: signedIn ? account.problem ? 'problem' as const : needs.length && account.method !== 'token' ? 'more' as const : 'signed-in' as const : 'signed-out' as const, ...(signedIn && account.problem ? { problem: account.problem } : {}), ...(signedIn && needs.length && account.method !== 'token' ? { needs } : {}) };
  }
  list() { return { timeZone: this.core.temporal.preview().zone, accounts: this.rows().map(account => this.dto(account)), providers: Object.entries(providers).map(([id, value]) => ({ id, ...value })), flows: [...this.flows.values()].map(flow => this.flowDto(flow)) }; }
  save(p: any) {
    const before = p.id ? this.account(p.id) : undefined, provider = before?.provider ?? p.provider;
    if (!(provider in providers)) throw new Error('Choose GitHub, Google or Microsoft');
    if (before && p.expectedRevision !== undefined && p.expectedRevision !== before.revision) throw remoteError('REVISION_CONFLICT', 'This account changed on another screen. Open it again.');
    if (!before && this.rows().length >= accountServiceLimits.accounts) throw new Error(`Keep at most ${accountServiceLimits.accounts} accounts`);
    const label = p.label === undefined ? before?.label : p.label; if (typeof label !== 'string' || !label.trim() || label.length > 60 || /[\x00-\x1f]/.test(label)) throw new Error('Name the account on one line (up to 60 characters)');
    const clientId = p.clientId === undefined ? before?.clientId ?? '' : String(p.clientId).trim(); if (clientId && !/^[\x21-\x7e]{1,300}$/.test(clientId)) throw new Error('Enter the client ID the service gave you');
    const tenant = p.tenant === undefined ? before?.tenant : String(p.tenant).trim() || undefined; if (tenant && (provider !== 'microsoft' || !/^[A-Za-z0-9.-]{1,120}$/.test(tenant))) throw new Error('A Microsoft tenant is an ID or a domain name');
    const host = p.host === undefined ? before?.host : String(p.host).trim().toLowerCase() || undefined; if (host && (provider !== 'github' || !/^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?$/.test(host) || host === 'github.com')) throw new Error('A GitHub Enterprise host is a name such as github.example.com');
    const chosen: Account['services'] = {}; const wanted = p.services ?? before?.services ?? Object.fromEntries(providers[provider as AccountProvider].services.map(service => [service, 'read']));
    for (const [service, value] of Object.entries(wanted)) { if (!value || value === 'off') continue; if (!providers[provider as AccountProvider].services.includes(service as AccountService) || !['read', 'write'].includes(String(value))) throw new Error('Choose what the account is used for'); chosen[service as AccountService] = value as ServiceAccess; }
    if (!Object.keys(chosen).length) throw new Error('Choose at least one use for the account');
    const ai = p.ai ?? before?.ai ?? 'off'; if (!['off', 'read', 'write'].includes(ai)) throw new Error('Choose what assistants may do');
    const destinations = p.destinations ?? before?.destinations ?? localOnly; if (typeof destinations?.remote !== 'boolean' || typeof destinations?.cloud !== 'boolean') throw new Error('Choose which models may read it');
    const projects = p.projects === undefined ? before?.projects ?? null : p.projects; if (projects !== null && (!Array.isArray(projects) || projects.length > 50 || projects.some((item: unknown) => typeof item !== 'string' || !item.startsWith('/') || item.length > 4096))) throw new Error('Choose the projects it is for');
    const account: Account = { ...(before || { id: randomUUID(), created: Date.now(), revision: '0' }), provider, label: label.trim(), clientId, services: chosen, ai, destinations: { remote: destinations.remote || destinations.cloud, cloud: destinations.cloud }, projects } as Account;
    if (tenant) account.tenant = tenant; else delete account.tenant; if (host) account.host = host; else delete account.host;
    // Another app, tenant or host is another sign-in; the old one does not carry over.
    if (before && (before.clientId !== clientId || before.tenant !== tenant || before.host !== host) && before.method !== 'token') this.drop(account);
    if (before && before.host !== host) this.drop(account);
    if (p.clientSecret !== undefined) { if (typeof p.clientSecret !== 'string' || p.clientSecret.length > 1000 || /[\x00-\x1f]/.test(p.clientSecret)) throw new Error('Enter the client secret on one line'); this.secrets.set(account.id, 'CLIENT_SECRET', p.clientSecret.trim()); }
    return this.dto(this.put(account));
  }
  private drop(account: Account) { this.secrets.set(account.id, 'TOKENS', ''); for (const key of ['method', 'granted', 'signedInAt', 'problem'] as const) delete account[key]; for (const flow of this.flows.values()) if (flow.accountId === account.id) this.end(flow); this.denyOpen(account.id); }
  /** Questions about a changed sign-in are refused; a draft stays, bound to the identity it was written for. */
  private denyOpen(accountId: string) { for (const { value } of [...this.core.approvals.values()]) if (value.kind === 'account' && value.fields?.account === accountId) this.core.answer({ id: value.id, choice: 'deny' }, true); }
  async remove(id: unknown) {
    const account = this.account(id), tokens = this.tokens(account.id); this.drop(account); this.outbox.forgetAccount(account.id);
    this.secrets.set(account.id, 'CLIENT_SECRET', ''); this.core.store.db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);
    const revoked = tokens && account.method !== 'token' ? await this.oauth.revoke(account.provider, { clientId: account.clientId, ...(account.tenant ? { tenant: account.tenant } : {}), ...(account.host ? { host: account.host } : {}) }, tokens) : false;
    this.core.store.activity({ action: 'account.remove', provider: account.provider, status: 'completed' }); this.changed(); return { removed: true, revoked };
  }
  async signOut(id: unknown) {
    const account = this.account(id), tokens = this.tokens(account.id), client = this.client(account); const method = account.method; this.drop(account); const saved = this.put(account);
    const revoked = tokens && method !== 'token' ? await this.oauth.revoke(account.provider, client, tokens) : false;
    this.core.store.activity({ action: 'account.signout', provider: account.provider, status: 'completed' }); return { ...this.dto(saved), revoked };
  }

  // ---------- sign-in ----------
  private end(flow: Flow) { if (flow.timer) clearTimeout(flow.timer); delete flow.timer; delete flow.deviceCode; delete flow.verifier; this.flows.delete(flow.id); this.idle(); this.changed(); }
  private idle() { if (this.listener && ![...this.flows.values()].some(flow => flow.kind === 'browser' && flow.state === 'waiting')) { this.listener.server.close(); this.listener = undefined; } }
  private flowDto(flow: Flow) { return { id: flow.id, accountId: flow.accountId, kind: flow.kind, state: flow.state, expires: flow.expires, ...(flow.message ? { message: flow.message } : {}), ...(flow.merged ? { merged: flow.merged } : {}), ...(flow.userCode ? { userCode: flow.userCode, address: flow.address, ...(flow.complete ? { complete: flow.complete } : {}) } : {}), ...(flow.url ? { url: flow.url } : {}) }; }
  flow(id: unknown) { const flow = this.flows.get(String(id)); if (!flow) throw new Error('This sign-in is no longer waiting'); return this.flowDto(flow); }
  cancel(id: unknown) { const flow = this.flows.get(String(id)); if (flow) this.end(flow); return true; }
  /**
   * Starts a sign-in. A device code works from any screen, a phone's included; the browser's redirect comes back to this
   * computer. A token is one the owner made at the service, checked at once.
   */
  async signIn(p: any, device?: { id: string; name: string }) {
    const account = this.account(p.id), method = p.method as 'device' | 'browser' | 'token';
    if (!providers[account.provider].methods.includes(method)) throw new Error(`${providers[account.provider].label} does not sign in that way here`);
    if (method === 'token') {
      if (typeof p.token !== 'string' || !/^[\x21-\x7e]{10,500}$/.test(p.token.trim())) throw new Error('Paste the token on one line');
      const result = await this.finish(account, account.services, { access: p.token.trim(), obtained: Date.now() }, 'token').catch(error => { throw error instanceof AccountError && error.code === 'SIGNED_OUT' ? new Error(`${providers[account.provider].label} did not accept this token`) : error; }); return { state: 'done' as const, ...result };
    }
    if (!account.clientId) throw new Error('Enter the client ID of the app you registered first');
    if (device && method === 'browser') throw new Error(`Sign in to ${providers[account.provider].label} on the desktop: its page comes back to that computer. The phone can use the account afterwards.`);
    for (const flow of this.flows.values()) if (flow.accountId === account.id) this.end(flow);
    const client = this.client(account), wanted = scopes(account.provider, account.services), flow: Flow = { id: randomUUID(), accountId: account.id, kind: method, client, services: { ...account.services }, expires: Date.now() + accountServiceLimits.flowMs, state: 'waiting', ...(device ? { deviceId: device.id } : {}) };
    if (method === 'device') {
      const started = await this.oauth.deviceStart(account.provider, client, wanted);
      Object.assign(flow, { userCode: started.userCode, address: started.address, ...(started.complete ? { complete: started.complete } : {}), deviceCode: started.deviceCode, interval: started.interval, expires: Math.min(flow.expires, started.expires) });
      this.flows.set(flow.id, flow); this.poll(flow);
    } else {
      const port = await this.listen(), redirect = `${providers[account.provider].redirect}:${port}`, started = this.oauth.browserStart(account.provider, client, wanted, redirect);
      Object.assign(flow, { url: started.url, verifier: started.verifier, oauthState: started.state, redirect }); this.flows.set(flow.id, flow);
      flow.timer = setTimeout(() => this.fail(flow, 'The sign-in was not finished in time. Start it again.'), accountServiceLimits.flowMs); flow.timer.unref();
    }
    this.core.store.activity({ action: 'account.signin', provider: account.provider, status: 'started', ...(device ? { device: device.name } : {}) }); this.changed();
    return this.flowDto(flow);
  }
  private poll(flow: Flow) {
    flow.timer = setTimeout(async () => {
      if (!this.flows.has(flow.id) || flow.state !== 'waiting') return;
      if (Date.now() > flow.expires) return this.fail(flow, 'The code expired before the sign-in finished. Start again.');
      try {
        const account = this.account(flow.accountId), answer = await this.oauth.devicePoll(account.provider, flow.client, flow.deviceCode!);
        if (!this.flows.has(flow.id)) return;
        if (answer.state === 'done') await this.complete(flow, answer.tokens, 'device');
        else { if (answer.state === 'slower') flow.interval = Math.min(60, (flow.interval || 5) + 5); this.poll(flow); }
      } catch (error: any) {
        // The network may come back; a refusal ends it.
        if (error instanceof AccountError && error.code === 'UNREACHABLE') { if (this.flows.has(flow.id)) this.poll(flow); } else this.fail(flow, String(error?.message || error).slice(0, 300));
      }
    }, (flow.interval || 5) * 1000); flow.timer.unref();
  }
  private fail(flow: Flow, message: string) { if (flow.timer) clearTimeout(flow.timer); delete flow.timer; delete flow.deviceCode; delete flow.verifier; flow.state = 'failed'; flow.message = message; this.forgetLater(flow); this.idle(); this.changed(); }
  private forgetLater(flow: Flow) { const timer = setTimeout(() => { this.flows.delete(flow.id); if (!this.core.closed) this.changed(); }, 120_000); timer.unref(); flow.timer = timer; }
  private async listen() {
    if (!this.listener) {
      const server = createServer((request, response) => void this.callback(request.url || '', response));
      const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)); });
      server.unref(); this.listener = { server, port };
    }
    return this.listener.port;
  }
  private async callback(path: string, response: import('node:http').ServerResponse) {
    const url = new URL(path, 'http://127.0.0.1'), page = (status: number, text: string) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); response.end(`<!doctype html><title>PAL</title><p>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`); };
    const state = url.searchParams.get('state') || '', flow = state ? [...this.flows.values()].find(item => item.state === 'waiting' && item.oauthState && same(item.oauthState, state)) : undefined;
    if (!flow) return page(404, 'This sign-in is no longer waiting. Start it again in PAL.');
    delete flow.oauthState;
    try {
      const refused = url.searchParams.get('error'), code = url.searchParams.get('code');
      if (refused || !code) throw new Error(refused === 'access_denied' ? 'The sign-in was declined.' : 'The sign-in was not completed.');
      const account = this.account(flow.accountId), tokens = await this.oauth.exchange(account.provider, flow.client, { code, verifier: flow.verifier!, redirect: flow.redirect! });
      await this.complete(flow, tokens, 'browser'); page(200, 'Signed in. You can close this tab and return to PAL.');
    } catch (error: any) { const message = String(error?.message || error).slice(0, 300); this.fail(flow, message); page(400, message); }
  }
  private async complete(flow: Flow, tokens: AccountTokens, method: 'device' | 'browser') {
    const account = this.account(flow.accountId), result = await this.finish(account, flow.services, tokens, method, flow.client);
    if (flow.timer) clearTimeout(flow.timer); delete flow.timer; delete flow.deviceCode; delete flow.verifier; flow.state = 'done'; if (result.merged) flow.merged = result.account.id; flow.message = `Signed in as ${result.account.login}`; this.forgetLater(flow); this.idle(); this.changed();
  }
  /** Who signed in decides where the sign-in goes: the same identity is never connected twice, and an account never changes its identity. */
  private async finish(account: Account, granted: Account['services'], tokens: AccountTokens, method: Account['method'], client?: OAuthClient) {
    const identity = await this.identity(account, tokens);
    if (account.subject && account.subject !== identity.subject) throw new Error(`You signed in as ${identity.login}, but this account is ${account.login}. Add another account for ${identity.login}.`);
    const other = this.rows().find(item => item.id !== account.id && item.provider === account.provider && (item.host || '') === (account.host || '') && item.subject === identity.subject), target = other || this.account(account.id);
    if (JSON.stringify(tokens).length > 8000) throw new Error('The service returned a credential too large for PAL’s secret store');
    this.secrets.set(target.id, 'TOKENS', JSON.stringify(tokens));
    if (other && client) { this.secrets.set(target.id, 'CLIENT_SECRET', client.clientSecret || ''); target.clientId = client.clientId; }
    const { problem: _problem, ...rest } = target;
    const saved = this.put({ ...rest, ...(other ? { services: merge(other.services, granted) } : {}), granted: { ...granted }, subject: identity.subject, login: identity.login, method, signedInAt: Date.now() });
    if (other) { this.secrets.set(account.id, 'CLIENT_SECRET', ''); this.core.store.db.prepare('DELETE FROM accounts WHERE id=?').run(account.id); this.changed(); }
    this.core.store.activity({ action: 'account.signin', provider: account.provider, status: 'completed' });
    return { account: this.dto(saved), ...(other ? { merged: true } : {}) };
  }
  private http(account: Pick<Account, 'provider' | 'host' | 'tenant'>) {
    const at = this.oauth.resolve(account.provider, account);
    return new AccountHttp([...new Set(account.provider === 'google' ? Object.values(this.origins.google) : account.provider === 'microsoft' ? [this.origins.graph] : at.api.map(item => new URL(item).origin))], { ...(this.transport ? { transport: this.transport } : {}), private: this.private || !!account.host });
  }
  private identity(account: Account, tokens: AccountTokens, signal?: AbortSignal): Promise<Identity> {
    const credentials: Credentials = { http: this.http(account), token: async () => tokens.access };
    return account.provider === 'github' ? new GitHub(credentials, this.oauth.resolve('github', account).api[0]).identity(signal) : account.provider === 'google' ? googleIdentity(credentials, this.origins.google, signal) : microsoftIdentity(credentials, this.origins.graph, signal);
  }
  /** The token for one request, refreshed shortly before it expires; one refresh serves every request that waits. */
  private async token(id: string, signal?: AbortSignal): Promise<string> {
    const tokens = this.tokens(id); if (!tokens) throw new AccountError('Sign in to this account first.', { code: 'SIGNED_OUT' });
    if (!tokens.expires || tokens.expires - 60_000 > Date.now()) return tokens.access;
    const running = this.refreshing.get(id); if (running) return running;
    const task = (async () => {
      const account = this.account(id);
      try { const next = await this.oauth.refresh(account.provider, this.client(account), tokens, signal); if (this.tokens(id)?.access === tokens.access) this.secrets.set(id, 'TOKENS', JSON.stringify(next)); return next.access; }
      catch (error: any) { if (error instanceof AccountError && error.code === 'SIGNED_OUT') { const current = this.account(id); this.put({ ...current, problem: error.message }); } throw error; }
    })().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task); return task;
  }
  credentials(account: Account): Credentials { return { http: this.http(account), token: signal => this.token(account.id, signal) }; }
  async test(id: unknown) {
    const account = this.account(id), tokens = this.tokens(account.id); if (!tokens) throw new Error('Sign in to this account first');
    await this.token(account.id); const identity = await this.identity(account, this.tokens(account.id)!);
    if (identity.subject !== account.subject) throw new Error('The service names another person for this sign-in. Sign out and in again.');
    const { problem: _problem, ...rest } = account; if (account.problem) this.put(rest as Account);
    return { login: identity.login, works: true };
  }

  // ---------- services ----------
  private use(id: unknown, service: AccountService, need: ServiceAccess): Account {
    const account = this.account(id), access = this.access(account, service);
    if (!access) throw new AccountError(this.tokens(account.id) ? `${account.label} is not set up for ${serviceNames[service]}` : `Sign in to ${account.label} first`, { code: 'SIGNED_OUT' });
    if (rank[access] < rank[need]) throw new AccountError(`${account.label} may only read ${serviceNames[service]}. Allow changes in its settings and sign in again.`, { code: 'FORBIDDEN' });
    return account;
  }
  github(account: Account) { return new GitHub(this.credentials(account), this.oauth.resolve('github', account).api[0]); }
  calendar(account: Account): CalendarAdapter { const credentials = this.credentials(account); return account.provider === 'google' ? googleCalendar(credentials, this.origins.google) : microsoftCalendar(credentials, this.origins.graph); }
  mail(account: Account): MailAdapter { const credentials = this.credentials(account); return account.provider === 'google' ? googleMail(credentials, this.origins.google) : microsoftMail(credentials, this.origins.graph); }
  drive(account: Account): DriveAdapter { const credentials = this.credentials(account); return account.provider === 'google' ? googleDrive(credentials, this.origins.google) : microsoftDrive(credentials, this.origins.graph); }
  private range(p: any) {
    const from = typeof p.from === 'number' ? p.from : Date.now(), to = typeof p.to === 'number' ? p.to : from + 7 * day;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > accountServiceLimits.agendaDays * day) throw new Error(`Look at up to ${accountServiceLimits.agendaDays} days at once`);
    return { from, to };
  }
  private words(value: unknown, what = 'what to look for', max = 500) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Say ${what} (up to ${max} characters)`); return value.trim(); }
  private itemId(value: unknown) { if (typeof value !== 'string' || !value || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('Choose an item'); return value; }

  /** What a person asks on a screen. The desktop and a phone with full access use the same calls. */
  async rpc(method: string, p: any, device?: { id: string; name: string }): Promise<unknown> {
    const limit = Math.max(1, Math.min(accountServiceLimits.results, Number(p?.limit) || 20));
    switch (method) {
      case 'list': return this.list();
      case 'save': return this.save(p);
      case 'remove': return this.remove(p.id);
      case 'signIn': return this.signIn(p, device);
      case 'signOut': return this.signOut(p.id);
      case 'flow': return this.flow(p.id);
      case 'cancel': return this.cancel(p.id);
      case 'test': return this.test(p.id);
      case 'calendars': return { calendars: await this.calendar(this.use(p.accountId, 'calendar', 'read')).calendars() };
      case 'agenda': { const account = this.use(p.accountId, 'calendar', 'read'), range = this.range(p); return { ...range, events: await this.calendar(account).agenda({ ...(p.calendarId ? { calendarId: this.itemId(p.calendarId) } : {}), ...range, limit: 250 }) }; }
      case 'event': return this.calendar(this.use(p.accountId, 'calendar', 'read')).event(this.itemId(p.calendarId), this.itemId(p.eventId));
      case 'mailSearch': return { threads: await this.mail(this.use(p.accountId, 'mail', 'read')).search(typeof p.query === 'string' ? p.query.slice(0, 500) : '', limit) };
      case 'mailThread': return { messages: await this.mail(this.use(p.accountId, 'mail', 'read')).thread(this.itemId(p.threadId)) };
      case 'driveSearch': return { items: await this.drive(this.use(p.accountId, 'drive', 'read')).search(this.words(p.query), limit) };
      case 'driveList': return { items: await this.drive(this.use(p.accountId, 'drive', 'read')).list(p.folderId ? this.itemId(p.folderId) : undefined, 50) };
      case 'githubSearch': return this.github(this.use(p.accountId, 'github', 'read')).search(z.enum(['repositories', 'code', 'issues', 'pulls']).parse(p.kind), this.words(p.query), limit);
      case 'githubRead': { const { data: _data, ...value } = await this.githubRead(this.use(p.accountId, 'github', 'read'), p) as any; return value; }
      case 'import': return this.import(p);
      case 'outbox': return { writes: this.outbox.list({ limit: 100 }).map(write => this.writeDto(write)) };
      case 'draft': return this.writeDto(await this.prepare(p, { origin: 'person', ...(p.sessionId ? { sessionId: this.core.store.session(p.sessionId).id } : {}) }));
      case 'commit': return this.writeDto(await this.outbox.commit(this.itemId(p.id), String(p.digest || '')));
      case 'check': return this.writeDto(await this.outbox.check(this.itemId(p.id)));
      case 'discard': return this.writeDto(this.outbox.discard(this.itemId(p.id)));
      default: throw new Error('Unknown account request');
    }
  }
  writeDto(write: AccountWrite) { const { payload, subject: _subject, ...rest } = write; return { ...rest, kind: payload.kind === 'github' ? payload.write.kind : payload.kind, editable: ['draft', 'failed'].includes(write.state) && ['mail.send', 'mail.draft', 'calendar.create'].includes(payload.kind), ...(payload.kind === 'mail.send' || payload.kind === 'mail.draft' ? { mail: payload.mail } : payload.kind === 'calendar.create' ? { event: payload.event, calendarId: payload.calendarId } : {}) }; }
  githubRead(account: Account, p: any, signal?: AbortSignal): Promise<unknown> {
    const github = this.github(account);
    switch (p.what) {
      case 'repository': return github.repo(p.repo, signal);
      case 'file': return github.contents(p.repo, typeof p.path === 'string' ? p.path : '', p.ref, signal);
      case 'issue': return github.issue(p.repo, p.number, signal);
      case 'pull': return github.pull(p.repo, p.number, signal);
      case 'releases': return github.releases(p.repo, signal).then(releases => ({ releases }));
      case 'compare': return github.compare(p.repo, p.base, p.head, signal);
      default: throw new Error('Choose what to read on GitHub');
    }
  }
  /** A file, message or issue kept as a file of this conversation, with where it came from and who may read it. */
  async import(p: any, signal?: AbortSignal) {
    const session = this.core.store.session(p.sessionId); if (session.temporary) throw new Error('Temporary conversations do not keep files');
    const service: AccountService = p.what === 'drive' ? 'drive' : p.what === 'mail' || p.what === 'attachment' ? 'mail' : p.what === 'github' ? 'github' : (() => { throw new Error('Choose what to keep'); })();
    const account = this.use(p.accountId, service, 'read');
    let bytes: Buffer, name: string, mime: string | undefined, item: Record<string, unknown>;
    if (service === 'drive') { const file = await this.drive(account).item(this.itemId(p.fileId), signal), got = await this.drive(account).download(file, signal); bytes = got.bytes; name = got.name; mime = got.mime; item = { id: file.id, revision: file.revision, ...(file.link ? { link: file.link } : {}) }; }
    else if (p.what === 'mail') { const messages = await this.mail(account).thread(this.itemId(p.threadId), signal); if (!messages.length) throw new Error('This conversation has no messages'); bytes = Buffer.from(mailText(messages)); name = safeName(messages[0].subject, 'Mail') + '.md'; mime = 'text/markdown'; item = { thread: p.threadId, messages: messages.length }; }
    else if (p.what === 'attachment') { bytes = await this.mail(account).attachment(this.itemId(p.messageId), this.itemId(p.attachmentId), signal); name = safeName(p.name, 'attachment'); item = { message: p.messageId }; }
    else if (p.github?.what === 'file') { const file: any = await this.githubRead(account, p.github, signal); if (!file.data) throw new Error('Choose a file, not a folder'); bytes = file.data; name = safeName(String(file.path).split('/').pop(), 'file'); item = { repo: file.repo, path: file.path, sha: file.sha, link: file.link }; }
    else { const value: any = await this.githubRead(account, { ...p.github }, signal); bytes = Buffer.from(githubText(value)); name = safeName(`${value.repo || 'github'} ${value.number ? '#' + value.number : p.github?.what}`, 'GitHub') + '.md'; mime = 'text/markdown'; item = { repo: value.repo, ...(value.number ? { number: value.number } : {}), ...(value.link ? { link: value.link } : {}), ...(value.revision ? { revision: value.revision } : {}) }; }
    const version = await this.core.workbench.artifacts.install({ sessionId: session.id, bytes, name, ...(mime ? { mime } : {}), source: 'user-import', policy: account.destinations, label: 'account', provenance: { kind: 'account', provider: account.provider, account: account.label, service, ...item } });
    this.core.store.activity({ action: 'account.import', sessionId: session.id, provider: account.provider, service, status: 'completed' });
    return { artifactId: version.artifactId, versionId: version.versionId, name: version.name, mime: version.mime, bytes: version.bytes };
  }

  // ---------- writes ----------
  private async payload(account: Account, p: any, sessionId?: string): Promise<{ service: AccountService; title: string; description: string; payload: WritePayload }> {
    const who = `${providers[account.provider].label} · ${account.login || account.label}`;
    switch (p.kind) {
      case 'calendar.create': case 'calendar.update': {
        const event = validEvent(p.event), calendarId = p.calendarId ? this.itemId(p.calendarId) : 'primary', update = p.kind === 'calendar.update', description = `${who}\n${update ? 'Change this event to' : 'New event'}\n\n${eventText(event)}${event.attendees?.length ? '\n\nThe service sends invitations to the guests.' : ''}`;
        return { service: 'calendar', title: `${update ? 'Change' : 'Add'} the event “${event.title}”`, description, payload: update ? { kind: p.kind, calendarId, eventId: this.itemId(p.eventId), event, revision: this.itemId(p.revision) } : { kind: p.kind, calendarId, event } };
      }
      case 'calendar.remove': { const event = await this.calendar(account).event(this.itemId(p.calendarId || 'primary'), this.itemId(p.eventId)); if (p.revision && event.revision !== p.revision) throw remoteError('REVISION_CONFLICT', 'This event changed. Open it again.'); const when = timeText(event.start); return { service: 'calendar', title: `Delete the event “${event.title}”`, description: `${who}\nDelete: ${event.title}\n${when}${event.attendees.length ? `\n${event.attendees.length} guests are told by the service.` : ''}`, payload: { kind: p.kind, calendarId: p.calendarId || 'primary', eventId: event.id, revision: event.revision, title: event.title, when } }; }
      case 'mail.send': case 'mail.draft': {
        const mail = validMail(p.mail); if (p.kind === 'mail.send' && !mail.to.length && !mail.cc.length && !mail.bcc.length) throw new Error('Name at least one recipient');
        return { service: 'mail', title: p.kind === 'mail.send' ? `Send “${mail.subject || '(no subject)'}” to ${mail.to[0] || mail.cc[0] || mail.bcc[0]}${mail.to.length + mail.cc.length + mail.bcc.length > 1 ? ` and ${mail.to.length + mail.cc.length + mail.bcc.length - 1} more` : ''}` : `Save the draft “${mail.subject || '(no subject)'}”`, description: `${who}${p.kind === 'mail.draft' ? '\nSaved in Drafts, not sent' : ''}\nTo: ${mail.to.join(', ') || '—'}${mail.cc.length ? `\nCc: ${mail.cc.join(', ')}` : ''}${mail.bcc.length ? `\nBcc: ${mail.bcc.join(', ')}` : ''}\nSubject: ${mail.subject || '(no subject)'}${mail.reply ? '\nA reply in an existing conversation' : ''}\n\n${mail.text}`, payload: { kind: p.kind, mail } };
      }
      case 'drive.create': case 'drive.update': {
        if (!sessionId) throw new Error('Choose the conversation the file is in');
        const version = this.core.workbench.artifacts.version(sessionId, p.artifactId, p.versionId), file = { artifactId: version.artifactId, versionId: version.versionId, sha256: version.sha256, bytes: version.bytes, mime: version.mime, ownerSessionId: sessionId };
        if (p.kind === 'drive.create') { const name = safeName(p.name || version.name, 'file'); return { service: 'drive', title: `Upload ${name}`, description: `${who}\nNew file: ${name}\n${version.bytes.toLocaleString('en')} bytes, ${version.mime}\nFrom: ${version.name}`, payload: { kind: p.kind, ...(p.folderId ? { folderId: this.itemId(p.folderId) } : {}), name, ...file } }; }
        const target = await this.drive(account).item(this.itemId(p.fileId)); if (!target.canEdit) throw new Error(`${target.name} cannot be changed from here`); if (p.revision && target.revision !== p.revision) throw remoteError('REVISION_CONFLICT', 'This file changed. Open it again.');
        return { service: 'drive', title: `Write a new version of ${target.name}`, description: `${who}\nNew version of: ${target.name}\n${version.bytes.toLocaleString('en')} bytes, ${version.mime}\nFrom: ${version.name}`, payload: { kind: p.kind, fileId: target.id, name: target.name, revision: target.revision, ...file } };
      }
      case 'github': { const write = validWrite(p.write); return { service: 'github', title: describeWrite(write).split('\n')[0], description: `${who}\n${describeWrite(write)}`, payload: { kind: 'github', write } }; }
      default: throw new Error('Choose what to write');
    }
  }
  /** A draft: checked and described, and not sent. */
  async prepare(p: any, by: { origin: AccountWrite['origin']; sessionId?: string }): Promise<AccountWrite> {
    const account = this.account(p.accountId), content = await this.payload(account, p, by.sessionId);
    this.use(account.id, content.service, 'write');
    if (p.id) { const before = this.outbox.get(p.id); if (before.accountId !== account.id || before.payload.kind !== content.payload.kind) throw new Error('This draft is for something else'); return this.outbox.revise(before.id, String(p.digest || ''), content); }
    return this.outbox.create({ accountId: account.id, subject: account.subject!, login: account.login || account.label, provider: account.provider, ...content, origin: by.origin, ...(by.sessionId ? { sessionId: by.sessionId } : {}) });
  }
  /** A write goes only to the identity it was prepared for, with the access it needs, as it is now. */
  private writable(write: AccountWrite) { const account = this.use(write.accountId, write.service, 'write'); if (account.subject !== write.subject) throw new Error('This was prepared for another sign-in. Prepare it again.'); return account; }
  private async perform(write: AccountWrite, context: WriteContext): Promise<Written> {
    const account = this.writable(write), p = write.payload;
    const bytes = async (file: { ownerSessionId: string; artifactId: string; versionId: string; sha256: string }) => { const { version, data } = await this.core.workbench.artifacts.bytes(file.ownerSessionId, file.artifactId, file.versionId); if (version.sha256 !== file.sha256) throw new Error('This file is no longer what was reviewed'); return data; };
    const done = (result: Written) => { this.core.store.activity({ action: 'account.write', provider: account.provider, kind: p.kind === 'github' ? p.write.kind : p.kind, ...(write.sessionId ? { sessionId: write.sessionId } : {}), status: 'completed', id: result.id }); return result; };
    switch (p.kind) {
      case 'calendar.create': return done(await this.calendar(account).create(p.calendarId, p.event, context));
      case 'calendar.update': return done(await this.calendar(account).update(p.calendarId, p.eventId, p.event, p.revision, context));
      case 'calendar.remove': return done(await this.calendar(account).remove(p.calendarId, p.eventId, p.revision, context));
      case 'mail.send': return done(await this.mail(account).send(p.mail, context));
      case 'mail.draft': return done(await this.mail(account).draft(p.mail, context));
      case 'drive.create': return done(await this.drive(account).create({ ...(p.folderId ? { folderId: p.folderId } : {}), name: p.name, mime: p.mime, bytes: await bytes(p) }, context).catch(error => { throw error instanceof AccountError && error.status === 409 ? new AccountError(`A file named ${p.name} is already there`, { status: 409, code: 'REFUSED' }) : error; }));
      case 'drive.update': return done(await this.drive(account).update(p.fileId, { mime: p.mime, bytes: await bytes(p), revision: p.revision }, context));
      case 'github': return done(await this.github(account).write(p.write, context));
    }
  }
  private async look(write: AccountWrite, context: WriteContext): Promise<Written | undefined> {
    const account = this.writable(write), p = write.payload, gone = (error: unknown) => error instanceof AccountError && error.code === 'NOT_FOUND';
    switch (p.kind) {
      case 'calendar.create': return this.calendar(account).created(p.calendarId, context);
      case 'calendar.update': { const now = await this.calendar(account).event(p.calendarId, p.eventId, context.signal); return now.revision !== p.revision && now.title === p.event.title && JSON.stringify(now.start) === JSON.stringify(p.event.start) ? { id: now.id, revision: now.revision, ...(now.link ? { link: now.link } : {}) } : undefined; }
      case 'calendar.remove': try { const now = await this.calendar(account).event(p.calendarId, p.eventId, context.signal); return now.cancelled ? { id: p.eventId } : undefined; } catch (error) { if (gone(error)) return { id: p.eventId }; throw error; }
      case 'mail.send': return this.mail(account).sent(context);
      // A draft that was saved twice is visible and harmless; it is looked for among sent and unsent mail alike.
      case 'mail.draft': return this.mail(account).sent(context);
      case 'drive.create': return this.drive(account).created({ ...(p.folderId ? { folderId: p.folderId } : {}), name: p.name }, context);
      case 'drive.update': { const now = await this.drive(account).item(p.fileId, context.signal); return now.revision !== p.revision && now.bytes === p.bytes ? { id: now.id, revision: now.revision, ...(now.link ? { link: now.link } : {}) } : undefined; }
      case 'github': return this.github(account).written(p.write, account.login || '', context);
    }
  }

  // ---------- assistants ----------
  /** Accounts this conversation's assistant may use for a service now, and why not for the rest. */
  private allowed(session: Session, service: AccountService, need: ServiceAccess): Account[] {
    if (session.temporary || !ownerControlled(session)) return [];
    return this.rows().filter(account => { const access = this.access(account, service); return access && rank[access] >= rank[need] && account.ai !== 'off' && (need === 'read' || account.ai === 'write') && (account.projects === null || account.projects.some(project => session.cwd === project || session.cwd.startsWith(project + '/'))); });
  }
  offered(session: Session, service: AccountService, need: ServiceAccess): { accounts: Account[]; reason: string } {
    if (session.temporary || !ownerControlled(session)) return { accounts: [], reason: 'Accounts are for saved conversations of this computer’s owner' };
    const all = this.allowed(session, service, need);
    if (!all.length) return { accounts: [], reason: `No account lets assistants ${need === 'write' ? 'change' : 'read'} ${serviceNames[service]} in this project` };
    const route = this.core.workbench.knownRoute(session.id), accounts = all.filter(account => routeAllowed(route, account.destinations));
    return { accounts, reason: accounts.length ? '' : `The account does not allow this conversation’s model (${routeLabels[route]}) to read it` };
  }
  /** Whether the owner let assistants use any account here; which models may read it is decided when a tool is offered. */
  any(session: Session) { return services.some(service => this.allowed(session, service, 'read').length > 0); }
  /** The account a tool call means: the named one, or the only one. */
  pick(session: Session, service: AccountService, need: ServiceAccess, named?: string): Account {
    const { accounts, reason } = this.offered(session, service, need); if (!accounts.length) throw new AccountError(reason, { code: 'FORBIDDEN' });
    if (named) { const found = accounts.find(account => [account.label, account.login, account.id].some(value => value?.toLowerCase() === named.toLowerCase())); if (!found) throw new AccountError(`There is no account “${named}” here. Available: ${accounts.map(account => account.label).join(', ')}`, { code: 'NOT_FOUND' }); return found; }
    if (accounts.length > 1) throw new AccountError(`Name the account: ${accounts.map(account => `${account.label} (${account.login})`).join(', ')}`, { code: 'AMBIGUOUS' });
    return accounts[0];
  }
  /** Shows a person exactly what an assistant prepared. Only their answer sends it; no bypass does. */
  async review(session: Session, p: any, signal: AbortSignal): Promise<AccountWrite> {
    const write = await this.prepare(p, { origin: 'assistant', sessionId: session.id });
    if (Buffer.byteLength(write.description) > 48 * 1024) { this.outbox.discard(write.id); throw new Error('This is too long to review in one place (48 KB). Make it shorter, or prepare it as a draft.'); }
    const answer = await this.core.approval(session.id, { kind: 'account', title: `${write.title}?`, detail: write.description, choices: ['allow', 'deny'], fields: { account: write.accountId, write: write.id, digest: write.digest, reviewComplete: true } });
    if (answer.choice !== 'allow') { if (this.outbox.get(write.id).state === 'draft') this.outbox.discard(write.id); return this.outbox.get(write.id); }
    signal.throwIfAborted();
    // Offered again: what the owner changed while the question was open counts.
    if (!this.offered(this.core.store.session(session.id), write.service, 'write').accounts.some(account => account.id === write.accountId)) { this.outbox.discard(write.id); throw new Error('Access to this account changed while you were asked. Nothing was sent.'); }
    return this.outbox.commit(write.id, write.digest, signal);
  }
  /** A routine's standing destination: an account that may write now, as the person it is signed in as, to named recipients only. */
  delivery(p: any): Delivery {
    const mail = p?.target?.kind === 'mail', account = this.use(p?.accountId, mail ? 'mail' : 'github', 'write');
    if (mail) { const to = p.target.to; if (!Array.isArray(to) || !to.length || to.length > 5 || !to.every(emailAddress)) throw new Error('Name one to five email addresses for the result'); return { accountId: account.id, subject: account.subject!, login: account.login || account.label, target: { kind: 'mail', to: [...new Set<string>(to)] } }; }
    if (p?.target?.kind !== 'github' || !Number.isInteger(p.target.number) || p.target.number < 1) throw new Error('Choose where the result goes: mail, or an issue as owner/name and number');
    return { accountId: account.id, subject: account.subject!, login: account.login || account.label, target: { kind: 'github', repo: repository(p.target.repo), number: p.target.number } };
  }
  /** Sends a routine's result to the destination the owner chose with it; it is recorded like every other write. */
  async deliver(to: Delivery, p: { label: string; text: string; sessionId: string }): Promise<{ state: 'sent' | 'unknown' | 'failed'; reason?: string }> {
    try {
      const account = this.account(to.accountId); if (account.subject !== to.subject) return { state: 'failed', reason: 'The account is signed in as someone else now.' };
      const text = p.text.length > 50_000 ? p.text.slice(0, 50_000) + '\n\n[shortened]' : p.text, when = this.core.temporal.now(p.sessionId).localDate;
      const write = await this.prepare(to.target.kind === 'mail' ? { accountId: account.id, kind: 'mail.send', mail: { to: to.target.to, subject: `${p.label} · ${when}`.replace(/[\x00-\x1f]/g, ' ').slice(0, 200), text } } : { accountId: account.id, kind: 'github', write: { kind: 'comment', repo: to.target.repo, number: to.target.number, body: `**${p.label}** · ${when}\n\n${text}` } }, { origin: 'routine', sessionId: p.sessionId });
      const done = await this.outbox.commit(write.id, write.digest); return done.state === 'sent' ? { state: 'sent' } : { state: done.state === 'unknown' ? 'unknown' : 'failed', ...(done.error ? { reason: done.error } : {}) };
    } catch (error: any) { return { state: 'failed', reason: String(error?.message || error).slice(0, 300) }; }
  }
  forgetSession(sessionId: string) { this.outbox.forgetSession(sessionId); }
  /** Revoking a phone abandons the sign-ins it started. */
  deviceRevoked(deviceId: string) { for (const flow of [...this.flows.values()]) if (flow.deviceId === deviceId) this.end(flow); }
  close() { for (const flow of this.flows.values()) if (flow.timer) clearTimeout(flow.timer); this.flows.clear(); this.listener?.server.close(); this.listener = undefined; }
}
function merge(a: Account['services'], b: Account['services']) { const result: Account['services'] = { ...a }; for (const [service, value] of Object.entries(b) as [AccountService, ServiceAccess][]) if (!result[service] || rank[value] > rank[result[service]!]) result[service] = value; return result; }
export function timeText(time: EventTime) { return 'date' in time ? `${time.date} (all day)` : `${time.dateTime.slice(0, 16).replace('T', ' ')} ${time.timeZone}`; }
export function eventText(event: EventInput) { return [event.title, `Starts: ${timeText(event.start)}`, `Ends: ${timeText(event.end)}`, ...(event.recurrence ? [`Repeats: ${describeRecurrence(event.recurrence)}`] : []), ...(event.location ? [`Where: ${event.location}`] : []), ...(event.attendees?.length ? [`Guests: ${event.attendees.join(', ')}`] : []), ...(event.notes ? ['', event.notes] : [])].join('\n'); }
export function mailText(messages: MailMessage[]) { return `# ${messages[0].subject}\n\n` + messages.map(m => `## ${m.from ? `${m.from.name ? `${m.from.name} ` : ''}<${m.from.email}>` : 'Unknown sender'} · ${new Date(m.date).toISOString()}\n\nTo: ${m.to.map(a => a.email).join(', ') || '—'}${m.cc.length ? `\nCc: ${m.cc.map(a => a.email).join(', ')}` : ''}${m.attachments.length ? `\nAttachments: ${m.attachments.map(a => a.name).join(', ')}` : ''}\n\n${m.text}${m.truncated ? '\n\n[shortened]' : ''}`).join('\n\n'); }
export function githubText(value: any) {
  if (value.files && value.number) return `# ${value.repo}#${value.number} ${value.title}\n\n${value.state} · ${value.author} · ${value.head} → ${value.base}\n\n${value.body || ''}\n\n## Files\n\n${value.files.map((f: any) => `### ${f.path} (${f.status}, +${f.additions} −${f.deletions})\n\n${f.patch ? '```diff\n' + f.patch + '\n```' : ''}`).join('\n\n')}${value.reviews?.length ? `\n\n## Reviews\n\n${value.reviews.map((r: any) => `- ${r.author}: ${r.state}${r.body ? ` — ${r.body}` : ''}`).join('\n')}` : ''}`;
  if (value.number) return `# ${value.repo}#${value.number} ${value.title}\n\n${value.state} · ${value.author}${value.labels?.length ? ` · ${value.labels.join(', ')}` : ''}\n\n${value.body || ''}\n\n${(value.comments || []).map((c: any) => `## ${c.author} · ${c.at}\n\n${c.body}`).join('\n\n')}`;
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}
