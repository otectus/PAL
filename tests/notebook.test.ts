// PAL Everywhere §17.3: a project scratchpad saves with revisions (an edit from another device is a conflict, never
// a silent overwrite), and the Daybook only indexes records that already exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

test('scratchpad revisions refuse stale saves and keep history; the Daybook lists the day’s records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-notebook-'));
  const core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await core.rpc('notebook.save', { project: directory, text: 'Ideas:\n- terminal', expectedRevision: '0' });
  assert.equal(first.revision, '1');
  const second = await core.rpc('notebook.save', { project: directory, text: 'Ideas:\n- terminal\n- canvas', expectedRevision: '1' });
  assert.equal(second.history[0].text, 'Ideas:\n- terminal');
  await assert.rejects(core.rpc('notebook.save', { project: directory, text: 'stale phone edit', expectedRevision: '1' }), /changed on another device/);
  assert.equal(core.notebook.scratchpad(directory).text, 'Ideas:\n- terminal\n- canvas');
  const session = await core.create({ provider: 'codex', cwd: directory, trusted: true, title: 'Daybook check' });
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const day = await core.rpc('notebook.day', { date: today });
  assert.ok(day.items.some((item: any) => item.kind === 'conversation' && item.sessionId === session.id));
  assert.ok(day.items.some((item: any) => item.kind === 'scratchpad' && item.project === directory));
  assert.equal(day.derived, false);
});

test('the desktop note library preserves scratchpads and creates, renames, opens and deletes independent notes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-note-library-'));
  const otherProject = join(directory, 'other');
  const core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });

  const scratch = await core.rpc('notebook.save', { project: otherProject, text: 'Kept from the old scratchpad', expectedRevision: '0' });
  const first = await core.rpc('notebook.create', { project: directory, title: 'Meeting notes' });
  const second = await core.rpc('notebook.create', { project: directory, title: 'Release ideas' });
  assert.notEqual(first.id, second.id);
  assert.equal(first.kind, 'note');

  const saved = await core.rpc('notebook.saveNote', { id: first.id, text: 'Discuss the desktop library', expectedRevision: '0' });
  assert.equal(saved.revision, '1');
  await core.rpc('notebook.rename', { id: first.id, title: 'Weekly meeting' });
  assert.deepEqual(await core.rpc('notebook.get', { id: first.id }).then((note: any) => [note.title, note.text, note.project]), ['Weekly meeting', 'Discuss the desktop library', directory]);

  const library = await core.rpc('notebook.list', {});
  assert.ok(library.notes.some((note: any) => note.id === first.id && note.title === 'Weekly meeting' && note.preview === 'Discuss the desktop library'));
  assert.ok(library.notes.some((note: any) => note.kind === 'scratchpad' && note.project === otherProject && note.revision === scratch.revision));
  assert.ok(library.notes.some((note: any) => note.id === second.id), 'empty newly created notes stay in the library');

  await assert.rejects(core.rpc('notebook.delete', { id: first.id, expectedRevision: '0' }), /changed before it could be deleted/);
  assert.equal((await core.rpc('notebook.delete', { id: first.id, expectedRevision: '1' })).deleted, true);
  await assert.rejects(core.rpc('notebook.get', { id: first.id }), /no longer exists/);
  assert.ok((await core.rpc('notebook.list', {})).notes.every((note: any) => note.id !== first.id));
});

test('deleting and recreating a project scratchpad keeps its revision monotonic and rejects an old editor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-scratchpad-delete-'));
  const project = join(directory, 'project');
  const core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });

  const old = await core.rpc('notebook.save', { project, text: 'old body', expectedRevision: '0' });
  await core.rpc('notebook.delete', { id: old.id, expectedRevision: old.revision });
  const empty = await core.rpc('notebook.scratchpad', { project });
  assert.deepEqual([empty.text, empty.revision, empty.history.length], ['', '2', 0]);
  assert.ok((await core.rpc('notebook.list', {})).notes.every((note: any) => note.id !== old.id), 'the body-free tombstone is not a library note');

  const recreated = await core.rpc('notebook.save', { project, text: 'new body', expectedRevision: empty.revision });
  assert.equal(recreated.revision, '3');
  await assert.rejects(core.rpc('notebook.save', { project, text: 'stale old editor', expectedRevision: old.revision }), /changed on another device/);
  assert.equal((await core.rpc('notebook.scratchpad', { project })).text, 'new body');
});
