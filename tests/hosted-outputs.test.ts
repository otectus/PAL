import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { HostedOutputs, hostedLimits, type HostedFile } from '../broker/artifacts/hosted-outputs.ts';

const signal = () => new AbortController().signal;
async function fixture(t: any, provider = 'anthropic', temporary = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-hosted-')), core = new Core(new Store(directory), () => ({ send: async () => {}, interrupt: async () => {}, close: async () => {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.rpc('provider.credentials', { provider, key: 'saved-key' });
  const session = await core.create({ provider, model: 'model', cwd: directory, ...(temporary ? { temporary: true } : {}) } as any), outputs = new HostedOutputs(core), calls: { url: string; init: any }[] = [];
  let allowed = true;
  const source = (reply: (url: string) => Response | Promise<Response>) => ({ sessionId: session.id, provider, base: 'https://api.example/v1/', key: 'fixture-key', turnId: 'turn-1', check: () => { if (!allowed) throw new Error('the account changed'); },
    fetch: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return reply(String(url)); }) as typeof fetch });
  return { core, session, outputs, calls, source, revoke: () => { allowed = false; } };
}
const claudeFile = (id: string, name: string, bytes: Buffer, mime = 'text/csv') => (url: string) => url.endsWith('/content') ? new Response(new Uint8Array(bytes)) : Response.json({ id, filename: name, mime_type: mime, size_bytes: bytes.length });

