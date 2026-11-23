// PAL Everywhere §17.2: specialists run as child operations of the conversation (visible, cancellable), at most
// `concurrency` at a time, with no tools; a document editor's edits are staged as a change set for review and only
// for files the parent passed; a panel keeps each view attributed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';

test('specialists: staged edits, child operations, the concurrency limit, cancellation and an attributed panel', { skip: skipWithoutHelper }, async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: any[] = [];
  const f = await workbenchFixture(t, [
    body => { requests.push(body); return { content: JSON.stringify({ edits: [{ path: 'notes.md', content: 'The meeting is on Tuesday.\n', reason: 'typo' }, { path: 'secret.md', content: 'x' }], observations: ['Fixed one typo.'] }) }; },
    async body => { requests.push(body); await gate; return { content: JSON.stringify({ observations: [{ text: 'Slow view.' }], suggestions: [] }) }; },
    body => { requests.push(body); return { content: JSON.stringify({ observations: [{ text: 'Second view.' }], suggestions: [] }) }; },
    body => { requests.push(body); return { content: JSON.stringify({ observations: [{ text: 'Method X helps.' }], suggestions: [] }) }; },
    body => { requests.push(body); return { content: JSON.stringify({ observations: [{ text: 'Method X does not help.' }], suggestions: [] }) }; },
  ]);
  await writeFile(join(f.project, 'notes.md'), 'The meting is on Tuesday.\n');
  await f.core.updateSettings({ workbench: { helper: { provider: 'ollama', model: 'plain:latest' } } });
  const { session, root } = await f.session();
  const signal = new AbortController().signal;
  // Built-ins cannot be deleted; a custom specialist keeps its own model and instructions.
  assert.throws(() => f.core.specialists.remove({ id: 'builtin:editor' }), /Built-in/);
  const custom = f.core.specialists.save({ specialist: { name: 'Plain English', role: 'document_editor', provider: 'ollama', model: 'plain:latest', instructions: 'Prefer short sentences.' } });
  // The document editor stages a change set only for the file it was given; the file on disk is unchanged.
  const edited = await f.core.specialists.run(session.id, { specialist: custom.id, request: 'Fix spelling', inputs: [{ kind: 'file', rootId: root.id, path: 'notes.md' }] }, signal);
  assert.equal(edited.status, 'completed', edited.summary);
  assert.match(edited.summary, /staged a change set for 1 file/); assert.match(edited.summary, /secret\.md/);
  assert.equal(requests[0].tools, undefined, 'a specialist has no tools');
  assert.match(requests[0].messages[0].content, /Prefer short sentences/);
  const review: any = f.core.workbench.changes.review((edited.data as any).changeSetId);
  assert.deepEqual(review.operations.map((op: any) => op.path), ['notes.md']);
  assert.equal(await readFile(join(f.project, 'notes.md'), 'utf8'), 'The meting is on Tuesday.\n', 'nothing is applied before review');
  const operations = () => f.core.workbench.operations.list(session.id, { limit: 50 }).filter((op: any) => op.kind === 'specialist.run');
  assert.equal(operations()[0].state, 'completed'); assert.equal(operations()[0].details?.specialist, 'Plain English');
  // One at a time: the second waits queued, and cancelling it ends it before anything is sent.
  f.core.specialists.setConcurrency({ concurrency: 1 });
  const first = f.core.specialists.run(session.id, { specialist: 'Researcher', request: 'Summarize the notes', inputs: [{ kind: 'file', rootId: root.id, path: 'notes.md' }] }, signal);
  await until(() => requests.length === 2);
  const second = f.core.specialists.run(session.id, { specialist: 'Researcher', request: 'Summarize again', inputs: [{ kind: 'file', rootId: root.id, path: 'notes.md' }] }, signal);
  await until(() => operations().some((op: any) => op.state === 'queued'));
  const queued = operations().find((op: any) => op.state === 'queued')!;
  await f.core.rpc('operations.cancel', { sessionId: session.id, id: queued.id });
  await assert.rejects(second, /Cancelled/);
  assert.equal(f.core.workbench.operations.get(queued.id).state, 'cancelled');
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(requests.length, 2, 'the cancelled run never reached the model');
  // A panel: each view attributed, both kept even when they disagree.
  f.core.specialists.setConcurrency({ concurrency: 2 });
  const panel = await f.core.specialists.panel(session.id, [
    { specialist: 'Researcher', request: 'Second view', inputs: [{ kind: 'file', rootId: root.id, path: 'notes.md' }] },
    { specialist: 'Researcher', request: 'Does method X help?', inputs: [{ kind: 'file', rootId: root.id, path: 'notes.md' }] },
  ], undefined, signal);
  const views = (panel.data as any).views;
  assert.equal(views.length, 2); assert.ok(views.every((view: any) => view.specialist === 'Researcher' && view.status === 'completed'));
  assert.match(panel.summary, /both are kept/);
});
