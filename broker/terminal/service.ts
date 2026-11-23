/**
 * Broker-owned interactive terminals (PAL Everywhere, handoff §7).
 *
 * Each terminal is a real controlling terminal running a shell on this computer, as the desktop account, in a
 * worker process (native/terminal/pal-terminal.c) that keeps the screen with libvterm. The broker keeps the
 * authoritative screen, a bounded scrollback and the control state, so the desktop and a phone see the same
 * terminal and neither parses escape sequences itself.
 *
 * Lifecycle and control:
 * - States: starting → running → stopping → exited, or interrupted (the broker restarted; nothing reruns) and
 *   unknown (a stop that could not be confirmed). Watching is separate from the process: closing a screen or
 *   losing a phone's connection detaches the view and the shell keeps running.
 * - One input controller at a time. Taking control issues a lease bound to the principal, the terminal and a
 *   new input epoch; the previous controller's lease ends at once. Input frames carry the lease, epoch and a
 *   sequence number that must be exactly the next one: a repeated frame is acknowledged as a duplicate and never
 *   written again, a gap is refused. After a lost acknowledgement the client asks for the input status instead of
 *   resending. If the worker dies after input was accepted, the epoch rotates and the terminal is marked so the
 *   person inspects the recovered screen; no record can make a process effect happen exactly once.
 * - Input is never stored (passwords typed into `sudo` stay in the pipe), and terminal output never reaches a
 *   model unless the person shares a selection.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteError } from '../execution.ts';
import { terminalKeys } from '../remote/owner-schemas.ts';
export { terminalKeys };

export type Run = [col: number, text: string, fg: number, bg: number, attrs: number];
export type TerminalPrincipal = { kind: 'local' } | { kind: 'device'; deviceId: string; name?: string };
export type TerminalState = 'starting' | 'running' | 'stopping' | 'exited' | 'interrupted' | 'unknown';
export type InputEvent = { text: string } | { paste: string } | { key: TerminalKey; mods?: number } | { char: number; mods?: number };
export type TerminalKey = (typeof terminalKeys)[number];

/** Starting operational limits (handoff §7.4); measured and adjustable, not product ceilings. */
export const terminalLimits = { running: 4, inputBytes: 64 * 1024, scrollbackLines: 10_000, scrollbackBytes: 6 * 1024 * 1024, keptRecords: 20, stopMs: 10_000 };

type Controller = { principal: TerminalPrincipal; leaseId: string; revision: number; epoch: number; lastSequence: number; acquired: number };
type Terminal = {
  id: string; title: string; shell: string; shellName: string; cwd: string; created: number; updated: number; state: TerminalState;
  owner: TerminalPrincipal; sessionId?: string; pid?: number; exitCode?: number; exitSignal?: number; leftover?: number;
  stopReport?: { signalled: number; killed: number; remaining: number }; note?: string;
  controller: Controller | null; controllerRevision: number; epoch: number;
  rows: number; cols: number; lines: Run[][]; cursor: [number, number, number]; alt: boolean; revision: number;
  scrollback: Run[][]; scrollBytes: number; scrollFirst: number; dropped: number; foreground?: { pgid: number; name: string };
  worker?: ChildProcess; stopped?: Promise<void>;
};
type Persisted = Pick<Terminal, 'id' | 'title' | 'shell' | 'shellName' | 'cwd' | 'created' | 'updated' | 'state' | 'owner' | 'sessionId' | 'exitCode' | 'exitSignal' | 'note'>;
type StoreLike = { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };

const keyCodes: Record<TerminalKey, number> = { enter: 1, tab: 2, backspace: 3, escape: 4, up: 5, down: 6, left: 7, right: 8, insert: 9, delete: 10, home: 11, end: 12, pageup: 13, pagedown: 14,
  f1: 101, f2: 102, f3: 103, f4: 104, f5: 105, f6: 106, f7: 107, f8: 108, f9: 109, f10: 110, f11: 111, f12: 112 };
