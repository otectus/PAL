// PAL Everywhere §11.1: a collection can hold a dated snapshot of a web page or of a file sent from a phone, with
// its origin recorded; removing it deletes the snapshot; watched folders reindex after changes settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSearch } from '../broker/web.ts';
import { until, workbenchFixture } from './fixtures/workbench.ts';

test('web and uploaded snapshots become indexed sources with their origin; watched folders reindex', async t => {
  const f = await workbenchFixture(t);
  (f.core as any).web = new WebSearch(async (url: string) => ({ url, status: 200, contentType: 'text/html', text: '<html><head><title>Cache design</title></head><body><main><p>The cache keeps 400 entries and expires them after an hour.</p></main></body></html>' }));
  await f.core.updateSettings({ webSearch: { enabled: true, provider: 'searxng', searxngUrl: 'https://search.example' } });
  const collection = await f.core.rpc('collections.create', { name: 'Design notes' });
  await assert.rejects(f.core.rpc('collections.setWatch', { id: collection.id, watch: true }), /Add a folder/);
  const withPage = await f.core.rpc('collections.addUrl', { id: collection.id, url: 'https://docs.example/cache' });
  const page = withPage.sources[0];
  assert.equal(page.origin.kind, 'url'); assert.equal(page.origin.url, 'https://docs.example/cache'); assert.match(page.origin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(page.path.startsWith(join(f.core.store.directory, 'knowledge-sources', collection.id)), 'PAL keeps the snapshot itself');
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, trusted: true });
  const artifact = await f.core.workbench.artifacts.install({ sessionId: session.id, bytes: Buffer.from('# Meeting\nWe agreed to ship on Friday.\n'), name: 'meeting.md', mime: 'text/markdown', source: 'upload', provenance: { kind: 'phone-import' } } as any);
  const withUpload = await f.core.rpc('collections.addArtifact', { id: collection.id, sessionId: session.id, artifactId: artifact.artifactId });
  assert.equal(withUpload.sources[1].origin.kind, 'upload'); assert.equal(withUpload.sources[1].origin.name, 'meeting.md');
  await f.core.rpc('collections.index', { id: collection.id });
  await until(() => (f.core.collections as any).job?.done === true, 15_000);
  const listed = (await f.core.rpc('collections.list', {})).collections.find((item: any) => item.id === collection.id);
  assert.equal(listed.files, 2); assert.ok(listed.chunks >= 2, JSON.stringify(listed));
  // Removing a snapshot deletes PAL's copy; indexing then erases its chunks.
  const current = (await f.core.rpc('collections.list', {})).collections.find((item: any) => item.id === collection.id);
  await f.core.rpc('collections.removeSource', { id: collection.id, expectedRevision: current.revision, path: page.path });
  await until(() => !existsSync(page.path));
  // A watched folder schedules an incremental reindex once changes settle.
  const folder = join(f.project, 'docs'); await mkdir(folder);
  const latest = (await f.core.rpc('collections.list', {})).collections.find((item: any) => item.id === collection.id);
  await f.core.rpc('collections.addSource', { id: collection.id, expectedRevision: latest.revision, path: folder });
  await f.core.rpc('collections.setWatch', { id: collection.id, watch: true });
  await writeFile(join(folder, 'new.md'), 'A new decision.\n');
  await until(() => (f.core.collections as any).pendingIndex.size === 1, 5000);
  await f.core.rpc('collections.setWatch', { id: collection.id, watch: false });
  assert.equal((f.core.collections as any).watchers.size, 0);
});
