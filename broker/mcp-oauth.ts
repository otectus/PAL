/**
 * OAuth sign-in for Streamable HTTP tool servers (PAL Everywhere §14.1, MCP authorization specification).
 *
 * The protocol steps use the pinned @modelcontextprotocol/sdk helpers (package.json pins the version): protected
 * resource and authorization server discovery (RFC 9728, RFC 8414), dynamic client registration (RFC 7591) or a
 * client ID the owner registered themselves, the authorization code grant with PKCE S256 (RFC 7636), the resource
 * indicator (RFC 8707) and refresh. stdio servers never use OAuth; their credentials stay environment secrets.
 *
 * Tokens stay on this computer in the owner-only secrets file and are bound to the origin they were issued for: a
 * changed server address makes them unusable until the owner signs in again. The access token reaches only that
 * origin, through the same guarded fetch as a BEARER_TOKEN secret; discovery and token requests go to the
 * authorization server, under the server's address policy, without it.
 *
 * Redirects: on the desktop, a listener on 127.0.0.1 at a remembered port (RFC 8252 §7.3). From an owner phone, the
 * app's private-use scheme (RFC 8252 §7.1); the phone returns the code over its pinned connection. PKCE keeps the
 * verifier here, so an intercepted code is useless elsewhere. Each sign-in is a flow bound to the server's definition,
 * the initiating device and a random state, for ten minutes; a reused, expired or mismatched completion is refused.
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, selectResourceURL, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { publicAddress } from './web.ts';
import { remoteError } from './execution.ts';
import type { Core } from './core.ts';
import type { ExtensionServer } from './extensions.ts';

export const oauthLimits = { flowMs: 10 * 60_000, flows: 8, refreshSkewMs: 60_000, responseBytes: 1024 * 1024 };
/** The phone's private-use redirect (RFC 8252 §7.1): the app's reverse-domain scheme. */
export const phoneRedirect = 'dev.otectus.cere.mobile:/oauth-callback';
const tokensKey = '__oauth_tokens', clientKey = '__oauth_client', portKey = 'oauth:loopback-port';

type Metadata = { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string; token_endpoint_auth_methods_supported?: string[]; [key: string]: unknown };
type StoredClient = { issuer: string; client_id: string; client_secret?: string; redirect_uris: string[]; registered: 'dynamic' | 'owner'; metadata: Metadata; resource?: string; scope?: string };
type StoredTokens = { issuer: string; origin: string; resource?: string; access_token: string; refresh_token?: string; expires_at?: number; scope?: string; obtained: number };
type Flow = { id: string; serverId: string; definition: string; state: string; verifier: string; redirectUrl: string; client: StoredClient; deviceId?: string; deviceName?: string; created: number; expires: number };

