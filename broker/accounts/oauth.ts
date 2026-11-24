/**
 * Signing in to an account with an app the owner registered (PAL Everywhere §14.1): the device authorization grant
 * (RFC 8628) where the service offers it, so it works from a phone too, and otherwise the browser with PKCE and a
 * redirect to this computer. Tokens stay here. PAL ships no client ID of its own.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AccountError, AccountHttp, type Transport } from './http.ts';

export type AccountProvider = 'github' | 'google' | 'microsoft';
export type AccountService = 'github' | 'calendar' | 'mail' | 'drive';
export type ServiceAccess = 'read' | 'write';
export type OAuthClient = { clientId: string; clientSecret?: string; tenant?: string; host?: string };
export type AccountTokens = { access: string; refresh?: string; expires?: number; scope?: string; obtained: number };
export type ProviderEndpoints = { authorize?: string; token: string; device?: string; revoke?: string; api: string[] };
export const providers: Record<AccountProvider, { label: string; services: AccountService[]; methods: ('device' | 'browser' | 'token')[]; register: string; redirect: string }> = {
  github: { label: 'GitHub', services: ['github'], methods: ['device', 'token'], register: 'https://github.com/settings/applications/new', redirect: '' },
  google: { label: 'Google', services: ['calendar', 'mail', 'drive'], methods: ['browser'], register: 'https://console.cloud.google.com/auth/clients', redirect: 'http://127.0.0.1' },
  microsoft: { label: 'Microsoft', services: ['calendar', 'mail', 'drive'], methods: ['device', 'browser'], register: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', redirect: 'http://localhost' },
};
/** Fixed addresses; only a GitHub Enterprise host and a Microsoft tenant are the owner's to choose. Tests replace them. */
export function endpoints(provider: AccountProvider, client: Pick<OAuthClient, 'tenant' | 'host'> = {}): ProviderEndpoints {
  if (provider === 'github') {
    const web = `https://${client.host || 'github.com'}`, api = client.host ? `https://${client.host}/api/v3` : 'https://api.github.com';
    return { device: `${web}/login/device/code`, token: `${web}/login/oauth/access_token`, api: [api] };
  }
  if (provider === 'google') return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke', api: ['https://www.googleapis.com', 'https://gmail.googleapis.com', 'https://openidconnect.googleapis.com'] };
  const base = `https://login.microsoftonline.com/${encodeURIComponent(client.tenant || 'common')}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, device: `${base}/devicecode`, token: `${base}/token`, api: ['https://graph.microsoft.com'] };
}
/** The least a chosen use needs. Reading asks for reading only. */
export function scopes(provider: AccountProvider, services: Partial<Record<AccountService, ServiceAccess>>): string[] {
  // GitHub's apps have no read-only access to private repositories: reading asks for public ones only. A fine-grained token can be narrower.
  if (provider === 'github') return services.github === 'write' ? ['repo', 'read:user'] : ['read:user'];
  if (provider === 'google') return ['openid', 'email',
    ...(services.calendar ? ['https://www.googleapis.com/auth/calendar.readonly', ...(services.calendar === 'write' ? ['https://www.googleapis.com/auth/calendar.events'] : [])] : []),
    ...(services.mail ? ['https://www.googleapis.com/auth/gmail.readonly', ...(services.mail === 'write' ? ['https://www.googleapis.com/auth/gmail.compose'] : [])] : []),
    ...(services.drive ? [services.drive === 'write' ? 'https://www.googleapis.com/auth/drive' : 'https://www.googleapis.com/auth/drive.readonly'] : [])];
  return ['offline_access', 'User.Read', ...(services.calendar ? [services.calendar === 'write' ? 'Calendars.ReadWrite' : 'Calendars.Read'] : []),
    ...(services.mail ? services.mail === 'write' ? ['Mail.ReadWrite', 'Mail.Send'] : ['Mail.Read'] : []), ...(services.drive ? [services.drive === 'write' ? 'Files.ReadWrite' : 'Files.Read'] : [])];
}

export class AccountOAuth {
  private http: (origins: string[], isPrivate: boolean) => AccountHttp;
  resolve: typeof endpoints;
  constructor(options: { transport?: Transport; endpoints?: typeof endpoints; private?: boolean } = {}) {
    this.resolve = options.endpoints || endpoints;
    this.http = (origins, isPrivate) => new AccountHttp(origins, { ...(options.transport ? { transport: options.transport } : {}), private: options.private === true || isPrivate });
  }
  private post(provider: AccountProvider, client: OAuthClient, url: string, form: Record<string, string>, signal?: AbortSignal) {
    const http = this.http([new URL(url).origin], !!client.host);
    return http.raw({ method: 'POST', url, form, headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) }).then(reply => {
      let value: any; try { value = JSON.parse(reply.body.toString('utf8')); } catch { throw new AccountError('The sign-in service sent something other than the expected answer', { status: reply.status, code: 'PROTOCOL' }); }
      return { status: reply.status, value };
    });
  }
  private secret(client: OAuthClient): Record<string, string> { return client.clientSecret ? { client_secret: client.clientSecret } : {}; }
  private tokens(value: any, previous?: AccountTokens): AccountTokens {
    if (typeof value?.access_token !== 'string' || !value.access_token) throw refusal(value);
    return { access: value.access_token, ...(typeof value.refresh_token === 'string' ? { refresh: value.refresh_token } : previous?.refresh ? { refresh: previous.refresh } : {}),
      ...(Number(value.expires_in) > 0 ? { expires: Date.now() + Number(value.expires_in) * 1000 } : {}), ...(typeof value.scope === 'string' ? { scope: value.scope.slice(0, 1000) } : previous?.scope ? { scope: previous.scope } : {}), obtained: Date.now() };
  }
  async deviceStart(provider: AccountProvider, client: OAuthClient, wanted: string[], signal?: AbortSignal) {
    const at = this.resolve(provider, client); if (!at.device) throw new Error(`${providers[provider].label} signs in through the browser on this computer`);
    const { value } = await this.post(provider, client, at.device, { client_id: client.clientId, scope: wanted.join(' ') }, signal);
    if (typeof value.device_code !== 'string' || typeof value.user_code !== 'string') throw refusal(value);
    const address = new URL(String(value.verification_uri || value.verification_url)); if (address.protocol !== 'https:') throw new AccountError('The sign-in service named an address PAL does not open', { code: 'PROTOCOL' });
    const complete = typeof value.verification_uri_complete === 'string' && new URL(value.verification_uri_complete).origin === address.origin ? value.verification_uri_complete : undefined;
    return { deviceCode: value.device_code as string, userCode: String(value.user_code).slice(0, 40), address: address.href, ...(complete ? { complete } : {}), interval: Math.max(5, Math.min(60, Number(value.interval) || 5)), expires: Date.now() + Math.max(60, Math.min(1800, Number(value.expires_in) || 900)) * 1000 };
  }
  /** One question: is the sign-in finished? The service sets the pace. */
  async devicePoll(provider: AccountProvider, client: OAuthClient, deviceCode: string, signal?: AbortSignal): Promise<{ state: 'pending' | 'slower' } | { state: 'done'; tokens: AccountTokens }> {
    const { value } = await this.post(provider, client, this.resolve(provider, client).token, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: client.clientId, device_code: deviceCode, ...this.secret(client) }, signal);
    if (value.error === 'authorization_pending') return { state: 'pending' };
    if (value.error === 'slow_down') return { state: 'slower' };
    return { state: 'done', tokens: this.tokens(value) };
  }
  browserStart(provider: AccountProvider, client: OAuthClient, wanted: string[], redirect: string) {
    const at = this.resolve(provider, client); if (!at.authorize) throw new Error(`${providers[provider].label} does not sign in through the browser here`);
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('base64url'), url = new URL(at.authorize);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.clientId, redirect_uri: redirect, scope: wanted.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }) })) url.searchParams.set(key, value);
    return { url: url.href, verifier, state };
  }
  async exchange(provider: AccountProvider, client: OAuthClient, p: { code: string; verifier: string; redirect: string }, signal?: AbortSignal) {
    const { value } = await this.post(provider, client, this.resolve(provider, client).token, { grant_type: 'authorization_code', client_id: client.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirect, ...this.secret(client) }, signal);
    return this.tokens(value);
  }
  async refresh(provider: AccountProvider, client: OAuthClient, previous: AccountTokens, signal?: AbortSignal) {
    if (!previous.refresh) throw new AccountError('The sign-in expired. Sign in to this account again.', { code: 'SIGNED_OUT' });
    const { status, value } = await this.post(provider, client, this.resolve(provider, client).token, { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: previous.refresh, ...this.secret(client) }, signal);
    if (status >= 400 && status < 500 && value?.error === 'invalid_grant') throw new AccountError('The sign-in was ended at the service. Sign in to this account again.', { code: 'SIGNED_OUT' });
    return this.tokens(value, previous);
  }
  /** Ends the sign-in at the service where it offers that to PAL; otherwise only this computer forgets it. */
  async revoke(provider: AccountProvider, client: OAuthClient, tokens: AccountTokens) {
    const at = this.resolve(provider, client).revoke; if (!at) return false;
    return this.post(provider, client, at, { token: tokens.refresh || tokens.access }).then(reply => reply.status < 400, () => false);
  }
}
function refusal(value: any) {
  const code = String(value?.error || ''), said = String(value?.error_description || '').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
  const known: Record<string, string> = { access_denied: 'The sign-in was declined.', expired_token: 'The code expired before the sign-in finished. Start again.', incorrect_client_credentials: 'The client ID or secret is not right.', invalid_client: 'The client ID or secret is not right.', unauthorized_client: 'The registered app does not allow this kind of sign-in.', device_flow_disabled: 'Turn on Device Flow in the registered app first.', invalid_grant: 'The sign-in code was not accepted. Start again.', invalid_scope: 'The registered app does not allow the access PAL asked for.' };
  return new AccountError(known[code] || (said ? `The sign-in service refused: ${said}` : 'The sign-in service refused.'), { code: 'SIGN_IN_REFUSED' });
}
