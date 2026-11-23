/**
 * Code Lab, command runs and read-only Git, all through the one execution boundary (runner.ts).
 *
 * A Code Lab run is stateless Python with the selected artifact versions mounted read-only at
 * /work/input and a size-limited /work/output whose files become artifacts. Its code is kept as an
 * artifact too, so a chart traces back to the exact data and code that drew it. Exiting with status 0
 * means the run finished; it is never presented as verification of a conclusion.
 *
 * A command run is a reviewed argument vector in a workspace folder that allows commands, with that
 * folder writable and everything else hidden. Git tools run read-only with hooks, external diff
 * programs, text conversion and pagers turned off.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { privateDir } from '../paths.ts';
import { terminateProcessGroup } from '../process-group.ts';
import type { Workbench } from '../workbench.ts';
import type { ArtifactRef } from '../tools/contracts.ts';
import { recipes, helperDigest, recipeFile } from './recipes.ts';
import { validateProgram, type LabRequest, type CellRecord } from './program.ts';
import { runKernel } from './kernel.ts';
import { strictest } from '../tools/contracts.ts';
import { safeName } from '../artifacts/store.ts';
import { isolation, pythonRuntime, sandboxed } from './runner.ts';
import type { WorkspaceRoot } from '../workspace/roots.ts';
import { rootArgs, run as fs } from '../workspace/fsclient.ts';

export const labLimits = { codeBytes: 64 * 1024, inputs: 8, argv: 64, argBytes: 4096, commandWallMs: 30 * 60_000, gitOutput: 64 * 1024 };
export type ExecutionGrant = { id: string; sessionId: string; expires: number; maxRuns: number; usedRuns: number };

export class Execution {
  workbench: Workbench;
  grants = new Map<string, ExecutionGrant>();
  constructor(workbench: Workbench) { this.workbench = workbench; }
  get core() { return this.workbench.core; }
  enabled() { return this.core.settings.workbench?.codeLab?.enabled === true; }
  async status(sessionId?: string) {
    const [status, runtime] = await Promise.all([isolation(), pythonRuntime()]);
    return { enabled: this.enabled(), ...status, available: status.available && runtime.python !== 'unavailable',
      problem: status.problem || (runtime.python === 'unavailable' ? 'Install Python 3 on the desktop to run an analysis' : undefined), runtime, grant: sessionId ? this.grantFor(sessionId) || null : null, recipes: Object.entries(recipes).map(([id, recipe]) => ({ id, ...recipe })) };
  }
  grantFor(sessionId: string) { return [...this.grants.values()].find(grant => grant.sessionId === sessionId && grant.expires > Date.now() && grant.usedRuns < grant.maxRuns); }
  grantRuns(p: any) {
    const minutes = p.minutes ?? 30, maxRuns = p.maxRuns ?? 10;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 50) throw new Error('A Code Lab permission lasts 1–240 minutes and covers 1–50 runs');
    const grant: ExecutionGrant = { id: crypto.randomUUID(), sessionId: p.sessionId, expires: Date.now() + minutes * 60_000, maxRuns, usedRuns: 0 };
    for (const old of this.grants.values()) if (old.sessionId === p.sessionId) this.grants.delete(old.id);
    this.grants.set(grant.id, grant); this.core.changed(); return grant;
  }
  /** Resolve the UI request once its validated operation is durable. Model tools await the final result. */
  launch(sessionId: string, p: LabRequest): Promise<{ operationId: string }> {
    return new Promise((resolve, reject) => {
      this.workbench.track(this.runInner(sessionId, p, operationId => resolve({ operationId })))
        .then(op => op.state === 'completed' ? resolve({operationId:op.id}) : reject(new Error(op.error?.message || op.state)), reject);
    });
  }
  run(sessionId: string, p: LabRequest) { return this.workbench.track(this.runInner(sessionId, p)); }
  private async runInner(sessionId: string, p: LabRequest, accepted?: (id: string) => void) {
    if (!this.enabled()) throw Object.assign(new Error('Code Lab is turned off. Turn it on in Settings → Connections → Images & analysis.'), { code: 'disabled' });
    const program = validateProgram(p);
    const status = await isolation(), runtime = await pythonRuntime();
    if (!status.available || runtime.python === 'unavailable') throw Object.assign(new Error(status.problem || 'Desktop Python is unavailable'), { code: 'isolation_unavailable' });
    const artifacts = this.workbench.artifacts, ops = this.workbench.operations, session = this.core.store.session(sessionId);
    if (session.temporary) throw new Error('Temporary conversations stay text-only');
    const parent = p.parentId ? ops.get(p.parentId) : undefined;
    if (parent && (parent.kind !== 'codelab.run' || parent.sessionId !== sessionId)) throw new Error('Choose a Code Lab run in this conversation');
    const inputs = await Promise.all(program.refs.map(ref => artifacts.bytes(sessionId, ref.artifactId, ref.versionId)));
    const refs = inputs.map(({ version }) => ({ artifactId: version.artifactId, versionId: version.versionId, purpose: 'input' }));
    const purpose = typeof p.purpose === 'string' ? p.purpose.trim().slice(0, 300) : '';
    const language = program.cells[0].language;
    const recipeCode = p.analysisId ? this.workbench.analyses.codeVersion(sessionId, p.analysisId) : undefined;
    const priorCode = parent?.inputs.find(r => r.purpose === 'code');
    const priorPolicy = priorCode ? artifacts.version(sessionId, priorCode.artifactId, priorCode.versionId).policy : undefined;
    const policy = strictest(artifacts.inherit(sessionId, refs), ...(priorPolicy ? [priorPolicy] : []), ...(recipeCode ? [recipeCode.policy] : []));
    const code = await artifacts.install({ sessionId, bytes: Buffer.from(program.codeText), name: program.multi ? 'analysis.steps.json' : language === 'sql' ? 'analysis.sql' : 'analysis.py',
      source: p.origin === 'model' ? 'tool-output' : 'user-import', turnId: p.turnId, policy,
      provenance: { kind: 'codelab-code', purpose } });
    if (this.core.closed || !this.enabled()) throw new Error('Code Lab is unavailable');
    p.signal?.throwIfAborted();
    const codeRef = { artifactId: code.artifactId, versionId: code.versionId, purpose: 'code' };
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let prefix = digest([refs, program.parameters, runtime, helperDigest, program.sharedPython]);
    const cells: CellRecord[] = program.cells.map(cell => {
      prefix = digest([prefix, cell.code, cell.language]);
      return { name: cell.name, language: cell.language, state: 'pending', digest: prefix, results: [] };
    });
    const past = (parent?.details?.cells || []) as CellRecord[];
    let reuse = !!parent && p.reuseSteps === true;
    const operation = ops.create({ sessionId, turnId: p.turnId, kind: 'codelab.run', origin: p.origin,
      ...(parent ? { parentId: parent.id, groupId: parent.groupId || parent.id } : {}),
      label: 'Code Lab: ' + (purpose.slice(0, 80) || 'analysis'), payloadDigest: digest([code.sha256, refs, program.parameters, program.timeout]),
      witness: { approval: p.approval, inputs: refs.map(r => r.versionId) }, inputs: [...refs, codeRef],
      details: { purpose, runtime, helperDigest, limits: status.enforced, timeLimitSeconds: program.timeout, language, notebook: program.multi, sharedPython: program.sharedPython,
        approval: p.approval, notify: p.notify === true, analysisId: p.analysisId, code: codeRef, parameters: program.parameters, cells } });
    const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
    const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal;
    const removeJob = this.core.jobs.add('codelab', operation.label, () => controller.abort(new Error('Cancelled')));
    let scratch: string | undefined;
    let stdout = '', stderr = '', truncated = false, currentCell: CellRecord | undefined, exitCode: number | null = null, exitSignal: string | null = null;
    const produced: ArtifactRef[] = [];
    const started = Date.now(), deadline = started + program.timeout * 1000;
    const record = (extra = {}) => ops.update(operation.id, { details: { ...operation.details, cells, stdout, stderr, truncated, ...extra } });
    try {
      ops.transition(operation.id, 'queued');
      accepted?.(operation.id);
      scratch = await mkdtemp(join(privateDir(join(this.core.store.directory, 'runs')), 'lab-'));
      signal.throwIfAborted();
      ops.transition(operation.id, 'running');
      this.card(operation.id);
      const binds = [{ source: recipeFile('lab_data'), target: '/work/lab/lab_data.py' }, { source: recipeFile('sql'), target: '/work/lab/sql.py' }];
      const mount = async (name: string, bytes: Buffer | string, target: string) => {
        const source = join(scratch!, name);
        await writeFile(source, bytes, { mode: 0o400 }); binds.push({ source, target });
      };
      const paths: string[] = [];
      for (const [index, input] of inputs.entries()) {
        let name = safeName(input.version.name, 'input').replace(/\s+/g, '_');
        while (paths.includes('/work/input/' + name)) name = (index + 1) + '-' + name;
        paths.push('/work/input/' + name);
        await mount('input-' + index, input.data, paths[index]);
      }
      await mount('inputs.json', JSON.stringify(paths), '/work/inputs.json');
      await mount('parameters.json', JSON.stringify(program.parameters), '/work/parameters.json');
      let outputBytes = 0, lastUpdate = 0;
      const onOutput = (stream: 'stdout' | 'stderr', text: string) => {
        const space = Math.max(0, 256 * 1024 - stdout.length - stderr.length);
        if (text.length > space) truncated = true;
        const piece = text.slice(0, space);
        if (stream === 'stdout') stdout += piece; else stderr += piece;
        if (currentCell) currentCell[stream] = ((currentCell[stream] || '') + piece).slice(-16000);
        if (Date.now() - lastUpdate >= 350) { lastUpdate = Date.now(); record(); }
      };
      const storeFile = async (index: number, path: string, bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes > 100 * 1024 * 1024 || cells.reduce((n, c) => n + c.results.length, 0) >= 20) throw new Error('Notebook output limit exceeded');
        const parents = [...refs.map(ref => ({ ...ref, relation: 'analysis-input' })), { ...codeRef, relation: 'analysis-code' },
          ...cells.slice(0, index).flatMap(c => c.results.map(ref => ({ ...ref, relation: 'analysis-step' })))];
        const version = await artifacts.install({ sessionId, turnId: p.turnId, bytes, name: basename(path), source: 'tool-output',
          policy, operationId: operation.id, parents, provenance: { kind: 'codelab', operationId: operation.id, exitCode, code: code.versionId, step: index + 1, path } });
        cells[index].results.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: version.kind === 'image' ? 'plot' : 'output' });
      };
      if (program.sharedPython) {
        let cellStarted = Date.now();
        const result = await runKernel(program.cells, binds, { scratchRoot: scratch, signal, wallMs: Math.max(1, deadline - Date.now()), onOutput,
          onCell: event => {
            currentCell = cells[event.index];
            currentCell.state = event.state;
            if (event.state === 'running') {
              cellStarted = Date.now();
              ops.update(operation.id, { progress: { value: event.index + 1, max: cells.length, at: cellStarted, note: currentCell.name } });
            } else currentCell.durationMs = Date.now() - cellStarted;
            record();
          },
        });
        exitCode = result.exitCode; exitSignal = result.signal; truncated ||= result.truncated;
        const errors = result.outputProblem ? [result.outputProblem] : [];
        for (const file of result.outputs) {
          const match = /^cell-(\d+)\/(.+)$/.exec(file.name);
          const index = match ? Number(match[1]) - 1 : cells.findLastIndex(c => c.state !== 'pending');
          if (index < 0 || index >= cells.length) { errors.push('Invalid cell output path'); continue; }
          try { await storeFile(index, match ? match[2] : file.name, file.bytes); }
          catch (error) { errors.push(error instanceof Error ? error.message : 'Could not save output'); }
        }
        produced.push(...cells.flatMap(c => c.results));
        if (result.cancelled || result.timedOut || exitCode !== 0 || errors.length || result.completedCells !== cells.length)
          throw Object.assign(new Error(result.cancelled ? 'Execution stopped' : result.timedOut ? 'Stopped at the time limit' :
            errors.join('. ') || result.stderr.trim().split('\n').at(-1) || 'The Python kernel ended before all cells completed'),
            { code: result.timedOut ? 'timeout' : errors.length ? 'output_failed' : 'process_exit' });
      }

      for (const [index, step] of (program.sharedPython ? [] : program.cells).entries()) {
        signal.throwIfAborted();
        currentCell = cells[index];
        ops.update(operation.id, { progress: { value: index + 1, max: cells.length, at: Date.now(), note: step.name } });
        currentCell.state = 'running'; record();
        const previous = past[index];
        reuse = reuse && previous?.digest === currentCell.digest && previous.state === 'completed';
        if (reuse) {
          let bytes = 0;
          for (const ref of previous.results) {
            try {
              const version = artifacts.version(sessionId, ref.artifactId, ref.versionId);
              if (JSON.stringify(version.policy) !== JSON.stringify(policy) || !await artifacts.available(version)) { reuse = false; break; }
              bytes += version.bytes;
            } catch { reuse = false; break; }
          }
          if (reuse) outputBytes += bytes;
        }
        if (reuse) {
          Object.assign(currentCell, { cached: true, results: previous.results, stdout: previous.stdout, stderr: previous.stderr, durationMs: 0 });
          stdout = (stdout + (previous.stdout || '')).slice(0, 256 * 1024);
          stderr = (stderr + (previous.stderr || '')).slice(0, 256 * 1024);
          exitCode = 0;
        } else {
          const main = '/work/main.' + (step.language === 'sql' ? 'sql' : 'py');
          const source = join(scratch, 'cell-' + index);
          await writeFile(source, step.code, { mode: 0o400 });
          const entry = step.language === 'sql' ? '/work/lab/sql.py' : main;
          const wallMs = deadline - Date.now();
          if (wallMs <= 0) throw Object.assign(new Error('Stopped at the time limit'), { code: 'timeout' });
          const result = await sandboxed({ argv: ['/usr/bin/python3', '-I', '-u', '-c',
            'import runpy,sys;sys.path.insert(0,"/work/lab");runpy.run_path(sys.argv[1],run_name="__main__")', entry],
            binds: [...binds, { source, target: main }], cwd: '/work', signal, limits: { wallMs },
            onOutput });
          exitCode = result.exitCode; exitSignal = result.signal; truncated ||= result.truncated;
          currentCell.durationMs = result.durationMs;
          const errors = result.outputProblem ? [result.outputProblem] : [];
          for (const file of result.outputs) {
            try { await storeFile(index, file.name, file.bytes);
            } catch (error) { errors.push(error instanceof Error ? error.message : 'Could not save output'); }
          }
          if (result.cancelled || result.timedOut || exitCode !== 0 || errors.length) {
            produced.push(...currentCell.results);
            const reason = result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : errors.length ? 'output_failed' : 'process_exit';
            const diagnostic = result.stderr.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 500);
            throw Object.assign(new Error(result.cancelled ? 'Execution stopped' : result.timedOut ? 'Stopped at the time limit' :
              errors.length ? errors.join('\n').slice(0, 1200) : 'Exited with ' + (exitSignal || 'status ' + exitCode) + (diagnostic ? ' · ' + diagnostic : '')), { code: reason });
          }
        }
        produced.push(...currentCell.results);
        if (index < cells.length - 1) for (const [j, ref] of currentCell.results.entries()) {
          const { data, version } = await artifacts.bytes(sessionId, ref.artifactId, ref.versionId);
          const path = String(version.provenance.path || version.name);
          await mount('step-' + index + '-' + j, data, '/work/steps/' + (index + 1) + '/' + path);
        }
        currentCell.state = 'completed'; record();
      }
      const finished = ops.transition(operation.id, 'completed', { results: produced, details: { ...operation.details, cells, stdout, stderr, truncated, durationMs: Date.now() - started, exitCode, signal: exitSignal } });
      try { this.core.workflows.observeAction(sessionId, 'codelab.run', { operationId: operation.id }, { exitCode: exitCode ?? -1, durationMs: Date.now() - started }); } catch { /* the source conversation was removed */ }
      this.card(operation.id); return finished;
    } catch (error: any) {
      const current = ops.get(operation.id);
      let state: 'cancelled'|'interrupted'|'failed' = 'failed';
      if (signal.aborted) state = ['cancel_requested', 'cancelled'].includes(current.state) ? 'cancelled' : 'interrupted';
      if (currentCell) currentCell.state = state;
      const finished = ops.transition(operation.id, state, { results: produced, details: { ...operation.details, cells, stdout, stderr, truncated, durationMs: Date.now() - started, exitCode, signal: exitSignal },
        ...(state === 'cancelled' ? { cancellation: { requested: current.cancellation?.requested || Date.now(), confirmed: true, note: 'Execution stopped' } } : {}),
        error: { code: error?.code || state, message: String(error?.message || error).slice(0, 1200) } });
      this.card(operation.id); return finished;
    } finally { removeJob(); this.workbench.runControllers.delete(operation.id); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  /** One card per run, updated in place. */
  card(operationId: string) {
    const operation = this.workbench.operations.get(operationId), d = operation.details || {};
    const lines = [operation.label, operation.state === 'completed' ? `Finished with exit status ${d.exitCode} in ${((d.durationMs as number) / 1000).toFixed(1)} s${operation.results.length ? ` · ${operation.results.length} file${operation.results.length === 1 ? '' : 's'}` : ''}` : operation.state, operation.error?.message || '', d.outputProblem ? String(d.outputProblem) : ''].filter(Boolean);
    if (d.notify && ['completed','cancelled','failed','interrupted'].includes(operation.state) && !this.core.closed) this.core.emit('notice', { kind: operation.state === 'completed' ? 'complete' : 'error', sessionId: operation.sessionId, text: operation.label + ' · ' + operation.state });
    try { this.core.putMessage({ id: `${operation.sessionId}:op:${operation.id}`, sessionId: operation.sessionId, role: 'workbench', kind: 'operation', operationId: operation.id, time: operation.created, text: lines.join('\n'), ...(operation.results.length ? { artifacts: operation.results } : {}) }); } catch { /* gone */ }
  }

  /** A reviewed argument vector in a folder that allows commands; that folder writable, everything else hidden. */
  command(...args: Parameters<Execution['commandInner']>) { return this.workbench.track(this.commandInner(...args)); }
  private async commandInner(sessionId: string, root: WorkspaceRoot, p: { argv: unknown; cwd?: string; network?: boolean; timeoutSeconds?: number; origin: 'model' | 'user'; turnId?: string; signal?: AbortSignal }) {
    if (!root.policy.execute) throw new Error(`${root.name} does not allow running commands; allow it in the folder permissions`);
    if (!Array.isArray(p.argv) || !p.argv.length || p.argv.length > labLimits.argv || p.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > labLimits.argBytes)) throw new Error('Give the program and its arguments as a list of up to 64 strings');
    const status = await isolation();
    if (!status.available) throw Object.assign(new Error(status.problem || 'Command runs are unavailable'), { code: 'isolation_unavailable' });
    const timeout = Math.min(Math.max(5, p.timeoutSeconds || 300), labLimits.commandWallMs / 1000) * 1000;
    const before = await this.manifest(root);
    if (this.core.closed) throw new Error('PAL is closing');
    let operation = this.workbench.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'command.run', origin: p.origin, label: 'Command: ' + (p.argv as string[]).join(' ').slice(0, 100),
      payloadDigest: createHash('sha256').update(JSON.stringify([root.id, p.argv, p.network])).digest('hex'), witness: { root: root.id, revision: root.revision, network: !!p.network }, inputs: [],
      details: { argv: p.argv, root: root.name, network: !!p.network, timeoutSeconds: timeout / 1000, limits: status.enforced } });
    const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
    const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal;
    const removeJob = this.core.jobs.add('codelab', operation.label, () => controller.abort(new Error('Cancelled')));
    try {
      operation = this.workbench.operations.transition(operation.id, 'queued'); operation = this.workbench.operations.transition(operation.id, 'running'); this.card(operation.id);
      let live = '', last = 0;
      const result = await sandboxed({ argv: p.argv as string[], binds: [{ source: root.path, target: root.path, writable: true }], cwd: root.path + (p.cwd ? '/' + p.cwd : ''), network: !!p.network, collectOutput: false, limits: { wallMs: timeout }, signal,
        onOutput: (_stream, text) => { live = (live + text).slice(-8000); if (Date.now() - last > 500) { last = Date.now(); this.workbench.operations.update(operation.id, { details: { ...operation.details, stdout: live } }); } } });
      const after = await this.manifest(root);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).slice(0, 200);
      const current = this.workbench.operations.get(operation.id);
      const finished = this.workbench.operations.transition(operation.id, result.cancelled ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : result.timedOut || result.exitCode !== 0 ? 'failed' : 'completed', {
        ...(result.timedOut ? { error: { code: 'timeout', message: 'Stopped at the time limit' } } : result.exitCode !== 0 && !result.cancelled ? { error: { code: 'process_exit', message: 'Command ended with ' + (result.signal || 'status ' + result.exitCode) } } : {}),
        details: { ...current.details, exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated,
          changedFiles: changed, changeNote: before.size >= 5000 ? 'Only the first 5,000 files were compared; other changes may not be listed.' : 'Changes are observed by size and modification time inside this folder only; this is not a complete system audit.' } });
      try { this.core.workflows.observeAction(sessionId, 'command.run', { argv: p.argv, root: root.name }, { exitCode: result.exitCode ?? -1, durationMs: result.durationMs }); } catch { /* none */ }
      for (const path of changed) this.core.workflows.observeEdit(join(root.path, path), Date.now(), 'workspace');
      this.card(operation.id);
      return finished;
    } catch (error: any) {
      const current = this.workbench.operations.get(operation.id);
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) this.workbench.operations.transition(operation.id, signal.aborted ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : 'failed', { error: { code: error?.code || 'failed', message: String(error?.message || error).slice(0, 500) } });
      this.card(operation.id); throw error;
    } finally { removeJob(); this.workbench.runControllers.delete(operation.id); }
  }
  /**
   * A host command (PAL Everywhere §7.5): reviewed shell code, or a program and its arguments, run as the desktop
   * account. It is not isolated: it can reach everything that account can (files, keys, network, the desktop), and
   * the folder is only its working directory. Output is bounded; the time limit and Stop end its whole process
   * group, and an end that could not be confirmed is reported, never shown as success.
   */
  hostCommand(...args: Parameters<Execution['hostInner']>) { return this.workbench.track(this.hostInner(...args)); }
  private async hostInner(sessionId: string, root: WorkspaceRoot, p: { program: { kind: 'shell'; shell: 'bash' | 'sh' | 'fish' | 'zsh'; command: string } | { kind: 'argv'; argv: string[] };
    cwd?: string; timeoutSeconds?: number; origin: 'model' | 'user'; turnId?: string; signal?: AbortSignal }) {
    const shells: Record<string, string[]> = { bash: ['/usr/bin/bash', '/bin/bash'], sh: ['/usr/bin/sh', '/bin/sh'], fish: ['/usr/bin/fish', '/bin/fish'], zsh: ['/usr/bin/zsh', '/bin/zsh'] };
    let argv: string[];
    if (p.program.kind === 'shell') {
      if (typeof p.program.command !== 'string' || !p.program.command.trim() || p.program.command.includes('\0') || Buffer.byteLength(p.program.command) > 64 * 1024) throw new Error('Give the shell command as text up to 64 KiB');
      const shell = (shells[p.program.shell] || []).find(path => existsSync(path));
      if (!shell) throw Object.assign(new Error(`${p.program.shell} is not installed on this computer`), { code: 'dependency_missing' });
      argv = [shell, '-c', p.program.command];
    } else {
      if (!Array.isArray(p.program.argv) || !p.program.argv.length || p.program.argv.length > labLimits.argv || p.program.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Give the program and its arguments as a list');
      argv = p.program.argv;
    }
    const timeout = Math.min(Math.max(5, p.timeoutSeconds || 300), 1800) * 1000, cwd = root.path + (p.cwd ? '/' + p.cwd : '');
    const label = (p.program.kind === 'shell' ? p.program.command : p.program.argv.join(' ')).replace(/\s+/g, ' ').slice(0, 100);
    if (this.core.closed) throw new Error('PAL is closing');
    let operation = this.workbench.operations.create({ sessionId, ...(p.turnId ? { turnId: p.turnId } : {}), kind: 'command.host', origin: p.origin, label: 'Host: ' + label,
      payloadDigest: createHash('sha256').update(JSON.stringify([root.id, argv, p.cwd || ''])).digest('hex'), witness: { root: root.id, revision: root.revision, execution: 'desktop-account' }, inputs: [],
      details: { program: p.program, cwd, root: root.name, execution: 'desktop-account', timeoutSeconds: timeout / 1000 } });
    const controller = new AbortController(); this.workbench.runControllers.set(operation.id, controller);
    const signal = p.signal ? AbortSignal.any([p.signal, controller.signal]) : controller.signal;
    const removeJob = this.core.jobs.add('codelab', operation.label, () => controller.abort(new Error('Cancelled')));
    const limit = 256 * 1024, started = Date.now();
    try {
      operation = this.workbench.operations.transition(operation.id, 'queued'); operation = this.workbench.operations.transition(operation.id, 'running'); this.card(operation.id);
      const env: Record<string, string> = { ...process.env as Record<string, string>, PAL_HOST_COMMAND: '1' };
      for (const key of Object.keys(env)) if (/^(?:PAL|CERE)_.*(TOKEN|SECRET|KEY)/.test(key)) delete env[key];
      const result = await new Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; cancelled: boolean; survivors: number }>((resolve, reject) => {
        let stdout = '', stderr = '', truncated = false, timedOut = false, cancelled = false, last = 0;
        signal.throwIfAborted();
        const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stopping: Promise<boolean> | undefined;
        const stopGroup = (why: 'timeout' | 'cancel') => {
          if (stopping) return;
          if (why === 'timeout') timedOut = true; else cancelled = true;
          stopping = terminateProcessGroup(child.pid).then(() => true, () => false);
        };
        const timer = setTimeout(() => stopGroup('timeout'), timeout); timer.unref();
        const abort = () => stopGroup('cancel'); signal.addEventListener('abort', abort, { once: true });
        const take = (current: string, chunk: Buffer) => { if (current.length >= limit) { truncated = true; return current; } const next = current + chunk.toString('utf8'); if (next.length > limit) truncated = true; return next.slice(0, limit); };
        child.stdout!.on('data', (chunk: Buffer) => { stdout = take(stdout, chunk); if (Date.now() - last > 500) { last = Date.now(); this.workbench.operations.update(operation.id, { details: { ...operation.details, stdout: stdout.slice(-8000) } }); } });
        child.stderr!.on('data', (chunk: Buffer) => { stderr = take(stderr, chunk); });
        child.on('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Object.assign(new Error(`Could not start ${argv[0]}: ${error.message}`), { code: (error as any).code === 'ENOENT' ? 'not_found' : 'failed' })); });
        child.on('close', async (code, killed) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          let survivors = 0;
          if (stopping) survivors = await stopping ? 0 : 1;
          else if (child.pid) {
            try { process.kill(-child.pid, 0); survivors = 1; } catch {}
          }
          resolve({ exitCode: code, signal: killed, stdout, stderr, truncated, timedOut, cancelled, survivors });
        });
      });
      const current = this.workbench.operations.get(operation.id);
      const state = result.cancelled ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : result.timedOut || result.exitCode !== 0 ? 'failed' : 'completed';
      const finished = this.workbench.operations.transition(operation.id, state, {
        ...(result.timedOut ? { error: { code: 'timeout', message: 'Stopped at the time limit' } } : result.exitCode !== 0 && !result.cancelled ? { error: { code: 'process_exit', message: 'Command ended with ' + (result.signal || 'status ' + result.exitCode) } } : {}),
        ...(result.survivors ? { cancellation: { requested: Date.now(), confirmed: false, note: 'Some processes of this command were still running after it ended.' } } : {}),
        details: { ...current.details, exitCode: result.exitCode, signal: result.signal, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, survivors: result.survivors } });
      try { this.core.workflows.observeAction(sessionId, 'command.host', { command: label, root: root.name }, { exitCode: result.exitCode ?? -1, durationMs: Date.now() - started }); } catch { /* none */ }
      this.card(operation.id);
      return finished;
    } catch (error: any) {
      const current = this.workbench.operations.get(operation.id);
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)) this.workbench.operations.transition(operation.id, signal.aborted ? (current.state === 'cancel_requested' ? 'cancelled' : 'interrupted') : 'failed', { error: { code: error?.code || 'failed', message: String(error?.message || error).slice(0, 500) } });
      this.card(operation.id); throw error;
    } finally { removeJob(); this.workbench.runControllers.delete(operation.id); }
  }
  private async manifest(root: WorkspaceRoot) {
    const map = new Map<string, string>();
    try {
      const value = await fs(['walk', ...rootArgs(this.workbench.roots.handle(root)), '.', '--hidden', '--limit', '5000', '--max-entries', '5000', '--max-depth', '12', '--deadline-ms', '5000', '--exclude', '.git', '--exclude', 'node_modules']);
      for (const entry of value.entries) if (!entry.invalidName && entry.type === 'file') map.set(entry.path, `${entry.size}:${entry.mtimeMs}`);
    } catch { /* unobservable */ }
    return map;
  }
  /** Read-only Git with every program hook disabled; the folder is mounted read-only for the run. */
  async git(root: WorkspaceRoot, args: string[], signal: AbortSignal) {
    const status = await isolation();
    if (!status.available) throw Object.assign(new Error(status.problem || 'Git tools are unavailable'), { code: 'isolation_unavailable' });
    const result = await sandboxed({ argv: ['/usr/bin/git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'safe.directory=*', '-c', 'protocol.allow=never', '-C', root.path, ...args],
      binds: [{ source: root.path, target: root.path }], cwd: root.path, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, collectOutput: false, limits: { wallMs: 20_000, displayBytes: labLimits.gitOutput }, signal });
    if (result.exitCode !== 0) throw new Error((result.stderr || 'git failed').trim().split('\n').slice(-2).join(' ').slice(0, 300));
    return { output: result.stdout, truncated: result.truncated };
  }
}
