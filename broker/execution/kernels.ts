/**
 * Analysis sessions: a Python namespace that stays between cells, for exploring data step by step (PAL Everywhere §15.2).
 *
 * A session is started and ended by the person, belongs to one conversation, and runs inside the same boundary as Code
 * Lab: no network, read-only inputs, nothing of the user's visible. Its state lives only in that process. It is never
 * saved or restored, and it ends when it is stopped, when it has been idle for a while, at its age limit, or when PAL
 * closes. Because a cell can depend on cells before it, each result records the session and its place in it, says so
 * wherever it is shown, and cannot be saved as a replayable analysis; "Make a notebook" starts the same cells clean.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Workbench } from '../workbench.ts';
import type { ArtifactRef, DestinationPolicy } from '../tools/contracts.ts';
import { strictest } from '../tools/contracts.ts';
import { privateDir } from '../paths.ts';
import { safeName } from '../artifacts/store.ts';
import type { Operation } from '../operations/store.ts';
import { pythonRuntime, startSandbox } from './runner.ts';
import { recipeFile, helperDigest } from './recipes.ts';

export const kernelLimits = { kernels: 2, idleMs: 30 * 60_000, ageMs: 8 * 60 * 60_000, startMs: 20_000, codeBytes: 64 * 1024, inputs: 16, cells: 200, timeoutSeconds: 600, interruptMs: 5000, drainMs: 60, controlLine: 512 * 1024, output: 256 * 1024, fileBytes: 32 * 1024 * 1024, files: 20, variables: 200 };
export type KernelVariable = { name: string; type: string; detail: string };
type Cell = { operationId: string; code: string; codeRef: ArtifactRef; state: string; purpose: string };
type Running = { cell: number; operationId: string; resolve: (event: { ok: boolean; problem: string }) => void; stdout: string; stderr: string; truncated: boolean; files: Map<string, Buffer[]>; bytes: number; finished: string[]; note: () => void };
type Kernel = {
  id: string; sessionId: string; started: number; used: number; state: 'starting' | 'idle' | 'running' | 'stopping';
  scratch: string; inputs: { artifactId: string; versionId: string; name: string; path: string }[]; policy: DestinationPolicy | undefined;
  stop: () => void; send: (command: Record<string, unknown>) => void; ended: Promise<void>;
  cells: Cell[]; sinceClear: number; variables: KernelVariable[]; running?: Running; ready: () => void; endReason: string;
  idle?: NodeJS.Timeout; age?: NodeJS.Timeout; unlist: () => void;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, length: number) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, length) : '';

export class Kernels {
  workbench: Workbench;
  private kernels = new Map<string, Kernel>();
  private starting = new Set<string>();
  /** Why the last session of a conversation ended, until a new one starts. */
  private ended = new Map<string, { at: number; reason: string; cells: number }>();
  constructor(workbench: Workbench) { this.workbench = workbench; }
  private get core() { return this.workbench.core; }
  status(sessionId: string) {
    const kernel = this.kernels.get(sessionId), ended = this.ended.get(sessionId);
    return { available: this.workbench.execution.enabled(), limits: { idleMinutes: kernelLimits.idleMs / 60_000, hours: kernelLimits.ageMs / 3_600_000 },
      session: kernel ? { id: kernel.id, state: kernel.state, started: kernel.started, cells: kernel.cells.map((cell, index) => ({ number: index + 1, operationId: cell.operationId, state: cell.state, purpose: cell.purpose, code: cell.code.slice(0, 4000) })), sinceClear: kernel.sinceClear, variables: kernel.variables,
        inputs: kernel.inputs.map(({ path, ...input }) => ({ ...input, path })), runningOperationId: kernel.running?.operationId || '', idleEnds: kernel.used + kernelLimits.idleMs, ends: kernel.started + kernelLimits.ageMs } : null,
      ended: !kernel && ended ? ended : null };
  }
  running() { return [...this.kernels.values()].map(kernel => ({ sessionId: kernel.sessionId, id: kernel.id, started: kernel.started, state: kernel.state })); }
  /** The strictest rule of everything this session was given: its output can only go where all of it may. */
  policy(sessionId: string) { return this.kernels.get(sessionId)?.policy; }
  private kernel(sessionId: string) { const kernel = this.kernels.get(sessionId); if (!kernel) throw Object.assign(new Error(this.ended.get(sessionId)?.reason || 'No analysis session is running in this conversation'), { code: 'no_session' }); return kernel; }

  async start(sessionId: string, p: { inputs?: unknown } = {}) {
    const session = this.core.store.session(sessionId);
    if (session.temporary) throw new Error('Temporary conversations stay text-only');
    if (!this.workbench.execution.enabled()) throw Object.assign(new Error('Code Lab is turned off. Turn it on in Settings → Connections → Images & analysis.'), { code: 'disabled' });
    if (this.kernels.has(sessionId) || this.starting.has(sessionId)) throw new Error('This conversation already has an analysis session');
    if (this.kernels.size + this.starting.size >= kernelLimits.kernels) throw new Error(`Up to ${kernelLimits.kernels} analysis sessions run at once. Stop one first.`);
    if ((await pythonRuntime()).python === 'unavailable') throw Object.assign(new Error('Desktop Python is unavailable'), { code: 'isolation_unavailable' });
    this.starting.add(sessionId);
    let scratch = '';
    try {
      scratch = await mkdtemp(join(privateDir(join(this.core.store.directory, 'runs')), 'session-'));
      await mkdir(join(scratch, 'input'), { mode: 0o700 });
      await writeFile(join(scratch, 'inputs.json'), '[]', { mode: 0o600 }); await writeFile(join(scratch, 'parameters.json'), '{}', { mode: 0o600 });
      const { child, stop, control } = await startSandbox({ argv: ['/usr/bin/python3', '-I', '-u', '/work/session.py'], cwd: '/work', limits: { processes: 48, wallMs: kernelLimits.ageMs },
        binds: [{ source: join(import.meta.dirname, 'session.py'), target: '/work/session.py' }, { source: recipeFile('lab_data'), target: '/work/lab/lab_data.py' }, { source: join(scratch, 'input'), target: '/work/input' },
          { source: join(scratch, 'inputs.json'), target: '/work/inputs.json' }, { source: join(scratch, 'parameters.json'), target: '/work/parameters.json' }] });
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const kernel: Kernel = { id: randomUUID(), sessionId, started: Date.now(), used: Date.now(), state: 'starting', scratch, inputs: [], policy: undefined, stop, cells: [], sinceClear: 0, variables: [], ready, endReason: '',
        send: command => { try { child.stdin!.write(JSON.stringify(command) + '\n'); } catch { /* it ended */ } }, ended: Promise.resolve(), unlist: () => {} };
      child.stdin!.on('error', () => {});
      let startProblem = '';
      child.stdout!.on('data', chunk => this.output(kernel, 'stdout', chunk)); child.stderr!.on('data', chunk => { if (kernel.state === 'starting') startProblem = (startProblem + chunk.toString('utf8')).slice(-500); this.output(kernel, 'stderr', chunk); });
      this.events(kernel, control);
      kernel.ended = new Promise<void>(resolve => { const finish = () => { this.finished(kernel); resolve(); }; child.once('close', finish); child.once('error', error => { startProblem ||= error.message; finish(); }); });
      this.kernels.set(sessionId, kernel); this.ended.delete(sessionId);
      const timer = setTimeout(() => stop(), kernelLimits.startMs);
      await Promise.race([started, kernel.ended]); clearTimeout(timer);
      if (this.kernels.get(sessionId) !== kernel) { this.ended.delete(sessionId); throw new Error('The analysis session could not start' + (startProblem ? ': ' + startProblem.trim().split('\n').at(-1) : '')); }
      kernel.state = 'idle'; kernel.unlist = this.core.jobs.add('codelab', 'Analysis session', () => void this.stop(sessionId));
      kernel.age = setTimeout(() => this.end(kernel, 'The analysis session reached its 8-hour limit and ended. Its state was not kept.'), kernelLimits.ageMs); kernel.age.unref();
      this.touch(kernel);
      if (p.inputs !== undefined) await this.add(kernel, p.inputs);
      this.core.changed();
      return this.status(sessionId);
    } catch (error) { if (scratch && !this.kernels.has(sessionId)) await rm(scratch, { recursive: true, force: true }); throw error; } finally { this.starting.delete(sessionId); }
  }
  private touch(kernel: Kernel) { kernel.used = Date.now(); clearTimeout(kernel.idle); kernel.idle = setTimeout(() => this.end(kernel, 'The analysis session ended after 30 minutes without use. Its state was not kept.'), kernelLimits.idleMs); kernel.idle.unref(); }
  private end(kernel: Kernel, reason: string) { if (this.kernels.get(kernel.sessionId) !== kernel) return; kernel.endReason ||= reason; kernel.state = 'stopping'; kernel.stop(); }
  private finished(kernel: Kernel) {
    if (this.kernels.get(kernel.sessionId) !== kernel) return;
    this.kernels.delete(kernel.sessionId); clearTimeout(kernel.idle); clearTimeout(kernel.age); kernel.unlist();
    this.ended.set(kernel.sessionId, { at: Date.now(), reason: kernel.endReason || 'The analysis session ended unexpectedly (it may have run out of memory). Its state is gone.', cells: kernel.cells.length });
    kernel.running?.resolve({ ok: false, problem: this.ended.get(kernel.sessionId)!.reason });
    void rm(kernel.scratch, { recursive: true, force: true }).catch(() => {});
    if (!this.core.closed) this.core.changed();
  }
  private output(kernel: Kernel, stream: 'stdout' | 'stderr', chunk: Buffer) {
    const running = kernel.running; if (!running) return;
    const space = kernelLimits.output - running.stdout.length - running.stderr.length, piece = chunk.toString('utf8').slice(0, Math.max(0, space));
    if (piece.length < chunk.length) running.truncated = true;
    running[stream] += piece; running.note();
  }
  /** Events come from inside the sandbox: each is bounded and checked before anything believes it. */
  private events(kernel: Kernel, control: NodeJS.ReadableStream) {
    let pending = '';
    control.on('data', (data: Buffer) => {
      pending += data.toString('latin1');
      if (pending.length > kernelLimits.controlLine * 2) { this.end(kernel, 'The analysis session sent an unreadable event and was stopped'); pending = ''; return; }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.event === 'ready' && kernel.state === 'starting') kernel.ready();
        const running = kernel.running;
        if ((event.event === 'done' || event.event === 'cleared') && Array.isArray(event.variables))
          kernel.variables = event.variables.slice(0, kernelLimits.variables).filter((item: any) => item && typeof item.name === 'string').map((item: any) => ({ name: text(item.name, 80), type: text(item.type, 80), detail: text(item.detail, 160) }));
        if (!running || event.cell !== running.cell) continue;
        if (event.event === 'file' && typeof event.name === 'string' && typeof event.data === 'string' && event.data.length <= kernelLimits.controlLine) {
          const name = event.name, part = Buffer.from(event.data, 'base64');
          if (!/^[^\x00-\x1f\\]{1,200}$/.test(name) || name.startsWith('/') || name.split('/').some((piece: string) => piece === '..' || piece === '')) continue;
          running.bytes += part.length;
          if (running.bytes > kernelLimits.fileBytes || (!running.files.has(name) && running.files.size >= kernelLimits.files) || running.finished.includes(name)) continue;
          running.files.set(name, [...(running.files.get(name) || []), part]);
          if (event.last === true) running.finished.push(name);
        } else if (event.event === 'done') { const ok = event.ok === true, problem = text(event.problem, 300); setTimeout(() => running.resolve({ ok, problem }), kernelLimits.drainMs); }
        else if (event.event === 'cleared') running.resolve({ ok: true, problem: '' });
      }
    });
    control.on('error', () => {});
  }
  /** Adds versions to what the session may read; each is a copy that never changes. */
  private async add(kernel: Kernel, value: unknown) {
    if (!Array.isArray(value) || value.length > kernelLimits.inputs || value.some((ref: any) => !ref || typeof ref.artifactId !== 'string')) throw new Error('Choose up to 16 files');
    for (const ref of value as { artifactId: string; versionId?: string }[]) {
      const { version, data } = await this.workbench.artifacts.bytes(kernel.sessionId, ref.artifactId, ref.versionId);
      if (kernel.inputs.some(input => input.versionId === version.versionId)) continue;
      if (kernel.inputs.length >= kernelLimits.inputs) throw new Error('An analysis session reads up to 16 files');
      let name = safeName(version.name, 'input').replace(/\s+/g, '_'); while (kernel.inputs.some(input => basename(input.path) === name)) name = `${kernel.inputs.length + 1}-${name}`;
      await writeFile(join(kernel.scratch, 'input', name), data, { flag: 'wx', mode: 0o400 });
      kernel.inputs.push({ artifactId: version.artifactId, versionId: version.versionId, name: version.name, path: '/work/input/' + name });
      kernel.policy = kernel.policy ? strictest(kernel.policy, version.policy) : version.policy;
    }
    await writeFile(join(kernel.scratch, 'inputs.json'), JSON.stringify(kernel.inputs.map(input => input.path)));
  }
  run(sessionId: string, p: Parameters<Kernels['runInner']>[1]) { return this.workbench.track(this.runInner(sessionId, p)); }
  /** Runs one cell. The operation records the exact code, the inputs, the session and the cell's place in it. */
  private async runInner(sessionId: string, p: { code: unknown; inputs?: unknown; purpose?: unknown; timeoutSeconds?: unknown; origin: 'user' | 'model'; approval: 'user' | 'individual' | 'grant'; turnId?: string; signal?: AbortSignal; accepted?: (operation: Operation) => void }): Promise<Operation> {
    const kernel = this.kernel(sessionId), artifacts = this.workbench.artifacts, ops = this.workbench.operations;
    if (!this.workbench.execution.enabled()) throw Object.assign(new Error('Code Lab is turned off'), { code: 'disabled' });
    if (kernel.state !== 'idle' || kernel.running) throw new Error('The analysis session is busy with another cell');
    if (kernel.cells.length >= kernelLimits.cells) throw new Error('This analysis session has run 200 cells. Make a notebook of it or start a new one.');
    if (typeof p.code !== 'string' || !p.code.trim() || p.code.includes('\0') || Buffer.byteLength(p.code) > kernelLimits.codeBytes) throw new Error('Give 1 byte to 64 KiB of Python');
    const timeout = Math.min(kernelLimits.timeoutSeconds, Math.max(1, Math.floor(Number(p.timeoutSeconds)) || 60)), purpose = typeof p.purpose === 'string' ? p.purpose.trim().slice(0, 300) : '';
    kernel.state = 'running';
    let claimed = false;
    try {
      if (p.inputs !== undefined) await this.add(kernel, p.inputs);
      const refs: ArtifactRef[] = kernel.inputs.map(input => ({ artifactId: input.artifactId, versionId: input.versionId, purpose: 'input' }));
      const policy = kernel.policy || artifacts.inherit(sessionId, []);
      const code = await artifacts.install({ sessionId, bytes: Buffer.from(p.code), name: 'cell.py', source: p.origin === 'model' ? 'tool-output' : 'user-import', ...(p.turnId ? { turnId: p.turnId } : {}), policy, provenance: { kind: 'codelab-code', purpose } });
      const codeRef: ArtifactRef = { artifactId: code.artifactId, versionId: code.versionId, purpose: 'code' }, number = kernel.cells.length + 1;
      const runtime = await pythonRuntime();
      const sessionKernel = { id: kernel.id, started: kernel.started, sequence: number, earlier: kernel.sinceClear };
      const cellRecord = { name: `Cell ${number}`, language: 'python', state: 'running', digest: digest([kernel.id, number, p.code]), results: [] as ArtifactRef[], stdout: '', stderr: '', durationMs: 0 };
      const operation = ops.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'codelab.run', origin: p.origin, label: `Analysis session: ${purpose.slice(0, 80) || `cell ${number}`}`, payloadDigest: digest([kernel.id, number, code.sha256]), witness: { approval: p.approval, kernel: kernel.id, inputs: refs.map(ref => ref.versionId) }, inputs: [...refs, codeRef],
        details: { purpose, runtime, helperDigest, language: 'python', notebook: false, sharedPython: false, approval: p.approval, timeLimitSeconds: timeout, code: codeRef, parameters: {}, sessionKernel, cells: [cellRecord] } });
      const cell: Cell = { operationId: operation.id, code: p.code, codeRef, state: 'running', purpose };
      kernel.cells.push(cell); claimed = true;
      const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
      const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal, began = Date.now();
      ops.transition(operation.id, 'queued'); ops.transition(operation.id, 'running'); p.accepted?.(operation);
      this.workbench.execution.card(operation.id);
      let last = 0, timedOut = false;
      const running: Running = { cell: number, operationId: operation.id, resolve: () => {}, stdout: '', stderr: '', truncated: false, files: new Map(), bytes: 0, finished: [], note: () => {
        if (Date.now() - last < 350) return; last = Date.now();
        try { ops.update(operation.id, { details: { ...operation.details, stdout: running.stdout, stderr: running.stderr, cells: [{ ...cellRecord, stdout: running.stdout.slice(-16_000), stderr: running.stderr.slice(-16_000) }] } }); } catch { /* it ended */ }
      } };
      const outcome = new Promise<{ ok: boolean; problem: string }>(resolve => { running.resolve = resolve; });
      kernel.running = running;
      // Stopping a cell interrupts it and keeps the session; a cell that does not answer takes the session with it.
      let force: NodeJS.Timeout | undefined;
      const interrupt = () => { kernel.send({ op: 'interrupt' }); force ||= setTimeout(() => this.end(kernel, 'A cell did not stop, so the analysis session was ended. Its state is gone.'), kernelLimits.interruptMs); };
      const limit = setTimeout(() => { timedOut = true; interrupt(); }, timeout * 1000);
      signal.addEventListener('abort', interrupt, { once: true }); if (signal.aborted) interrupt();
      kernel.send({ op: 'run', cell: number, code: p.code });
      const result = await outcome;
      clearTimeout(limit); clearTimeout(force); signal.removeEventListener('abort', interrupt); this.workbench.runControllers.delete(operation.id);
      kernel.running = undefined; kernel.sinceClear++;
      const results: ArtifactRef[] = []; let saveProblem = '';
      for (const name of running.finished) {
        try {
          const version = await artifacts.install({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), bytes: Buffer.concat(running.files.get(name)!), name: basename(name), source: 'tool-output', policy, operationId: operation.id,
            parents: [...refs.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, relation: 'analysis-input' })), { artifactId: codeRef.artifactId, versionId: codeRef.versionId, relation: 'analysis-code' }],
            provenance: { kind: 'codelab', operationId: operation.id, code: code.versionId, path: name, step: 1, sessionKernel: { ...sessionKernel } } });
          results.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: version.kind === 'image' ? 'plot' : 'output' });
        } catch (error: any) { saveProblem = String(error?.message || error).slice(0, 200); }
      }
      const current = ops.get(operation.id), problem = result.problem || saveProblem, stopped = signal.aborted;
      const state = result.ok && !stopped ? 'completed' as const : stopped ? current.state === 'cancel_requested' ? 'cancelled' as const : 'interrupted' as const : 'failed' as const;
      cell.state = state;
      const message = timedOut ? 'Stopped at the time limit' : stopped ? 'Stopped' : running.stderr.trim().split('\n').at(-1)?.slice(0, 500) || problem || 'The cell failed';
      const finished = ops.transition(operation.id, state, { results, details: { ...operation.details, stdout: running.stdout, stderr: running.stderr, truncated: running.truncated, durationMs: Date.now() - began, exitCode: result.ok ? 0 : 1, ...(problem ? { outputNote: problem } : {}),
        cells: [{ ...cellRecord, state, results, stdout: running.stdout.slice(-16_000), stderr: running.stderr.slice(-16_000), durationMs: Date.now() - began }] }, ...(state === 'completed' ? {} : { error: { code: timedOut ? 'timeout' : stopped ? 'cancelled' : 'process_exit', message } }) });
      try { this.core.workflows.observeAction(sessionId, 'codelab.run', { operationId: operation.id }, { exitCode: result.ok ? 0 : 1, durationMs: Date.now() - began }); } catch { /* the conversation was removed */ }
      this.workbench.execution.card(operation.id);
      return finished;
    } finally {
      kernel.running = undefined;
      if (this.kernels.get(sessionId) === kernel) { if (kernel.state === 'running') kernel.state = 'idle'; this.touch(kernel); }
      if (!claimed && this.kernels.get(sessionId) !== kernel) await Promise.resolve();
      if (!this.core.closed) this.core.changed();
    }
  }
  async interrupt(sessionId: string) { const kernel = this.kernel(sessionId); if (!kernel.running) throw new Error('No cell is running'); await this.workbench.cancelRun(kernel.running.operationId); return this.status(sessionId); }
  /** Forgets every variable; the process, its inputs and its cell history stay. */
  async clear(sessionId: string) {
    const kernel = this.kernel(sessionId);
    if (kernel.state !== 'idle') throw new Error('Stop the running cell first');
    kernel.state = 'running';
    try {
      const number = -1 - kernel.cells.length;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The analysis session did not answer')), kernelLimits.interruptMs);
        kernel.running = { cell: number, operationId: '', resolve: outcome => { clearTimeout(timer); if (outcome.ok) resolve(); else reject(new Error(outcome.problem)); }, stdout: '', stderr: '', truncated: false, files: new Map(), bytes: 0, finished: [], note: () => {} };
        kernel.send({ op: 'clear', cell: number });
      });
      kernel.sinceClear = 0; kernel.variables = [];
    } finally { kernel.running = undefined; if (kernel.state === 'running') kernel.state = 'idle'; this.touch(kernel); this.core.changed(); }
    return this.status(sessionId);
  }
  async stop(sessionId: string, reason = 'The analysis session was stopped. Its state was not kept.') {
    const kernel = this.kernel(sessionId);
    this.end(kernel, reason); await kernel.ended;
    return this.status(sessionId);
  }
  /** A clean process with the same inputs. */
  async restart(sessionId: string) {
    const inputs = this.kernel(sessionId).inputs.map(({ artifactId, versionId }) => ({ artifactId, versionId }));
    await this.stop(sessionId, 'The analysis session was restarted.');
    return this.start(sessionId, { inputs });
  }
  /** The session's cells as a Code Lab notebook that starts clean each time: the way to check that a result holds without hidden state. */
  notebook(sessionId: string) {
    const kernel = this.kernel(sessionId), cells = kernel.cells.filter(cell => cell.state === 'completed');
    if (!cells.length) throw new Error('Run a cell first');
    const kept = cells.slice(-12);
    // Code Lab runs up to twelve steps; earlier cells are joined into the first so nothing is left out.
    const steps = cells.length > 12 ? [{ name: 'Earlier cells', language: 'python', code: cells.slice(0, cells.length - 11).map(cell => cell.code).join('\n\n') }, ...cells.slice(-11).map((cell, index) => ({ name: cell.purpose || `Cell ${cells.length - 10 + index}`, language: 'python', code: cell.code }))]
      : kept.map((cell, index) => ({ name: cell.purpose || `Cell ${index + 1}`, language: 'python', code: cell.code }));
    return { steps, sharedPython: true, inputs: kernel.inputs.slice(0, 8).map(({ artifactId, versionId }) => ({ artifactId, versionId })), skipped: kernel.cells.length - cells.length };
  }
  removeSession(sessionId: string) { const kernel = this.kernels.get(sessionId); if (kernel) this.end(kernel, 'The conversation was removed.'); this.ended.delete(sessionId); }
  async close() { const kernels = [...this.kernels.values()]; for (const kernel of kernels) this.end(kernel, 'PAL closed, so the analysis session ended. Its state was not kept.'); await Promise.allSettled(kernels.map(kernel => kernel.ended)); }
}
