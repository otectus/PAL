import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calibrationContract, calibrationMetrics, calibrationPolicy, calibrate } from '../broker/graph-memory/calibration.ts';
import { contractVersion, profileSchema, rubricVersion } from '../broker/graph-memory/assessment.ts';
import { Canonical } from '../broker/graph-memory/canonical.ts';
import { emptyCapabilities } from '../broker/graph-memory/task-models.ts';

const qualifiedRows = () => Array.from({ length: 300 }, (_, i) => ({
  category: 'preference', challenge: ['negation', 'source_role', 'time', 'adversarial'][i % 4], expected: 'accept', action: 'accept',
  supportCorrect: true, cited: true, elapsed: 1, mode: 'semantic' as const, expectedSupport: 'supported', predictedSupport: 'supported',
}));

test('qualification excludes deterministic outcomes and requires per-category support and evidence precision', () => {
  const semantic = qualifiedRows();
  const rows = [...semantic, ...Array.from({ length: 20 }, () => ({ ...semantic[0], mode: 'deterministic' as const, expected: 'review', supportCorrect: false, cited: false }))];
  const result = calibrationMetrics(rows);
  assert.equal(result.qualified, true);
  assert.equal(result.semantic_evaluated, 300);
  assert.equal(result.deterministic.evaluated, 20);
  assert.equal(result.categories.preference.support_precision, 1);
  assert.equal(result.categories.preference.evidence_precision, 1);

  const badSupport = qualifiedRows(); badSupport[0].supportCorrect = false;
  assert.equal(calibrationMetrics(badSupport).qualified, false);
  const badCitation = qualifiedRows(); badCitation[0].cited = false;
  assert.equal(calibrationMetrics(badCitation).qualified, false);
});

test('measured qualification requires exact observed identities, contract, policy, and category metrics', t => {
  const directory = mkdtempSync(join(tmpdir(), 'cere-calibration-identity-'));
  const c = new Canonical(directory);
  t.after(() => { c.close(); rmSync(directory, { recursive: true, force: true }); });
  const profile = c.curation.profile();
  const base = {
    connectionRef: 'default:ollama', connectionRevision: 0, credentialRef: 'none', credentialRevision: 'none', adapterId: 'ollama',
    modelId: 'configured', modelVersion: 'returned-v1', modelDigest: 'a'.repeat(64), processing: 'local', outputMode: 'json_schema',
    prompt: contractVersion, parser: 1, schema: 1, rubric: rubricVersion,
  };
  const assessor = { ...base, fingerprint: 'assessor-route' }, adjudicator = { ...base, fingerprint: 'adjudicator-route' };
  const category = { cases: 300, accepted: 300, wrong: 0, action_precision: 1, support_precision: 1, evidence_precision: 1, qualified: true };
  c.curation.call('curation_evaluation_record', { fingerprint: assessor.fingerprint, dataset: 'heldout-v1', result: {
    qualified: true, qualified_categories: ['preference'], qualification_basis: 'measured', assessor, adjudicator,
    contract: calibrationContract, policy: calibrationPolicy(profile), categories: { preference: category },
  } });
  const producer = { assess: assessor, adjudicate: adjudicator };
  assert.equal(c.curation.verified(producer, profile, 'preference'), true);
  assert.equal(c.curation.verified({ ...producer, assess: { ...assessor, modelDigest: 'b'.repeat(64) } }, profile, 'preference'), false);
  assert.equal(c.curation.verified({ ...producer, adjudicate: { ...adjudicator, parser: 2 } }, profile, 'preference'), false);
  assert.equal(c.curation.verified(producer, { ...profile, threshold: profile.threshold + .01 }, 'preference'), false);
  assert.equal(c.curation.verified(producer, profile, 'decision'), false);

  const experimental = { assess: { fingerprint: 'explicit-experiment' }, adjudicate: { fingerprint: 'explicit-experiment' } };
  assert.equal(c.curation.verified(experimental, { ...profile, unmeasuredFingerprint: 'explicit-experiment' }, 'preference'), true);
  assert.equal(c.curation.verified(experimental, profile, 'preference'), false);
});

test('calibration rejects a route that becomes stale before scoring', async () => {
  const profile = profileSchema.parse({ reviewModel: { connectionRef: 'default:ollama', modelId: 'synthetic' } });
  const stale = Object.assign(new Error('route changed'), { code: 'STALE_TASK_ROUTE' });
  const route = {
    connectionRef: 'default:ollama', connectionRevision: 0, credentialRef: 'none', credentialRevision: 'none', adapterId: 'ollama',
    endpoint: 'http://127.0.0.1:11434', modelId: 'synthetic', processing: 'local' as const, capabilities: emptyCapabilities(), fingerprint: 'route-a',
  };
  const review = {
    router: { recheck: async () => { throw stale; } },
    canonical: { call: async () => { throw new Error('must not record a stale calibration'); } },
    generate: async (_task: string, _binding: unknown, _prompt: string, _schema: unknown, bundle: any) => ({
      route, outputMode: 'json_schema', model: 'returned-v1', repaired: false,
      value: { schemaVersion: 1, targetVersionId: bundle.version_id, support: 'supported', evidenceIds: [bundle.evidence[0].id], importance: 4,
        futureUse: 4, novelty: 4, durability: 'persistent', temporalStability: 'stable', duplicateOf: null, conflictsWith: [],
        suggestedAction: 'keep', reasonCodes: ['direct'], explanation: 'Directly supported.', missingContext: [] },
    }),
  };
  const corpus = { version: 'v1', reviewer: 'fixture', cases: [{ id: 'one', group: 'g1', split: 'heldout', role: 'user',
    source: 'I prefer concise answers.', quote: 'I prefer concise answers.', statement: { category: 'preference', modality: 'actual' },
    expected: 'accept', support: 'supported', challenge: 'direct' }] };
  await assert.rejects(calibrate(review as any, corpus, 1, { profile, revision: 0 }, AbortSignal.timeout(5000)), (error: any) => error === stale);
});
