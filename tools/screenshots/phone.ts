/**
 * Takes the gallery's phone images: pairs PAL Mobile on an Android emulator with the demo desktop that run.sh
 * prepares, gives it full access and walks through its screens.
 *
 *   ANDROID_SERIAL=emulator-5554 tools/screenshots/run.sh --phone
 *
 * The emulator needs the debug app and its test APK (`:app:installDebug :app:installDebugAndroidTest`). The app's
 * data is cleared first. Only an emulator is accepted, never a connected phone.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { brokerFrameLimit } from '../../broker/fanout.ts';
import { parsePairing } from '../../broker/remote/crypto.ts';
import { JsonLines } from '../../broker/wire.ts';

const out = process.env.PAL_SCREENSHOTS_DIR!, serial = process.env.ANDROID_SERIAL!, app = 'dev.otectus.cere.mobile.debug', home = process.env.HOME!;
if (!/^emulator-\d+$/.test(serial)) throw new Error('Only an emulator');
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const adb = (args: string[], options: { timeout?: number; optional?: boolean } = {}) => new Promise<Buffer>((done, reject) =>
  execFile('adb', ['-s', serial, ...args], { encoding: 'buffer', timeout: options.timeout ?? 60_000, maxBuffer: 1 << 25 }, (error, stdout, stderr) => error && !options.optional ? reject(new Error(`adb ${args[0]} ${args[1]}: ${stderr}`)) : done(stdout)));
const shell = async (...args: string[]) => (await adb(['shell', ...args], { optional: true })).toString();
async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms = 30_000) {
  for (const end = Date.now() + ms; ;) { const value = await check().catch(() => undefined); if (value) return value; if (Date.now() > end) throw new Error('Timed out waiting for ' + what); await wait(400); }
}
const rpc = (method: string, params: any = {}) => new Promise<any>((done, reject) => {
  const socket = net.createConnection(join(process.env.PAL_RUNTIME_DIR!, 'broker.sock')), lines = new JsonLines(brokerFrameLimit);
  socket.setEncoding('utf8'); socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
  socket.on('data', chunk => lines.push(String(chunk), (m: any) => { if (m.id === 1) { socket.destroy(); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : done(m.result); } }));
});
const freePort = () => new Promise<number>(done => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => done(port)); }); });

type Node = { text: string; description: string; box: number[] };
async function nodes(): Promise<Node[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await shell('uiautomator', 'dump', '--compressed', '/sdcard/w.xml');
    const xml = (await adb(['exec-out', 'cat', '/sdcard/w.xml'], { optional: true })).toString();
    if (!xml.includes('<hierarchy')) { await wait(400); continue; }
    const clean = (value = '') => value.replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map(([, raw]) => { const value = Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]])); return { text: clean(value.text), description: clean(value['content-desc']), box: (value.bounds?.match(/\d+/g) ?? []).map(Number) }; });
  }
  return [];
}
const find = async (label: string, last = false) => { const all = await nodes(), match = (test: (value: string) => boolean) => all.filter(n => test(n.text) || test(n.description)); const exact = match(v => v === label), near = exact.length ? exact : match(v => v.startsWith(label)); return last ? near.at(-1) : near[0]; };
const tap = async (label: string, last = false) => { const node = await until(label, () => find(label, last)); await shell('input', 'tap', String((node.box[0] + node.box[2]) >> 1), String((node.box[1] + node.box[3]) >> 1)); await wait(1200); };
const seen = (label: string, ms?: number) => until(label, () => find(label), ms);
const back = async () => { await shell('input', 'keyevent', 'BACK'); await wait(900); };
async function shot(name: string) { await wait(1200); await writeFile(join(out, name + '.png'), await sharp(await adb(['exec-out', 'screencap', '-p'])).resize({ width: 540 }).png({ compressionLevel: 9, palette: true }).toBuffer()); console.log('saved', name); }

await until('the demo desktop', () => rpc('remote.status'), 40_000);
const port = await freePort();
await adb(['reverse', `tcp:${port}`, `tcp:${port}`]); await adb(['shell', 'pm', 'clear', app]);
for (const permission of ['POST_NOTIFICATIONS', 'ACCESS_LOCAL_NETWORK', 'CAMERA', 'RECORD_AUDIO']) await shell('pm', 'grant', app, 'android.permission.' + permission);
await shell('settings', 'put', 'global', 'sysui_demo_allowed', '1');
const now = new Date().toTimeString().slice(0, 5).replace(':', '');
for (const extra of ['-e command enter', `-e command clock -e hhmm ${now}`, '-e command battery -e level 100 -e plugged false', '-e command network -e wifi show -e level 4', '-e command notifications -e visible false']) await shell('am', 'broadcast', '-a', 'com.android.systemui.demo', ...extra.split(' '));
await shell('cmd', 'uimode', 'night', 'yes');
const prepared = await rpc('remote.preparePair', { addresses: ['127.0.0.1'], port, name: 'Demo desktop', actionAuthentication: 'trusted-device' }), offer = parsePairing(prepared.uri);
const pairing = adb(['shell', 'am', 'instrument', '-w', '-e', 'class', 'dev.otectus.pal.mobile.UsbPairingSetupTest#pairFromExplicitUsbOffer', '-e', 'palPairingOffer', prepared.uri, app + '.test/androidx.test.runner.AndroidJUnitRunner'], { timeout: 180_000 });
const phone = await until('the phone’s answer', async () => { const text = (await adb(['exec-out', 'run-as', app, 'cat', 'files/usb-pairing-response.json'], { optional: true })).toString(); return text.startsWith('{') && JSON.parse(text); }, 90_000);
const review = await rpc('remote.reviewPair', { response: phone.response });
if (review.sas !== phone.sas) throw new Error('The six words differ');
const projects = ['aurora-web', 'lumen', 'tidepool', 'dotfiles'].map(name => `${home}/Projects/${name}`);
await rpc('remote.confirmPair', { response: phone.response, sas: review.sas, confirmed: true, projectPaths: projects, caps: ['chat.read', 'chat.write', 'approvals.answer', 'providers.execute', 'approvals.provider', 'settings.write', 'desktop.control'], categories: ['timers'], scriptIds: [] });
await shell('run-as', app, 'touch', 'files/usb-pairing-desktop-confirmed'); await pairing;
await rpc('remote.setRole', { id: phone.deviceId, role: 'owner', confirmed: true });
console.log('paired', offer.desktopId ? 'yes' : 'no');
await shell('am', 'force-stop', app); await shell('monkey', '-p', app, '-c', 'android.intent.category.LAUNCHER', '1');
await seen('Chats', 60_000);
if (process.argv.includes('--hold')) { console.log('Holding; stop with Ctrl+C'); setInterval(() => {}, 1 << 30); await new Promise(() => {}); }

// A project conversation with its folder, and a deploy command that waits for an answer.
const drafts = await rpc('session.create', { provider: 'ollama', model: 'gpt-oss:20b', cwd: `${home}/Projects/aurora-web`, trusted: true, title: 'Review offline drafts', capabilities: { files: true, images: true, analysis: true } });
await rpc('workspace.addRoot', { sessionId: drafts.id, path: `${home}/Projects/aurora-web`, policy: { write: true, organize: true } });
await rpc('session.send', { id: drafts.id, text: 'Look at how offline drafts are saved and synced. What should change before we freeze the schema?' });
await wait(4000);
await shot('mobile-chats');
await tap('Plan the 2.4 release'); await seen('Message PAL'); await shot('mobile-conversation'); await back();
await tap('Review offline drafts'); await seen('Message PAL'); await tap('Chat options'); await tap('Voice settings'); await shot('mobile-voice'); await back(); await back();
if (!await find('Chats')) await back();
await tap('Work', true); await seen('aurora-web'); await wait(1500); await shot('mobile-work');
const deploy = await rpc('session.create', { provider: 'codex', model: 'gpt-6.2-sol', effort: 'low', cwd: `${home}/Projects/tidepool`, trusted: true, title: 'Deploy the pipeline to staging' });
await rpc('session.send', { id: deploy.id, text: 'Ship the reviewed build to staging so QA can start.' });
await tap('Inbox', true); await seen('Deploy', 30_000); await wait(1500); await shot('mobile-inbox');
await tap('Settings', true); await tap('This computer'); await shot('mobile-computer');
await shell('am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit');
await adb(['reverse', '--remove', `tcp:${port}`], { optional: true });
process.exit(0);
