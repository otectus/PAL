#!/usr/bin/env node
// A08: the browser companion's page in a real browser. Starts a fixture desktop on loopback, drives headless Chrome or
// Chromium with a profile of its own and no name resolution, pairs it, reads, sends, answers and is revoked, and checks
// that the page ran without an error or a blocked resource. Usage: node tools/browser-companion-check.ts [--out DIR]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { WebSocket } from 'ws';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { MobileGateway } from '../broker/remote/server.ts';

const chrome = ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
if (!chrome) { console.log('SKIPPED: no Chrome or Chromium is installed'); process.exit(0); }
const at = process.argv.indexOf('--out'), out = at > 0 ? process.argv[at + 1] : join(tmpdir(), 'pal-browser-check'); mkdirSync(out, { recursive: true });
const free = async () => { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const { port } = server.address() as any; await new Promise<void>(done => server.close(() => done())); return port as number; };
const until = async (what: () => any, name: string) => { for (let i = 0; i < 300; i++) { const value = await what(); if (value) return value; await new Promise(done => setTimeout(done, 50)); } throw new Error('Timed out waiting for ' + name); };

const base = await mkdtemp(join(tmpdir(), 'pal-browser-check-')), project = join(base, 'Importer'); await mkdir(project);
let sends = 0; const core = new Core(new Store(join(base, 'state')), (_session: any, h: any) => ({ async send(_t: string, _i: any, o: any) { sends++; h.policy?.(true); o?.beforeAccept?.(); o?.onDispatched?.(); o?.onAccepted?.(); setTimeout(() => { h.event({ type: 'message', id: 'r' + sends, text: 'Here is what I found.\n\n<b>This is text, not markup.</b>' }); h.event({ type: 'complete' }); }, 150); }, async interrupt() {}, async close() {} }) as any);
core.capabilities.codex = { available: true, remoteRestricted: true } as any;
const gateway = new MobileGateway(core), port = await free(), local = (method: string, params: any = {}) => gateway.local(method, params) as Promise<any>;
const session = await core.create({ provider: 'codex', cwd: project, trusted: true, title: 'Fix the importer' }); await core.create({ provider: 'codex', cwd: project, trusted: true, title: 'Release notes' });
for (const [role, text, ago] of [['user', 'The importer drops the last row of a file without a newline.', 20], ['assistant', 'I can reproduce it: the reader only yields a row when it meets a line break. I will flush what is left when the file ends.', 18], ['user', 'Good. Keep the old format working.', 12]] as const) core.store.message({ id: randomUUID(), sessionId: session.id, role, text, time: Date.now() - ago * 60_000 } as any);

