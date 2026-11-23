import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OwnerOps } from '../broker/remote/owner.ts';
import { ownerOperations } from '../broker/remote/owner-schemas.ts';
import { needsProof } from '../broker/remote/schemas.ts';

const sessionId = randomUUID(), id = randomUUID(), requestId = randomUUID();
const start = {
  sessionId, question: 'Compare the supported approaches', preset: 'quick', mode: 'compare', scope: 'both',
  sourceIds: ['eyJraW5kIjoiY29sbGVjdGlvbiIsImlkIjoibWFudWFsIn0'], plan: ['Find primary sources'], sites: ['example.com'], siteMode: 'prefer',
  urls: ['https://example.com/docs'], recency: 'month', output: 'matrix', minutes: 5, sources: 12, calls: 6,
  criteria: ['Cite every finding'], parallel: false, requestId,
};

test('owner research wire inputs are complete, bounded, and model work requires an action proof', () => {
  assert.equal(ownerOperations['owner.research.start'].schema.safeParse(start).success, true);
  assert.equal(ownerOperations['owner.research.start'].schema.safeParse({ ...start, plan: Array(13).fill('step') }).success, false);
  assert.equal(ownerOperations['owner.research.start'].schema.safeParse({ ...start, urls: ['file:///private'] }).success, false);
  assert.equal(ownerOperations['owner.research.start'].schema.safeParse({ ...start, sites: Array(6).fill('example.com') }).success, false);
  assert.equal(ownerOperations['owner.research.start'].schema.safeParse({ ...start, calls: 21 }).success, false);
  assert.equal(ownerOperations['owner.research.list'].schema.safeParse({ sessionId, project: true }).success, true);
  assert.equal(ownerOperations['owner.research.list'].schema.safeParse({ sessionId }).success, true, 'already shipped clients retain the full-run list');
  assert.equal(ownerOperations['owner.research.list'].schema.safeParse({}).success, true, 'legacy unscoped lists are filtered by run session');
  assert.equal(ownerOperations['owner.research.exclude'].schema.safeParse({ id, evidenceId: 'E2' }).success, true);
  assert.equal(ownerOperations['owner.research.exclude'].schema.safeParse({ id, evidenceId: 'E2.P1' }).success, false, 'sources and passages are distinct IDs');
  assert.equal(ownerOperations['owner.research.passage'].schema.safeParse({ id, passageId: 'E2.P1', versionId: 'v2' }).success, true);
  for (const method of ['owner.research.plan', 'owner.research.start', 'owner.research.refresh', 'owner.research.continue', 'owner.research.steer', 'owner.research.ask', 'owner.research.resynthesize'])
    assert.equal(needsProof(method, {}), true, method);
  for (const method of ['owner.research.pause', 'owner.research.stop', 'owner.research.update', 'owner.research.export', 'owner.research.note', 'owner.research.exclude'])
    assert.equal(needsProof(method, {}), false, method);
});

test('owner research run operations authorize the run conversation and do not create recurring authority', async () => {
  const calls: { method: string; params: any }[] = [], authorized: string[] = [];
  const outside = randomUUID();
  const router: any = {
    owner: () => true,
    session: (_device: any, scoped: string) => { authorized.push(scoped); if (scoped !== sessionId) throw new Error('wrong session'); return { id: scoped }; },
    core: { rpc: async (method: string, params: any) => { calls.push({ method, params }); if (method === 'research.get') return { id, sessionId }; if (method === 'research.list') return [{ id, sessionId }, { id: randomUUID(), sessionId: outside }]; return { ok: true }; } },
  };
  const ops = new OwnerOps(router), device: any = { id: randomUUID() };
  await ops.dispatch(device, 'owner.research.readReport', { id });
  await ops.dispatch(device, 'owner.research.continue', { id, focus: 'new evidence' });
  await ops.dispatch(device, 'owner.research.export', { id, format: 'markdown' });
  const listed = await ops.dispatch(device, 'owner.research.list', { sessionId, project: true });
  assert.deepEqual(listed, [{ id, sessionId }]);
  assert.deepEqual(authorized, [sessionId, sessionId, sessionId, sessionId, sessionId, outside]);
  assert.deepEqual(calls.map(call => call.method), ['research.get', 'research.readReport', 'research.get', 'research.continue', 'research.get', 'research.export', 'research.list']);
  await assert.rejects(() => ops.dispatch(device, 'owner.research.update', { id, monitorDays: 7 }), /durable authorization/);
  assert.equal(calls.at(-1)?.method, 'research.get', 'the run is scoped before recurring authority is refused');
});

test('large phone run DTOs stay below one frame and fetch one exact versioned passage', async () => {
  const text = 'Exact cited passage. ' + 'x'.repeat(930);
  const evidence = Array.from({ length: 60 }, (_, source) => ({
    id: `E${source + 1}`, title: `Source ${source + 1}`, status: 'read', url: `https://example.com/${source + 1}`,
    excerpt: text, snippet: text,
    passages: Array.from({ length: 24 }, (_, passage) => ({ id: `E${source + 1}.P${passage + 1}`, location: `Page ${passage + 1}`, text })),
  }));
  const run = { id, sessionId, state: 'completed', report: { artifactId: 'report', versionId: 'v2', name: 'Report.md' }, reportText: '# '.concat('r'.repeat(120_000)), evidence,
    findings: [{ text: 'Finding [E1.P1]', citations: ['E1.P1'], status: 'Supported' }], activity: [], table: { columns: [], rows: [] } };
  const router: any = {
    owner: () => true, session: () => ({ id: sessionId }),
    core: { rpc: async (method: string) => method === 'research.get' ? run : method === 'research.list' ? Array.from({ length: 60 }, (_, index) => ({ ...run, id: `${index}` })) : method === 'research.readReport' ? { text: 'version report', evidence } : true },
  };
  const ops = new OwnerOps(router), device: any = { id: randomUUID() };
  const dto: any = await ops.dispatch(device, 'owner.research.get', { id });
  assert.ok(Buffer.byteLength(JSON.stringify(dto), 'utf8') < 1_048_576);
  assert.equal(dto.reportText, undefined);
  assert.deepEqual(dto.evidence[0].passages[0], { id: 'E1.P1', location: 'Page 1' });
  const legacy = await ops.dispatch(device, 'owner.research.list', { sessionId });
  assert.ok(legacy.length > 0 && legacy.length < 60, 'newest legacy rows remain usable instead of overflowing the frame');
  assert.ok(Buffer.byteLength(JSON.stringify(legacy), 'utf8') < 1_048_576);
  const passage = await ops.dispatch(device, 'owner.research.passage', { id, passageId: 'E1.P1', versionId: 'v2' });
  assert.deepEqual(passage, { id: 'E1.P1', text, location: 'Page 1', sourceId: 'E1', title: 'Source 1', versionId: 'v2' });
});
