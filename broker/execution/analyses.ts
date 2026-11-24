/** Saved analyses refer to immutable runs and authorized artifacts. Code and data are never copied into settings. */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workbench } from '../workbench.ts';
import type { ArtifactRef } from '../tools/contracts.ts';
import { limitedControlled } from '../authority.ts';
import { parseCsv, previewTable, tableLimits, spreadsheetRuns } from '../table-preview.ts';
import { zipFilesAsync } from '../artifacts/zip.ts';
import { helperDigest, kernelSource, recipeSource, recipes } from './recipes.ts';
import { pythonRuntime } from './runner.ts';

type Saved = { id: string; name: string; sourceSessionId: string; operationId: string; days: number; due: number; paused: string; previous?: string; device?: string; envelope?: string };
type TableRequest = { sessionId: string; artifactId: string; versionId: string; query?: string; sort?: string; direction?: string; rows?: number[]; offset?: number; limit?: number; spreadsheetSafe?: boolean };
const day = 86_400_000;
const refOf = (v: Pick<ArtifactRef, 'artifactId' | 'versionId'>) => ({ artifactId: v.artifactId, versionId: v.versionId });
export class AnalysisLibrary {
  workbench: Workbench;
  ticking = false;
  canScheduleForDevice: (deviceId: string, sessionId: string) => boolean = () => false;
  constructor(workbench: Workbench) {
    this.workbench = workbench;
    this.db.exec(`CREATE TABLE IF NOT EXISTS saved_analyses(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, name TEXT NOT NULL, due INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, UNIQUE(operation_id,name));
      CREATE INDEX IF NOT EXISTS analysis_due ON saved_analyses(due);
      CREATE TABLE IF NOT EXISTS analysis_runtimes(digest TEXT PRIMARY KEY, helpers TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO analysis_runtimes(digest,helpers) VALUES (?,?)')
      .run(helperDigest, JSON.stringify({ 'lab_data.py': recipeSource('lab_data'), 'sql.py': recipeSource('sql'), 'kernel.py': kernelSource }));
  }
  get db() { return this.workbench.core.store.db; }
  get artifacts() { return this.workbench.artifacts; }
  private session(id: string) {
    const session = this.workbench.core.store.session(id);
    if (session.temporary || limitedControlled(session)) throw new Error('Code Lab needs a saved full-access conversation');
    return session;
  }
  private sameProject(a: string, b: string) {
    const current = this.session(a), other = this.session(b);
    if (a !== b && (!current.cwd || current.cwd !== other.cwd)) throw new Error('Choose a run in this project');
  }
  private put(row: Saved) {
    this.db.prepare(`INSERT INTO saved_analyses(id,session_id,operation_id,name,due,data) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET due=excluded.due,data=excluded.data`).run(row.id, row.sourceSessionId, row.operationId, row.name, row.due, JSON.stringify(row));
    this.workbench.core.changed();
    return row;
  }
  private saved(sessionId: string, id: unknown) {
    const row = this.db.prepare('SELECT data FROM saved_analyses WHERE id=?').get(z.uuid().parse(id));
    if (!row) throw new Error('The saved analysis no longer exists');
    const saved: Saved = JSON.parse(String(row.data));
    this.sameProject(sessionId, saved.sourceSessionId);
    return saved;
  }
  projectSessions(sessionId: string) {
    const session = this.session(sessionId);
    return this.workbench.core.store.sessions().filter(s => s.id === session.id || (!!session.cwd && s.cwd === session.cwd && !s.temporary && !limitedControlled(s))).map(s => s.id);
  }
  list(sessionId: string) {
    const ids = this.projectSessions(sessionId);
    return this.db.prepare('SELECT data FROM saved_analyses WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC')
      .all(JSON.stringify(ids)).map(row => {
        const { device: _device, envelope: _envelope, ...summary } = JSON.parse(String(row.data)) as Saved;
        return summary;
      });
  }
  async open(sessionId: string, operationId: unknown) {
    const op = this.workbench.operations.get(operationId);
    if (op.sessionId !== sessionId || op.kind !== 'codelab.run') throw new Error('Choose a Code Lab run in this conversation');
    const code = op.inputs.find(ref => ref.purpose === 'code');
    if (!code) throw new Error('The original code is unavailable');
    const { data } = await this.artifacts.bytes(sessionId, code.artifactId, code.versionId);
    const steps = op.details?.notebook ? JSON.parse(data.toString()) : [];
    const inputs = op.inputs.filter(ref => ref.purpose !== 'code').map(refOf);
    const slots = inputs.map((ref, i) => {
      try {
        const version = this.artifacts.version(sessionId, ref.artifactId, ref.versionId);
        return { ...ref, name: version.name, mime: version.mime, sha256: version.sha256, policy: version.policy, available: true };
      } catch { return { ...ref, name: 'Input ' + (i + 1), mime: undefined, policy: undefined, available: false }; }
    });
    return { operationId: op.id, parentId: op.id, purpose: String(op.details?.purpose || op.label.replace(/^Code Lab: /, '')), language: String(op.details?.language || 'python'),
      sharedPython: op.details?.sharedPython === true, parameters: op.details?.parameters || {}, timeoutSeconds: op.details?.timeLimitSeconds || 60, code: steps.length ? steps[0].code : data.toString(), steps, inputs, slots,
      runtime: op.details?.runtime, expectedOutputs: op.results.map(r => { try { return this.artifacts.version(sessionId, r.artifactId, r.versionId).name; } catch { return '(removed)'; } }) };
  }
  codeVersion(sessionId: string, id: unknown) {
    const row = this.saved(sessionId, id);
    const ref = this.workbench.operations.get(row.operationId).inputs.find(r => r.purpose === 'code');
    if (!ref) throw new Error('The saved code is missing');
    return this.artifacts.version(row.sourceSessionId, ref.artifactId, ref.versionId);
  }
  async preflight(sessionId: string, p: any) {
    this.session(sessionId);
    const refs = z.array(z.object({artifactId:z.uuid(),versionId:z.uuid()})).max(8).parse(p.inputs || []);
    const runtime = await pythonRuntime(), warnings: string[] = [];
    const schema = async (owner: string, ref: typeof refs[number], i: number) => {
      const version = this.artifacts.version(owner, ref.artifactId, ref.versionId);
      let columns: string[] = [], sheets: string[] = [];
      let rows: number | undefined, fields: unknown[] = [], sample: unknown[] = [];
      if ((version.kind === 'table' || /\.(csv|tsv|xlsx)$/i.test(version.name)) && version.bytes <= 25 * 1024 * 1024) {
        const { data } = await this.artifacts.bytes(owner, ref.artifactId, ref.versionId);
        if (/\.xlsx$/i.test(version.name)) {
          const parsed = await this.workbench.extractor.parseFile(data, version.name, version.mime);
          sheets = (parsed.stats.sheets || []) as string[];
          const sheet = p.parameters?.['sheet' + (i + 1)] || p.parameters?.sheet || sheets[0];
          columns = ((parsed.stats.headers || {}) as Record<string,string[]>)[sheet] || [];
          if (!sheets.includes(sheet)) warnings.push('Choose an available worksheet for ' + version.name);
          warnings.push(...parsed.warnings);
        } else if (/\.(csv|tsv)$/i.test(version.name)) {
          const preview = previewTable(data.toString('utf8'), version.name);
          fields = preview.columns; columns = preview.columns.map(c => c.name); rows = preview.rows; sample = preview.sample; warnings.push(...preview.problems);
        }
      }
      return { ...ref, name: version.name, columns, sheets, mime: version.mime, rows, fields, sample };
    };
    const slots = await Promise.all(refs.map((r,i) => schema(sessionId,r,i)));
    const original = p.analysisId ? await this.load(sessionId,p.analysisId) : p.parentId ? await this.open(sessionId,p.parentId) : undefined;
    if (original) {
      const sourceSessionId = 'sourceSessionId' in original ? String(original.sourceSessionId) : sessionId;
      if (original.slots.length !== slots.length) warnings.push('The number of inputs differs from the saved analysis');
      for (const [i, slot] of slots.entries()) {
        const old = original.slots[i];
        if (!old || old.versionId === slot.versionId || !old.available) continue;
        const before = await schema(sourceSessionId,old,i);
        if (before.mime !== slot.mime || JSON.stringify(before.columns) !== JSON.stringify(slot.columns)) warnings.push('Input ' + (i + 1) + ' has different columns or a different file type from ' + old.name);
      }
      if (JSON.stringify(original.runtime) !== JSON.stringify(runtime)) warnings.push('Python or its packages differ from the original run');
    }
    const sources: string[] = Array.isArray(p.steps) && p.steps.length ? p.steps.map((s: any) => String(s.code)) : [String(p.code || '')];
    const knownModules: Record<string,string> = { numpy: 'numpy', matplotlib: 'matplotlib', PIL: 'pillow', pandas: 'pandas', scipy: 'scipy', duckdb: 'duckdb', openpyxl: 'openpyxl', pyarrow: 'pyarrow' };
    const needed = new Set<string>();
    for (const code of sources) for (const match of code.matchAll(/^\s*(?:from|import)\s+(\w+)/gm)) {
      if (Object.hasOwn(knownModules,match[1])) needed.add(knownModules[match[1]]);
    }
    if (slots.some(slot => /\.parquet$/i.test(slot.name))) needed.add('duckdb');
    const missingPackages = [...needed].filter(pkg => !runtime.packages[pkg]);
    if (missingPackages.length) warnings.push('Desktop Python is missing ' + missingPackages.join(', '));
    return { slots, warnings: [...new Set(warnings)], runtime, missingPackages };
  }
  async sample(sessionId: string) {
    this.session(sessionId);
    const csv = 'month,revenue\nJan,120\nFeb,155\nMar,143\nApr,189\nMay,215\nJun,206\n';
    const name = 'sample-revenue.csv';
    const existing = this.artifacts.list(sessionId, { query: name, limit: 10 }).artifacts.find(v => v.name === name && v.latest.provenance.kind === 'codelab-sample');
    const sample = existing && await this.artifacts.available(existing.latest) ? existing.latest : await this.artifacts.install({ sessionId, bytes: Buffer.from(csv), name, source: 'user-import', provenance: { kind: 'codelab-sample' } });
    return { recipeId: 'plot', code: recipes.plot.code, purpose: 'Monthly revenue trend', language: 'python', inputs: [refOf(sample)], parameters: { x: 'month', y: 'revenue', yLabel: 'Revenue (USD)' } };
  }
  async save(sessionId: string, operationId: unknown, label: unknown) {
    this.session(sessionId);
    const op = this.workbench.operations.get(operationId);
    if (op.sessionId !== sessionId || op.kind !== 'codelab.run' || op.state !== 'completed' || op.details?.exitCode !== 0) throw new Error('Choose a successful analysis to save');
    // §15.2: a session cell may depend on cells before it, so it is never presented as something that replays.
    if (op.details?.sessionKernel) throw new Error('This ran in an analysis session and may depend on earlier cells. Make a notebook of the session, run it, and save that.');
    const name = z.string().trim().min(1).max(120).parse(label);
    await this.open(sessionId, op.id);
    const old = this.db.prepare('SELECT data FROM saved_analyses WHERE operation_id=? AND name=?').get(op.id, name);
    if (old) return JSON.parse(String(old.data)) as Saved;
    return this.put({ id: randomUUID(), name, sourceSessionId: sessionId, operationId: op.id, days: 0, due: 0, paused: '' });
  }
  async load(sessionId: string, id: unknown) {
    const row = this.saved(sessionId, id);
    const spec = await this.open(row.sourceSessionId, row.operationId);
    const warnings: string[] = [];
    const slots = spec.slots.map(slot => {
      const available = slot.available && this.artifacts.authorized(sessionId, slot.artifactId);
      if (!available) warnings.push('Choose a replacement for ' + slot.name);
      else if (this.artifacts.version(sessionId, slot.artifactId).versionId !== slot.versionId) warnings.push(slot.name + ' has a newer version. This draft uses the original.');
      return { ...slot, available };
    });
    if (JSON.stringify(spec.runtime) !== JSON.stringify(await pythonRuntime())) warnings.push('Runtime packages differ from the original run');
    return { ...spec, id: row.id, sourceSessionId: row.sourceSessionId, parentId: sessionId === row.sourceSessionId ? row.operationId : undefined,
      operationId: sessionId === row.sourceSessionId ? row.operationId : undefined, purpose: row.name, inputs: slots.filter(s => s.available).map(refOf), slots, warnings };
  }
  remove(sessionId: string, id: unknown) {
    const row = this.saved(sessionId, id);
    if (row.sourceSessionId !== sessionId) throw new Error('Remove this analysis from its original conversation');
    this.db.prepare('DELETE FROM saved_analyses WHERE id=?').run(row.id);
    this.workbench.core.changed(); return true;
  }
  async export(sessionId: string, operationId: unknown, selected?: unknown) {
    const spec = await this.open(sessionId, operationId), op = this.workbench.operations.get(operationId);
    if (op.details?.sessionKernel) throw new Error('This ran in an analysis session and may depend on earlier cells, so it cannot be exported for replay. Make a notebook of the session, run it, and export that.');
    const chosen = selected === undefined ? op.results : z.array(z.uuid()).max(20).parse(selected).map(id => {
      const ref = op.results.find(r => r.versionId === id);
      if (!ref) throw new Error('Choose an output from this analysis');
      return ref;
    });
    const entries: { name: string; data: Buffer }[] = [];
    const outputFiles = [];
    let total = 0;
    for (const [i, ref] of chosen.entries()) {
      const v = this.artifacts.version(sessionId, ref.artifactId, ref.versionId);
      total += v.bytes;
      if (total > 95 * 1024 * 1024) throw new Error('Select fewer outputs for an analysis bundle');
      const name = 'outputs/' + (i + 1) + '-' + v.name.replace(/[:\\]/g, '_');
      entries.push({ name, data: (await this.artifacts.bytes(sessionId, ref.artifactId, ref.versionId)).data });
      outputFiles.push({ ...refOf(ref), name, sha256: v.sha256 });
    }
    const cells = spec.steps.length ? spec.steps : [{ name: spec.purpose, code: spec.code, language: spec.language }];
    const files = cells.map((c: {code:string; language:string}, i: number) => {
      const name = 'code/step-' + (i + 1) + (c.language === 'sql' ? '.sql' : '.py');
      entries.push({ name, data: Buffer.from(c.code) }); return name;
    });
    const originalDigest = String(op.details?.helperDigest || '');
    const archived = this.db.prepare('SELECT helpers FROM analysis_runtimes WHERE digest=?').get(originalDigest);
    const helpers: Record<string,string> = archived ? JSON.parse(String(archived.helpers)) : { 'lab_data.py': recipeSource('lab_data'), 'sql.py': recipeSource('sql'), 'kernel.py': kernelSource };
    for (const [name, source] of Object.entries(helpers))
      entries.push({ name: 'runtime/' + name, data: Buffer.from(source) });
    for (const [path, target] of [['replay.mjs','replay.mjs'], ['kernel.ts','runtime/kernel.ts'], ['runner.ts','runtime/runner.ts']]) {
      entries.push({ name: target, data: await readFile(new URL('./' + path, import.meta.url)) });
    }
    entries.push({name:'README.txt', data:Buffer.from(
      'Replay on Linux with the Node.js version used by PAL, Bubblewrap, Python and the packages listed in manifest.json.\n' +
      'Unpack the ZIP. Run node replay.mjs --help for options. Supply input files in manifest order.\n' +
      'Each input is checked against its recorded SHA-256. Use --replace-inputs to deliberately substitute a file.\n' +
      'Outputs are written to a fresh analysis-results directory. The program runs in a new network-isolated sandbox.\n')});
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1, operationId: op.id, purpose: spec.purpose, sharedPython: spec.sharedPython, runtime: spec.runtime, originalHelperDigest: op.details?.helperDigest,
      exportedHelperDigest: archived ? originalDigest : helperDigest, helperVersionsMatch: originalDigest ? !!archived : null, limits: op.details?.limits, timeLimitSeconds: spec.timeoutSeconds, inputs: spec.slots, parameters: spec.parameters, files, outputs: outputFiles }, null, 2)) });
    entries.push({ name: 'parameters.json', data: Buffer.from(JSON.stringify(spec.parameters, null, 2)) });
    const refs = [...op.inputs, ...chosen];
    const result = await this.artifacts.install({ sessionId, name: 'analysis.zip', source: 'derived', bytes: await zipFilesAsync(entries),
      parents: refs.map(r => ({ ...refOf(r), relation: 'analysis-bundle' })), policy: this.artifacts.inherit(sessionId, refs), provenance: { kind: 'analysis-bundle', operationId: op.id } });
    return refOf(result);
  }
  async table(p: TableRequest, exporting = false) {
    const { version, data } = await this.artifacts.bytes(p.sessionId, p.artifactId, p.versionId);
    if (!/\.(csv|tsv)$/i.test(version.name)) throw new Error('Choose a CSV or TSV table');
    if (data.length > tableLimits.bytes) throw new Error('Use a Code Lab query for tables over 64 MiB');
    const { rows: parsed, problems } = parseCsv(data.toString('utf8').replace(/^\uFEFF/, ''), version.name.toLowerCase().endsWith('.tsv') ? '\t' : ',');
    const columns = parsed.shift() || [];
    const query = (p.query || '').trim().toLocaleLowerCase();
    const rows = parsed.map((values, i) => ({ row: i + 1, values })).filter(row => !query || row.values.some(v => v.toLocaleLowerCase().includes(query)));
    const column = columns.indexOf(p.sort || '');
    if (p.sort && column < 0) throw new Error('Choose an existing sort column');
    if (column >= 0) {
      const collator = new Intl.Collator(undefined, { numeric: true });
      const numeric = rows.every(r => !r.values[column]?.trim() || Number.isFinite(Number(r.values[column])));
      const direction = p.direction === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const left = a.values[column]?.trim() || '', right = b.values[column]?.trim() || '';
        if (!left || !right) return left ? -1 : right ? 1 : 0;
        return direction * (numeric ? Number(left) - Number(right) : collator.compare(left, right));
      });
    }
    if (exporting) {
      if (problems.length) throw new Error('Resolve parsing or preview limits before exporting this selection: ' + problems.join('. '));
      const ids = p.rows ? new Set(z.array(z.number().int().positive()).max(tableLimits.rows).parse(p.rows)) : undefined;
      const selected = ids ? rows.filter(r => ids.has(r.row)) : rows;
      if (ids && selected.length !== ids.size) throw new Error('A selected record is outside this result');
      // Text for a spreadsheet: a cell it would run gets a leading apostrophe. The source version stays as it is.
      const safe = p.spreadsheetSafe === true; let escaped = 0;
      const encode = (values: string[]) => values.map(v => { const runs = safe && spreadsheetRuns(v); if (runs) escaped++; return '"' + (runs ? "'" : '') + v.replaceAll('"', '""') + '"'; }).join(',');
      const result = await this.artifacts.install({ sessionId: p.sessionId, name: 'selected.csv', source: 'derived', bytes: Buffer.from([encode(columns), ...selected.map(r => encode(r.values))].join('\r\n') + '\r\n'),
        parents: [{ ...refOf(version), relation: 'source-table' }], policy: version.policy, provenance: { kind: 'table-selection', rows: selected.length, ...(safe ? { spreadsheetSafe: true, escapedCells: escaped } : {}), ...(ids ? { sourceRecords: [...ids].map(String) } : {}), query, sort: p.sort || '', direction: p.direction || 'asc' } });
      return refOf(result);
    }
    const offset = z.number().int().min(0).parse(p.offset ?? 0), limit = z.number().int().min(1).max(200).parse(p.limit ?? 50);
    const page = rows.slice(offset, offset + limit), width = Math.min(80, columns.length);
    const cellLimit = Math.min(2000, Math.max(4, Math.floor(110000 / Math.max(1, width * page.length))));
    const displayColumns = columns.slice(0,width);
    if (columns.length > width) problems.push('Showing the first ' + width + ' columns. Use SQL to select other columns.');
    let shortened = false;
    const displayRows = page.map(r => ({ row:r.row, values:r.values.slice(0,width).map(v => {
      if (v.length > cellLimit) shortened = true;
      return v.slice(0,cellLimit);
    }) }));
    if (shortened) problems.push('Long values are shortened in this preview. Export the matching rows for their full values.');
    return { columns:displayColumns, rows:displayRows, total:parsed.length, matched:rows.length, formulaCells: rows.reduce((sum, r) => sum + r.values.filter(spreadsheetRuns).length, columns.filter(spreadsheetRuns).length), problems };
  }
  schedule(sessionId: string, id: unknown, interval: unknown, device?: string) {
    const row = this.saved(sessionId, id), days = z.number().int().min(0).max(365).parse(interval);
    if (sessionId !== row.sourceSessionId) throw new Error('Schedule this analysis in its original conversation');
    if (days && !this.workbench.execution.enabled()) throw new Error('Turn on Code Lab before scheduling');
    return this.put({ ...row, days, device, due: days ? Date.now() + days * day : 0, paused: '',
      envelope: JSON.stringify(this.workbench.core.schedules.envelope(sessionId)) });
  }
  async tick(now = Date.now()) {
    if (this.ticking || this.workbench.core.closed) return;
    this.ticking = true;
    try {
      for (const { data } of this.db.prepare('SELECT data FROM saved_analyses WHERE due>0 AND due<=? ORDER BY due LIMIT 4').all(now)) {
        const row = JSON.parse(String(data)) as Saved, sessionId = row.sourceSessionId;
        const next = now + row.days * day;
        const claimed = { ...row, due: next };
        const claim = this.db.prepare('UPDATE saved_analyses SET due=?,data=? WHERE id=? AND data=?')
          .run(next, JSON.stringify(claimed), row.id, data);
        if (!claim.changes) continue;
        this.workbench.core.changed();
        try {
          if (this.workbench.core.settings.paused) throw new Error('PAL actions are paused');
          if (row.device && !this.canScheduleForDevice(row.device, sessionId)) throw new Error('The authorizing phone no longer has access');
          if (row.envelope !== JSON.stringify(this.workbench.core.schedules.envelope(sessionId))) throw new Error('The settings for this schedule changed');
          const draft = await this.load(sessionId, row.id);
          if (this.workbench.operations.get(row.operationId).details?.helperDigest && this.workbench.operations.get(row.operationId).details?.helperDigest !== helperDigest) throw new Error('The notebook runtime helpers changed');
          if (draft.slots.some(s => !s.available)) throw new Error('A scheduled input is missing');
          if (draft.warnings.some(s => s.startsWith('Runtime'))) throw new Error('The analysis runtime changed');
          const inputs = draft.slots.map(s => {
            const latest = this.artifacts.version(sessionId, s.artifactId);
            if (latest.mime !== s.mime || JSON.stringify(latest.policy) !== JSON.stringify(s.policy)) throw new Error('An input format or destination policy changed');
            return refOf(latest);
          });
          const review = await this.preflight(sessionId, { ...draft, inputs, analysisId: row.id });
          if (review.warnings.length) throw new Error(review.warnings.join('. '));
          if (row.device && !this.canScheduleForDevice(row.device, sessionId)) throw new Error('The authorizing phone no longer has access');
          if (this.saved(sessionId, row.id).due !== next || this.workbench.core.closed) continue;
          const run = await this.workbench.execution.run(sessionId, { ...draft, inputs, parentId: row.previous || row.operationId, origin: 'schedule', approval: 'schedule' });
          if (this.saved(sessionId, row.id).due !== next) continue;
          if (run.state !== 'completed') throw new Error(run.error?.message || run.state);
          this.put({ ...row, due: next, previous: run.id });
          this.workbench.core.emit('notice', { kind: 'schedule', sessionId, text: row.name + ' finished in Code Lab' });
        } catch (error) {
          if (!this.db.prepare('SELECT 1 FROM saved_analyses WHERE id=? AND due=?').get(row.id, next)) continue;
          this.put({ ...row, days: 0, due: 0, paused: error instanceof Error ? error.message : 'Schedule paused' });
        }
      }
    } finally { this.ticking = false; }
  }
}
