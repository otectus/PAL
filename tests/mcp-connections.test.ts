// PAL Everywhere §14 (CON-01, CON-02): an HTTP tool server's OAuth sign-in from the desktop (loopback) or an owner
// phone (private-use redirect, bound to that phone), tokens kept desktop-side and bound to the server's address,
// refresh, reviewable configuration import, and an external write whose response was lost is not sent again until a
// person reconciles it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { phoneRedirect } from '../broker/mcp-oauth.ts';
import { oauthMcpFixture } from './fixtures/mcp-oauth-server.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
async function broker(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'pal-mcp-oauth-')), project = join(dir, 'project');
  await mkdir(project);
  const fixture = await oauthMcpFixture();
  const core = new Core(new Store(join(dir, 'state')), idle);
  t.after(async () => { await core.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); });
  await core.rpc('provider.credentials', { provider: 'openai', key: 'fixture-key' });
  await core.updateSettings({ extensions: [{ name: 'Items', transport: 'http', url: fixture.url, network: 'local', enabled: true, secrets: [], projects: [], allowed: ['create_item'], timeoutSeconds: 5 }] });
  const id = core.extensions.servers()[0].id;
  return { core, dir, project, fixture, id };
}
/** The person's browser: follows the authorization page to its redirect, which is where the code goes. */
async function approve(authorizationUrl: string) { const response = await fetch(authorizationUrl, { redirect: 'manual' }); return new URL(response.headers.get('location')!); }

test('desktop sign-in: discovery, registration, PKCE and the resource indicator; tokens stay desktop-side and bound to the address', async t => {
  const f = await broker(t);
  await assert.rejects(f.core.rpc('extensions.restart', { id: f.id }), /did not start/);
  assert.match(f.core.extensions.snapshot()[0].error, /Sign in to it/);
  const started = await f.core.rpc('extensions.oauthStart', { id: f.id });
  assert.match(started.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), f.fixture.url);
  assert.deepEqual(f.fixture.state.registered[0].redirect_uris, [started.redirectUrl, phoneRedirect], 'registered for the desktop and phone redirects');
  // The browser lands on PAL's loopback listener, which completes the sign-in.
  const callback = await approve(started.authorizationUrl);
  const page = await fetch(callback); assert.equal(page.status, 200); assert.match(await page.text(), /Signed in to Items/);
  // The listener closes once no desktop sign-in waits; the same state never completes twice.
  await assert.rejects(f.core.oauth.complete({ state: callback.searchParams.get('state')!, code: callback.searchParams.get('code')! }, undefined, true), /no longer waiting/);
  const status = f.core.extensions.snapshot()[0];
  assert.equal(status.oauth?.signedIn, true); assert.equal(status.oauth?.scope, 'items'); assert.equal(status.oauth?.refreshable, true);
  assert.doesNotMatch(JSON.stringify(f.core.snapshot().extensions), /at-1|rt-1/, 'no token in snapshots');
  const ready = await f.core.rpc('extensions.restart', { id: f.id });
  assert.equal(ready.state, 'ready');
  // A token near expiry is refreshed with the same resource indicator; the new one is used per request.
  const secrets = f.core.extensions.secrets.values(f.id), tokens = JSON.parse(secrets.__oauth_tokens);
  f.core.extensions.secrets.set(f.id, '__oauth_tokens', JSON.stringify({ ...tokens, expires_at: Date.now() - 1000 }));
  assert.equal(await f.core.oauth.token(f.core.extensions.servers()[0]), 'at-2'); assert.equal(f.fixture.state.refreshes, 1);
  // A changed address makes the sign-in unusable: tokens are bound to the origin they were issued for.
  const moved = { ...f.core.extensions.servers()[0], url: 'http://127.0.0.2:9/mcp' };
  assert.equal(await f.core.oauth.token(moved), undefined);
  assert.match(f.core.oauth.status(moved)!.stale!, /address changed/);
  const out = await f.core.rpc('extensions.oauthSignOut', { id: f.id });
  assert.equal(out.signedIn, false); assert.equal(f.core.extensions.secrets.values(f.id).__oauth_tokens, undefined);
});

test('a phone sign-in uses its private-use redirect, completes only from that phone, and once', async t => {
  const f = await broker(t);
  const phone = { id: '0b5c1f5e-2a8e-4c11-9c0f-7d8f6a1b2c3d', name: 'Pixel' };
  const started = await f.core.oauth.start({ id: f.id }, phone);
  assert.equal(started.redirectUrl, phoneRedirect);
  const redirect = await approve(started.authorizationUrl);
  assert.equal(redirect.protocol + redirect.pathname, phoneRedirect);
  const state = redirect.searchParams.get('state')!, code = redirect.searchParams.get('code')!;
  await assert.rejects(f.core.oauth.complete({ state, code }, 'a-different-phone'), /another device/);
  await assert.rejects(f.core.oauth.complete({ state, code }, undefined, true), /another device/, 'the desktop listener cannot finish a phone sign-in');
  const done = await f.core.oauth.complete({ state, code }, phone.id);
  assert.equal(done.signedIn, true);
  await assert.rejects(f.core.oauth.complete({ state, code }, phone.id), /no longer waiting/);
  // Revoking a phone abandons the sign-ins it started.
  const again = await f.core.oauth.start({ id: f.id }, phone);
  f.core.oauth.deviceRevoked(phone.id);
  const second = await approve(again.authorizationUrl);
  await assert.rejects(f.core.oauth.complete({ state: second.searchParams.get('state')!, code: second.searchParams.get('code')! }, phone.id), /no longer waiting/);
});

