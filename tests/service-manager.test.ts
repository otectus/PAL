import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { ServiceManager, runCommand, validateLocalServices } from '../broker/service-manager.ts';

const wait = async (what: () => boolean | Promise<boolean>, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await what()) return true; await new Promise(done => setTimeout(done, 50)); } return false; };
const port = () => new Promise<number>(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as any; server.close(() => done(port)); }); });
/** A core whose Ollama is a program in its own folder, at a port of its own. */
async function fixture(t: any, options: { program?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pal-services-')), bin = join(root, 'bin'), path = process.env.PATH; await mkdir(bin);
  if (options.program !== undefined) { await writeFile(join(bin, 'ollama'), `#!${process.execPath}\n${options.program}\n`); await chmod(join(bin, 'ollama'), 0o755); }
  process.env.PATH = bin + delimiter + '/usr/bin' + delimiter + '/bin';
  const core = new Core(new Store(join(root, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }) as any), at = await port();
  await core.updateSettings({ ollama: { host: `http://127.0.0.1:${at}` } });
  t.after(async () => { process.env.PATH = path; await core.close(); await rm(root, { recursive: true, force: true }); });
  return { core, at, root, services: core.services };
}
/** A systemd that only remembers, so every decision can be seen without starting anything. */
function pretend(services: ServiceManager, options: { refuse?: string; memory?: string; supported?: boolean } = {}) {
  const units = new Map<string, string>(), calls: string[][] = [], up = new Set<number>();
  services.run = async (file, args) => {
    calls.push([file, ...args]); const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (options.supported === false && file !== 'bash') return { code: 1, stdout: '', stderr: 'Failed to connect to bus' };
    if (file === 'bash') return options.memory === undefined ? { code: 1, stdout: '', stderr: 'no such file' } : ok(options.memory);
    if (file === 'journalctl') return ok('\x1b[31mline one\x1b[0m\nline two\u0007\n');
    if (file === 'systemd-run') { if (options.refuse) return { code: 1, stdout: '', stderr: options.refuse }; units.set(args.find(arg => arg.startsWith('--unit='))!.slice(7), 'active'); return ok(); }
    if (args[1] === 'stop') { units.delete(args[2]); return ok(); }
    if (args[1] === 'show' && args[2].endsWith('.service')) { const active = units.get(args[2]); return ok(`LoadState=${active ? 'loaded' : 'not-found'}\nActiveState=${active || 'inactive'}\nResult=success\nControlGroup=${active === 'active' ? '/app.slice/' + args[2] : ''}\nTransient=${active ? 'yes' : 'no'}\n`); }
    return ok('Version=262\n');
  };
  services.answers = async (_host, port) => up.has(port); services.listens = async (group, port) => !!group && up.has(port);
  return { units, calls, up, ran: (file: string) => calls.filter(call => call[0] === file) };
}
const row = async (services: ServiceManager, id = 'ollama') => (await services.list()).services.find(item => item.id === id)!;

test('A07 nothing is managed until chosen, and what is chosen is exactly what PAL may start', async t => {
  const { core, services, at } = await fixture(t, { program: '' }), system = pretend(services, { memory: 'installed=yes\nconfigured=no\n' });
  assert.deepEqual(core.settings.localServices, { managed: [], autostart: [] });
  await assert.rejects(services.start('ollama'), /Let PAL run Ollama first/); await assert.rejects(services.restart('ollama'), /Let PAL run/); await assert.rejects(services.start('docker'), /Unknown local service/);
  await services.autostart(); assert.equal(system.ran('systemd-run').length, 0);
  await core.rpc('settings.update', { localServices: { managed: ['ollama'], autostart: ['ollama', 'memory'] } });
  assert.deepEqual(core.settings.localServices, { managed: ['ollama'], autostart: ['ollama'] }, 'only a managed service starts with PAL');
  for (const bad of [null, [], { managed: ['x'] }, { managed: 'ollama' }, { other: 1 }]) assert.throws(() => validateLocalServices(bad, core.settings.localServices));
  assert.deepEqual(validateLocalServices({ managed: [] }, core.settings.localServices), { managed: [], autostart: [] });
  // The command line: a unit of this profile's own, bounded recovery, and the address PAL itself uses.
  await services.start('ollama'); const [, ...args] = system.ran('systemd-run')[0];
  assert.ok(args.includes(`--unit=${services.unitName('ollama')}`)); assert.match(services.unitName('ollama'), /^pal-[0-9a-f]{10}-ollama\.service$/);
  assert.ok(args.includes(`--setenv=OLLAMA_HOST=127.0.0.1:${at}`)); assert.deepEqual(args.slice(-2)[1], 'serve'); assert.ok(args.includes('StartLimitBurst=3') && args.includes('Restart=on-failure'));
  assert.equal((await row(services)).state, 'starting'); system.up.add(at); await services.settling.get('ollama');
  assert.deepEqual([(await row(services)).state, (await row(services)).owner], ['ready', 'pal']);
  await assert.rejects(services.start('ollama'), /already running/);
  assert.notEqual(services.unitName('ollama'), new ServiceManager({ store: { directory: '/another/profile' } } as any).unitName('ollama'), 'another profile has other units');
  assert.match((await services.log('ollama')).text, /^line one\nline two$/);
});

test('A07 what someone else started is used, never stopped, restarted or replaced', async t => {
  const { core, services, at } = await fixture(t, { program: '' }), system = pretend(services);
  await core.updateSettings({ localServices: { managed: ['ollama', 'memory'], autostart: ['ollama'] } });
  system.up.add(at); const before = await row(services); assert.deepEqual([before.state, before.owner], ['ready', 'external']);
  await assert.rejects(services.start('ollama'), /something PAL did not start already answers there/);
  await assert.rejects(services.stop('ollama'), /PAL did not start Ollama/); await assert.rejects(services.restart('ollama'), /PAL did not start Ollama/);
  await services.autostart(); assert.deepEqual([system.ran('systemd-run').length, system.calls.filter(call => call[2] === 'stop').length], [0, 0]);
  // A unit file under PAL's name that PAL did not create is not PAL's either.
  system.up.clear(); const run = services.run;
  services.run = async (file, args, timeout) => file === 'systemctl' && args[1] === 'show' && args[2].endsWith('.service') ? { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nResult=success\nControlGroup=/x\nTransient=no\n', stderr: '' } : run(file, args, timeout);
  await assert.rejects(services.start('ollama'), /PAL did not create exists/); await assert.rejects(services.stop('ollama'), /PAL did not start/);
});

test('A07 a start that cannot work says why, fails once, and takes nothing else down', async t => {
  const { core, services } = await fixture(t, { program: '' });
  await core.updateSettings({ localServices: { managed: ['ollama', 'memory'] }, memory: { enabled: true } });
  let system = pretend(services, { supported: false }); assert.equal((await services.list()).supported, false); await assert.rejects(services.start('ollama'), /systemd user session/);
  system = pretend(services, { refuse: '\x1b[1mUnit refused\x1b[0m\nmore' }); await assert.rejects(services.start('ollama'), /could not be started: Unit refused$/); assert.match((await row(services)).problem, /Unit refused/);
  // The databases: not here, not installed, not configured, or set up on another computer.
  for (const [memory, why] of [[undefined, /not part of this installation/], ['installed=no\nconfigured=yes\n', /not installed/], ['installed=yes\nconfigured=no\n', /no private settings file/]] as const) { system = pretend(services, { memory }); await assert.rejects(services.start('memory'), why); assert.equal(system.ran('systemd-run').length, 0); }
  process.env.PAL_QDRANT_URL = 'https://vectors.example:6333'; try { assert.match((await row(services, 'memory')).unavailable, /another address/); } finally { delete process.env.PAL_QDRANT_URL; }
  await core.updateSettings({ ollama: { host: 'http://192.168.5.5:11434' } }); assert.match((await row(services)).unavailable, /another address/); await assert.rejects(services.start('ollama'), /another address/);
  // Without its databases memory still keeps and finds what it is told: SQLite is the record, the databases are projections.
  const session = await core.create({ provider: 'codex', cwd: tmpdir(), trusted: true }); await core.memory.ready;
  await core.memory.save(core.store.session(session.id), 'The launch colour is tangerine.');
  assert.match(JSON.stringify(await core.memory.list(core.store.session(session.id))), /tangerine/);
});

test('A07 nothing is stopped under a conversation or a download, and one change runs at a time', async t => {
  const { core, services, at, root } = await fixture(t, { program: '' }), system = pretend(services);
  await core.updateSettings({ localServices: { managed: ['ollama'] } });
  await services.start('ollama'); system.up.add(at); await services.settling.get('ollama');
  const session: any = { id: 'busy', provider: 'ollama', mode: 'managed', cwd: root, title: 'T', status: 'working', created: 1, updated: 1, model: 'm' }; core.store.saveSession(session);
  assert.match((await row(services)).blocking, /conversation is using it/); await assert.rejects(services.stop('ollama'), /conversation is using it/); await assert.rejects(services.restart('ollama'), /conversation is using it/);
  core.store.saveSession({ ...session, status: 'idle' }); core.localModels.job = { model: 'm', status: 'x', completed: 0, total: 0, started: 0, controller: new AbortController() };
  await assert.rejects(services.stop('ollama'), /being downloaded/); core.localModels.job = undefined;
  const stopping = services.stop('ollama'); await assert.rejects(services.stop('ollama'), /already being started or stopped/); await stopping;
  assert.equal(system.units.size, 0);
  // It started, and then never answered: the row says so and nothing is retried.
  system.up.clear(); await services.start('ollama'); system.units.set(services.unitName('ollama'), 'failed'); await services.settling.get('ollama');
  const failed = await row(services); assert.deepEqual([failed.state, failed.owner], ['failed', 'none']); assert.match(failed.problem, /stopped with an error/); assert.equal(system.ran('systemd-run').length, 2);
});

const user = (await runCommand('systemd-run', ['--user', '--scope', '--quiet', '--collect', '/usr/bin/true'], 10_000)).code === 0;
const server = `import {createServer} from 'node:http';const [host,port]=process.env.OLLAMA_HOST.split(':');if(process.argv[2]!=='serve')process.exit(2);createServer((q,r)=>r.end('{}')).listen(Number(port),host);console.log('serving');`;
test('A07 with a real user manager: a started service is in PAL’s own unit, and stopping it leaves every other process alone', { skip: !user && 'no systemd user session here' }, async t => {
  const { core, services } = await fixture(t, { program: server }), unit = services.unitName('ollama');
  t.after(async () => { await runCommand('systemctl', ['--user', 'stop', unit], 30_000); await runCommand('systemctl', ['--user', 'reset-failed', unit]); });
  await core.updateSettings({ localServices: { managed: ['ollama'] } });
  await services.start('ollama'); await services.settling.get('ollama');
  const started = await row(services); assert.deepEqual([started.state, started.owner, started.problem], ['ready', 'pal', '']);
  assert.match((await services.log('ollama')).text, /serving/);
  // The same address, answered by a process outside the unit, is someone else's, even while a unit of PAL's runs.
  const other = createServer(socket => socket.destroy()), elsewhere = await port(); await new Promise<void>(done => other.listen(elsewhere, '127.0.0.1', done)); t.after(() => other.close());
  const mine = core.settings.ollama.host; await core.updateSettings({ ollama: { host: `http://127.0.0.1:${elsewhere}` } });
  assert.equal((await row(services)).owner, 'external');
  await core.updateSettings({ ollama: { host: mine } });
  await services.stop('ollama'); assert.ok(await wait(async () => (await row(services)).state === 'stopped'));
  assert.equal(other.listening, true, 'another process is untouched');
  assert.equal((await runCommand('systemctl', ['--user', 'show', unit, '-p', 'LoadState', '--value'])).stdout.trim(), 'not-found');
  await assert.rejects(services.stop('ollama'), /PAL did not start Ollama/);
});

test('A07 with a real user manager: a program that keeps failing is tried three times and then stays stopped', { skip: !user && 'no systemd user session here' }, async t => {
  const { core, services, root } = await fixture(t, { program: `import {appendFileSync} from 'node:fs';appendFileSync(process.env.XDG_STATE_HOME+'/tries','x');console.error('cannot bind');process.exit(1);` }), unit = services.unitName('ollama');
  const state = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = root;
  t.after(async () => { if (state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = state; await runCommand('systemctl', ['--user', 'stop', unit], 30_000); await runCommand('systemctl', ['--user', 'reset-failed', unit]); });
  await core.updateSettings({ localServices: { managed: ['ollama'] } });
  await services.start('ollama').catch(() => {}); await services.settling.get('ollama');
  assert.ok(await wait(async () => (await row(services)).state === 'failed', 25_000)); await new Promise(done => setTimeout(done, 2500));
  const { readFile } = await import('node:fs/promises'); assert.equal((await readFile(join(root, 'tries'), 'utf8')).length, 3);
  assert.match((await services.log('ollama')).text, /cannot bind/); assert.equal((await row(services)).owner, 'none');
});
