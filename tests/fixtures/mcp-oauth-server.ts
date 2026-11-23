/**
 * An OAuth-protected Streamable HTTP MCP server for tests (PAL Everywhere §14.1): protected resource metadata
 * (RFC 9728), authorization server metadata (RFC 8414), dynamic registration (RFC 7591), an authorization endpoint
 * that approves at once and redirects with a code, and a token endpoint that checks PKCE S256, the redirect and
 * the resource indicator. Its MCP endpoint (the SDK's reference server) accepts only issued access tokens and offers
 * a write tool whose response can be withheld, to model a lost response.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const body = (req: IncomingMessage) => new Promise<string>(resolve => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text)); });
export async function oauthMcpFixture() {
  const state = { hold: false, created: [] as string[], registered: [] as any[], codes: new Map<string, any>(), tokens: new Set<string>(), refreshes: 0, issued: 0, tokenRequests: [] as Record<string, string>[] };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let base = '';
  const mcp = () => {
    const server = new McpServer({ name: 'fixture-oauth', version: '1.0.0' });
    server.registerTool('create_item', { description: 'Create an item.', inputSchema: { title: z.string() }, annotations: { readOnlyHint: false } }, async ({ title }) => {
      state.created.push(title);
      if (state.hold) await new Promise(() => {});
      return { content: [{ type: 'text', text: 'created ' + title }], structuredContent: { id: 'item-' + state.created.length } };
    });
    return server;
  };
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const http = createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['items'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register' && req.method === 'POST') { const value = JSON.parse(await body(req)); state.registered.push(value); return json(res, 201, { ...value, client_id: 'client-' + state.registered.length }); }
    if (url.pathname === '/authorize') {
      const code = randomUUID();
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), method: url.searchParams.get('code_challenge_method'), redirect: url.searchParams.get('redirect_uri'), resource: url.searchParams.get('resource'), client: url.searchParams.get('client_id') });
      const target = new URL(url.searchParams.get('redirect_uri')!); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state') || '');
      res.writeHead(302, { location: target.href }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      state.tokenRequests.push(form);
      const issue = () => { const access = 'at-' + (++state.issued); state.tokens.add(access); return access; };
      if (form.grant_type === 'authorization_code') {
        const code = state.codes.get(form.code); state.codes.delete(form.code);
        const verified = code && code.method === 'S256' && createHash('sha256').update(form.code_verifier || '').digest('base64url') === code.challenge;
        if (!verified || code.redirect !== form.redirect_uri || code.resource !== form.resource || code.client !== form.client_id) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, { access_token: issue(), refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, scope: 'items' });
      }
      if (form.grant_type === 'refresh_token' && form.refresh_token === 'rt-1' && form.resource === base + '/mcp') { state.refreshes++; return json(res, 200, { access_token: issue(), token_type: 'Bearer', expires_in: 3600 }); }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token || !state.tokens.has(token)) { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }); return res.end('unauthorized'); }
    const id = req.headers['mcp-session-id'];
    let transport = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!transport) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, onsessioninitialized: sid => { sessions.set(sid, transport!); } });
      transport.onclose = () => { if (transport!.sessionId) sessions.delete(transport!.sessionId); };
      await mcp().connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as any).port}`;
  return { base, url: base + '/mcp', state,
    async close() { for (const transport of sessions.values()) await transport.close().catch(() => {}); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
