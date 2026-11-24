// PAL Everywhere §11.2: collection retrieval measured on a small representative corpus (code, configuration, a PDF,
// tables, a transcript, contradictions, copies and a stale file), against the retrieval it replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { ollamaHost } from '../broker/ollama.ts';
import { chunkDocument, chunkTranscript } from '../broker/knowledge-collections.ts';
import { disagreement, locate, selectExcerpts, type Candidate } from '../broker/collection-ranking.ts';
import { scoreRetrieval, type EvaluationQuery } from '../broker/collection-evaluation.ts';

const corpus = fileURLToPath(new URL('./fixtures/collections-eval/', import.meta.url));
const { queries } = JSON.parse(await readFile(join(corpus, 'queries.json'), 'utf8')) as { queries: EvaluationQuery[] };
const candidate = (source: string, text: string, extra: Partial<Candidate> = {}): Candidate => ({ key: source + text.length, source, file: '/c/' + source, collection: 'C', collectionId: 'c', location: '', text, why: 'words', stale: false, ...extra });

test('chunks keep the lines or the time they came from', () => {
  const text = '# A\n\nfirst\n\n## B\n\n' + Array.from({ length: 60 }, (_item, index) => `line ${index} of the section`).join('\n') + '\n';
  const chunks = chunkDocument(text, 400, 60, { lines: true }), source = text.split('\n');
  for (const chunk of chunks) {
    const { location, text: body } = locate(chunk.text), match = /lines? (\d+)(?:–(\d+))?/.exec(location)!;
    const lines = source.slice(Number(match[1]) - 1, Number(match[2] || match[1])).join('\n');
    assert.ok(lines.includes(body.split('\n')[0]), `${location}: ${body.slice(0, 40)}`); assert.ok(lines.includes(body.split('\n').at(-1)!), location);
  }
  assert.ok(chunks.some(chunk => chunk.text.startsWith('§ B · lines ')), 'the heading stays beside the lines');
  assert.deepEqual(chunkDocument('# A\n\nx'), [{ text: '# A\n\nx', heading: 'A' }], 'chunks without lines are as they were');
  assert.equal(locate(chunkTranscript('WEBVTT\n\n00:00:05.000 --> 00:00:09.000\n<v Ada>Hello\n\n00:01:00.000 --> 00:01:02.000\nBye\n')[0].text).location, 'time 0:05–1:02');
});

test('the same passage is given once and names its other places; one file does not push out the others', () => {
  const copy = 'The on-call engineer answers a page within 15 minutes and writes a summary of open incidents.';
  const { excerpts, duplicates } = selectExcerpts([candidate('a.md', copy, { location: 'lines 1–2' }), candidate('copy/a.md', copy, { location: 'lines 1–2' }), candidate('b.md', 'Unrelated words about trains and tickets.')], 'page minutes', 2000);
  assert.equal(duplicates, 1); assert.deepEqual(excerpts.map(item => item.source), ['a.md', 'b.md']); assert.deepEqual(excerpts[0].also, ['copy/a.md, lines 1–2']);
  const long = Array.from({ length: 6 }, (_item, index) => candidate('long.md', `Chapter ${index} says alpha beta gamma number ${index} in its own words ${'x'.repeat(index)}`));
  const few = selectExcerpts([...long, candidate('short.md', 'alpha beta gamma in one line')], 'alpha beta gamma', 10_000, { max: 4 });
  assert.ok(few.excerpts.some(item => item.source === 'short.md')); assert.ok(few.excerpts.filter(item => item.source === 'long.md').length >= 2);
  assert.equal(selectExcerpts(long, 'alpha', 60).excerpts.length, 1, 'the budget is kept'); assert.equal(selectExcerpts([], 'x', 1000).excerpts.length, 0);
  const weak = selectExcerpts([candidate('a.md', 'Only a developer machine may do this.')], 'Which espresso machine is in the kitchen?', 1000); assert.equal(weak.excerpts[0].weak, true, 'kept, and called weak');
  assert.deepEqual(selectExcerpts([candidate('a.md', 'Only a developer machine may do this.'), candidate('b.md', 'The kitchen espresso machine is on floor two.')], 'Which espresso machine is in the kitchen?', 1000).excerpts.map(item => item.source), ['b.md'], 'and dropped beside a real match');
});

