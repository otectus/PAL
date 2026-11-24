#!/usr/bin/env node
// M06 baseline: document-collection retrieval through Canonical.retrieve, the path
// KnowledgeCollections.context takes: a collection's own scope, document chunks from the shared
// chunker keyed by file and content hash, local model route, relevance floor and six items. The
// corpus in tests/fixtures/memory/document-cases.json asks paraphrased questions about a small set
// of project documents. Lexical only: no embedding model, Neo4j or Qdrant is involved, and nothing
// contacts the network. Lineage, chunk bounds, erasure and scope isolation are pass/fail gates;
// hit rates are a measured baseline for later retrieval changes, not a release target.
//
// `--sweep` (RC-09) repeats the questions while scaling the lexical floor, the knob a strict answer mode would turn.
// The floor is zero in a store of under 50 passages, so the sweep adds conversation passages around the collection to
// reach the size of a store in use; they are in another scope and never an answer.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Canonical } from '../../broker/graph-memory/canonical.ts';
import { chunkDocument, collectionLimits } from '../../broker/knowledge-collections.ts';

const round = (value: number) => Number(value.toFixed(3));
const gate = (target: string, value: number, passed: boolean) => ({ target, value, status: passed ? 'passed' : 'failed' });

const topics = ['build', 'release', 'session', 'window', 'server', 'report', 'review', 'draft', 'folder', 'model', 'phone', 'screen', 'test', 'branch', 'memory', 'search', 'image', 'voice', 'timer', 'list'];
const acts = ['opened', 'checked', 'renamed', 'moved', 'finished', 'started', 'compared', 'cleaned', 'measured', 'discussed'];
/** Passages of an ordinary conversation, the same ones every time. */
const filler = (count: number) => Array.from({ length: count }, (_, index) => `The ${topics[index % topics.length]} was ${acts[index % acts.length]} after the ${topics[(index * 7 + 3) % topics.length]} and before the ${topics[(index * 11 + 5) % topics.length]}, number ${index}.`);

type Embed = (texts: string[]) => Promise<number[][]>;
const cosine = (a: number[], b: number[]) => { let dot = 0, left = 0, right = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; } return dot / (Math.sqrt(left * right) || 1); };