const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(base, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--force-dark-mode', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; browser.stderr.setEncoding('utf8'); browser.stderr.on('data', data => { stderr = (stderr + data).slice(-20_000); });
try {
  const endpoint = await until(() => /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1], 'the browser');
  const socket = new WebSocket(endpoint); await new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); });
  let next = 1, page = ''; const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>(), problems: string[] = [];
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes)), entry = waiting.get(message.id);
    if (entry) { waiting.delete(message.id); message.error ? entry.fail(new Error(message.error.message)) : entry.done(message.result); return; }
    if (message.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text));
    if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level) && !/WebSocket connection|favicon/.test(message.params.entry.text + message.params.entry.url)) problems.push(`${message.params.entry.level}: ${message.params.entry.text} ${message.params.entry.url || ''}`);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push('console: ' + JSON.stringify(message.params.args));
  });
  const call = (method: string, params: any = {}, where = page): Promise<any> => new Promise((done, fail) => { const id = next++; waiting.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params, ...(where ? { sessionId: where } : {}) })); });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, ''); page = (await call('Target.attachToTarget', { targetId, flatten: true }, '')).sessionId;
  for (const domain of ['Page', 'Runtime', 'Log']) await call(domain + '.enable');
  const evaluate = async (expression: string) => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const size = (width: number, height: number) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const shot = async (name: string) => { const { data } = await call('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name + '.png'), Buffer.from(data, 'base64')); };
  const text = (id: string) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`), visible = (id: string) => evaluate(`(() => { const node = document.getElementById(${JSON.stringify(id)}); return !!node && node.offsetParent !== null; })()`);
  const type = (id: string, value: string) => evaluate(`(() => { const node = document.getElementById(${JSON.stringify(id)}); node.focus(); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const click = (id: string) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);

  await local('remote.browserConfigure', { enabled: true, port }); let made = await local('remote.browserPrepare', { projectPaths: [project], role: 'limited', caps: ['chat.write', 'providers.execute', 'approvals.answer', 'approvals.provider'] });
  await size(1120, 760); await call('Page.navigate', { url: made.urls[0] + '/' }); await until(() => visible('pair').catch(() => false), 'the pairing form'); await shot('pair');
  await type('code', 'WRONG-CODE1'); await type('name', 'Work laptop'); await click('pairSubmit'); await until(() => text('pairError').then((value: string) => /not the code/.test(value)), 'the refusal of a wrong code');
  await type('code', made.code.toLowerCase()); await click('pairSubmit'); await until(() => visible('compare'), 'the six words');
  const words = await text('sas'), { received } = (core.remoteStatus as any).browser.pairing; assert.equal(words, received.sas, 'the same six words on both sides'); assert.equal(received.name, 'Work laptop'); await shot('compare');
  await local('remote.browserConfirm', { pairingId: made.pairingId, sas: words, confirmed: true }); await until(() => visible('workspace'), 'the conversations');
  await until(() => evaluate(`document.querySelectorAll('#sessions button').length`).then((n: number) => n === 2), 'two conversations'); await shot('list');
  // Its keys sign and cannot be taken out.
  assert.equal(await evaluate(`(async () => { const db = await new Promise(done => { const r = indexedDB.open('pal-companion', 1); r.onsuccess = () => done(r.result); }); const self = await new Promise(done => { const r = db.transaction('identity').objectStore('identity').get('self'); r.onsuccess = () => done(r.result); }); db.close(); let out = []; for (const key of [self.connection, self.action]) { try { await crypto.subtle.exportKey('pkcs8', key); out.push('exported'); } catch { out.push(key.extractable ? 'extractable' : 'kept'); } } return out.join(); })()`), 'kept,kept');
  await evaluate(`[...document.querySelectorAll('#sessions button')].find(node => node.textContent.includes('Fix the importer')).click()`); await until(() => evaluate(`document.querySelectorAll('#messages li').length`).then((n: number) => n === 3), 'three messages'); await shot('conversation');
  await type('text', 'Also add a test for it.'); await evaluate(`document.getElementById('composer').requestSubmit()`); await until(() => sends === 1, 'the message'); await until(() => evaluate(`document.getElementById('messages').textContent.includes('Here is what I found.')`), 'the reply');
  assert.equal(await evaluate(`document.querySelectorAll('#messages b').length`), 0, 'markup stays text'); assert.ok((await text('messages')).includes('<b>This is text, not markup.</b>')); assert.equal(await evaluate(`document.getElementById('text').value`), '');
  const asked = core.approval(session.id, { kind: 'provider', title: 'Run the tests?', detail: 'npm test -- importer', choices: ['allow', 'deny'] }); await until(() => visible('showApprovals'), 'the request'); await click('showApprovals'); await until(() => evaluate(`document.querySelectorAll('.request button').length === 2`), 'Deny and Allow'); await shot('request');
  await evaluate(`[...document.querySelectorAll('.request button')].find(node => node.textContent === 'Allow').click()`); await until(() => evaluate(`document.getElementById('confirm').open`), 'the question'); await click('confirmYes'); assert.equal((await asked).choice, 'allow');
  // Narrow, and light.
  await until(() => evaluate(`!document.getElementById('approvals').open`), 'the closed list'); await size(390, 780); await new Promise(done => setTimeout(done, 200)); await shot('narrow-conversation'); assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'nothing is cut off at phone width'); await click('back'); await new Promise(done => setTimeout(done, 200)); await shot('narrow-list');
  await size(1120, 760); await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await new Promise(done => setTimeout(done, 200)); await shot('light');
  // A reload keeps the pairing; revoking ends it here at once.
  await call('Page.reload'); await until(() => visible('workspace').catch(() => false), 'the conversations again'); await local('remote.revoke', { id: gateway.registry.devices()[0].id }); await until(() => visible('pair'), 'the pairing form again'); assert.match(await text('pairError'), /removed this browser/);
  assert.equal(await evaluate(`(async () => { const db = await new Promise(done => { const r = indexedDB.open('pal-companion', 1); r.onsuccess = () => done(r.result); }); const self = await new Promise(done => { const r = db.transaction('identity').objectStore('identity').get('self'); r.onsuccess = () => done(r.result); }); db.close(); return self === undefined; })()`), true, 'and its keys are gone');
  assert.deepEqual(problems, [], 'no error, blocked resource or policy violation'); socket.close(); console.log('PASSED: paired, read, sent, answered, narrow and light, revoked. Screenshots: ' + out);
} finally { browser.kill('SIGKILL'); await new Promise(done => browser.once('close', done)); await gateway.close(); await core.close(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
