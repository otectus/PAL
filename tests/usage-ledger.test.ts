// PAL Everywhere §17.4: one usage ledger. Provider-reported counts are exact, CLI turns are counted but not
// priced, a missing price is unknown rather than zero, and the monthly limit stops the next paid request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

async function makeCore(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-usage-'));
  const instance = new Core(new Store(directory), (_session, h) => ({ async send(_t, _i, o) { o?.beforeAccept?.(); o?.onDispatched?.(); o?.onAccepted?.(); h.event({ type: 'complete' }); }, async interrupt() {}, async close() {} }));
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { core: instance, directory };
}
const plan = (provider: string, model: string, reported?: { inputTokens: number; outputTokens: number }, boundary: 'pal-managed' | 'cli-owned' = 'pal-managed') =>
  ({ schema: 1 as const, turnId: 'turn-' + Math.random(), time: Date.now(), provider, model, boundary, estimator: 'utf8-bytes/2' as const, contextSize: null, rounds: 1, layers: [], unknown: [], ...(reported ? { reported: { ...reported, source: provider } } : {}) });

test('the ledger keeps exact, subscription and unpriced use apart and prices only what has a price', async t => {
  const { core, directory } = await makeCore(t);
  const session = await core.create({ provider: 'codex', cwd: directory, trusted: true });
  core.usage.recordTurn(session.id, plan('openai', 'gpt-test', { inputTokens: 1_000_000, outputTokens: 500_000 }));
  core.usage.recordTurn(session.id, plan('anthropic', 'claude-x', { inputTokens: 2000, outputTokens: 100 }));
  const cli = plan('codex', 'gpt-codex', undefined, 'cli-owned');
  core.usage.recordTurn(session.id, cli); core.usage.recordTurn(session.id, cli);
  core.usage.recordTurn(session.id, plan('ollama', 'local')); // nothing reported: not a ledger row
  core.usage.setPolicy({ expectedRevision: '0', prices: { 'openai:gpt-test': { input: 2, output: 8 } } });
  const summary = await core.rpc('usage.summary', { days: 30 });
  assert.equal(summary.totals.calls, 3, 'one CLI turn counted once');
  assert.equal(summary.totals.subscription, 1);
  assert.equal(summary.totals.reported, 2);
  assert.equal(summary.totals.priced, 1); assert.equal(summary.totals.unpriced, 2, 'an unknown price is not zero');
  assert.equal(Number(summary.totals.cost.toFixed(2)), 6, '1M input × 2 + 0.5M output × 8');
  assert.ok(summary.warnings.some((w: string) => /no price/.test(w)));
  assert.equal(summary.byProject[0].key, directory);
});

test('the monthly limit stops the next paid API request before anything is sent; a stale policy edit conflicts', async t => {
  const { core, directory } = await makeCore(t);
  const session = await core.create({ provider: 'codex', cwd: directory, trusted: true });
  core.usage.recordTurn(session.id, plan('openai', 'gpt-test', { inputTokens: 1_000_000, outputTokens: 0 }));
  const policy = core.usage.setPolicy({ expectedRevision: '0', prices: { 'openai:*': { input: 5, output: 15 } }, monthlyLimit: 4 });
  assert.throws(() => core.usage.setPolicy({ expectedRevision: '0', monthlyLimit: 100 }), /changed on another device/);
  for (const prices of [{ input: 'bad', output: 2 }, { input: 4 }, { input: 0, output: -1 }, { input: 1, output: Infinity }]) {
    assert.throws(() => core.usage.setPolicy({ expectedRevision: policy.revision, monthlyLimit: null, prices: { 'openai:*': prices } }), /price/);
    assert.deepEqual(core.usage.policy(), policy, 'invalid prices cannot clear the budget or advance its revision');
  }
  assert.throws(() => core.usage.assertWithinBudget('openai'), /reached the limit you set/);
  assert.doesNotThrow(() => core.usage.assertWithinBudget('ollama'), 'local models are never stopped by a price limit');
  core.usage.setPolicy({ expectedRevision: policy.revision, monthlyLimit: null });
  assert.doesNotThrow(() => core.usage.assertWithinBudget('openai'));
});
