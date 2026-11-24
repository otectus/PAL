// PAL Everywhere §11.3: sources pinned to a conversation or project, and what the Context view says about a turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';

const library: any = vm.createContext({ Qt: { locale: () => undefined } });
vm.runInContext('Number.prototype.toLocaleString = function () { return String(this) };' + readFileSync(new URL('../qml/ContextExplain.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
const { planRows, documentsDetail, pinnedDetail, destinationLine, toolsLine, helpersLine } = library;

test('a pinned file is read again for every message, kept out of the history, and reported', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'One.' }), () => ({ content: 'Two.' }), () => ({ content: 'Three.' })]);
  const { session, root } = await f.session({ write: false });
  await writeFile(join(f.project, 'rules.md'), 'The release captain is Ada.\n');
  const empty = await f.core.rpc('references.pins', { sessionId: session.id }); assert.deepEqual(empty, { supported: true, pins: [] });
  const kept = await f.core.rpc('references.keep', { sessionId: session.id, ref: { kind: 'file', rootId: root.id, path: 'rules.md' } });
  assert.deepEqual(kept.pins.map((pin: any) => [pin.label, pin.kind, pin.scope]), [['rules.md', 'file', 'session']]);
  assert.equal((await f.core.rpc('references.keep', { sessionId: session.id, ref: { kind: 'file', rootId: root.id, path: 'rules.md' } })).pins.length, 1, 'the same source is pinned once');
  await f.core.send({ id: session.id, text: 'Who signs?' }); await f.finished(session.id);
  assert.equal(f.requests[0].messages.filter((m: any) => /keeps these sources pinned/.test(m.content)).length, 1); assert.match(JSON.stringify(f.requests[0].messages), /release captain is Ada/);
  await writeFile(join(f.project, 'rules.md'), 'The release captain is Grace.\n');
  await f.core.send({ id: session.id, text: 'And now?' }); await f.finished(session.id);
  const second = JSON.stringify(f.requests[1].messages); assert.match(second, /captain is Grace/); assert.ok(!second.includes('captain is Ada'), 'nothing of the earlier reading stays in the history');
  const plan = (await f.core.rpc('session.context', { id: session.id })).lastPlan; const layer = plan.layers.find((item: any) => item.id === 'pinned'); assert.equal(layer.included, true); assert.deepEqual(layer.detail, { included: ['rules.md'], omitted: [] });
  const after = await f.core.rpc('references.unkeep', { sessionId: session.id, id: kept.pins[0].id }); assert.deepEqual(after.pins, []);
  await f.core.send({ id: session.id, text: 'Once more' }); await f.finished(session.id);
  assert.ok(!/keeps these sources pinned/.test(JSON.stringify(f.requests[2].messages)));
  await assert.rejects(f.core.rpc('references.unkeep', { sessionId: session.id, id: kept.pins[0].id }), /already removed/);
});

test('a pin grants nothing: what cannot be read or may not go to the model is left out with its reason, and the message still goes', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'Fine.' })], { cloud: true });
  const { session, root } = await f.session({ write: false });
  await writeFile(join(f.project, 'secret.md'), 'The vault code is 4417.\n'); await writeFile(join(f.project, 'gone.md'), 'x\n');
  for (const path of ['secret.md', 'gone.md']) await f.core.rpc('references.keep', { sessionId: session.id, ref: { kind: 'file', rootId: root.id, path } });
  await import('node:fs/promises').then(fs => fs.rm(join(f.project, 'gone.md')));
  await f.core.send({ id: session.id, text: 'What is the code?' }); await f.finished(session.id);
  assert.ok(f.requests.length >= 1); assert.ok(!JSON.stringify(f.requests).includes('4417'), 'a folder kept to this computer never reaches a cloud model');
  const layer = (await f.core.rpc('session.context', { id: session.id })).lastPlan.layers.find((item: any) => item.id === 'pinned');
  assert.equal(layer.included, false); assert.equal(layer.detail.omitted.length, 2); assert.match(layer.detail.omitted[0], /secret\.md: .*may only be processed/);
});

test('pins are limited, text only, and a folder’s file stays with its conversation', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t), { session, root } = await f.session({ write: false });
  for (let i = 0; i < 5; i++) await writeFile(join(f.project, `n${i}.md`), `note ${i}\n`);
  await writeFile(join(f.project, 'plan.md'), 'The plan is blue.\n');
  const keep = (ref: any, scope?: string) => f.core.rpc('references.keep', { sessionId: session.id, ref, ...(scope ? { scope } : {}) });
  await assert.rejects(keep({ kind: 'file', rootId: root.id, path: 'photo.png' }), /Pin text sources|not|no such/i);
  await assert.rejects(keep({ kind: 'file', rootId: root.id, path: 'n0.md' }, 'project'), /belongs to one conversation/);
  for (let i = 0; i < 4; i++) await keep({ kind: 'file', rootId: root.id, path: `n${i}.md` });
  await assert.rejects(keep({ kind: 'file', rootId: root.id, path: 'n4.md' }), /up to 4/);
  await assert.rejects(keep({ kind: 'url', href: 'https://example.test' }), /no longer valid/);
  // A kept file shared with the project is pinned for every conversation in it, and only there.
  const artifact = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'plan.md') });
  await f.core.rpc('artifacts.update', { sessionId: session.id, artifactId: artifact.artifactId, shared: true });
  await keep({ kind: 'artifact', artifactId: artifact.artifactId }, 'project');
  const other = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project }), elsewhere = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.directory });
  assert.deepEqual((await f.core.rpc('references.pins', { sessionId: other.id })).pins.map((pin: any) => [pin.label, pin.scope]), [['plan.md', 'project']]);
  assert.deepEqual((await f.core.rpc('references.pins', { sessionId: elsewhere.id })).pins, []);
  const cli = await f.core.create({ provider: 'codex', cwd: f.project, trusted: true }); assert.equal((await f.core.rpc('references.pins', { sessionId: cli.id })).supported, false);
  await assert.rejects(f.core.rpc('references.keep', { sessionId: cli.id, ref: { kind: 'conversation', sessionId: session.id } }), /saved Ollama and API/);
});

test('Context names the destination, tools, skills and helper calls, and describes what a request was given', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t), { session } = await f.session({ write: false });
  const context = await f.core.rpc('session.context', { id: session.id });
  assert.equal(context.route.route, 'local'); assert.ok(context.tools.offered >= 1 && context.tools.available >= context.tools.offered && context.tools.tokens > 0); assert.deepEqual(context.helpers, { calls: 0, models: [] }); assert.equal(context.pinned.supported, true);
  assert.match(destinationLine({ route: 'local', evidence: 'The model runs here' }), /Messages go to this computer\. The model runs here\./);
  assert.match(toolsLine({ offered: 6, available: 14, tokens: 2100 }), /6 tools are described .*; 8 more when it asks\./); assert.match(helpersLine({ calls: 2, models: ['m'] }), /2 helper calls with m\./);
  assert.equal(documentsDetail({ excerpts: ['a.md · lines 1–4'], dropped: 2, conflicts: 1, stale: ['b.md'], withheld: ['Private'] }), 'a.md · lines 1–4 · 2 left out for space · 1 excerpt disagrees with another · changed since indexing: b.md · withheld from this model: Private');
  assert.equal(pinnedDetail({ included: ['a'], omitted: ['b: gone'] }), 'a · left out: b: gone');
  const row = planRows({ layers: [{ id: 'pinned', label: 'Pinned sources', trust: 'untrusted', tokens: 10, included: true, detail: { included: ['a'], omitted: [] } }] }, undefined)[0]; assert.match(row.status, /included · a/);
});