test('a file a reply named is kept once, from its own account and address', async t => {
  const f = await fixture(t), bytes = Buffer.from('a,b\n1,2\n'), reply = claudeFile('file_1', '../../etc/table.csv', bytes), wanted: HostedFile[] = [{ kind: 'anthropic', id: 'file_1' }, { kind: 'anthropic', id: 'file_1' }];
  const receipt = await f.outputs.capture(wanted, f.source(reply), signal());
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.example/v1/files/file_1', 'https://api.example/v1/files/file_1/content']);
  assert.ok(f.calls.every(call => call.init.redirect === 'error' && call.init.headers['x-api-key'] === 'fixture-key' && call.init.headers.Authorization === undefined));
  assert.deepEqual(receipt.files.map(file => file.name), ['table.csv']); assert.deepEqual(receipt.notes, []);
  const stored = await f.core.workbench.artifacts.bytes(f.session.id, receipt.files[0].artifactId, receipt.files[0].versionId);
  assert.deepEqual(stored.data, bytes); assert.equal(stored.version.mime, 'text/csv'); assert.equal(stored.version.turnId, 'turn-1'); assert.deepEqual(stored.version.provenance, { kind: 'provider-code-output', provider: 'anthropic', fileId: 'file_1' });
  const again = await f.outputs.capture(wanted, f.source(() => { throw new Error('nothing is fetched twice'); }), signal());
  assert.deepEqual(again.files, receipt.files); assert.equal(f.calls.length, 2);
});
test('what is too large, empty, a program, misdescribed or not reachable is not kept, and the rest is', async t => {
  const f = await fixture(t), good = Buffer.from('fine');
  const receipt = await f.outputs.capture(['big', 'empty', 'program', 'other', 'gone', 'bad/../id', 'good'].map(id => ({ kind: 'anthropic', id })), f.source(url => {
    const id = /files\/([^/]+)/.exec(url)![1];
    if (id === 'gone') return new Response('no', { status: 404 });
    if (url.endsWith('/content')) return new Response(new Uint8Array(id === 'program' ? [0x7f, 0x45, 0x4c, 0x46, 1] : id === 'empty' ? [] : good));
    return Response.json({ id: id === 'other' ? 'someone-else' : id, filename: id + '.txt', mime_type: 'text/plain', size_bytes: id === 'big' ? hostedLimits.fileBytes + 1 : 4 });
  }), signal());
  assert.deepEqual(receipt.files.map(file => file.name), ['good.txt']); assert.equal(receipt.notes.length, 6);
  assert.ok(receipt.notes.every(note => note.startsWith('One file was not kept (') && !note.includes('fixture-key')));
  assert.ok(f.calls.every(call => call.url.startsWith('https://api.example/v1/files/')));
  const many = await f.outputs.capture(Array.from({ length: hostedLimits.files + 3 }, (_, index) => ({ kind: 'anthropic' as const, id: 'many' + index })), f.source(url => claudeFile(/files\/([^/]+)/.exec(url)![1], /files\/([^/]+)/.exec(url)![1] + '.txt', good)(url)), signal());
  assert.equal(many.files.length, hostedLimits.files); assert.match(many.notes.at(-1)!, /first 16 files/);
});
test('figures in a reply and files of an OpenAI container are kept the same way', async t => {
  const google = await fixture(t, 'google'), png = (await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer()).toString('base64');
  const receipt = await google.outputs.capture([{ kind: 'inline', mime: 'image/png', data: png }, { kind: 'inline', mime: 'application/pdf', data: png }], google.source(() => { throw new Error('nothing is fetched'); }), signal());
  assert.deepEqual(receipt.files.map(file => file.name), ['gemini-figure-1.png']); assert.equal(google.calls.length, 0);
  assert.equal((await google.core.workbench.artifacts.bytes(google.session.id, receipt.files[0].artifactId, receipt.files[0].versionId)).version.kind, 'image');
  const openai = await fixture(t, 'openai'), bytes = Buffer.from('x');
  const kept = await openai.outputs.capture([{ kind: 'openai', container: 'cntr_1', id: 'cfile_1', name: 'C:\\out\\result.txt' }, { kind: 'openai', container: '../escape', id: 'cfile_2', name: 'no.txt' }], openai.source(() => new Response(new Uint8Array(bytes))), signal());
  assert.deepEqual(openai.calls.map(call => call.url), ['https://api.example/v1/containers/cntr_1/files/cfile_1/content']); assert.equal(openai.calls[0].init.headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(kept.files.map(file => file.name), ['result.txt']); assert.equal(kept.notes.length, 1);
});
test('a temporary conversation, a changed account and Stop keep nothing', async t => {
  const temporary = await fixture(t, 'anthropic', true);
  const none = await temporary.outputs.capture([{ kind: 'anthropic', id: 'file_1' }], temporary.source(() => { throw new Error('nothing is fetched'); }), signal());
  assert.deepEqual(none.files, []); assert.match(none.notes[0], /temporary conversation/); assert.equal(temporary.calls.length, 0);
  const changed = await fixture(t);
  const late = changed.source(url => { if (url.endsWith('/content')) changed.revoke(); return claudeFile('file_1', 'late.txt', Buffer.from('late'))(url); });
  const refused = await changed.outputs.capture([{ kind: 'anthropic', id: 'file_1' }], late, signal());
  assert.deepEqual(refused.files, []); assert.match(refused.notes[0], /the account changed/);
  const stopped = await fixture(t), controller = new AbortController();
  await assert.rejects(stopped.outputs.capture([{ kind: 'anthropic', id: 'file_1' }], stopped.source(url => { controller.abort(new Error('Stopped')); return claudeFile('file_1', 'x.txt', Buffer.from('x'))(url); }), controller.signal), /Stopped/);
});
test('a conversation hands its own account to the capture, and a limited phone’s turn keeps nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-hosted-core-')); let adapter: any;
  const core = new Core(new Store(directory)); t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.rpc('provider.credentials', { provider: 'anthropic', key: 'default-key' });
  const account: any = await core.rpc('connections.save', { kind: 'anthropic', name: 'Work' }); await core.rpc('provider.credentials', { provider: 'anthropic', connectionId: account.id, key: 'work-key' });
  const session = await core.create({ provider: 'anthropic', connectionId: account.id, model: 'claude-opus-5-5', cwd: directory } as any);
  const seen: any[] = []; core.hostedOutputs.capture = async (files, source) => { source.check(); seen.push({ files, provider: source.provider, key: source.key, base: source.base, connectionId: source.connectionId }); return { files: [], notes: [] }; };
  adapter = core.conversationAdapter(core.store.session(session.id), { token: '', native() {}, event() {}, approve: async () => ({ choice: 'deny' }) } as any, {} as any);
  await adapter.access.captureFiles([{ kind: 'anthropic', id: 'file_1' }], signal());
  assert.deepEqual(seen, [{ files: [{ kind: 'anthropic', id: 'file_1' }], provider: 'anthropic', key: 'work-key', base: 'https://api.anthropic.com/v1/', connectionId: account.id }]);
  const limited = core.store.session(session.id); (limited as any).remote = { role: 'limited', deviceId: 'phone' }; core.store.saveSession(limited);
  await assert.rejects(adapter.access.captureFiles([{ kind: 'anthropic', id: 'file_1' }], signal()), /restricted remote turn/);
  delete (limited as any).remote; core.store.saveSession(limited); await core.rpc('provider.credentials', { provider: 'anthropic', connectionId: account.id, key: 'rotated' });
  await assert.rejects(adapter.access.captureFiles([{ kind: 'anthropic', id: 'file_1' }], signal()), /account/);
});