export async function runDocuments(options: { cases?: any; filler?: number; scale?: number; embed?: Embed; semanticFloor?: number } = {}) {
  const corpus = options.cases ?? JSON.parse(await readFile(new URL('../../tests/fixtures/memory/document-cases.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'pal-document-baseline-'));
  const c = new Canonical(directory);
  try {
    // Collections register a project-kind scope of their own, with no parent (knowledge-collections.ts).
    const collection = c.registerScope({ key: JSON.stringify(['fixture-host', 'collection:baseline']), label: 'Collection · baseline', kind: 'project' }).id;
    const project = c.registerScope({ key: 'documents:project', label: 'Project memory' }).id;
    const chunks = new Map<string, { path: string; sha256: string; index: number }>(), passages: { id: string; text: string }[] = [];
    let oversized = 0, total = 0;
    for (const doc of corpus.documents) {
      const sha256 = createHash('sha256').update(doc.text).digest('hex');
      for (const [index, chunk] of chunkDocument(doc.text).entries()) {
        total++;
        // A chunk is at most chunkChars of the document plus its "§ heading" line.
        if (Array.from(chunk.text).length > collectionLimits.chunkChars + 3 + chunk.heading.length) oversized++;
        const row = c.observeText({ scope_id: collection, text: chunk.text, role: 'document', kind: 'document', session_id: 'file:' + doc.path, source_event_id: `${sha256}#${index}` });
        chunks.set(row.id, { path: doc.path, sha256, index }); passages.push({ id: row.id, text: chunk.text });
      }
    }
    for (const text of [...corpus.projectMemory, ...filler(options.filler || 0)]) c.observeText({ scope_id: project, text, role: 'user', session_id: 'history' });
    // Meaning is given the way the vector projection gives it: an artifact, its revision and a similarity.
    const vectors = new Map<string, number[]>(), meant = new Map<string, number[]>();
    if (options.embed) {
      const queries = [...corpus.questions.map((item: any) => item.query), ...corpus.abstain, ...corpus.erase.queries, ...corpus.leakQueries];
      (await options.embed(passages.map(item => item.text))).forEach((vector, index) => vectors.set(passages[index].id, vector));
      (await options.embed(queries)).forEach((vector, index) => meant.set(queries[index], vector));
    }
    const near = (text: string) => passages.flatMap(item => {
      const row = c.one('SELECT id,content_revision,source_generation FROM artifacts WHERE id=?', item.id), vector = meant.get(text);
      return row.id && vector ? [{ artifactId: row.id, contentRevision: row.content_revision, sourceGeneration: row.source_generation, score: cosine(vectors.get(item.id)!, vector) }] : [];
    }).sort((a, b) => b.score - a.score).slice(0, 40);
    const retrieve = (scope: string, text: string) => c.retrieve({ ...(options.embed ? { semantic_ids: near(text), semantic_floor: options.semanticFloor ?? 0 } : {}), scope_id: scope, text, relevance_floor: true, max_items: 6, model_route: 'local', ...(options.scale ? { lexical_scale: options.scale } : {}) }).results as any[];
    let unresolved = 0, cited = 0;
    const sources = (results: any[]) => results.map(row => {
      cited++;
      const chunk = chunks.get(row.id);
      // Lineage: every returned chunk names its file and the content revision it was indexed from.
      if (!chunk || row.sessionId !== 'file:' + chunk.path) { unresolved++; return ''; }
      return chunk.path;
    });
    const ranks: (number | null)[] = [], misses: string[] = [];
    for (const item of corpus.questions) {
      const found = sources(retrieve(collection, item.query)).indexOf(item.source);
      ranks.push(found < 0 ? null : found + 1);
      if (found !== 0) misses.push(item.id);
    }
    const abstained = corpus.abstain.filter((query: string) => retrieve(collection, query).length === 0).length;
    // Erasure by document source removes every chunk of the file; nothing returns afterwards.
    const erasedPath = corpus.erase.path;
    const foundBefore = corpus.erase.queries.filter((query: string) => sources(retrieve(collection, query)).includes(erasedPath)).length;
    c.forget({ scope_id: collection, document_source: 'file:' + erasedPath });
    const resurrected = corpus.erase.queries.filter((query: string) => sources(retrieve(collection, query)).includes(erasedPath)).length;
    // Isolation: project memory never answers from a collection, and a collection never from project memory.
    let leaked = 0;
    for (const query of corpus.leakQueries) {
      leaked += retrieve(project, query).filter(row => chunks.has(row.id)).length;
      leaked += retrieve(collection, query).filter(row => !chunks.has(row.id)).length;
    }
    const answered = ranks.filter(rank => rank !== null) as number[];
    return {
      corpus: { documents: corpus.documents.length, chunks: total, questions: corpus.questions.length, abstain: corpus.abstain.length },
      retrieval: {
        hitAt1: round(ranks.filter(rank => rank === 1).length / ranks.length),
        hitAt3: round(ranks.filter(rank => rank !== null && rank <= 3).length / ranks.length),
        hitAt6: round(answered.length / ranks.length),
        mrr: round(ranks.reduce((sum: number, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length),
        abstention: round(abstained / corpus.abstain.length),
        notFirst: misses,
      },
      gates: {
        lineage: gate('every returned chunk resolves to its file and content hash', unresolved, unresolved === 0 && cited > 0),
        chunkBounds: gate(`chunks stay within ${collectionLimits.chunkChars} characters plus their heading`, oversized, oversized === 0),
        noErasureResurrection: gate('a forgotten document returns nothing', resurrected, foundBefore > 0 && resurrected === 0),
        noScopeLeakage: gate('collections and project memory stay apart', leaked, leaked === 0),
        semanticRecall: { target: 'embedding recall', status: options.embed ? 'measured' : 'unmeasured' },
      },
    };
  } finally {
    c.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** RC-09: what each scale of the lexical floor does to answers found first and to questions the documents do not answer. */
export async function sweepLexicalFloor(scales = [1, 1.25, 1.5, 2, 2.5, 3, 4], passages = 400) {
  const rows = [];
  for (const scale of scales) { const { retrieval } = await runDocuments({ filler: passages, scale }); rows.push({ scale, hitAt1: retrieval.hitAt1, hitAt3: retrieval.hitAt3, hitAt6: retrieval.hitAt6, abstention: retrieval.abstention }); }
  return { passages, rows };
}

/**
 * RC-09, the separate opt-in run: the same questions with an embedding model, while raising the similarity floor. The
 * corpus goes to the local Ollama server named on the command line and nowhere else.
 */
export async function sweepSemanticFloor(embed: Embed, floors = [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75], passages = 400) {
  const cache = new Map<string, number[]>(), once: Embed = async texts => { const missing = texts.filter(text => !cache.has(text)); if (missing.length) (await embed(missing)).forEach((vector, index) => cache.set(missing[index], vector)); return texts.map(text => cache.get(text)!); };
  const rows = [];
  for (const floor of floors) { const { retrieval } = await runDocuments({ filler: passages, embed: once, semanticFloor: floor }); rows.push({ floor, hitAt1: retrieval.hitAt1, hitAt3: retrieval.hitAt3, hitAt6: retrieval.hitAt6, abstention: retrieval.abstention }); }
  return { passages, rows };
}
const ollamaEmbed = (host: string, model: string): Embed => async texts => {
  const address = new URL(host);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('Use an Ollama server on this computer');
  const response = await fetch(new URL('/api/embed', address), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: texts }) });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  return (await response.json() as any).embeddings;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const option = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const report = process.argv.includes('--sweep') ? await sweepLexicalFloor() : option('--semantic') ? await sweepSemanticFloor(ollamaEmbed(option('--host') || 'http://127.0.0.1:11434', option('--semantic')!)) : await runDocuments();
  const output = process.argv.indexOf('--output');
  if (output > 0 && process.argv[output + 1]) await writeFile(process.argv[output + 1], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