/** What identifies a server for a sign-in: its address and address policy. A change abandons flows and tokens. */
export const oauthDefinition = (server: ExtensionServer) => createHash('sha256').update(JSON.stringify([server.id, server.url || '', server.network || 'public'])).digest('base64url');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** fetch for discovery and token requests: HTTPS (or plain HTTP for a local server), under the address policy, capped. */
export function authFetch(server: ExtensionServer, resolve: (host: string) => Promise<string[]> = host => lookup(host, { all: true }).then(rows => rows.map(row => row.address))) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && server.network === 'local')) throw new Error(`The sign-in service at ${url.origin} must use HTTPS`);
    const host = url.hostname.replace(/^\[|\]$/g, ''), addresses = isIP(host) ? [host] : await resolve(host);
    if (!addresses.length) throw new Error(`${url.hostname} could not be resolved`);
    if (server.network !== 'local' && addresses.some(address => !publicAddress(address))) throw new Error(`${url.hostname} resolves to this computer or a private network; mark the server as local if that is intended`);
    const response = await fetch(url, { ...(input instanceof Request ? { method: input.method, headers: input.headers, body: input.body, duplex: 'half' } as RequestInit : {}), ...init, redirect: 'manual' });
    if (!response.body) return response;
    let seen = 0;
    const capped = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { seen += chunk.byteLength; if (seen > oauthLimits.responseBytes) controller.error(new Error('The sign-in service sent more than 1 MB')); else controller.enqueue(chunk); } }));
    return new Response(capped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class McpOAuth {
  core: Core;
  private flows = new Map<string, Flow>();
  private listener?: { server: Server; port: number };
  private refreshing = new Map<string, Promise<string | undefined>>();
  constructor(core: Core) { this.core = core; }
  private get secrets() { return this.core.extensions.secrets; }
  private server(id: unknown) {
    const server = this.core.extensions.servers().find(item => item.id === id);
    if (!server) throw new Error('This tool server no longer exists');
    if (server.transport !== 'http') throw new Error('Sign-in applies to tool servers at an address; a program keeps its credentials as secrets');
    return server;
  }
  private read<T>(serverId: string, key: string): T | undefined { try { const value = this.secrets.values(serverId)[key]; return value ? JSON.parse(value) as T : undefined; } catch { return undefined; } }
  private write(serverId: string, key: string, value: unknown) {
    const text = value === undefined ? '' : JSON.stringify(value);
    if (text.length > 8192) throw new Error('The sign-in service returned a credential too large for PAL’s secret store');
    this.secrets.set(serverId, key, text);
  }
  /** The loopback redirect, listening while a desktop sign-in waits. The port is kept so a registered client stays valid. */
  private async loopback(): Promise<string> {
    if (!this.listener) {
      const wanted = this.core.store.get<number>(portKey, 0);
      const server = createServer((request, response) => void this.callback(request.url || '', response));
      const port = await new Promise<number>((resolve, reject) => {
        const listen = (port: number) => { server.once('error', (error: any) => { if (port && error?.code === 'EADDRINUSE') listen(0); else reject(error); }); server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)); };
        listen(wanted);
      });
      server.unref();
      if (port !== wanted) this.core.store.set(portKey, port);
      this.listener = { server, port };
    }
    return `http://127.0.0.1:${this.listener.port}/oauth/callback`;
  }
  private async callback(path: string, response: import('node:http').ServerResponse) {
    const url = new URL(path, 'http://127.0.0.1'), page = (status: number, text: string) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); response.end(`<!doctype html><meta charset="utf-8"><title>PAL</title><p>${text.replace(/[<>&]/g, '')}</p>`); };
    if (url.pathname !== '/oauth/callback') return page(404, 'Not found.');
    try {
      const result = await this.complete({ state: url.searchParams.get('state') || '', code: url.searchParams.get('code') || undefined, error: url.searchParams.get('error') || undefined }, undefined, true);
      page(200, `Signed in to ${result.server}. You can close this tab and return to PAL.`);
    } catch (error: any) { page(400, String(error?.message || error).slice(0, 300)); }
    finally { this.idle(); }
  }
  private idle() { this.expire(); if (this.listener && ![...this.flows.values()].some(flow => !flow.deviceId)) { this.listener.server.close(); this.listener = undefined; } }
  private expire() { for (const [id, flow] of this.flows) if (flow.expires < Date.now()) this.flows.delete(id); }
  /** The client PAL uses with this authorization server: registered for both redirects where the service accepts that. */
  private async client(server: ExtensionServer, issuer: string, metadata: Metadata, redirectUrl: string, resource: string | undefined, scope: string | undefined, owned?: { clientId: string; clientSecret?: string }) {
    const fetchFn = authFetch(server);
    if (owned) {
      const client: StoredClient = { issuer, client_id: owned.clientId, ...(owned.clientSecret ? { client_secret: owned.clientSecret } : {}), redirect_uris: [redirectUrl, phoneRedirect], registered: 'owner', metadata, ...(resource ? { resource } : {}), ...(scope ? { scope } : {}) };
      this.write(server.id, clientKey, client); return client;
    }
    const stored = this.read<StoredClient>(server.id, clientKey);
    if (stored && stored.issuer === issuer && (stored.registered === 'owner' || stored.redirect_uris.includes(redirectUrl))) { const client = { ...stored, metadata, ...(resource ? { resource } : {}), ...(scope ? { scope } : {}) }; this.write(server.id, clientKey, client); return client; }
    if (!metadata.registration_endpoint) throw new Error(`${server.name}'s sign-in service does not let PAL register itself. Register an OAuth app there with the redirect addresses PAL shows, then enter its client ID.`);
    const register = (uris: string[]) => registerClient(issuer, { metadata: metadata as any, clientMetadata: { client_name: 'PAL', redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } as any, ...(scope ? { scope } : {}), fetchFn: fetchFn as any });
    // A service that refuses the phone's private-use redirect still gets a desktop-only registration.
    const registered: any = await register([redirectUrl, phoneRedirect]).catch(() => register([redirectUrl]));
    const client: StoredClient = { issuer, client_id: registered.client_id, ...(registered.client_secret ? { client_secret: registered.client_secret } : {}), redirect_uris: registered.redirect_uris || [redirectUrl], registered: 'dynamic', metadata, ...(resource ? { resource } : {}), ...(scope ? { scope } : {}) };
    this.write(server.id, clientKey, client); return client;
  }
  /**
   * Starts a sign-in. Without a device it is the desktop's (loopback redirect, the desktop opens the page); with one it
   * belongs to that owner phone (its private-use redirect); only that phone can complete it.
   */
  async start(p: { id: string; clientId?: string; clientSecret?: string }, device?: { id: string; name: string }) {
    const server = this.server(p.id);
    if (!server.enabled) throw new Error('Turn the tool server on first');
    if (p.clientId !== undefined && (typeof p.clientId !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(p.clientId))) throw new Error('Enter the client ID the service gave you');
    if (p.clientSecret !== undefined && (typeof p.clientSecret !== 'string' || p.clientSecret.length > 1000 || /[\x00-\x1f]/.test(p.clientSecret))) throw new Error('Enter the client secret on one line');
    this.expire();
    if (this.flows.size >= oauthLimits.flows) throw new Error('Too many sign-ins are waiting. Finish or let one expire first.');
    const fetchFn = authFetch(server);
    let info: any;
    try { info = await discoverOAuthServerInfo(server.url!, { fetchFn: fetchFn as any }); }
    catch (error: any) { throw new Error(`${server.name} did not describe a sign-in service: ${String(error?.message || error).slice(0, 200)}`); }
    const issuer = String(info.authorizationServerUrl), metadata = (info.authorizationServerMetadata || {}) as Metadata;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error(`${server.name}'s sign-in service is missing its authorization or token address`);
    const selected = await selectResourceURL(server.url!, {} as any, info.resourceMetadata);
    const resource = selected && info.resourceMetadata ? String(info.resourceMetadata.resource) : selected ? selected.href : undefined;
    const scope = info.resourceMetadata?.scopes_supported?.join(' ') || undefined;
    const redirectUrl = device ? phoneRedirect : await this.loopback();
    const client = await this.client(server, issuer, metadata, redirectUrl, resource, scope, p.clientId ? { clientId: p.clientId, ...(p.clientSecret ? { clientSecret: p.clientSecret } : {}) } : undefined);
    if (!client.redirect_uris.includes(redirectUrl)) throw new Error(`${server.name}'s sign-in service did not accept PAL's phone redirect. Sign in on the desktop; the phone can use the connection afterwards.`);
    const state = randomBytes(32).toString('base64url');
    const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata: metadata as any, clientInformation: client as any, redirectUrl, state, ...(scope ? { scope } : {}), ...(resource ? { resource: new URL(resource) } : {}) });
    const flow: Flow = { id: randomUUID(), serverId: server.id, definition: oauthDefinition(server), state, verifier: codeVerifier, redirectUrl, client, ...(device ? { deviceId: device.id, deviceName: device.name } : {}), created: Date.now(), expires: Date.now() + oauthLimits.flowMs };
    this.flows.set(flow.id, flow);
    this.core.store.activity({ action: 'extension.signin', server: server.name, status: 'started', ...(device ? { device: device.name } : {}) });
    return { flowId: flow.id, server: server.name, authorizationUrl: authorizationUrl.href, redirectUrl, expiresAt: flow.expires, registered: client.registered };
  }
  /** Completes a sign-in from the redirect: the state finds the flow once; device, expiry and definition must still match. */
  async complete(p: { state: string; code?: string; error?: string }, deviceId?: string, loopback = false) {
    this.expire();
    const flow = typeof p.state === 'string' && p.state ? [...this.flows.values()].find(item => same(item.state, p.state)) : undefined;
    if (!flow) throw remoteError('INVALID_ARGUMENT', 'This sign-in is no longer waiting. Start it again.');
    // A completion from another device is refused without ending the sign-in its own device is finishing.
    if ((flow.deviceId || undefined) !== (deviceId || undefined) || (loopback && flow.deviceId)) throw remoteError('SCOPE_DENIED', 'This sign-in was started on another device. Start it again here.');
    this.flows.delete(flow.id);
    if (p.error) throw remoteError('INVALID_ARGUMENT', `The sign-in was not completed (${String(p.error).replace(/[^\w.-]/g, '').slice(0, 60)}).`);
    if (typeof p.code !== 'string' || !p.code || p.code.length > 4096) throw remoteError('INVALID_ARGUMENT', 'The sign-in returned no code. Start it again.');
    const server = this.core.extensions.servers().find(item => item.id === flow.serverId);
    if (!server || server.transport !== 'http' || oauthDefinition(server) !== flow.definition) throw remoteError('REVISION_CONFLICT', 'The tool server changed while you were signing in. Sign in again.');
    const tokens: any = await exchangeAuthorization(flow.client.issuer, { metadata: flow.client.metadata as any, clientInformation: flow.client as any, authorizationCode: p.code, codeVerifier: flow.verifier, redirectUri: flow.redirectUrl,
      ...(flow.client.resource ? { resource: new URL(flow.client.resource) } : {}), fetchFn: authFetch(server) as any })
      .catch((error: any) => { throw remoteError('INVALID_ARGUMENT', `${server.name}'s sign-in service refused the code: ${String(error?.message || error).replace(/[\x00-\x1f]/g, ' ').slice(0, 200)}`); });
    this.save(server, flow.client, tokens);
    this.core.extensions.credentialsChanged(server.id);
    this.core.store.activity({ action: 'extension.signin', server: server.name, status: 'completed', ...(flow.deviceName ? { device: flow.deviceName } : {}) });
    return { serverId: server.id, server: server.name, signedIn: true, ...(tokens.scope ? { scope: String(tokens.scope).slice(0, 500) } : {}) };
  }
  private save(server: ExtensionServer, client: StoredClient, tokens: any) {
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token) throw new Error('The sign-in service returned no access token');
    const stored: StoredTokens = { issuer: client.issuer, origin: new URL(server.url!).origin, ...(client.resource ? { resource: client.resource } : {}), access_token: tokens.access_token,
      ...(typeof tokens.refresh_token === 'string' ? { refresh_token: tokens.refresh_token } : {}), ...(Number.isFinite(tokens.expires_in) ? { expires_at: Date.now() + Number(tokens.expires_in) * 1000 } : {}),
      ...(typeof tokens.scope === 'string' ? { scope: tokens.scope.slice(0, 500) } : {}), obtained: Date.now() };
    this.write(server.id, tokensKey, stored);
  }
  /** The access token for this server's current address, refreshed when it is about to expire; undefined when signed out. */
  async token(server: ExtensionServer): Promise<string | undefined> {
    if (server.transport !== 'http' || !server.url) return undefined;
    const stored = this.read<StoredTokens>(server.id, tokensKey);
    if (!stored || stored.origin !== new URL(server.url).origin) return undefined;
    if (!stored.expires_at || stored.expires_at - oauthLimits.refreshSkewMs > Date.now() || !stored.refresh_token) return stored.access_token;
    const running = this.refreshing.get(server.id);
    if (running) return running;
    const refresh = (async () => {
      const client = this.read<StoredClient>(server.id, clientKey);
      if (!client || client.issuer !== stored.issuer) return stored.access_token;
      try {
        const tokens: any = await refreshAuthorization(client.issuer, { metadata: client.metadata as any, clientInformation: client as any, refreshToken: stored.refresh_token!, ...(client.resource ? { resource: new URL(client.resource) } : {}), fetchFn: authFetch(server) as any });
        this.save(server, client, { refresh_token: stored.refresh_token, ...tokens });
        return tokens.access_token as string;
      } catch { return stored.access_token; }
    })().finally(() => this.refreshing.delete(server.id));
    this.refreshing.set(server.id, refresh);
    return refresh;
  }
  /** Signs out: forgets tokens (and a dynamically registered client) for this server. */
  signOut(id: unknown) {
    const server = this.server(id);
    this.write(server.id, tokensKey, undefined);
    if (this.read<StoredClient>(server.id, clientKey)?.registered === 'dynamic') this.write(server.id, clientKey, undefined);
    for (const [flowId, flow] of this.flows) if (flow.serverId === server.id) this.flows.delete(flowId);
    this.core.extensions.credentialsChanged(server.id);
    this.core.store.activity({ action: 'extension.signout', server: server.name, status: 'completed' });
    return this.status(server);
  }
  /** Sign-in state for display: never a token. */
  status(server: ExtensionServer) {
    if (server.transport !== 'http' || !server.url) return undefined;
    const stored = this.read<StoredTokens>(server.id, tokensKey), client = this.read<StoredClient>(server.id, clientKey);
    const current = !!stored && stored.origin === new URL(server.url).origin;
    return { signedIn: current, ...(stored && !current ? { stale: 'The address changed since you signed in. Sign in again.' } : {}), ...(current ? { issuer: stored!.issuer, ...(stored!.scope ? { scope: stored!.scope } : {}), ...(stored!.expires_at ? { expiresAt: stored!.expires_at } : {}), refreshable: !!stored!.refresh_token } : {}),
      ...(client ? { client: client.registered } : {}), waiting: [...this.flows.values()].filter(flow => flow.serverId === server.id && flow.expires > Date.now()).length,
      redirects: { desktop: this.listener ? `http://127.0.0.1:${this.listener.port}/oauth/callback` : (this.core.store.get<number>(portKey, 0) ? `http://127.0.0.1:${this.core.store.get<number>(portKey, 0)}/oauth/callback` : null), phone: phoneRedirect } };
  }
  /** Revoking a phone abandons the sign-ins it started. */
  deviceRevoked(deviceId: string) { for (const [id, flow] of this.flows) if (flow.deviceId === deviceId) this.flows.delete(id); }
  close() { this.flows.clear(); this.listener?.server.close(); this.listener = undefined; }
}