test('an external write whose response was lost is not sent again until someone reconciles it', async t => {
  const f = await broker(t);
  const started = await f.core.rpc('extensions.oauthStart', { id: f.id });
  await fetch(await approve(started.authorizationUrl));
  const session = await f.core.create({ provider: 'openai', model: 'm', cwd: f.project, tools: true, trusted: true });
  await f.core.extensions.ensure(session.id);
  const name = f.core.toolsFor(session.id).map(tool => tool.function.name).find(item => item.includes('create_item'))!;
  const first: any = await f.core.callTool(session.id, name, { title: 'Release notes' }, new AbortController().signal);
  assert.equal(first.output, 'created Release notes');
  assert.equal(f.core.extensions.writes()[0].state, 'completed'); assert.equal(f.core.extensions.writes()[0].result, 'item-1');
  // The service takes the request but its response never arrives.
  f.fixture.state.hold = true;
  const controller = new AbortController(); setTimeout(() => controller.abort(new Error('response lost')), 300);
  await assert.rejects(f.core.callTool(session.id, name, { title: 'Weekly digest' }, controller.signal));
  const unknown = f.core.extensions.writes()[0];
  const review = (await f.core.rpc('extensions.writes', {})).find((row: any) => row.id === unknown.id);
  assert.equal(review.conversationTitle, session.title);
  assert.match(review.intent, /Weekly digest/);
  assert.equal(review.args, undefined);
  assert.equal(unknown.state, 'unknown'); assert.equal(f.fixture.state.created.length, 2);
  f.fixture.state.hold = false;
  const refused: any = await f.core.callTool(session.id, name, { title: 'Weekly digest' }, new AbortController().signal);
  assert.equal(refused.ran, false); assert.match(refused.message, /may already have taken effect/);
  assert.equal(f.fixture.state.created.length, 2, 'not sent again');
  // A different request is unaffected; after a person checks the service, the same request may be sent.
  const other: any = await f.core.callTool(session.id, name, { title: 'Other' }, new AbortController().signal);
  assert.equal(other.output, 'created Other');
  await f.core.rpc('extensions.resolveWrite', { id: unknown.id, outcome: 'not-done' });
  const retried: any = await f.core.callTool(session.id, name, { title: 'Weekly digest' }, new AbortController().signal);
  assert.equal(retried.output, 'created Weekly digest');
  // A write still dispatching when PAL stopped is unknown after a restart.
  const store = f.core.store;
  store.set('extensions:external-writes', [{ ...unknown, id: 'w-crash', state: 'dispatching' }]);
  const { Extensions } = await import('../broker/extensions.ts');
  new Extensions(f.core);
  assert.equal(f.core.extensions.writes()[0].state, 'unknown');
});

test('importing another app’s configuration is a review: nothing starts, values stay private, servers arrive turned off', async t => {
  const f = await broker(t);
  const text = JSON.stringify({ mcpServers: {
    files: { command: 'node', args: ['server.js'], env: { FILES_TOKEN: 'secret-value-123', HOME: '/tmp' } },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer remote-token-456', 'X-Team': 'a' } },
    legacy: { type: 'sse', url: 'https://old.example.com/sse' },
    missing: { command: 'no-such-program-xyz' },
  } });
  const preview = await f.core.rpc('extensions.importPreview', { text });
  assert.doesNotMatch(JSON.stringify(preview), /secret-value-123|remote-token-456/, 'values never appear in the preview');
  const byName = Object.fromEntries(preview.servers.map((server: any) => [server.name, server]));
  assert.match(byName.files.command, /\/node$/); assert.deepEqual(byName.files.secrets, [{ name: 'FILES_TOKEN', value: 'imported' }]);
  assert.ok(byName.files.warnings.some((w: string) => /HOME cannot be passed/.test(w)));
  assert.deepEqual(byName.remote.secrets, [{ name: 'BEARER_TOKEN', value: 'imported' }]); assert.ok(byName.remote.warnings.some((w: string) => /X-Team/.test(w)));
  assert.match(byName.legacy.problem, /SSE/); assert.match(byName.missing.problem, /not found/);
  const applied = await f.core.rpc('extensions.importApply', { token: preview.token, names: ['files', 'remote', 'legacy'] });
  assert.deepEqual(applied.added.map((server: any) => server.name), ['files', 'remote']);
  const servers = f.core.extensions.servers().filter(server => server.name !== 'Items');
  assert.ok(servers.every(server => server.enabled === false), 'imported servers are off until reviewed');
  assert.equal(f.core.extensions.secrets.values(servers[0].id).FILES_TOKEN, 'secret-value-123');
  assert.equal(f.core.extensions.secrets.values(servers[1].id).BEARER_TOKEN, 'remote-token-456');
  assert.doesNotMatch(JSON.stringify(f.core.settings.extensions), /secret-value-123|remote-token-456/);
  await assert.rejects(f.core.rpc('extensions.importApply', { token: preview.token, names: ['files'] }), /expired/, 'a preview is used once');
});
