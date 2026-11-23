import type { ArtifactStore } from '../artifacts/store.ts';
import type { Operation } from '../operations/store.ts';
import type { ArtifactVersion } from '../artifacts/store.ts';
import { parseCsv } from '../table-preview.ts';

type Table = { headers: string[]; rows: string[][] };
type Difference = { column: string; before: string | null; after: string | null; delta?: number };
type Example = { key: string; beforeRecord?: number; afterRecord?: number; changes?: Difference[] };
type Comparison = { name: string; step?: number; warning?: string; leftVersion?: string; rightVersion?: string;
  headers?: { left: string[]; right: string[] }; leftRows?: number; rightRows?: number;
  matched?: number; added?: number; removed?: number; modified?: number; examples?: Example[] };

function indexRows(table: Table, keys: string[]) {
  if (new Set(table.headers).size !== table.headers.length) throw new Error('Column names must be distinct to compare records');
  const columns = keys.map(key => {
    const i = table.headers.indexOf(key);
    if (i < 0) throw new Error('Missing matching column: ' + key);
    return i;
  });
  const index = new Map<string, number>();
  table.rows.forEach((row, i) => {
    if (row.length !== table.headers.length) throw new Error('Record ' + (i + 1) + ' has a different field count from its header');
    const components = columns.map(c => row[c]);
    if (components.some(v => !v.trim())) throw new Error('Missing key at record ' + (i + 1));
    const key = keys.length ? JSON.stringify(components) : String(i + 1);
    if (index.has(key)) throw new Error('Duplicate key at records ' + (index.get(key)! + 1) + ' and ' + (i + 1));
    index.set(key, i);
  });
  return index;
}

function compareRows(a: Table, b: Table, keys: string[]) {
  const left = indexRows(a, keys), right = indexRows(b, keys);
  const examples: Example[] = [];
  let matched = 0, added = 0, removed = 0, modified = 0;
  const fields = [...new Set([...a.headers, ...b.headers])].map(column => ({ column, x: a.headers.indexOf(column), y: b.headers.indexOf(column) }));
  for (const [key, i] of left) {
    const j = right.get(key);
    if (j === undefined) {
      removed++;
      if (examples.length < 20) examples.push({ key: key.slice(0,300), beforeRecord: i + 1 });
      continue;
    }
    matched++;
    const changes: Difference[] = [];
    let changed = false;
    for (const {column, x, y} of fields) {
      const before = a.rows[i][x] ?? null, after = b.rows[j][y] ?? null;
      if (before === after) continue;
      changed = true;
      if (changes.length === 12 || examples.length === 20) break;
      const delta = before?.trim() && after?.trim() ? Number(after) - Number(before) : NaN;
      changes.push({column:column.slice(0,160), before:before?.slice(0,240) ?? null, after:after?.slice(0,240) ?? null, ...(Number.isFinite(delta) ? {delta} : {})});
    }
    if (!changed) continue;
    modified++;
    if (examples.length < 20) examples.push({ key:key.slice(0,300), beforeRecord:i+1, afterRecord:j+1, changes });
  }
  for (const [key, j] of right) if (!left.has(key)) {
    added++;
    if (examples.length < 20) examples.push({ key:key.slice(0,300), afterRecord:j+1 });
  }
  return { matched, added, removed, modified, examples };
}

export async function compareResultTables(artifacts: ArtifactStore, left: Operation, right: Operation, p: { keys?: string[]; mode?: 'position' } = {}) {
  const tables: Comparison[] = [], warnings: string[] = [];
  function versions(op: Operation) {
    const map = new Map<string, ArtifactVersion>();
    for (const ref of op.results) {
      try {
        const v = artifacts.version(op.sessionId, ref.artifactId, ref.versionId);
        if (/\.(csv|tsv)$/i.test(v.name)) map.set(JSON.stringify([v.provenance.step || 0, v.provenance.path || v.name]), v);
      } catch { warnings.push('Output version ' + ref.versionId + ' is unavailable'); }
    }
    return map;
  }
  const a = versions(left), b = versions(right);
  let budget = 16 * 1024 * 1024;
  const read = async (owner: string, v: ArtifactVersion): Promise<Table> => {
    const {data} = await artifacts.bytes(owner, v.artifactId, v.versionId);
    const {rows, problems} = parseCsv(data.toString('utf8').replace(/^\uFEFF/, ''), /\.tsv$/i.test(v.name) ? '\t' : ',');
    if (problems.length) throw new Error(problems.join('. '));
    const headers = rows.shift() || [];
    if (headers.length > 256 || rows.length * headers.length > 1_000_000) throw new Error('Use a Code Lab query to compare tables of this size');
    return {headers, rows};
  };
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key), y = b.get(key), v = (x || y)!;
    const info: Comparison = { name: v.name, step: Number(v.provenance.step || 0), leftVersion: x?.versionId, rightVersion: y?.versionId };
    tables.push(info);
    if (!x || !y) { info.warning = 'Only the ' + (x ? 'earlier' : 'later') + ' run produced this output'; continue; }
    if (x.bytes + y.bytes > budget) { info.warning = 'Comparison preview limit reached. Use the table comparison recipe for larger files.'; continue; }
    budget -= x.bytes + y.bytes;
    try {
      const [before, after] = await Promise.all([read(left.sessionId, x), read(right.sessionId, y)]);
      Object.assign(info, { leftRows: before.rows.length, rightRows: after.rows.length, headers:{left:before.headers, right:after.headers} });
      if (p.keys?.length || p.mode === 'position') Object.assign(info, compareRows(before, after, p.mode === 'position' ? [] : p.keys || []));
    } catch (error) { info.warning = error instanceof Error ? error.message : 'Table is unavailable'; }
  }
  return {tables, warnings};
}