test('passages that state different things are both given and both marked; equal ones are not', () => {
  const left = 'Database backups are kept for 30 days and copied every Sunday to the second site.', right = 'Database backups are kept for 90 days and copied every Sunday to the second site.';
  assert.equal(disagreement(left, right), 'different numbers'); assert.equal(disagreement(left, left), ''); assert.equal(disagreement('Secrets are never written to logs', 'Secrets are written to logs'), 'one negates the other');
  const { excerpts, duplicates } = selectExcerpts([candidate('new.md', left), candidate('old.md', right), candidate('c.md', 'Trains under five hours are booked by the traveller.', { why: 'meaning' })], 'how long are backups kept', 2000);
  assert.equal(duplicates, 0, 'a contradiction is never folded away'); assert.match(excerpts.find(item => item.source === 'new.md')!.conflict!, /old\.md \(different numbers\)/); assert.ok(excerpts.find(item => item.source === 'old.md')!.conflict); assert.equal(excerpts.find(item => item.source === 'c.md')!.conflict, undefined);
});

/** A two-page PDF written by hand, so the corpus needs no other program. */
function pdf(pages: string[]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_page, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, text] of pages.entries()) { const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let body = '%PDF-1.4\n'; const offsets = objects.map((object, index) => { const at = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const start = body.length;
  return Buffer.from(body + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`, 'latin1');
}
/** A deterministic embedding fixture: words map to a few concepts, so paraphrases land near each other. */
const concepts: Record<string, number> = {};
for (const [index, group] of [['ceiling', 'cap', 'maximum', 'limit'], ['outage', 'incident', 'failure', 'broke'], ['begin', 'began', 'start', 'cause', 'why'], ['certificate', 'tls'], ['allowance', 'budget', 'per', 'diem'], ['meal', 'food', 'lunch'], ['backup', 'backups', 'snapshot'], ['kept', 'retention', 'retain'], ['sign', 'signs', 'approve'], ['engineer', 'responder'], ['pool', 'workers', 'worker']].entries()) for (const word of group) concepts[word] = index;
function embed(text: string) {
  const vector = new Array(1024).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) || []) { if (word in concepts) vector[concepts[word]] += 3; else { let hash = 0; for (const c of word) hash = (hash * 31 + c.charCodeAt(0)) >>> 0; if (word.length > 3) vector[16 + hash % 1008] += 1; } }
  const length = Math.hypot(...vector) || 1; return vector.map(value => value / length);
}
async function evaluated(t: any, semantic: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'pal-collection-eval-')), docs = join(root, 'docs');
  await cp(corpus, docs, { recursive: true }); await rm(join(docs, 'queries.json'));
  await writeFile(join(docs, 'handbook', 'expenses.pdf'), pdf(['Travel expenses are paid within ten days of the claim.', 'The refund limit is 1500 euros per claim and needs a receipt.']));
  // Enough other text for word frequencies to mean something.
  await mkdir(join(docs, 'other'));
  for (let i = 0; i < 70; i++) await writeFile(join(docs, 'other', `note-${i}.md`), `# Note ${i}\n\nTopic ${['gardening', 'sailing', 'pottery', 'astronomy', 'chess', 'baking', 'cycling'][i % 7]} session ${i}: the group met, discussed plans for the season and chose a date. Attendance was ${10 + i}.\n\nThe next meeting of group ${i} is in the usual place.\n`);
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {}; res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', digest: 'fixture' }] }));
    if (req.url === '/api/show' && semantic) return res.end(JSON.stringify({ capabilities: ['embedding'], model: body.model }));
    if (req.url === '/api/embed' && semantic) return res.end(JSON.stringify({ embeddings: (Array.isArray(body.input) ? body.input : [body.input]).map((value: string) => embed(value)) }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const core = new Core(new Store(join(root, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await core.updateSettings({ ollama: { host: `http://127.0.0.1:${(server.address() as any).port}` } });
  await core.memory.ready;
  let collection = await core.rpc('collections.create', { name: 'Corpus', grounding: 'strict' });
  collection = await core.rpc('collections.update', { id: collection.id, expectedRevision: collection.revision, code: true });
  collection = await core.rpc('collections.addSource', { id: collection.id, expectedRevision: collection.revision, path: docs });
  await core.rpc('collections.index', { id: collection.id });
  for (let i = 0; i < 1200 && !core.collections.job?.done; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(core.collections.job?.error || '', '');
  collection = core.collections.all().find((item: any) => item.id === collection.id);
  const asked = queries.filter(query => query.needs !== 'pdf' || (existsSync('/usr/bin/pdftotext') && existsSync('/usr/bin/pdfinfo')));
  return { core, docs, collection, asked };
}
/** What a turn was given before: the first six matches in retrieval order, without locations, copies folded or conflicts marked. */
async function earlier(core: Core, collection: any, query: string) {
  const result: any = await core.memory.service.call('retrieve', { scope_id: collection.scopeId, text: query, host: ollamaHost(core.settings.ollama.host), token_budget: 2400, model_route: 'local', relevance_floor: true, max_items: 6 });
  return (result.items || []).map((item: any, index: number) => { const file = collection.files.find((entry: any) => entry.documentSource === String(result.results?.[index]?.sessionId || '')); return { source: file ? file.path.slice(file.path.indexOf('/docs/') + 6) : '?', location: locate(String(item.text)).location }; });
}

test('measured on the corpus by words alone: sources, places, contradictions and refusals', async t => {
  const { core, docs, collection, asked } = await evaluated(t, false);
  const now = [], before = [];
  for (const query of asked) { now.push((await core.rpc('collections.search', { id: collection.id, query: query.q })).results); before.push(await earlier(core, collection, query.q)); }
  const score = scoreRetrieval(asked, now), baseline = scoreRetrieval(asked, before);
  t.diagnostic(`now ${JSON.stringify({ ...score, missed: undefined })}`); t.diagnostic(`before ${JSON.stringify({ ...baseline, missed: undefined })}`); if (score.missed.length) t.diagnostic('missed: ' + score.missed.join(' | '));
  assert.ok(score.recall >= baseline.recall, 'never finds less than before'); assert.ok(score.recall >= 0.9, `source recall ${score.recall}`);
  assert.ok(score.location >= 0.9, `location ${score.location}`); assert.ok(score.conflicts > baseline.conflicts && score.conflicts >= 0.5, `contradictions ${score.conflicts}`);
  assert.ok(score.refusal >= baseline.refusal && score.refusal >= 0.75, `refusal ${score.refusal}`); assert.ok(score.meanReciprocalRank >= 0.85, `rank ${score.meanReciprocalRank}`);
  // A copied file is one excerpt, not two.
  const page = now[asked.findIndex(query => /answer a page/.test(query.q))]; assert.equal(page.filter((row: any) => /oncall\.md$/.test(row.source) && /15 minutes/.test(row.excerpt)).length, 1);
  // A file changed after indexing is still found, and says so until it is indexed again.
  await appendFile(join(docs, 'release', 'checklist.md'), '5. Thank everyone.\n');
  const stale = await core.rpc('collections.search', { id: collection.id, query: 'Who signs the release tag?' }); assert.equal(stale.results.find((row: any) => row.source === 'release/checklist.md')?.stale, true);
  assert.equal(stale.mode, 'words', 'without an embedding model the words still find it');
});

test('measured with an embedding model: meaning adds answers words alone miss and loses none', async t => {
  const { core, collection } = await evaluated(t, true);
  const paraphrased: EvaluationQuery[] = [{ q: 'What caused the importer incident?', sources: ['media/retro.vtt'] }, { q: 'retention of snapshots', sources: ['policy/backups.md'] }, { q: 'cap for retries', sources: ['src/retry.py'] }];
  for (let i = 0; i < 400 && !(await core.rpc('collections.search', { id: collection.id, query: 'outage certificate' })).mode.includes('meaning'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const all = [...queries.filter(query => !query.needs), ...paraphrased], answers = [], before = [];
  for (const query of all) { answers.push((await core.rpc('collections.search', { id: collection.id, query: query.q })).results); before.push(await earlier(core, collection, query.q)); }
  const score = scoreRetrieval(all, answers), baseline = scoreRetrieval(all, before);
  t.diagnostic(`before ${JSON.stringify({ ...baseline, missed: undefined })}`);
  assert.ok(score.recall >= baseline.recall && score.refusal >= baseline.refusal && score.precision >= baseline.precision && score.conflicts > baseline.conflicts, 'no measure is worse than before');
  t.diagnostic(`hybrid ${JSON.stringify({ ...score, missed: undefined })} missed ${score.missed.join(' | ')}`);
  assert.ok(score.recall >= 0.9, `source recall ${score.recall}`);
});

test('a turn receives locations, conflicts and stale marks, within its budget and the collection’s permission', async t => {
  const { core, docs, collection } = await evaluated(t, false);
  const session = await core.create({ provider: 'codex', cwd: docs, trusted: true });
  await core.rpc('collections.bind', { id: collection.id, target: 'session', sessionId: session.id, bound: true });
  const packet = await core.collections.context(core.store.session(session.id), 'How long are database backups kept?', 2400, 'local', new AbortController().signal);
  const body = JSON.parse(packet.text.replace(/^<pal_document_data>\n|\n<\/pal_document_data>$/g, ''));
  assert.match(body.how_to_answer, /Some excerpts disagree/); assert.ok(body.items.some((item: any) => item.source === 'policy/backups.md' && /lines? \d/.test(item.location) && /archive/.test(item.conflict)));
  assert.ok(!packet.text.includes(docs), 'no home path'); assert.ok(packet.text.length < 2400 * 4 + 1500); assert.ok(packet.detail.conflicts >= 2); assert.ok(packet.detail.excerpts.length);
  assert.equal((await core.collections.context(core.store.session(session.id), 'How long are database backups kept?', 2400, 'cloud', new AbortController().signal)).text, '', 'a cloud model still needs the collection’s permission');
});

test('reranking needs the collection’s cloud permission, falls back, and is off unless chosen', async t => {
  const { core, collection } = await evaluated(t, false);
  let calls = 0, fail = false;
  core.collections.send = (async (_url: any, init: any) => { calls++; if (fail) throw new Error('offline'); const body = JSON.parse(init.body), order = body.documents.map((_text: string, index: number) => ({ index, relevance_score: body.documents.length - index })); const at = body.documents.findIndex((text: string) => /Flights need approval/.test(text)); if (at >= 0) order[at].relevance_score = 99; return new Response(JSON.stringify({ data: order.sort((a: any, b: any) => b.relevance_score - a.relevance_score), usage: { total_tokens: 10 } }), { headers: { 'Content-Type': 'application/json' } }); }) as any;
  const search = () => core.rpc('collections.search', { id: collection.id, query: 'flights approval, backups kept, handover, secrets and the release tag' });
  await search(); assert.equal(calls, 0);
  await assert.rejects(core.rpc('collections.update', { id: collection.id, expectedRevision: collection.revision, rerank: true }), /Allow cloud models/);
  await core.updateSettings({ memory: { voyageRerankModel: 'rerank-2.5' } });
  let current = await core.rpc('collections.update', { id: collection.id, expectedRevision: collection.revision, allowCloud: true, rerank: true });
  await search(); assert.equal(calls, 0, 'without a key nothing is sent');
  core.credentials.update('voyage', 'fixture-key-1234567890'); const ranked = await search(); assert.ok(calls >= 1); assert.equal(ranked.reranked, true);
  fail = true; assert.ok((await search()).results.length, 'an unavailable reranker changes the order, never the answer');
  current = await core.rpc('collections.update', { id: collection.id, expectedRevision: current.revision, allowCloud: false }); assert.equal(current.rerank, false, 'reranking ends with the permission it needs');
});