const same = (a: TerminalPrincipal, b: TerminalPrincipal) => a.kind === b.kind && (a.kind === 'local' || a.deviceId === (b as { deviceId: string }).deviceId);
const frame = (type: string, payload: Buffer = Buffer.alloc(0)) => { const head = Buffer.alloc(5); head[0] = type.charCodeAt(0); head.writeUInt32BE(payload.length, 1); return Buffer.concat([head, payload]); };
const lineBytes = (line: Run[]) => line.reduce((sum, run) => sum + run[1].length + 16, 8);

/** The worker binary: installed beside the broker (share/pal/native) or built in build/. */
export function workerPath(): string | undefined {
  const configured = process.env.PAL_TERMINAL_WORKER || process.env.CERE_TERMINAL_WORKER;
  if (configured) { try { accessSync(configured, constants.X_OK); return configured; } catch { return undefined; } }
  for (const url of ['../../native/pal-terminal', '../../build/pal-terminal'].map(path => new URL(path, import.meta.url))) {
    const path = fileURLToPath(url);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch {}
  }
  return undefined;
}

export class TerminalService extends EventEmitter {
  private terminals = new Map<string, Terminal>();
  private store: StoreLike;
  private closed = false;
  constructor(store: StoreLike) {
    super();
    this.store = store;
    // A broker restart ends every terminal it ran: they are shown as interrupted and never started again.
    for (const record of store.get<Persisted[]>('terminals', [])) {
      const interrupted = ['starting', 'running', 'stopping'].includes(record.state);
      this.terminals.set(record.id, { ...record, state: interrupted ? 'interrupted' : record.state, note: interrupted ? 'PAL restarted while this terminal was running; its commands were not run again.' : record.note,
        controller: null, controllerRevision: 0, epoch: 0, rows: 24, cols: 80, lines: [], cursor: [0, 0, 0], alt: false, revision: 0, scrollback: [], scrollBytes: 0, scrollFirst: 0, dropped: 0 });
    }
    this.persist();
  }

