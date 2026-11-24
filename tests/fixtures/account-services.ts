/** Stand-ins for GitHub, Google and Microsoft: sign-in, calendars, mail, files and repositories, with faults on request. */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type Seen = { method: string; path: string; auth: string; body: string; headers: http.IncomingHttpHeaders };
export async function accountServices() {
  const seen: Seen[] = [], state = { devicePending: 1, subject: 'u-1', login: 'me@example.test', tokens: new Set<string>(), refreshes: 0, revoked: [] as string[],
    events: new Map<string, any>(), mail: new Map<string, any>(), drafts: new Map<string, any>(), files: new Map<string, any>(), issues: [] as any[], comments: [] as any[],
    /** How the next matching write behaves: after taking effect, its answer is lost, or refused. */
    fault: undefined as undefined | { match: RegExp; kind: 'lose' | 'refuse' | 'before' | 'error' }, expiresIn: 3600, code: '', challenge: '' };
  const issue = (scope = 'all') => { const token = 'tok-' + randomUUID(); state.tokens.add(token); return { access_token: token, token_type: 'Bearer', expires_in: state.expiresIn, refresh_token: 'ref-' + randomUUID(), scope }; };
  let base = '';
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
      const raw = Buffer.concat(chunks), body = raw.toString('utf8'), url = new URL(request.url!, base), path = url.pathname, method = request.method!, auth = String(request.headers.authorization || '');
      seen.push({ method, path: path + url.search, auth, body, headers: request.headers });
      const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
      const form = new URLSearchParams(body), parse = () => JSON.parse(body || '{}');
      const fault = state.fault && method !== 'GET' && state.fault.match.test(path) ? state.fault : undefined;
      if (fault) state.fault = undefined;
      if (fault?.kind === 'before') return response.destroy();
      if (fault?.kind === 'refuse') return json({ message: 'Validation Failed', errors: [{ message: 'title is not allowed' }] }, 422);
      /** Answers, unless the fault says the answer is lost after the write took effect. */
      const done = (value: unknown, status = 200) => fault?.kind === 'lose' ? response.destroy() : fault?.kind === 'error' ? json({ error: { message: 'backend' } }, 503) : json(value, status);
      // ── sign-in ──
      if (path.endsWith('/device/code') || path.endsWith('/devicecode')) return json({ device_code: 'dev-1', user_code: 'WDJB-MJHT', verification_uri: 'https://example.test/device', expires_in: 600, interval: 5 });
      if (path === '/token') {
        if (form.get('client_id') === 'bad-client') return json({ error: 'invalid_client' }, 401);
        if (form.get('grant_type')?.includes('device_code')) return state.devicePending-- > 0 ? json({ error: 'authorization_pending' }, 400) : json(issue());
        if (form.get('grant_type') === 'refresh_token') { state.refreshes++; return form.get('refresh_token') === 'ref-dead' ? json({ error: 'invalid_grant' }, 400) : json({ ...issue(), refresh_token: undefined }); }
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        return form.get('code') === state.code && challenge === state.challenge ? json(issue()) : json({ error: 'invalid_grant' }, 400);
      }
      // A person agreeing in their browser: the page sends them straight back.
      if (path === '/authorize') { state.code = 'code-' + randomUUID(); state.challenge = url.searchParams.get('code_challenge') || ''; const back = new URL(url.searchParams.get('redirect_uri')!); back.hostname = '127.0.0.1'; back.searchParams.set('state', url.searchParams.get('state') || ''); back.searchParams.set('code', state.code); response.writeHead(302, { location: back.href }); return response.end(); }
      if (path === '/revoke') { state.revoked.push(form.get('token') || ''); return json({}); }
      if (!state.tokens.has(auth.replace('Bearer ', '')) && !path.startsWith('/content/')) return json({ message: 'Bad credentials' }, 401);
      // ── identities ──
      if (path === '/api/user') return json({ id: state.subject, login: state.login });
      if (path === '/v1/userinfo') return json({ sub: state.subject, email: state.login });
      if (path === '/v1.0/me') return json({ id: state.subject, mail: state.login });
      // ── Google Calendar ──
      const calendar = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
      if (path === '/calendar/v3/users/me/calendarList') return json({ items: [{ id: 'primary', summary: 'Mine', primary: true, accessRole: 'owner', timeZone: 'Europe/Berlin' }] });
      if (calendar) {
        const id = calendar[2];
        if (method === 'GET' && !id) return json({ items: [...state.events.values()] });
        if (method === 'GET') return state.events.has(id) ? json(state.events.get(id)) : json({ error: { message: 'Not Found' } }, 404);
        if (method === 'POST') { const value = parse(); if (state.events.has(value.id)) return json({ error: { message: 'The requested identifier already exists.' } }, 409); const event = { ...value, etag: '"1"', status: 'confirmed', htmlLink: 'https://calendar.test/' + value.id, organizer: { self: true } }; state.events.set(value.id, event); return done(event); }
        const event = state.events.get(id); if (!event) return json({ error: { message: 'Not Found' } }, 404); if (request.headers['if-match'] !== event.etag) return json({ error: { message: 'Precondition Failed' } }, 412);
        if (method === 'DELETE') { state.events.set(id, { ...event, status: 'cancelled' }); return fault ? done({}) : (response.writeHead(204), response.end()); }
        const next = { ...event, ...parse(), etag: `"${Number(event.etag.replaceAll('"', '')) + 1}"` }; state.events.set(id, next); return done(next);
      }
      // ── Gmail ──
      if (path === '/gmail/v1/users/me/threads') return json({ threads: [...new Set([...state.mail.values()].map((m: any) => m.threadId))].map(id => ({ id })) });
      const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path); if (thread) return json({ id: thread[1], messages: [...state.mail.values()].filter((m: any) => m.threadId === thread[1]) });
      if (path === '/gmail/v1/users/me/messages/send') { const value = parse(), id = 'm-' + state.mail.size, rawText = Buffer.from(value.raw, 'base64url').toString('utf8'); state.mail.set(id, { id, threadId: value.threadId || 't-' + id, sent: rawText, internalDate: '1763900000000', labelIds: ['SENT'], payload: { headers: [] } }); return done({ id }); }
      if (path === '/gmail/v1/users/me/messages') { const wanted = (url.searchParams.get('q') || '').replace('rfc822msgid:', ''), found = [...state.mail.values()].filter((m: any) => m.sent?.includes(`<${wanted}>`)); return json({ messages: found.map((m: any) => ({ id: m.id })) }); }
      const one = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(?:\/attachments\/(.+))?$/.exec(path); if (one) return one[2] ? json({ data: Buffer.from('attachment bytes').toString('base64url') }) : state.mail.has(one[1]) ? json(state.mail.get(one[1])) : json({ error: { message: 'Not Found' } }, 404);
      // ── Google Drive ──
      if (path === '/drive/v3/files/generateIds') return json({ ids: ['gen-' + randomUUID()] });
      if (path === '/drive/v3/files') { const q = url.searchParams.get('q') || '', key = /value='([^']+)'/.exec(q)?.[1]; return json({ files: [...state.files.values()].filter((f: any) => key ? f.appProperties?.pal === key : true) }); }
      const file = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path); if (file) { const value = state.files.get(file[1]); if (!value) return json({ error: { message: 'Not Found' } }, 404); if (file[2] || url.searchParams.get('alt') === 'media') { response.writeHead(200); return response.end(value.content); } const { content: _content, ...rest } = value; return json(rest); }
      const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
      if (upload) { if (upload[1]) { const value = state.files.get(upload[1]); value.content = raw; value.size = String(raw.length); value.headRevisionId = 'r' + (Number(value.headRevisionId.slice(1)) + 1); const { content: _content, ...rest } = value; return done(rest); } const metadata = JSON.parse(/\r\n\r\n(\{.*\})\r\n/.exec(body)![1]); if (state.files.has(metadata.id)) return json({ error: { message: 'exists' } }, 409); const value = { ...metadata, size: '1', headRevisionId: 'r1', capabilities: { canEdit: true }, content: raw }; state.files.set(metadata.id, value); const { content: _content, ...rest } = value; return done(rest); }
      // ── Microsoft Graph ──
      if (path === '/v1.0/me/calendar/calendarView') return json({ value: [...state.events.values()].filter((e: any) => e.subject) });
      if (path === '/v1.0/me/calendar/events') { if (method === 'GET') return json({ value: [...state.events.values()] }); const value = parse(), existing = [...state.events.values()].find((e: any) => e.transactionId === value.transactionId); if (existing) return json(existing, 201); const event = { ...value, id: 'ms-' + state.events.size, '@odata.etag': 'W/"1"', webLink: 'https://outlook.test/e' }; state.events.set(event.id, event); return done(event, 201); }
      if (path === '/v1.0/me/messages' && method === 'POST') { const value = parse(), id = 'msg-' + state.mail.size; state.mail.set(id, { ...value, id, isDraft: true }); return json({ id, webLink: 'https://outlook.test/m' }, 201); }
      if (path === '/v1.0/me/messages') { const filter = url.searchParams.get('$filter') || '', wanted = /internetMessageId eq '([^']+)'/.exec(filter)?.[1]; return json({ value: [...state.mail.values()].filter((m: any) => !wanted || m.internetMessageId === wanted) }); }
      const sending = /^\/v1\.0\/me\/messages\/([^/]+)\/send$/.exec(path); if (sending) { state.mail.get(sending[1]).isDraft = false; return fault ? done({}) : (response.writeHead(202), response.end()); }
      const content = /^\/v1\.0\/me\/drive\/items\/([^/]+)\/content$/.exec(path); if (content && method === 'GET') { response.writeHead(302, { location: `${base}/content/${content[1]}` }); return response.end(); }
      if (path.startsWith('/content/')) { if (auth) return json({ message: 'token leaked' }, 400); response.writeHead(200); return response.end('onedrive bytes'); }
      const item = /^\/v1\.0\/me\/drive\/items\/([^/]+)$/.exec(path); if (item) return json({ id: item[1], name: 'notes.txt', size: 14, file: { mimeType: 'text/plain' }, eTag: 'e1', webUrl: 'https://onedrive.test/x' });
      // ── GitHub ──
      const gh = path.replace(/^\/api/, '');
      if (gh === '/search/issues') return json({ total_count: 1, items: [{ number: 7, title: 'A bug', state: 'open', user: { login: 'someone' }, repository_url: `${base}/api/repos/o/r`, html_url: 'https://github.test/o/r/issues/7', comments: 1 }] });
      const contents = /^\/repos\/o\/r\/contents\/(.+)$/.exec(gh); if (contents) return contents[1] === 'missing' ? json({ message: 'Not Found' }, 404) : json({ path: contents[1], sha: 'abc', size: 5, encoding: 'base64', content: Buffer.from('hello').toString('base64'), html_url: 'https://github.test/f' });
      if (gh === '/repos/o/r/issues' && method === 'POST') { const value = { ...parse(), number: 100 + state.issues.length, html_url: 'https://github.test/i', user: { login: state.login }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), state: 'open' }; state.issues.push(value); return done(value, 201); }
      if (gh === '/repos/o/r/issues') return json(state.issues);
      const comments = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(gh); if (comments) { if (method === 'GET') return json(state.comments); const value = { ...parse(), id: 900 + state.comments.length, user: { login: state.login }, created_at: new Date().toISOString(), html_url: 'https://github.test/c' }; state.comments.push(value); return done(value, 201); }
      const single = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(gh); if (single) { let value = state.issues.find(i => i.number === Number(single[1])); if (!value) return json({ message: 'Not Found' }, 404); if (method === 'PATCH') { Object.assign(value, parse(), { updated_at: 'later' }); return done(value); } return json({ ...value, labels: [], comments: 0 }); }
      if (gh === '/limited') return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
      json({ message: 'Not Found ' + path }, 404);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, seen, server, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
    endpoints: (provider: string) => ({ authorize: `${base}/authorize`, device: `${base}/device/code`, token: `${base}/token`, revoke: `${base}/revoke`, api: provider === 'github' ? [`${base}/api`] : [base] }), origins: { google: { api: base, mail: base, identity: base }, graph: base } };
}
