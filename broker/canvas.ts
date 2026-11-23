/**
 * Canvas (PAL Everywhere §13.1): an interactive, isolated preview of HTML, CSS and JavaScript from a conversation's
 * workspace folder, the same on the desktop and on a phone.
 *
 * The preview is an immutable snapshot of the entry file's folder, served only on 127.0.0.1 under a random
 * per-preview path, with a content security policy that allows nothing beyond the snapshot. It renders in a
 * separate headless browser with its own empty profile, no extensions, and every host name except 127.0.0.1
 * unresolvable, so generated pages cannot reach the network, the broker, the owner's browser profile or anything
 * else. Clients see rendered frames and send typed input (click, type, scroll, keys); page JavaScript never gets an
 * IPC channel, credentials or a file handle. Console messages and failed requests are collected and shown.
 * Annotations bind a note to the element under a point (selector, box and a cropped screenshot) and the snapshot
 * revision they were made on. Reload takes a new snapshot; nothing is ever published.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { WebSocket } from 'ws';
import type { Core } from './core.ts';
import { remoteError } from './execution.ts';

export const canvasLimits = { files: 300, bytes: 25 * 1024 * 1024, previews: 4, console: 200, annotations: 50, frameQuality: 70 };
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const csp = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

type Snapshot = { files: Map<string, Buffer>; revision: string; entry: string; root: string };
type Annotation = { id: string; revision: string; note: string; selector: string; box: { x: number; y: number; width: number; height: number }; text: string; artifact?: { artifactId: string; versionId: string }; time: number };
type Preview = { id: string; sessionId: string; rootId: string; path: string; token: string; snapshot: Snapshot; width: number; height: number; mobile: boolean;
  targetId?: string; cdpSession?: string; console: { level: string; text: string; time: number }[]; annotations: Annotation[]; created: number; frameRevision: number; url: string };

/** A minimal Chrome DevTools Protocol client over one browser WebSocket (flattened target sessions). */
class Cdp {
  ws: WebSocket; next = 1; pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(); handlers: ((m: any) => void)[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => {
      let message: any; try { message = JSON.parse(String(data)); } catch { return; }
      if (message.id && this.pending.has(message.id)) { const waiter = this.pending.get(message.id)!; this.pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message || 'DevTools error')); else waiter.resolve(message.result); return; }
      for (const handler of this.handlers) handler(message);
    });
    ws.on('close', () => { for (const waiter of this.pending.values()) waiter.reject(new Error('The preview browser closed')); this.pending.clear(); });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The preview browser did not respond in time. Reopen the preview.'));
      }, 20_000);
      this.pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
      });
    });
  }
}

export class Canvas {
  core: Core;
  private previews = new Map<string, Preview>();
  private server?: Server; private port = 0;
  private browser?: ChildProcess; private cdp?: Cdp; private profile?: string; private starting?: Promise<Cdp>;
  constructor(core: Core) { this.core = core; }