  /** The shells this computer offers, by absolute path; Bash is offered even when the login shell is another. */
  profiles() {
    const candidates: [string, string, string[]][] = [['bash', 'Bash', ['/usr/bin/bash', '/bin/bash']], ['fish', 'Fish', ['/usr/bin/fish', '/bin/fish']], ['zsh', 'Zsh', ['/usr/bin/zsh', '/bin/zsh']], ['sh', 'POSIX sh', ['/usr/bin/sh', '/bin/sh']]];
    const shells = candidates.map(([id, label, paths]) => ({ id, label, path: paths.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }) || '' })).filter(shell => shell.path);
    const login = this.loginShell();
    const preferred = shells.find(shell => shell.path === login || basename(shell.path) === basename(login))?.id || shells[0]?.id || '';
    return { shells, default: preferred, host: hostLabel(), account: userInfo().username, worker: workerPath() ? 'available' : 'missing', limits: terminalLimits,
      ...(workerPath() ? {} : { unavailableReason: 'The terminal helper (pal-terminal) is not installed. Rebuild or reinstall PAL.' }) };
  }
  private loginShell() {
    try { const line = readFileSync('/etc/passwd', 'utf8').split('\n').find(row => row.split(':')[0] === userInfo().username); const shell = line?.split(':')[6]; if (shell && existsSync(shell)) return shell; } catch {}
    return process.env.SHELL || '/bin/sh';
  }
  dto(t: Terminal) {
    return { id: t.id, title: t.title, shell: t.shellName, shellPath: t.shell, cwd: t.cwd, state: t.state, created: t.created, updated: t.updated, host: hostLabel(), account: userInfo().username,
      profile: 'desktop-account', owner: t.owner.kind === 'local' ? { kind: 'local' } : { kind: 'device', deviceId: t.owner.deviceId, name: t.owner.name || '' },
      controller: t.controller ? { kind: t.controller.principal.kind, ...(t.controller.principal.kind === 'device' ? { deviceId: t.controller.principal.deviceId, name: t.controller.principal.name } : {}), revision: t.controller.revision, epoch: t.controller.epoch } : null,
      controllerRevision: String(t.controllerRevision), rows: t.rows, cols: t.cols, revision: t.revision, foreground: t.foreground || null,
      ...(t.sessionId ? { sessionId: t.sessionId } : {}), ...(t.exitCode !== undefined ? { exitCode: t.exitCode, exitSignal: t.exitSignal ?? 0 } : {}), ...(t.leftover ? { leftover: t.leftover } : {}),
      ...(t.stopReport ? { stopReport: t.stopReport } : {}), ...(t.note ? { note: t.note } : {}), scrollback: { first: t.scrollFirst, count: t.scrollback.length, dropped: t.dropped } };
  }
  list() { return [...this.terminals.values()].sort((a, b) => b.created - a.created).map(t => this.dto(t)); }
  get(id: string) { const t = this.terminals.get(id); if (!t) throw remoteError('INVALID_ARGUMENT', 'That terminal no longer exists.'); return t; }
  /** The whole screen now, for a new viewer or one that missed a frame. */
  snapshot(id: string) { const t = this.get(id); return { terminal: this.dto(t), screen: { rows: t.rows, cols: t.cols, lines: t.lines, cursor: t.cursor, alt: t.alt, revision: t.revision } }; }

  create(principal: TerminalPrincipal, p: { shell?: string; cwd?: string; sessionId?: string; title?: string; rows?: number; cols?: number }) {
    if (this.closed) throw remoteError('REMOTE_DISABLED', 'PAL is shutting down.');
    const worker = workerPath();
    if (!worker) throw remoteError('DEPENDENCY_MISSING', 'The terminal helper (pal-terminal) is not installed. Rebuild or reinstall PAL.');
    if ([...this.terminals.values()].filter(t => ['starting', 'running', 'stopping'].includes(t.state)).length >= terminalLimits.running) throw remoteError('LIMIT_EXCEEDED', `At most ${terminalLimits.running} terminals run at once. Close one first.`);
    const profiles = this.profiles(), wanted = !p.shell || p.shell === 'default' ? profiles.default : p.shell;
    const shell = profiles.shells.find(entry => entry.id === wanted);
    if (!shell) throw remoteError('DEPENDENCY_MISSING', `${wanted || 'That shell'} is not installed on this computer.`);
    const cwd = p.cwd || homedir();
    try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { throw remoteError('INVALID_ARGUMENT', 'That folder does not exist on this computer.'); }
    const rows = Math.max(4, Math.min(300, Math.round(p.rows ?? 32))), cols = Math.max(10, Math.min(500, Math.round(p.cols ?? 80)));
    const now = Date.now(), id = randomUUID();
    const t: Terminal = { id, title: (p.title || `${shell.label} · ${basename(cwd) || cwd}`).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80), shell: shell.path, shellName: shell.id, cwd, created: now, updated: now,
      state: 'starting', owner: principal, ...(p.sessionId ? { sessionId: p.sessionId } : {}), controller: null, controllerRevision: 0, epoch: 0,
      rows, cols, lines: [], cursor: [0, 0, 1], alt: false, revision: 0, scrollback: [], scrollBytes: 0, scrollFirst: 0, dropped: 0 };
    const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color', COLORTERM: 'truecolor', PAL_TERMINAL: '1', LANG: process.env.LANG || 'C.UTF-8' };
    delete env.PAL_MCP_TOKEN; delete env.PAL_STATE_TOKEN; delete env.CERE_MCP_TOKEN; delete env.CERE_STATE_TOKEN;
    const child = spawn(worker, ['--shell', shell.path, '--cwd', cwd, '--rows', String(rows), '--cols', String(cols)], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    t.worker = child;
    this.terminals.set(id, t);
    this.attachWorker(t, child);
    const lease = this.grant(t, principal);
    this.prune(); this.persist(); this.changed(t);
    return { terminal: this.dto(t), lease };
  }

  private attachWorker(t: Terminal, child: ChildProcess) {
    let pending = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line) continue;
        try { this.onFrame(t, JSON.parse(line)); } catch { /* a malformed frame is ignored; the next snapshot repairs the view */ }
      }
    });
    child.stdin!.on('error', () => {});
    child.on('error', error => { if (t.state === 'starting') { t.state = 'exited'; t.note = 'The terminal could not start: ' + error.message.slice(0, 200); this.persist(); this.changed(t); } });
    child.on('exit', () => {
      if (t.worker !== child) return;
      t.worker = undefined;
      if (t.state === 'running' || t.state === 'starting') {
        // The worker ended without reporting the shell's exit: the processes' outcome is not known.
        t.state = 'unknown'; t.note = 'The terminal helper stopped unexpectedly. Its programs may still have been running; inspect the last screen.';
        if (t.controller) { t.controller = null; t.epoch++; t.controllerRevision++; }
      } else if (t.state === 'stopping') { t.state = t.stopReport?.remaining ? 'unknown' : 'exited'; }
      t.updated = Date.now(); this.persist(); this.changed(t);
    });
  }

  private onFrame(t: Terminal, f: any) {
    switch (f.t) {
      case 'ready': t.state = 'running'; t.pid = f.pid; t.updated = Date.now(); this.persist(); this.changed(t); break;
      case 'screen': {
        const base = t.revision;
        t.rows = f.rows; t.cols = f.cols; t.cursor = f.cursor; t.alt = !!f.alt; t.revision++;
        if (f.full) t.lines = f.lines;
        else { if (t.lines.length !== t.rows) t.lines = Array.from({ length: t.rows }, (_, i) => t.lines[i] || []); for (const [row, line] of Object.entries(f.changed as Record<string, Run[]>)) t.lines[Number(row)] = line; }
        if (t.lines.length > t.rows) t.lines.length = t.rows;
        this.emit('screen', t.id, f.full ? { id: t.id, base, rev: t.revision, full: true, rows: t.rows, cols: t.cols, cursor: t.cursor, alt: t.alt, lines: t.lines }
          : { id: t.id, base, rev: t.revision, full: false, rows: t.rows, cols: t.cols, cursor: t.cursor, alt: t.alt, changed: f.changed });
        break;
      }
      case 'scroll': {
        for (const line of f.lines as Run[][]) { t.scrollback.push(line); t.scrollBytes += lineBytes(line); }
        t.dropped += f.dropped || 0;
        while (t.scrollback.length > terminalLimits.scrollbackLines || t.scrollBytes > terminalLimits.scrollbackBytes) { const line = t.scrollback.shift()!; t.scrollBytes -= lineBytes(line); t.scrollFirst++; }
        this.emit('scroll', t.id, { id: t.id, count: f.lines.length, dropped: f.dropped || 0, last: t.scrollFirst + t.scrollback.length });
        break;
      }
      case 'scrollclear': t.scrollFirst += t.scrollback.length; t.scrollback = []; t.scrollBytes = 0; break;
      case 'title': if (typeof f.text === 'string' && f.text.trim()) { t.title = f.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80); t.updated = Date.now(); this.changed(t); } break;
      case 'fg': t.foreground = { pgid: f.pgid, name: String(f.name || '').slice(0, 40) }; this.changed(t); break;
      case 'bell': this.emit('bell', t.id); break;
      case 'stopped': t.stopReport = { signalled: f.signalled, killed: f.killed, remaining: f.remaining }; break;
      case 'exit':
        t.exitCode = f.code; t.exitSignal = f.signal; t.leftover = f.leftover || 0;
        t.state = t.stopReport?.remaining ? 'unknown' : 'exited';
        if (t.stopReport?.remaining) t.note = `${t.stopReport.remaining} process${t.stopReport.remaining === 1 ? '' : 'es'} did not stop. Check them on the desktop.`;
        t.controller = null; t.controllerRevision++; t.updated = Date.now(); this.persist(); this.changed(t);
        break;
      case 'error': this.emit('notice', t.id, { code: String(f.code || 'error'), message: String(f.message || '').slice(0, 200) }); break;
    }
  }

  private grant(t: Terminal, principal: TerminalPrincipal) {
    t.epoch++; t.controllerRevision++;
    t.controller = { principal, leaseId: randomUUID(), revision: t.controllerRevision, epoch: t.epoch, lastSequence: 0, acquired: Date.now() };
    return { leaseId: t.controller.leaseId, epoch: t.epoch, controllerRevision: String(t.controllerRevision), lastSequence: 0 };
  }
  /** Takes input control. The previous controller's lease ends; nothing it sent later is written. */
  acquire(principal: TerminalPrincipal, id: string, expectedControllerRevision: string, size?: { rows?: number; cols?: number }) {
    const t = this.live(id);
    if (String(t.controllerRevision) !== expectedControllerRevision) throw remoteError('REVISION_CONFLICT', 'Someone else took control of this terminal. Review it and try again.');
    const lease = this.grant(t, principal);
    if (size?.rows && size?.cols) this.write(t, frame('r', Buffer.from([size.rows >> 8, size.rows & 255, size.cols >> 8, size.cols & 255])));
    this.changed(t);
    return { terminal: this.dto(t), lease };
  }
  private live(id: string) {
    const t = this.get(id);
    if (!['starting', 'running'].includes(t.state) || !t.worker) throw remoteError('INVALID_ARGUMENT', 'This terminal is not running.');
    return t;
  }
  private lease(t: Terminal, principal: TerminalPrincipal, leaseId: string, epoch?: number) {
    const c = t.controller;
    if (!c || c.leaseId !== leaseId || !same(c.principal, principal) || (epoch !== undefined && c.epoch !== epoch)) throw remoteError('REVISION_CONFLICT', 'You no longer control this terminal. Take control again to type.');
    return c;
  }
  /**
   * One ordered input frame. Accepted means written to the terminal's input pipe; the acknowledgement names the
   * sequence. A frame already accepted is answered as a duplicate and not written again.
   */
  input(principal: TerminalPrincipal, id: string, leaseId: string, epoch: number, sequence: number, events: InputEvent[]) {
    const t = this.live(id), c = this.lease(t, principal, leaseId, epoch);
    if (sequence <= c.lastSequence) return { accepted: false, duplicate: true, lastSequence: c.lastSequence, epoch: c.epoch };
    if (sequence !== c.lastSequence + 1) throw remoteError('REVISION_CONFLICT', `Input arrived out of order (expected ${c.lastSequence + 1}). Check the terminal before typing again.`);
    const frames: Buffer[] = []; let bytes = 0;
    for (const event of events) {
      if ('text' in event) { const data = Buffer.from(event.text, 'utf8'); bytes += data.length; frames.push(frame('t', data)); }
      else if ('paste' in event) { const data = Buffer.from(event.paste, 'utf8'); bytes += data.length; frames.push(frame('p', data)); }
      else if ('key' in event) frames.push(frame('k', Buffer.from([keyCodes[event.key], (event.mods ?? 0) & 7])));
      else { const code = Buffer.alloc(5); code[0] = (event.mods ?? 0) & 7; code.writeUInt32BE(event.char >>> 0, 1); frames.push(frame('u', code)); }
    }
    if (bytes > terminalLimits.inputBytes) throw remoteError('LIMIT_EXCEEDED', 'Paste at most 64 KiB at a time.');
    c.lastSequence = sequence;
    this.write(t, Buffer.concat(frames));
    return { accepted: true, duplicate: false, lastSequence: sequence, epoch: c.epoch };
  }
  /** What the terminal accepted from this lease: asked after a lost acknowledgement instead of resending. */
  inputStatus(principal: TerminalPrincipal, id: string, leaseId: string, epoch: number) {
    const t = this.get(id), c = t.controller;
    const current = !!c && c.leaseId === leaseId && same(c.principal, principal) && c.epoch === epoch;
    return { current, lastSequence: current ? c!.lastSequence : null, epoch: t.epoch, controllerRevision: String(t.controllerRevision), state: t.state };
  }
  resize(principal: TerminalPrincipal, id: string, leaseId: string, rows: number, cols: number) {
    const t = this.live(id); this.lease(t, principal, leaseId);
    this.write(t, frame('r', Buffer.from([rows >> 8, rows & 255, cols >> 8, cols & 255])));
    return true;
  }
  /** Interrupts the foreground job (SIGINT to its process group). Any viewer allowed here may do it, like Stop. */
  interrupt(id: string) { const t = this.live(id); this.write(t, frame('i')); return { interrupted: true, foreground: t.foreground?.name || null }; }
  /** Gives up control without stopping anything. */
  release(principal: TerminalPrincipal, id: string) {
    const t = this.get(id);
    if (t.controller && same(t.controller.principal, principal)) { t.controller = null; t.controllerRevision++; t.epoch++; this.changed(t); }
    return true;
  }
  /** Stops the shell and every process it started; resolves with the confirmed outcome. */
  async close(id: string) {
    const t = this.get(id);
    if (!t.worker || !['starting', 'running', 'stopping'].includes(t.state)) return this.dto(t);
    if (t.state !== 'stopping') {
      t.state = 'stopping'; t.updated = Date.now(); this.changed(t);
      const worker = t.worker;
      t.stopped = new Promise<void>(resolve => {
        const timer = setTimeout(() => { if (t.worker === worker) { worker.kill('SIGKILL'); t.state = 'unknown'; t.note = 'Stopping did not finish in time; some programs may still be running.'; this.persist(); this.changed(t); } resolve(); }, terminalLimits.stopMs);
        timer.unref();
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      this.write(t, frame('x'));
    }
    await t.stopped;
    return this.dto(t);
  }
  /** Scrollback above the screen, oldest first, by absolute line number. */
  history(id: string, before?: number, limit = 200) {
    const t = this.get(id), end = Math.min(before ?? t.scrollFirst + t.scrollback.length, t.scrollFirst + t.scrollback.length), start = Math.max(t.scrollFirst, end - limit);
    return { first: t.scrollFirst, start, end, dropped: t.dropped, lines: t.scrollback.slice(start - t.scrollFirst, end - t.scrollFirst) };
  }
  /** A device lost its authority: its leases end, and terminals it started are stopped. */
  async revoked(deviceId: string) {
    const stops: Promise<unknown>[] = [];
    for (const t of this.terminals.values()) {
      if (t.controller?.principal.kind === 'device' && t.controller.principal.deviceId === deviceId) { t.controller = null; t.controllerRevision++; t.epoch++; this.changed(t); }
      if (t.owner.kind === 'device' && t.owner.deviceId === deviceId && ['starting', 'running'].includes(t.state)) stops.push(this.close(t.id).catch(() => {}));
    }
    await Promise.all(stops);
  }
  /** Removes a finished terminal from the list. */
  forget(id: string) { const t = this.get(id); if (['starting', 'running', 'stopping'].includes(t.state)) throw remoteError('INVALID_ARGUMENT', 'Stop the terminal first.'); this.terminals.delete(id); this.persist(); this.emit('removed', id); return true; }
  async closeAll() {
    this.closed = true;
    await Promise.all([...this.terminals.values()].filter(t => t.worker).map(t => this.close(t.id).catch(() => {})));
  }
  private write(t: Terminal, data: Buffer) {
    if (!t.worker?.stdin?.writable) throw remoteError('INVALID_ARGUMENT', 'This terminal is not running.');
    t.worker.stdin.write(data);
  }
  private changed(t: Terminal) { this.emit('state', t.id, this.dto(t)); }
  private prune() {
    const finished = [...this.terminals.values()].filter(t => !['starting', 'running', 'stopping'].includes(t.state)).sort((a, b) => b.updated - a.updated);
    for (const t of finished.slice(terminalLimits.keptRecords)) this.terminals.delete(t.id);
  }
  private persist() {
    const records: Persisted[] = [...this.terminals.values()].map(({ id, title, shell, shellName, cwd, created, updated, state, owner, sessionId, exitCode, exitSignal, note }) =>
      ({ id, title, shell, shellName, cwd, created, updated, state, owner, ...(sessionId ? { sessionId } : {}), ...(exitCode !== undefined ? { exitCode, exitSignal } : {}), ...(note ? { note } : {}) }));
    this.store.set('terminals', records);
  }
}

let cachedHost = '';
/** The computer's name, shown on every terminal so the desktop's paths are never mistaken for the phone's. */
export function hostLabel() {
  if (cachedHost) return cachedHost;
  try { cachedHost = readFileSync('/etc/hostname', 'utf8').trim(); } catch {}
  return cachedHost ||= 'this computer';
}
