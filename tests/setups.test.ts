// PAL Everywhere §12.3: a working setup previews only actual changes and its unresolved dependencies, applies them
// through the ordinary services, never enables a skill or grants anything, refuses a stale preview, and exports
// without local IDs, keys or bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchFixture } from './fixtures/workbench.ts';

test('a setup previews and applies its real changes, reports what is missing, and exports names only', async t => {
  const f = await workbenchFixture(t);
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, tools: true, trusted: true });
  const { setups } = f.core.setups.list();
  assert.ok(setups.some(setup => setup.id === 'builtin:developer' && !setup.families.host), 'built-ins never turn on host commands');
  // A built-in applied to a fresh conversation: families and the posture and instructions; nothing else.
  const preview = f.core.setups.preview({ setupId: 'builtin:developer', sessionId: session.id });
  assert.deepEqual(preview.changes.map((change: any) => change.kind).sort(), ['families', 'instructions', 'posture']);
  assert.deepEqual(preview.unresolved, []);
  const applied = await f.core.setups.apply({ token: preview.token });
  const after = f.core.store.session(session.id);
  assert.deepEqual(after.capabilities, { files: true, analysis: true });
  assert.equal(after.behavior?.postureId, 'posture:review'); assert.match(after.behavior?.instructions || '', /how you verified it/);
  assert.deepEqual(applied.applied.sort(), ['families', 'instructions', 'posture']);
  // Applied again, nothing is left to change.
  assert.deepEqual(f.core.setups.preview({ setupId: 'builtin:developer', sessionId: session.id }).changes, []);
  // A saved setup naming things that do not exist reports them instead of creating or enabling anything.
  const saved = f.core.setups.save({ setup: { name: 'Docs work', description: 'Docs', families: { files: true }, style: 'Nonexistent style', collections: ['Handbook'], skills: ['release-notes'], instructions: 'Use British spelling. '.repeat(20).trim() } });
  await assert.rejects(f.core.setups.start({ setupId: saved.id, expectedSetupRevision: '0', cwd: f.project }), /This setup changed/);
  const missing = f.core.setups.preview({ setupId: saved.id, sessionId: session.id });
  assert.equal(missing.changes.find((change: any) => change.kind === 'instructions')?.to, saved.instructions);
  assert.ok(missing.unresolved.some((line: string) => /style “Nonexistent style”/.test(line)));
  assert.ok(missing.unresolved.some((line: string) => /collection “Handbook”/.test(line)));
  assert.ok(missing.unresolved.some((line: string) => /skill “release-notes” is not enabled.*own review/.test(line)));
  assert.equal(f.core.skills.list().length, 0, 'nothing was imported or enabled');
  // A preview is bound to the conversation as it was: a change in between is a conflict.
  const stale = f.core.setups.preview({ setupId: saved.id, sessionId: session.id });
  f.core.setCapabilities({ id: session.id, capabilities: { files: true, images: true } });
  await assert.rejects(f.core.setups.apply({ token: stale.token }), /changed since the preview/);
  await assert.rejects(f.core.setups.apply({ token: stale.token }), /expired/, 'a preview is used once');
  // Another provider is a new conversation, not a silent switch.
  const api = f.core.setups.save({ setup: { name: 'API', provider: 'openai', model: 'gpt-x', families: {} } });
  assert.match(f.core.setups.preview({ setupId: api.id, sessionId: session.id }).unresolved[0], /Start a new conversation/);
  // Conflicting edits from two devices; built-ins are not deleted; export carries names and settings only.
  assert.throws(() => f.core.setups.save({ setup: { name: 'X', families: {} }, expectedRevision: '0' }), /changed on another device/);
  assert.throws(() => f.core.setups.remove({ id: 'builtin:developer' }), /Built-in/);
  assert.throws(() => f.core.setups.save({ setup: { name: 'Bad', families: { network: true } } }), /files, images, analysis and host/);
  const exported = f.core.setups.export({ ids: [saved.id, 'builtin:assets'] });
  const parsed = JSON.parse(exported.text);
  assert.equal(parsed.format, 'pal-setups'); assert.equal(parsed.setups.length, 2);
  assert.ok(parsed.setups.every((setup: any) => setup.id === undefined && setup.revision === undefined && setup.builtin === undefined));
  const imported = await f.core.setups.import({ text: exported.text });
  assert.equal(imported.added.length, 2); assert.notEqual(imported.added[0].id, saved.id);
  // Starting a conversation with a setup creates it with the setup's families and applies the rest.
  const started = await f.core.setups.start({ setupId: 'builtin:assets', cwd: f.project, model: 'chat:latest' });
  assert.deepEqual(started.session.capabilities, { files: true, images: true });
  assert.match(started.session.behavior?.instructions || '', /Name outputs/);
});