  browserPath(): string | undefined {
    const configured = process.env.PAL_CANVAS_BROWSER || process.env.CERE_CANVAS_BROWSER;
    if (configured) return existsSync(configured) ? configured : undefined;
    for (const dir of ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/snap/bin']) for (const name of ['google-chrome-stable', 'chromium', 'chromium-browser', 'google-chrome', 'chrome']) { const path = join(dir, name); if (existsSync(path)) return path; }
    return undefined;
  }
  status() { const browser = this.browserPath(); return { available: !!browser, browser: browser || null, ...(browser ? {} : { unavailableReason: 'Canvas needs Chromium or Google Chrome installed on this computer. Without it, files show as source only.' }), previews: [...this.previews.values()].map(p => this.dto(p)) }; }
  dto(p: Preview) { return { id: p.id, sessionId: p.sessionId, rootId: p.rootId, path: p.path, revision: p.snapshot.revision, width: p.width, height: p.height, mobile: p.mobile, files: p.snapshot.files.size, consoleCount: p.console.length, annotations: p.annotations.length, created: p.created, frameRevision: p.frameRevision }; }
  private get(id: string, sessionId?: string) { const p = this.previews.get(id); if (!p || (sessionId && p.sessionId !== sessionId)) throw remoteError('INVALID_ARGUMENT', 'That preview is closed. Open it again.'); return p; }
  list(sessionId: string) { return [...this.previews.values()].filter(p => p.sessionId === sessionId).map(p => this.dto(p)); }

  /** An immutable snapshot of the entry's folder, read beneath the workspace folder and never through links. */
  private async snapshot(rootPath: string, path: string): Promise<Snapshot> {
    const root = await realpath(rootPath), entryFull = await realpath(join(root, path));
    if (!entryFull.startsWith(root + sep)) throw new Error('The page must be inside this workspace folder');
    if (!/\.(?:html?|svg)$/i.test(entryFull)) throw new Error('Choose an HTML or SVG file to preview');
    const base = dirname(entryFull), files = new Map<string, Buffer>(); let total = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > 8) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name), info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!info.isFile() || files.size >= canvasLimits.files || total + info.size > canvasLimits.bytes) continue;
        total += info.size; files.set(relative(base, full).split(sep).join('/'), await readFile(full));
      }
    };
    await walk(base, 0);
    const entry = relative(base, entryFull).split(sep).join('/');
    if (!files.has(entry)) throw new Error('This file could not be included in the Canvas snapshot. Choose a smaller page or folder.');
    const revision = createHash('sha256').update([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => name + '\0' + createHash('sha256').update(data).digest('hex')).join('\n')).digest('hex').slice(0, 16);
    return { files, revision, entry, root: base };
  }
  private async serve() {
    if (this.server) return;
    this.server = createServer((req, res) => {
      const [, token, ...rest] = (req.url || '/').split('?')[0].split('/');
      const preview = [...this.previews.values()].find(p => p.token === token);
      let name: string;
      try { name = decodeURIComponent(rest.join('/') || 'index.html'); } catch { res.writeHead(400); res.end(); return; }
      const data = preview?.snapshot.files.get(name);
      if (req.method !== 'GET' || !preview || !data) { res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Security-Policy': csp }); res.end('Not part of this preview'); return; }
      res.writeHead(200, { 'Content-Type': types[extname(name).toLowerCase()] || 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(data);
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }
  private async browserCdp(): Promise<Cdp> {
    if (this.cdp && this.cdp.ws.readyState === WebSocket.OPEN) return this.cdp;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const path = this.browserPath();
      if (!path) throw remoteError('DEPENDENCY_MISSING', 'Canvas needs Chromium or Google Chrome installed on this computer.');
      this.profile = await mkdtemp(join(tmpdir(), 'pal-canvas-'));
      const child = spawn(path, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-default-apps', '--password-store=basic',
        '--metrics-recording-only', '--mute-audio', '--no-pings', '--deny-permission-prompts', `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--remote-allow-origins=http://127.0.0.1',
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
      this.browser = child;
      const url = await new Promise<string>((resolve, reject) => {
        let text = ''; const timer = setTimeout(() => reject(new Error('The preview browser did not start')), 20_000);
        child.stderr!.on('data', chunk => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } if (text.length > 100_000) text = text.slice(-10_000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('The preview browser exited')); });
      });
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const cdp = new Cdp(ws);
      cdp.handlers.push(message => this.event(message));
      child.on('exit', () => { this.cdp = undefined; for (const p of this.previews.values()) { p.targetId = undefined; p.cdpSession = undefined; } });
      this.cdp = cdp; return cdp;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private event(message: any) {
    const preview = [...this.previews.values()].find(p => p.cdpSession && p.cdpSession === message.sessionId);
    if (!preview) return;
    const push = (level: string, text: string) => { preview.console.push({ level, text: text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000), time: Date.now() }); if (preview.console.length > canvasLimits.console) preview.console.shift(); };
    if (message.method === 'Runtime.consoleAPICalled') push(message.params.type, (message.params.args || []).map((arg: any) => arg.value ?? arg.description ?? '').join(' '));
    else if (message.method === 'Runtime.exceptionThrown') push('error', message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Uncaught exception');
    else if (message.method === 'Log.entryAdded') push(message.params.entry.level, (message.params.entry.url ? message.params.entry.url + ': ' : '') + message.params.entry.text);
    else if (message.method === 'Page.loadEventFired') preview.frameRevision++;
  }
  private async attach(preview: Preview) {
    const cdp = await this.browserCdp();
    if (!preview.targetId) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      preview.targetId = targetId; preview.cdpSession = sessionId;
      for (const domain of ['Page.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable']) await cdp.send(domain, {}, sessionId);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: preview.width, height: preview.height, deviceScaleFactor: 1, mobile: preview.mobile }, preview.cdpSession);
    return cdp;
  }
  private async navigate(preview: Preview) {
    const cdp = await this.attach(preview);
    preview.url = `http://127.0.0.1:${this.port}/${preview.token}/${preview.snapshot.entry.split('/').map(encodeURIComponent).join('/')}`;
    await cdp.send('Page.navigate', { url: preview.url }, preview.cdpSession);
    await new Promise(resolve => setTimeout(resolve, 400));
    preview.frameRevision++;
  }

  async open(p: { sessionId: string; rootId: string; path: string; width?: number; height?: number; mobile?: boolean }) {
    const root = this.core.workbench.roots.get(p.sessionId, p.rootId);
    if (this.previews.size >= canvasLimits.previews) throw remoteError('LIMIT_EXCEEDED', 'Close another preview first.');
    await this.serve();
    const preview: Preview = { id: randomUUID(), sessionId: p.sessionId, rootId: root.id, path: p.path, token: randomBytes(24).toString('base64url'), snapshot: await this.snapshot(root.path, p.path),
      width: Math.max(240, Math.min(2560, p.width || 1280)), height: Math.max(240, Math.min(2560, p.height || 800)), mobile: p.mobile === true, console: [], annotations: [], created: Date.now(), frameRevision: 0, url: '' };
    this.previews.set(preview.id, preview);
    try { await this.navigate(preview); } catch (error) { this.previews.delete(preview.id); throw error; }
    this.core.store.activity({ action: 'canvas.open', sessionId: p.sessionId, path: p.path, status: 'completed' });
    return this.dto(preview);
  }
  /** Takes a new snapshot of the folder (a new revision) and loads it. */
  async reload(id: string, sessionId?: string) {
    const preview = this.get(id, sessionId), root = this.core.workbench.roots.get(preview.sessionId, preview.rootId);
    preview.snapshot = await this.snapshot(root.path, preview.path); preview.console = [];
    await this.navigate(preview); return this.dto(preview);
  }
  async resize(id: string, width: number, height: number, mobile: boolean, sessionId?: string) {
    const preview = this.get(id, sessionId); preview.width = Math.max(240, Math.min(2560, Math.round(width))); preview.height = Math.max(240, Math.min(2560, Math.round(height))); preview.mobile = mobile;
    await this.attach(preview); preview.frameRevision++; return this.dto(preview);
  }
  /** The rendered page now, as a bounded JPEG. */
  async frame(id: string, sessionId?: string) {
    const preview = this.get(id, sessionId), cdp = await this.attach(preview);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: canvasLimits.frameQuality, captureBeyondViewport: false }, preview.cdpSession);
    return { id, revision: preview.snapshot.revision, frameRevision: preview.frameRevision, width: preview.width, height: preview.height, data: 'data:image/jpeg;base64,' + shot.data };
  }
  /** Typed input at a point of the frame (0–1 coordinates) or as text and keys; the page only ever sees input events. */
  async input(id: string, p: { kind: 'click' | 'type' | 'key' | 'scroll'; x?: number; y?: number; text?: string; key?: string; deltaY?: number }, sessionId?: string) {
    const preview = this.get(id, sessionId), cdp = await this.attach(preview), s = preview.cdpSession;
    const x = Math.max(0, Math.min(1, p.x ?? 0.5)) * (preview.width - 1), y = Math.max(0, Math.min(1, p.y ?? 0.5)) * (preview.height - 1);
    if (p.kind === 'click') { for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s); }
    else if (p.kind === 'scroll') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.max(-5000, Math.min(5000, p.deltaY ?? 400)) }, s);
    else if (p.kind === 'type') await cdp.send('Input.insertText', { text: String(p.text || '').slice(0, 10_000) }, s);
    else if (p.kind === 'key') {
      const keys: Record<string, { key: string; code: string; keyCode: number; text?: string }> = { Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 } };
      const key = keys[p.key || ''];
      if (!key) throw new Error('Choose Enter, Tab, Backspace, Escape or an arrow key');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, ...(key.text ? { text: key.text } : {}) }, s);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode }, s);
    }
    await new Promise(resolve => setTimeout(resolve, 120)); preview.frameRevision++;
    return { frameRevision: preview.frameRevision };
  }
  console(id: string, sessionId?: string) { return this.get(id, sessionId).console; }
  /** The element at a point: a CSS selector, its box and text, for annotations and for model inspection. */
  private async elementAt(preview: Preview, x: number, y: number) {
    const cdp = await this.attach(preview), s = preview.cdpSession;
    const node = await cdp.send('DOM.getNodeForLocation', { x: Math.min(preview.width - 1, Math.round(x * preview.width)), y: Math.min(preview.height - 1, Math.round(y * preview.height)), includeUserAgentShadowDOM: false }, s);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, s);
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){let e=this.nodeType===1?this:this.parentElement;const r=e.getBoundingClientRect();const path=[];for(let n=e;n&&n.nodeType===1&&path.length<8;n=n.parentElement){let s=n.tagName.toLowerCase();if(n.id){s+='#'+CSS.escape(n.id);path.unshift(s);break;}const same=[...(n.parentElement?n.parentElement.children:[])].filter(c=>c.tagName===n.tagName);if(same.length>1)s+=':nth-of-type('+(same.indexOf(n)+1)+')';path.unshift(s);}return {selector:path.join(' > '),box:{x:r.x,y:r.y,width:r.width,height:r.height},text:(e.innerText||e.textContent||'').trim().slice(0,300)};}` }, s);
    return result.value as { selector: string; box: Annotation['box']; text: string };
  }
  async annotate(id: string, p: { x: number; y: number; note: string }, sessionId?: string) {
    const preview = this.get(id, sessionId);
    if (preview.annotations.length >= canvasLimits.annotations) throw new Error('Remove older annotations first');
    const element = await this.elementAt(preview, p.x, p.y), cdp = await this.attach(preview);
    const clip = { x: Math.max(0, element.box.x - 8), y: Math.max(0, element.box.y - 8), width: Math.max(16, Math.min(preview.width, element.box.width + 16)), height: Math.max(16, Math.min(preview.height, element.box.height + 16)), scale: 1 };
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip }, preview.cdpSession);
    const version = await this.core.workbench.artifacts.install({ sessionId: preview.sessionId, bytes: Buffer.from(shot.data, 'base64'), name: `annotation – ${element.selector.slice(-40).replace(/[\\/:*?"<>|]+/g, ' ')}.png`, mime: 'image/png', source: 'derived',
      policy: { remote: false, cloud: false }, provenance: { kind: 'canvas-annotation', revision: preview.snapshot.revision, selector: element.selector.slice(0, 500), path: preview.path } });
    const annotation: Annotation = { id: randomUUID(), revision: preview.snapshot.revision, note: String(p.note || '').slice(0, 2000), selector: element.selector, box: element.box, text: element.text, artifact: { artifactId: version.artifactId, versionId: version.versionId }, time: Date.now() };
    preview.annotations.push(annotation);
    return annotation;
  }
  annotations(id: string, sessionId?: string) { const preview = this.get(id, sessionId); return preview.annotations.map(a => ({ ...a, current: a.revision === preview.snapshot.revision })); }
  /** A full-page screenshot kept as an artifact of the conversation, tied to the snapshot revision. */
  async screenshot(id: string, sessionId?: string) {
    const preview = this.get(id, sessionId), cdp = await this.attach(preview);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, preview.cdpSession);
    return this.core.workbench.artifacts.install({ sessionId: preview.sessionId, bytes: Buffer.from(shot.data, 'base64'), name: `preview – ${preview.path.split('/').pop()}.png`, mime: 'image/png', source: 'derived',
      policy: { remote: false, cloud: false }, provenance: { kind: 'canvas-screenshot', revision: preview.snapshot.revision, path: preview.path, width: preview.width, height: preview.height } });
  }
  /** Bounded DOM text of the page or one element (selector), for a model to check its own work. */
  async inspect(id: string, selector?: string, sessionId?: string) {
    const preview = this.get(id, sessionId), cdp = await this.attach(preview);
    const { result } = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const e=${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.documentElement'};if(!e)return null;const r=e.getBoundingClientRect();return {html:e.outerHTML.slice(0,16000),text:(e.innerText||e.textContent||'').slice(0,8000),box:{x:r.x,y:r.y,width:r.width,height:r.height},title:document.title}})()` }, preview.cdpSession);
    if (!result.value) throw new Error(`No element matches ${selector}`);
    return { ...result.value, revision: preview.snapshot.revision, console: preview.console.slice(-20) };
  }
  async clickSelector(id: string, selector: string, sessionId?: string) {
    const preview = this.get(id, sessionId), found = await this.inspect(id, selector, sessionId);
    return this.input(id, { kind: 'click', x: (found.box.x + found.box.width / 2) / preview.width, y: (found.box.y + found.box.height / 2) / preview.height }, sessionId);
  }
  /** The snapshot's files as one ZIP artifact, to keep or share. */
  async export(id: string, sessionId?: string) {
    const preview = this.get(id, sessionId), { zipFilesAsync } = await import('./artifacts/zip.ts');
    const bytes = await zipFilesAsync([...preview.snapshot.files.entries()].map(([name, data]) => ({ name, data })));
    return this.core.workbench.artifacts.install({ sessionId: preview.sessionId, bytes, name: `${preview.path.split('/').pop()?.replace(/\.html?$/i, '') || 'canvas'} source.zip`, mime: 'application/zip', source: 'derived',
      policy: { remote: false, cloud: false }, provenance: { kind: 'canvas-export', revision: preview.snapshot.revision, files: preview.snapshot.files.size } });
  }
  async close(id: string, sessionId?: string) {
    const preview = this.get(id, sessionId);
    this.previews.delete(id);
    if (preview.targetId && this.cdp) await this.cdp.send('Target.closeTarget', { targetId: preview.targetId }).catch(() => {});
    if (!this.previews.size) await this.shutdown();
    return true;
  }
  async shutdown() {
    this.previews.clear();
    try { this.cdp?.ws.close(); } catch {}
    this.cdp = undefined;
    if (this.browser && this.browser.exitCode === null) { this.browser.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(resolve, 3000); this.browser!.once('exit', () => { clearTimeout(timer); resolve(null); }); }); }
    this.browser = undefined;
    if (this.profile) { await rm(this.profile, { recursive: true, force: true }).catch(() => {}); this.profile = undefined; }
    if (this.server) { await new Promise<void>(resolve => this.server!.close(() => resolve())); this.server = undefined; }
  }
}
