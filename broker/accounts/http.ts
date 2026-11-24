/**
 * Requests to an account's service (PAL Everywhere §14.2). A token is sent only to the origins of the service it was
 * issued for, over HTTPS, to a public address that is resolved once and pinned for the request. Redirects are refused;
 * the one place a service answers with a download address (a file's content) is followed without the token.
 * Responses are bounded, and every failure says whether the request may have taken effect.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { publicAddress } from '../web.ts';

export const accountLimits = { jsonBytes: 5 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, timeoutMs: 30_000, fileTimeoutMs: 120_000 };
export class AccountError extends Error {
  status: number; code: string;
  /** The request may have taken effect: look before trying it again. */
  ambiguous: boolean;
  retryAfterMs?: number;
  constructor(message: string, options: { status?: number; code?: string; ambiguous?: boolean; retryAfterMs?: number } = {}) {
    super(message); this.status = options.status || 0; this.code = options.code || 'ACCOUNT_ERROR'; this.ambiguous = options.ambiguous === true;
    if (options.retryAfterMs) this.retryAfterMs = options.retryAfterMs;
  }
}
export type AccountRequest = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; token?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; body?: Buffer; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; followContent?: boolean };
export type AccountReply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
export type Transport = (url: URL, options: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal; maxBytes: number; private: boolean }) => Promise<AccountReply>;

/** One request, its name resolved once and pinned; nothing is followed. */
export const transport: Transport = async (url, options) => {
  const host = url.hostname.replace(/^\[|\]$/g, ''), addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => { throw new AccountError(`${host} could not be found. Check the network.`, { code: 'UNREACHABLE' }); });
  options.signal.throwIfAborted();
  if (!addresses.length || (!options.private && addresses.some(item => !publicAddress(item.address)))) throw new AccountError(`${host} resolves to a private network`, { code: 'UNREACHABLE' });
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    let sent = false;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method, signal: options.signal, agent: false, lookup: (_host, o, callback: any) => o.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      headers: { 'User-Agent': 'PAL', Accept: 'application/json', 'Accept-Encoding': 'identity', ...options.headers, ...(options.body ? { 'Content-Length': String(options.body.length) } : {}) },
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > options.maxBytes) { request.destroy(new AccountError('The service sent more than PAL accepts', { code: 'TOO_LARGE', ambiguous: options.method !== 'GET' })); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('finish', () => { sent = true; });
    request.on('error', error => reject(error instanceof AccountError || options.signal.aborted && !sent ? error : new AccountError(`${host} did not answer`, { code: 'UNREACHABLE', ambiguous: sent && options.method !== 'GET' })));
    request.end(options.body);
  });
};

