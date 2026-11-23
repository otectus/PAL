import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { workbenchFixture, until } from './fixtures/workbench.ts';
import { png, providerFetch, json } from './fixtures/image-backends.ts';
import { listZip } from '../broker/artifacts/zip.ts';

test('library filters older records before paging, breaks timestamp ties, and enforces project scope', async (t) => {
  const f = await workbenchFixture(t, []),
    { session } = await f.session(),
    { session: second } = await f.session();
  const store = f.core.workbench.artifacts;
  let image;
  for (let i = 0; i < 150; i++) {
    if (i === 0)
      image = await store.install({
        sessionId: session.id,
        bytes: await png(8, 8),
        name: 'older image.png',
        source: 'model-generation',
        provenance: { kind: 'generation', prompt: 'Rare violet lighthouse' },
      });
    else
      await store.install({
        sessionId: session.id,
        bytes: Buffer.from('entry ' + i),
        name: 'item ' + i,
        source: 'user-import',
        provenance: { kind: 'text' },
      });
  }
  assert.ok(image);
  store.update(session.id, image.artifactId, { collections: ['Icons'], shared: true });
  assert.equal(store.list(session.id, { query: 'violet', limit: 1 }).artifacts[0].id, image.artifactId);
  assert.equal(store.list(second.id, { scope: 'session', kind: 'image' }).artifacts.length, 0);
  assert.deepEqual(store.list(second.id, { scope: 'project', collection: 'Icons' }).collections, ['Icons']);
  assert.equal(store.list(second.id, { scope: 'project', collection: 'Icons' }).artifacts[0].id, image.artifactId);
  store.store.db
    .prepare('INSERT INTO image_analysis(version_id,ocr) VALUES(?,?)')
    .run(image.versionId, 'Unique visible words');
  assert.equal(store.list(session.id, { query: 'unique words', limit: 1 }).artifacts[0].id, image.artifactId);
  await store.install({
    artifactId: image.artifactId, sessionId: session.id, bytes: await png(6, 6), name: 'crop.png',
    source: 'derived', provenance: { kind: 'crop' },
    parents: [{ artifactId: image.artifactId, versionId: image.versionId, relation: 'crop' }],
  });
  assert.equal(store.list(session.id, { query: 'violet today', limit: 1 }).artifacts[0].id, image.artifactId);
  assert.equal(store.list(session.id, { query: 'unique words yesterday' }).artifacts.length, 0);
  store.store.db.prepare("UPDATE artifacts SET updated=100, data=json_set(data,'$.updated',100)").run();
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = store.list(session.id, { before, limit: 13 });
    ids.push(...page.artifacts.map((x) => x.id));
    before = page.before;
  } while (before);
  assert.equal(new Set(ids).size, 150);
  assert.equal(ids.length, 150);
});

