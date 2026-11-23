// PAL Everywhere §12 (SKL-01): a skill package is imported without running anything, enabled by one review, kept
// as immutable versions, and offered to a tool-capable model only as reference material it loads on demand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipFilesAsync } from '../broker/artifacts/zip.ts';
import { frontMatter } from '../broker/skills.ts';
import { call, skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';

async function folder(t: any, files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'pal-skill-src-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text, { mode: path.endsWith('.sh') ? 0o755 : 0o644 }); }
  return dir;
}

test('front matter names a skill; a folder without SKILL.md or with a link is refused', async t => {
  assert.deepEqual(frontMatter('---\nname: Release notes\ndescription: "Write release notes"\nlicense: MIT\n---\n# Body\n'), { name: 'Release notes', description: 'Write release notes', license: 'MIT' });
  assert.equal(frontMatter('# Fallback name\n\nFirst paragraph.').name, 'Fallback name');
  const f = await workbenchFixture(t);
  await assert.rejects(f.core.rpc('skills.importFolder', { path: await folder(t, { 'README.md': 'x' }) }), /SKILL\.md/);
  const linked = await folder(t, { 'SKILL.md': '---\nname: L\n---\n' });
  await symlink('/etc/passwd', join(linked, 'passwd'));
  await assert.rejects(f.core.rpc('skills.importFolder', { path: linked }), /link/);
});

test('importing runs nothing; enabling is the one review; an update leaves the reviewed version active', async t => {
  const f = await workbenchFixture(t);
  const marker = join(tmpdir(), 'pal-skill-ran-' + process.pid);
  const source = await folder(t, { 'SKILL.md': '---\nname: Deploy check\ndescription: Checks a deploy\n---\nRun scripts/check.sh then report.\n', 'scripts/check.sh': `#!/bin/sh\ntouch ${marker}\n` });
  const imported = await f.core.rpc('skills.importFolder', { path: source });
  assert.equal(imported.status, 'review'); assert.equal(existsSync(marker), false, 'importing never executes package content');
  const review = await f.core.rpc('skills.review', { versionId: imported.id });
  assert.deepEqual(review.executables, ['scripts/check.sh']); assert.match(review.instructions, /Run scripts/);
  const enabled = await f.core.rpc('skills.enable', { versionId: imported.id, invocation: 'automatic', expectedRevision: review.revision });
  assert.equal(enabled.status, 'enabled');
  // A changed package is a new version waiting for review; the reviewed one stays the active one.
  await writeFile(join(source, 'scripts/check.sh'), `#!/bin/sh\nrm -rf /tmp/whatever\n`);
  const update = await f.core.rpc('skills.importFolder', { path: source });
  assert.notEqual(update.id, imported.id); assert.equal(update.status, 'review');
  const changes = (await f.core.rpc('skills.review', { versionId: update.id })).changes;
  assert.deepEqual(changes.changed, ['scripts/check.sh']); assert.equal(changes.instructionsChanged, false);
  const list = (await f.core.rpc('skills.list', {})).versions;
  assert.equal(list.find((v: any) => v.id === imported.id).status, 'enabled');
  // The same bytes again are the same version, not a duplicate.
  assert.equal((await f.core.rpc('skills.importFolder', { path: source })).id, update.id);
});

test('a ZIP archive is read through the bounded archive reader, one top folder unwrapped', async t => {
  const f = await workbenchFixture(t);
  const zip = await zipFilesAsync([{ name: 'pkg/SKILL.md', data: Buffer.from('---\nname: Zipped\n---\nHello') }, { name: 'pkg/notes/a.txt', data: Buffer.from('note') }]);
  const dir = await mkdtemp(join(tmpdir(), 'pal-skill-zip-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'skill.zip'), zip);
  const version = await f.core.rpc('skills.importArchive', { path: join(dir, 'skill.zip') });
  assert.deepEqual(version.files.map((file: any) => file.path).sort(), ['SKILL.md', 'notes/a.txt'].sort());
  assert.equal(version.source.kind, 'archive');
});

test('a model sees automatic skills, sees explicit ones only when named, and loading grants nothing', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [
    () => call('skills_list', {}),
    (body: any) => { const listed = JSON.parse(body.messages.at(-1).content).data.skills; return call('skill_load', { id: listed[0].id }); },
    () => ({ content: 'Done.' }),
  ]);
  const auto = await f.core.rpc('skills.importFolder', { path: await folder(t, { 'SKILL.md': '---\nname: Tone guide\ndescription: House style\n---\nWrite plainly.' }) });
  const explicit = await f.core.rpc('skills.importFolder', { path: await folder(t, { 'SKILL.md': '---\nname: Release kit\n---\nSteps.' }) });
  await f.core.rpc('skills.enable', { versionId: auto.id, invocation: 'automatic' });
  await f.core.rpc('skills.enable', { versionId: explicit.id, invocation: 'explicit' });
  const { session } = await f.session();
  assert.ok(f.core.workbench.tools(session.id).some(tool => tool.function.name === 'skills_list'));
  await f.core.rpc('session.send', { id: session.id, text: 'Help me write this', expectedDraftRevision: session.draftRevision });
  await f.finished(session.id);
  const results = f.toolResults();
  const listed = results.find((r: any) => r.name === 'skills_list')!.value.data.skills.map((s: any) => s.name);
  assert.deepEqual(listed, ['Tone guide'], 'an explicit-only skill is not offered unless named');
  const loaded = results.find((r: any) => r.name === 'skill_load')!.value;
  assert.match(loaded.data.instructions, /Write plainly/); assert.match(loaded.summary, /does not change what you are allowed/);
});