/** Requests for one account: its origins and the token are fixed; the caller chooses only what to ask. */
export class AccountHttp {
  private origins: Set<string>; private send: Transport; private private: boolean;
  constructor(origins: string[], options: { transport?: Transport; private?: boolean } = {}) { this.origins = new Set(origins); this.send = options.transport || transport; this.private = options.private === true; }
  async raw(p: AccountRequest): Promise<AccountReply> {
    const url = new URL(p.url), method = p.method || 'GET';
    if (!this.origins.has(url.origin)) throw new AccountError('This address is not part of the account’s service', { code: 'ORIGIN' });
    if (url.protocol !== 'https:' && !(this.private && url.protocol === 'http:')) throw new AccountError('Account services are reached over HTTPS only', { code: 'ORIGIN' });
    const body = p.json !== undefined ? Buffer.from(JSON.stringify(p.json)) : p.form ? Buffer.from(new URLSearchParams(p.form).toString()) : p.body;
    const signal = AbortSignal.any([AbortSignal.timeout(p.timeoutMs || accountLimits.timeoutMs), ...(p.signal ? [p.signal] : [])]);
    const headers = { ...(p.json !== undefined ? { 'Content-Type': 'application/json' } : p.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(p.token ? { Authorization: `Bearer ${p.token}` } : {}), ...p.headers };
    const reply = await this.send(url, { method, headers, ...(body ? { body } : {}), signal, maxBytes: p.maxBytes || accountLimits.jsonBytes, private: this.private }).catch(error => {
      if (p.signal?.aborted) throw p.signal.reason instanceof Error ? p.signal.reason : new Error('Stopped');
      throw error instanceof AccountError ? error : new AccountError(`${url.hostname} did not answer in time`, { code: 'UNREACHABLE', ambiguous: method !== 'GET' });
    });
    if (p.followContent && [301, 302, 303, 307].includes(reply.status) && reply.headers.location) {
      // A file's content on another host: fetched as an ordinary public download, without the account's token.
      const next = new URL(reply.headers.location, url);
      if (next.protocol !== 'https:' && !(this.private && next.protocol === 'http:')) throw new AccountError('The service sent the file to an address PAL does not use', { code: 'ORIGIN' });
      return this.send(next, { method: 'GET', headers: { Accept: '*/*' }, signal, maxBytes: p.maxBytes || accountLimits.fileBytes, private: this.private });
    }
    return reply;
  }
  /** The JSON answer, or an error in the service's own words. */
  async json<T = any>(p: AccountRequest): Promise<{ value: T; headers: IncomingHttpHeaders; status: number }> {
    const reply = await this.raw(p);
    if (reply.status < 200 || reply.status >= 300) throw failure(p, reply);
    if (!reply.body.length) return { value: undefined as T, headers: reply.headers, status: reply.status };
    try { return { value: JSON.parse(reply.body.toString('utf8')), headers: reply.headers, status: reply.status }; }
    catch { throw new AccountError('The service sent something other than the expected answer', { status: reply.status, code: 'PROTOCOL', ambiguous: (p.method || 'GET') !== 'GET' }); }
  }
}
export function failure(p: Pick<AccountRequest, 'method' | 'url'>, reply: AccountReply): AccountError {
  const method = p.method || 'GET'; let said = '';
  try {
    const value = JSON.parse(reply.body.toString('utf8')), error = value.error;
    said = typeof value.error_description === 'string' ? value.error_description : typeof error === 'object' && error ? String(error.message || error.code || '') : typeof value.message === 'string' ? value.message : typeof error === 'string' ? error : '';
    if (Array.isArray(value.errors)) said += value.errors.slice(0, 5).map((item: any) => `; ${item?.message || [item?.field, item?.code].filter(Boolean).join(' ')}`).join('');
  } catch { /* not JSON */ }
  said = said.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
  const retry = Number(reply.headers['retry-after']), reset = Number(reply.headers['x-ratelimit-reset']);
  const limited = reply.status === 429 || reply.status === 403 && (reply.headers['x-ratelimit-remaining'] === '0' || /rate limit/i.test(said));
  const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : limited && Number.isFinite(reset) ? Math.max(0, reset * 1000 - Date.now()) : undefined;
  const options = { status: reply.status, ambiguous: method !== 'GET' && reply.status >= 500 && reply.status !== 501, ...(wait ? { retryAfterMs: wait } : {}) };
  if (reply.status === 401) return new AccountError('The sign-in no longer works. Sign in to this account again.', { ...options, code: 'SIGNED_OUT' });
  if (limited) return new AccountError(`The service asks to wait${wait ? ` about ${Math.ceil(wait / 60000)} min` : ''} before more requests.`, { ...options, code: 'RATE_LIMITED' });
  if (reply.status === 403) return new AccountError(said ? `The account may not do this: ${said}` : 'The account may not do this. Sign in again with the access it needs.', { ...options, code: 'FORBIDDEN' });
  if (reply.status === 404 || reply.status === 410) return new AccountError('It does not exist, or this account cannot see it.', { ...options, code: 'NOT_FOUND' });
  if (reply.status === 409 || reply.status === 412) return new AccountError('It changed since you looked. Open it again, then repeat the change.', { ...options, code: 'REVISION_CONFLICT' });
  return new AccountError(said || `The service answered HTTP ${reply.status}`, { ...options, code: reply.status >= 500 ? 'SERVICE_ERROR' : 'REFUSED' });
}
