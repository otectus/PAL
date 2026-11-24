/**
 * Model-facing analysis tools. Code Lab and command runs show the exact code or command, the inputs, the
 * runtime and how each limit is enforced before they run; a bounded Code Lab permission the user gave can
 * cover Code Lab runs, never commands. Git tools only read.
 */
import { lineDiff } from '../file-proposals.ts';
import { validateProgram } from './program.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { completed, declined, failed, routeAllowed, type ToolResultV1 } from '../tools/contracts.ts';
import type { ToolSpec } from '../tools/registry.ts';
import type { Workbench } from '../workbench.ts';
import { WorkspaceError } from '../workspace/fsclient.ts';
import { describeOperation } from '../media/tools.ts';
import { normalizePath } from '../workspace/policy.ts';

const id = z.string().regex(/^[0-9a-f-]{36}$/);
export function registerAnalysisTools(workbench: Workbench) {
  const { registry } = workbench, lab = () => workbench.execution;
  const guard = (run: (context: Parameters<ToolSpec['run']>[0], args: any) => Promise<ToolResultV1>) => async (context: Parameters<ToolSpec['run']>[0], args: any) => {
    try { return await run(context, args); }
    catch (error: any) { if (context.signal.aborted) throw error; return failed(error?.code || 'failed', String(error?.message || error).slice(0, 600), error instanceof WorkspaceError ? 'explicit' : 'never'); }
  };
  const analysis = (session: any) => {
    if (!workbench.families(session).has('analysis')) return 'Analysis is not turned on for this conversation';
    return lab().enabled() ? '' : 'Code Lab is turned off in Settings';
  };
  const runResult = (operation: any): ToolResultV1 => {
    const d = operation.details || {};
    const data = { ...describeOperation(operation), exitCode: d.exitCode, durationMs: d.durationMs, stdout: String(d.stdout || '').slice(0, 16000), stderr: String(d.stderr || '').slice(0, 8000), ...(d.truncated ? { outputTruncated: true } : {}), ...(d.outputProblem ? { outputProblem: d.outputProblem } : {}), ...(d.changedFiles ? { changedFiles: d.changedFiles, changeNote: d.changeNote } : {}) };
    return operation.state === 'completed' ? completed(`Finished with exit status ${d.exitCode}${operation.results.length ? `; ${operation.results.length} output file${operation.results.length === 1 ? '' : 's'} kept as artifacts` : ''}. A finished run is not proof that its conclusion is right.`, data, { ...(operation.results.length ? { artifacts: operation.results } : {}), operationId: operation.id })
      : { schema: 1, status: 'failed', summary: operation.error?.message || `The run ended ${operation.state}.`, data, operationId: operation.id, ...(operation.results.length ? { artifacts: operation.results } : {}), error: { code: operation.error?.code || operation.state, message: operation.error?.message || operation.state, retry: 'explicit' } };
  };
  registry.register({
    name: 'codelab_run', family: 'analysis', core: true, effects: { execute: true },
    description: 'Run isolated Python or SQL on selected read-only artifact versions. Use /work/inputs.json for their ordered paths, /work/parameters.json for parameters, and /work/output for output files. SQL queries see input1, input2, etc. For notebook steps, previous files are under /work/steps/1/... . Set sharedPython for an all-Python notebook whose cells share variables in a fresh interpreter. Use parentId to review a revision. Cite the output file, row and column for numerical claims.',
    input: z.strictObject({ code: z.string().max(65536), language: z.enum(['python','sql']).optional(), sharedPython: z.boolean().optional(), parentId: id.optional(),
      steps: z.array(z.strictObject({ name: z.string().min(1).max(120), code: z.string().min(1).max(65536), language: z.enum(['python','sql']) })).max(12).optional(),
      parameters: z.record(z.string(), z.union([z.string(),z.number(),z.boolean(),z.array(z.string())])).optional(),
      inputs: z.array(z.strictObject({ artifactId: id, versionId: id })).max(8).optional(), purpose: z.string().min(1).max(300) }),
    available: analysis,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const request = { ...args, origin: 'model' as const, turnId, signal, approval: 'individual' as const };
      const program = validateProgram(request);
      const sourceRefs = args.inputs || [];
      const base = args.parentId ? await workbench.analyses.open(sessionId, args.parentId) : undefined;
      const policyRefs = base ? [...sourceRefs, ...workbench.operations.get(args.parentId).inputs] : sourceRefs;
      const policy = policyRefs.length ? workbench.artifacts.inherit(sessionId, policyRefs) : undefined;
      if (policy && !routeAllowed((await workbench.route(sessionId, signal)).route, policy))
        return failed('destination', 'The selected analysis materials cannot be processed by this conversation’s model', 'never');
      const grant = lab().grantFor(sessionId);
      if (!grant) {
        const status = await lab().status();
        const versions = sourceRefs.map((ref: {artifactId:string;versionId:string}) => workbench.artifacts.version(sessionId, ref.artifactId, ref.versionId));
        const review = (program.sharedPython ? 'Shared Python variables, clean start for each run.\n' : '') + program.cells.map(c => [c.name + ' (' + c.language + ')', ...c.code.split('\n').map((line, i) => String(i + 1) + '  ' + line)].join('\n')).join('\n\n');
        let diff = '';
        if (base) {
          const before = base.steps.length ? JSON.stringify(base.steps, null, 2) : base.code;
          try { diff = lineDiff(before, program.codeText, 'analysis'); }
          catch { diff = 'Large revision. The complete proposed code appears below.'; }
        }
        const answer = await workbench.core.approval(sessionId, { kind: 'execution', title: 'Run analysis code: ' + args.purpose.slice(0, 80) + '?',
          detail: ['Purpose: ' + args.purpose, 'Inputs: ' + (versions.map((v: {name:string;versionId:string}) => v.name + ' @ ' + v.versionId).join(', ') || 'none'),
            'Parameters: ' + JSON.stringify(program.parameters), 'Runtime: Python ' + status.runtime.python + '; no network; read-only inputs; outputs up to 20 files.',
            'Memory: ' + status.enforced.memory + '. Processes: ' + status.enforced.processes, diff, review].filter(Boolean).join('\n\n'),
          choices: ['allow', 'deny'], fields: { reviewComplete: true, purpose: args.purpose, digest: createHash('sha256').update(JSON.stringify([program.codeText, program.parameters, sourceRefs])).digest('hex') } });
        if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the code ran.' : 'The user declined running this code.');
      } else grant.usedRuns++;
      if (analysis(workbench.core.store.session(sessionId))) return failed('disabled', 'Analysis is no longer enabled', 'never');
      const operation = await lab().run(sessionId, { ...request, approval: grant ? 'grant' : 'individual' });
      const result = runResult(operation);
      return policy ? workbench.restricted(result, policy) : result;
    }),
  });
  registry.register({
    name: 'codelab_session', family: 'analysis', core: false, effects: { execute: true },
    description: 'Run one Python cell in the analysis session the user started. Variables from earlier cells are there; the last expression is shown. Files go to the current folder. Use codelab_run instead when the result must not depend on earlier cells.',
    input: z.strictObject({ code: z.string().min(1).max(65536), inputs: z.array(z.strictObject({ artifactId: id, versionId: id })).max(8).optional(), purpose: z.string().min(1).max(300) }),
    available: session => analysis(session) || (workbench.kernels.status(session.id).session ? '' : 'No analysis session is running. The user can start one in Workbench › Runs.'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const status = workbench.kernels.status(sessionId).session;
      if (!status) return failed('no_session', 'No analysis session is running. The user can start one in Workbench › Runs.', 'explicit');
      // Everything the session was ever given counts: its variables can hold any of it.
      const route = (await workbench.route(sessionId, signal)).route;
      const policies = [workbench.kernels.policy(sessionId), ...(args.inputs?.length ? [workbench.artifacts.inherit(sessionId, args.inputs)] : [])].filter(policy => !!policy);
      if (policies.some(policy => !routeAllowed(route, policy!))) return failed('destination', 'The session holds materials that may not be processed by this conversation’s model', 'never');
      const grant = lab().grantFor(sessionId);
      if (!grant) {
        const versions = (args.inputs || []).map((ref: { artifactId: string; versionId: string }) => workbench.artifacts.version(sessionId, ref.artifactId, ref.versionId));
        const answer = await workbench.core.approval(sessionId, { kind: 'execution', title: 'Run a cell in the analysis session: ' + args.purpose.slice(0, 80) + '?',
          detail: ['Purpose: ' + args.purpose, `Session: ${status.cells.length} cells so far, ${status.variables.length} variables. This cell can read and change them.`, 'New inputs: ' + (versions.map((v: { name: string; versionId: string }) => v.name + ' @ ' + v.versionId).join(', ') || 'none'), 'No network; read-only inputs; outputs up to 20 files.', args.code.split('\n').map((line: string, i: number) => String(i + 1) + '  ' + line).join('\n')].join('\n\n'),
          choices: ['allow', 'deny'], fields: { reviewComplete: true, purpose: args.purpose, digest: createHash('sha256').update(JSON.stringify([status.id, args.code, args.inputs || []])).digest('hex') } });
        if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the code ran.' : 'The user declined running this code.');
        // The person reviewed this cell for that session; a session started since then holds something else.
        if (workbench.kernels.status(sessionId).session?.id !== status.id) return failed('no_session', 'The analysis session ended while this was waiting for approval', 'explicit');
      } else grant.usedRuns++;
      const operation = await workbench.kernels.run(sessionId, { ...args, origin: 'model', turnId, signal, approval: grant ? 'grant' : 'individual' });
      const after = workbench.kernels.status(sessionId).session, result = runResult(operation);
      result.data = { ...(result.data as object), sessionState: after ? { cell: after.cells.length, variables: after.variables.slice(0, 40) } : 'ended' };
      const policy = workbench.kernels.policy(sessionId) || policies[0];
      return policy ? workbench.restricted(result, policy) : result;
    }),
  });
  registry.register({
    name: 'codelab_inspect', family: 'analysis', effects: { read: true },
    description: 'Inspect the original method, parameters, versioned input slots, logs and output references of a Code Lab run in this conversation before explaining or revising it.',
    input: z.strictObject({ operationId: id }), available: analysis,
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const operation = workbench.operations.get(args.operationId);
      if (operation.sessionId !== sessionId || operation.kind !== 'codelab.run') return failed('not_found', 'Choose a Code Lab run from this conversation', 'never');
      const policy = workbench.artifacts.inherit(sessionId, operation.inputs);
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, policy)) return failed('destination', 'The source policy does not allow this analysis to be sent to the model', 'never');
      const draft = await workbench.analyses.open(sessionId, operation.id);
      const data = { ...draft, outcome: operation.state, exitCode: operation.details?.exitCode, outputs: operation.results, stderr: String(operation.details?.stderr || '').slice(-4000), stdout: String(operation.details?.stdout || '').slice(-4000) };
      if (!workbench.spendEvidence(sessionId, turnId, Buffer.byteLength(JSON.stringify(data)))) return failed('evidence-budget','The analysis exceeds the remaining evidence allowance for this turn','never');
      return workbench.restricted(completed('Original analysis and results', data), policy);
    }),
  });
  registry.register({
    name: 'codelab_read_result', family: 'analysis', effects: { read: true },
    description: 'Read a bounded page of a CSV or TSV output from an analysis in this conversation. Returned record numbers refer to the original version even after filtering. Cite its name, version, record and column.',
    input: z.strictObject({ operationId: id, versionId: id, query: z.string().max(500).optional(), offset: z.int().min(0).optional(), limit: z.int().min(1).max(20).optional() }),
    available: analysis,
    run: guard(async ({ sessionId, turnId, signal }, args) => {
      const operation = workbench.operations.get(args.operationId);
      const output = operation.results.find(ref => ref.versionId === args.versionId);
      if (operation.sessionId !== sessionId || operation.kind !== 'codelab.run' || !output)
        return failed('not_found', 'Choose a result from this analysis', 'never');
      const version = workbench.artifacts.version(sessionId, output.artifactId, output.versionId);
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, version.policy))
        return failed('destination', 'The source policy does not allow sending these results to this model', 'never');
      const table = await workbench.analyses.table({ sessionId, ...output, query: args.query, offset: args.offset, limit: args.limit || 5 });
      const result = { name: version.name, ...output, ...table };
      if (!workbench.spendEvidence(sessionId, turnId, Buffer.byteLength(JSON.stringify(result))))
        return failed('evidence-budget','Select fewer rows to fit the evidence allowance','never');
      return workbench.restricted(completed('Numbered records from ' + version.name, result), version.policy);
    }),
  });
  registry.register({
    name: 'commands_run', family: 'analysis', effects: { execute: true, write: true },
    description: 'Run one program with arguments (a list, never a shell string) in a workspace folder that allows commands, such as a build or test. The folder is writable for the run; nothing else of the user’s is visible; network is off unless needed. The user reviews every command.',
    input: z.strictObject({ rootId: id.optional(), argv: z.array(z.string().max(4096)).min(1).max(64), cwd: z.string().max(4096).optional(), network: z.boolean().optional(), timeoutSeconds: z.int().min(5).max(1800).optional(), purpose: z.string().min(1).max(300) }),
    available: session => analysis(session) || (workbench.roots.list(session.id).some(root => root.policy.execute) ? '' : 'No workspace folder allows running commands'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.list(sessionId).find(item => item.policy.execute);
      if (!root?.policy.execute) return failed('denied', 'No workspace folder allows running commands', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, root.policy.destinations)) return failed('destination', `${root.name}’s contents may not be sent to this conversation’s model`, 'never');
      const cwd = args.cwd ? normalizePath(args.cwd, root.path) : '';
      const answer = await workbench.core.approval(sessionId, { kind: 'execution', title: `Run ${args.argv[0]} in ${root.name}?`,
        detail: [`Purpose: ${args.purpose}`, `Command: ${args.argv.map((arg: string) => JSON.stringify(arg)).join(' ')}`, `Folder: ${root.path}${cwd ? '/' + cwd : ''} (writable during the run)`, `Network: ${args.network ? 'allowed' : 'off'}`, `Time limit: ${args.timeoutSeconds || 300} s`].join('\n'),
        choices: ['allow', 'deny'], fields: { reviewComplete: true, root: root.id } });
      if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the command ran.' : 'The user declined this command.');
      return runResult(await lab().command(sessionId, root, { argv: args.argv, cwd, network: args.network, timeoutSeconds: args.timeoutSeconds, origin: 'model', turnId, signal }));
    }),
  });
  // Host commands (PAL Everywhere §7.5): the desktop account, not the sandbox. Offered only when the conversation
  // turned on Host commands; each run is a CLI permission request, so the working profile, power sessions and the
  // automatic-approval switch decide exactly as they do for Codex or Claude commands.
  registry.register({
    name: 'host_run', family: 'host', core: true, effects: { execute: true, write: true },
    description: 'Run a shell command (Bash by default) on the user’s computer as their desktop account, in a workspace folder of this conversation. Not isolated: it can read and change anything that account can, use the network and installed tools. Use it for builds, tests, git and system commands the user asked for. Output is bounded (256 KiB per stream); give a time limit for long work. The user may review each command before it runs.',
    input: z.strictObject({ command: z.string().min(1).max(64 * 1024), shell: z.enum(['bash', 'sh', 'fish', 'zsh']).optional(), rootId: id.optional(), cwd: z.string().max(4096).optional(), timeoutSeconds: z.int().min(5).max(1800).optional(), purpose: z.string().min(1).max(300) }),
    available: session => workbench.families(session).has('host') ? (workbench.roots.list(session.id).length ? '' : 'Choose a workspace folder for this conversation first') : 'Host commands are not turned on for this conversation',
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.primary(sessionId) || workbench.roots.list(sessionId)[0];
      if (!root) return failed('no_root', 'No workspace folder is chosen', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, root.policy.destinations)) return failed('destination', `${root.name}’s contents may not be sent to this conversation’s model, so its command output cannot be either`, 'never');
      const cwd = args.cwd ? normalizePath(args.cwd, root.path) : '', shell = args.shell || 'bash';
      const answer = await workbench.core.approval(sessionId, { kind: 'cli', title: `Run on this computer: ${args.command.replace(/\s+/g, ' ').slice(0, 80)}?`,
        detail: [`Purpose: ${args.purpose}`, `Shell: ${shell} (your desktop account, not isolated)`, `Folder: ${root.path}${cwd ? '/' + cwd : ''}`, `Time limit: ${args.timeoutSeconds || 300} s`, '', args.command.slice(0, 8000) + (args.command.length > 8000 ? '\n…' : '')].join('\n'),
        choices: ['allow', 'deny'], fields: { reviewComplete: args.command.length <= 8000, root: root.id } });
      if (answer.choice !== 'allow') return declined(answer.cancelled ? 'Stopped before the command ran.' : 'The user declined this command. Do not run it again without a new request.');
      if (answer.automatic && !workbench.core.automaticallyApprove(sessionId, { kind: 'cli', choices: ['allow'] })) return declined('Automatic approval ended before the command ran.');
      return runResult(await lab().hostCommand(sessionId, root, { program: { kind: 'shell', shell, command: args.command }, cwd, timeoutSeconds: args.timeoutSeconds, origin: 'model', turnId, signal }));
    }),
  });
  const gitTool = (name: string, description: string, input: z.ZodObject<any>, argv: (args: any) => string[]) => registry.register({
    name, family: 'files', effects: { read: true }, description, input,
    available: session => workbench.filesAvailable(session, 'read'),
    run: guard(async ({ sessionId, signal, turnId }, args) => {
      const root = args.rootId ? workbench.roots.get(sessionId, args.rootId) : workbench.roots.primary(sessionId);
      if (!root) return failed('no_root', 'No workspace folder is chosen', 'never');
      if (!routeAllowed((await workbench.route(sessionId, signal)).route, root.policy.destinations)) return failed('destination', `${root.name}’s contents may not be sent to this conversation’s model`, 'never');
      const value = await lab().git(root, argv(args), signal);
      if (!workbench.spendEvidence(sessionId, turnId, Buffer.byteLength(value.output))) return failed('evidence-budget', 'This turn already received the most file content PAL releases in one turn', 'never');
      return workbench.restricted(completed(`${name.replace('_', ' ')} for ${root.name}${value.truncated ? ' (output cut at 64 KiB)' : ''}.`, { rootId: root.id, output: value.output, ...(value.truncated ? { truncated: true } : {}) }), root.policy.destinations);
    }),
  });
  gitTool('git_status', 'Read-only git status of a workspace folder (branch, staged, changed and untracked files).', z.strictObject({ rootId: id.optional() }), () => ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  gitTool('git_diff', 'Read-only git diff of a workspace folder, optionally for one path or the staged changes. External diff programs and text conversion are off.', z.strictObject({ rootId: id.optional(), path: z.string().max(4096).optional(), staged: z.boolean().optional() }),
    args => ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(args.staged ? ['--cached'] : []), ...(args.path ? ['--', normalizePath(args.path) || '.'] : [])]);
  gitTool('git_log', 'Read-only recent commit history of a workspace folder.', z.strictObject({ rootId: id.optional(), limit: z.int().min(1).max(100).optional() }),
    args => ['log', '--no-decorate', '--no-color', `-n${args.limit || 20}`, '--date=short', '--format=%h %ad %an%n    %s']);
}
