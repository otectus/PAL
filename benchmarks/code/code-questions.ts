#!/usr/bin/env node
// A03: how well the code index answers questions about a project's own code, against the plain search a model would do
// otherwise (files ranked by how many of the question's words they contain). It reads this repository into an index in a
// temporary folder, asks tests/fixtures/code-questions.json, and contacts nothing.
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodeIndex, isTestPath } from '../../broker/code-context/index.ts';
import { languageOf, parseSource } from '../../broker/code-context/languages.ts';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
type Question = { q: string; a: string[] };
const round = (value: number) => Math.round(value * 1000) / 1000;
const common = new Set('a an and are as at be by for from has how in into is it its of on or out that the their them they this to was what when where which who with'.split(' '));

async function sources() {
  const found = new Map<string, string>();
  const walk = async (folder: string) => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules', 'build', 'dist', 'target', 'coverage'].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(path); else if (languageOf(path)) found.set(path, await readFile(join(root, path), 'utf8'));
    }
  };
  for (const folder of ['broker', 'native', 'qml', 'tests', 'tools', 'benchmarks']) await walk(folder);
  return found;
}
/** Files by how many of the question's words they contain, then by how often. */
function plain(files: Map<string, string>, question: string) {
  const words = [...new Set(question.toLowerCase().match(/[a-z0-9]+/g) || [])].filter(word => word.length > 2 && !common.has(word));
  return [...files].filter(([path]) => !isTestPath(path)).map(([path, text]) => { const lower = text.toLowerCase(), counts = words.map(word => lower.split(word).length - 1); return { path, distinct: counts.filter(Boolean).length, total: counts.reduce((sum, n) => sum + Math.min(n, 50), 0) }; }).sort((a, b) => b.distinct - a.distinct || b.total - a.total || a.path.localeCompare(b.path)).slice(0, 5).map(row => row.path);
}
export async function runCode() {
  const files = await sources(), directory = await mkdtemp(join(tmpdir(), 'pal-code-benchmark-')), index = new CodeIndex(join(directory, 'index.sqlite'));
  try {
    const started = performance.now(); for (const [path, text] of files) index.replace(root, { path, language: languageOf(path)!, sha256: '', size: text.length, mtime: 0, problem: '' }, parseSource(path, text));
    const indexing = performance.now() - started, sets = JSON.parse(await readFile(join(root, 'tests/fixtures/code-questions.json'), 'utf8')) as { tuned: Question[]; held: Question[] };
    const unknown = [...sets.tuned, ...sets.held].flatMap(item => item.a).filter(answer => { const [path, name] = answer.split('#'), last = name.split('.').at(-1)!; return !index.named(root, last).some(symbol => symbol.path === path && (!name.includes('.') || symbol.container === name.split('.')[0])); });
    const score = (questions: Question[]) => {
      let one = 0, five = 0, file = 0, base = 0, reciprocal = 0; const missed: string[] = [];
      for (const item of questions) {
        const found = index.find(root, item.q, 10).map(({ symbol }) => ({ key: `${symbol.path}#${symbol.container ? symbol.container + '.' : ''}${symbol.name}`, path: symbol.path }));
        // A symbol counts by its own name; a class or component also by a member found inside it.
        const hit = found.findIndex(row => item.a.some(answer => row.key === answer || row.key.startsWith(answer + '.'))), place = new Set(item.a.map(answer => answer.split('#')[0]));
        if (hit === 0) one++; if (hit >= 0 && hit < 5) five++; else missed.push(`${item.q} → ${found.slice(0, 3).map(row => row.key).join(', ')}`);
        if (hit >= 0) reciprocal += 1 / (hit + 1);
        if (found.slice(0, 5).some(row => place.has(row.path))) file++;
        if (plain(files, item.q).some(path => place.has(path))) base++;
      }
      return { questions: questions.length, hitAt1: round(one / questions.length), hitAt5: round(five / questions.length), mrr: round(reciprocal / questions.length), fileAt5: round(file / questions.length), plainSearchFileAt5: round(base / questions.length), missed };
    };
    const counts = index.counts(root);
    return { files: counts.files, symbols: counts.symbols, indexingMs: Math.round(indexing), unknown, tuned: score(sets.tuned), held: score(sets.held) };
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const report = await runCode(), output = process.argv.indexOf('--output');
  if (output > 0 && process.argv[output + 1]) await writeFile(process.argv[output + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