test('local image editing, protected expansion, difference, similarity, and deterministic delivery use exact version pixels', async (t) => {
  const f = await workbenchFixture(t, []),
    { session } = await f.session();
  const sessionId = session.id,
    core = f.core,
    store = core.workbench.artifacts;
  const box = await png(4, 4, '#ee2222');
  const data = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#223344' } })
    .composite([{ input: box, left: 6, top: 4 }])
    .png()
    .toBuffer();
  const v = await store.install({
    sessionId,
    bytes: data,
    name: 'palette.png',
    source: 'user-import',
    provenance: { kind: 'import' },
  });
  const input = { sessionId, artifactId: v.artifactId, versionId: v.versionId };
  const region = await core.rpc('images.region', { ...input, region: { left: 6, top: 4, width: 4, height: 4 } });
  assert.equal(region.parents[0].versionId, v.versionId);
  assert.equal(region.image.width, 4);
  const selection = await core.rpc('images.selectColour', {
    ...input,
    point: { x: 1, y: 1 },
    tolerance: 0,
    invert: true,
  });
  const subject = await core.rpc('images.selectColour', {
    ...input,
    point: { x: 7, y: 6 },
    tolerance: 0,
    mode: 'subject',
  });
  assert.equal(subject.overlay, selection.overlay);
  const cut = await core.rpc('images.cutout', { ...input, mask: selection.overlay });
  const out = await store.bytes(sessionId, cut.artifactId, cut.versionId);
  const raw = await sharp(out.data).ensureAlpha().raw().toBuffer();
  assert.equal(raw[3], 0);
  assert.equal(raw[(4 * 16 + 6) * 4 + 3], 255);
  const diff = await core.rpc('images.difference', { ...input, other: cut });
  assert.equal(diff.changed, 16 * 12 - 16);
  const extended = await core.rpc('images.extend', { ...input, ratio: 1 });
  assert.equal(extended.target.image.width, 16);
  assert.equal(extended.target.image.height, 16);
  assert.deepEqual(extended.target.provenance.sourceBounds, { left: 0, top: 2, width: 16, height: 12 });
  assert.equal(extended.mask.parents[0].versionId, extended.target.versionId);
  const twin = await store.install({
    sessionId,
    bytes: data,
    name: 'twin.png',
    source: 'user-import',
    provenance: { kind: 'import' },
  });
  const similar = await core.rpc('images.similar', { ...input, scope: 'session' });
  assert.equal(similar.artifacts.find((i: any) => i.id === twin.artifactId).similarity, 100);
  const kit = {
    sessionId,
    items: [cut],
    preset: 'icons',
    fit: 'contain',
    prefix: 'icon',
    sheet: true,
    manifest: true,
    originals: true,
  };
  const preview = await core.rpc('images.deliveryPreview', kit);
  assert.equal(preview.outputs.length, 3);
  const sample = await core.rpc('images.deliverySample', { ...kit, width: 32, height: 32 });
  const meta = await sharp(Buffer.from(sample.image.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 32);
  const bundle = await core.rpc('images.deliver', kit);
  const archive = await store.bytes(sessionId, bundle.artifactId, bundle.versionId);
  assert.deepEqual(
    listZip(archive.data, { entries: 20, members: 20, expandedBytes: 2e6, memberBytes: 2e6, ratio: 1000 })
      .map((e) => e.name)
      .sort(),
    [
      'contact-sheet.png',
      'icon-128.png',
      'icon-32.png',
      'icon-512.png',
      'manifest.json',
      'originals/1-Cutout of palette.png',
    ].sort(),
  );
});

test('style sets persist per-member approvals and regenerate one member independently', async (t) => {
  const f = await workbenchFixture(t, []),
    { session } = await f.session(),
    sessionId = session.id;
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fixture';
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  await f.core.updateSettings({
    workbench: { imageConnections: [{ name: 'Image fixture', kind: 'openai', model: 'gpt-image-2.6-sunburst' }] },
  });
  const connectionId = f.core.settings.workbench.imageConnections[0].id;
  const fetcher = providerFetch({
    'https://api.openai.com/v1/images/generations': async () =>
      json({ data: [{ b64_json: (await png(32, 32)).toString('base64') }], output_format: 'png' }),
  });
  f.core.workbench.media.fetch = fetcher.fetch;
  const kit = {
    name: 'Wayfinding',
    style: 'Flat silhouettes',
    typography: 'Sans serif',
    palette: ['#223344'],
    guides: [],
  };
  await f.core.rpc('images.saveKit', { ...kit, sessionId, shared: true });
  const set = await f.core.rpc('images.saveSet', { sessionId, name: 'Signs', kit, briefs: ['Door', 'Stairs'] });
  const params = { ...set, sessionId, connectionId, acknowledgeBilling: true };
  const render = async (index: number, regenerate = false) => {
    const op = await f.core.rpc('images.renderMember', { ...params, index, regenerate });
    await until(() => f.core.workbench.operations.get(op.operationId).state === 'completed');
    return f.core.workbench.operations.get(op.operationId).results[0];
  };
  const door = await render(0);
  const stairs = await render(1);
  await f.core.rpc('images.approveMember', { ...params, index: 0, chosen: door });
  await f.core.rpc('images.approveMember', { ...params, index: 1, chosen: stairs });
  await render(1, true);
  const reopened = await f.core.rpc('images.openSet', params);
  assert.equal(reopened.members[0].approved.versionId, door.versionId);
  assert.equal(reopened.members[1].approved.versionId, stairs.versionId);
  assert.equal(fetcher.calls.length, 3);
  assert.match(fetcher.calls[0].body.prompt, /Flat silhouettes/);
  assert.match(fetcher.calls[2].body.prompt, /Stairs/);
  assert.equal((await f.core.rpc('images.kits', { sessionId })).sets.length, 1);
});

test('regional OCR boxes map back to oriented source pixels and full-image OCR is searchable', async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('/usr/bin/tesseract') || !existsSync('/usr/share/tessdata/eng.traineddata')) {
    t.skip('English Tesseract data is required');
    return;
  }
  const f = await workbenchFixture(t, []),
    { session } = await f.session();
  const data = await sharp(
    Buffer.from(
      '<svg width="2200" height="320"><rect width="100%" height="100%" fill="white"/><text x="720" y="169" font-family="DejaVu Sans" font-size="72">Lighthouse panel</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const v = await f.core.workbench.artifacts.install({
    sessionId: session.id,
    bytes: data,
    name: 'screen.png',
    source: 'user-import',
    provenance: { kind: 'import' },
  });
  const region = { left: 400, top: 40, width: 1700, height: 230 };
  const result = await f.core.rpc('images.ocr', {
    sessionId: session.id,
    artifactId: v.artifactId,
    versionId: v.versionId,
    region,
    keepTranscript: true,
  });
  assert.equal(result.transcript.parents[0].versionId, v.versionId);
  assert.deepEqual(result.transcript.policy, v.policy);
  const line = result.lines.find((l: any) => /Lighthouse/i.test(l.text));
  assert.ok(line);
  assert.ok(Math.abs(line.box.left - 720) < 20);
  assert.ok(line.box.top > 85 && line.box.top < 150);
  const indexed = await f.core.rpc('images.indexText', { sessionId: session.id });
  assert.equal(indexed.indexed, 1);
  assert.equal(
    f.core.workbench.artifacts.list(session.id, { query: 'lighthouse panel' }).artifacts[0].id,
    v.artifactId,
  );
});
