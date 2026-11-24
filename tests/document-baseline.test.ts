import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocuments, sweepLexicalFloor, sweepSemanticFloor } from '../benchmarks/memory/document-baseline.ts';
import { lexicalScale } from '../broker/knowledge-collections.ts';

// M06: the measured document-collection retrieval baseline (2026-10-15, lexical only). Later
// retrieval changes must keep these floors or record a measured reason.
const floors = { hitAt1: 0.923, hitAt3: 1, mrr: 0.962, abstention: 0.667 } as const;

test('M06 collection retrieval cites resolvable sources, forgets erased files, stays in scope and holds its baseline', async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Network access is disabled in baseline tests'); }) as any;
  t.after(() => { globalThis.fetch = original; });
  const report = await runDocuments();
  for (const name of ['lineage', 'chunkBounds', 'noErasureResurrection', 'noScopeLeakage'] as const)
    assert.equal(report.gates[name].status, 'passed', `${name}: ${JSON.stringify(report.gates[name])}`);
  assert.equal(report.gates.semanticRecall.status, 'unmeasured', 'embedding recall is never claimed from a lexical run');
  for (const [metric, minimum] of Object.entries(floors))
    assert.ok((report.retrieval as any)[metric] >= minimum, `${metric} ${(report.retrieval as any)[metric]} fell below the ${minimum} baseline`);
  const { notFirst: _a, ...first } = report.retrieval, { notFirst: _b, ...again } = (await runDocuments()).retrieval;
  assert.deepEqual(again, first, 'a rerun measures the same quality');
  assert.equal(calls, 0);
});

test('RC-09 the strict answer mode’s floor loses no answer at any store size, and a higher one would', async () => {
  assert.deepEqual(lexicalScale, { strict: 1.5, balanced: 1, exploratory: 1 });
  let better = 0;
  for (const passages of [60, 200]) {
    const { rows: [usual, strict] } = await sweepLexicalFloor([1, lexicalScale.strict], passages);
    assert.deepEqual([usual.hitAt1, usual.hitAt6], [0.923, 1]);
    assert.deepEqual([strict.hitAt1, strict.hitAt3, strict.hitAt6], [usual.hitAt1, usual.hitAt3, usual.hitAt6], `${passages} passages`); assert.ok(strict.abstention >= usual.abstention);
    if (strict.abstention > usual.abstention) better++;
  }
  assert.equal(better, 2, 'it refuses more unrelated questions in smaller stores');
  const { rows: [small] } = await sweepLexicalFloor([2], 60); assert.ok(small.hitAt1 < 0.923, 'why it is not higher');
});

test('RC-09 the similarity floor is swept only with an embedding model someone supplies', async () => {
  // Words as directions: enough to show the knob works, and not a claim about any model.
  const embed = async (texts: string[]) => texts.map(text => { const vector = new Array(512).fill(0); for (const word of text.toLowerCase().match(/[a-z]{4,}/g) || []) { let hash = 7; for (const c of word) hash = (hash * 31 + c.charCodeAt(0)) >>> 0; vector[hash % 512] += 1; } return vector; });
  const { rows } = await sweepSemanticFloor(embed, [0.4, 0.99], 60);
  assert.ok(rows[0].hitAt6 >= rows[1].hitAt6); assert.deepEqual([rows[1].hitAt1, rows[1].hitAt6], [0.923, 1], 'at a floor nothing reaches, the words alone answer');
  assert.equal((await runDocuments({ embed })).gates.semanticRecall.status, 'measured');
});
