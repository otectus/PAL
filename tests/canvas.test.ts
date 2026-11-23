// PAL Everywhere §13.1 (CAN-01, CAN-02): a generated page runs in an isolated preview the desktop and a phone
// share; it can be clicked and inspected, annotations bind to the snapshot revision, and the page cannot reach
// the network: a blocked request fails visibly in the console.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';
import { Canvas } from '../broker/canvas.ts';

const browser = new Canvas({} as any).browserPath();
const opts = { skip: skipWithoutHelper || (browser ? false : 'needs Chromium or Chrome for the preview browser'), timeout: 90_000 };

test('a preview is interactive, isolated from the network, and annotations follow its revision', opts, async t => {
  const f = await workbenchFixture(t);
  await writeFile(join(f.project, 'index.html'), `<!doctype html><html><head><title>Counter</title><link rel="stylesheet" href="style.css"></head><body>
    <h1 id="title">Count: 0</h1><button id="more" onclick="let n=+document.querySelector('#title').dataset.n||0;n++;document.querySelector('#title').dataset.n=n;document.querySelector('#title').textContent='Count: '+n">More</button>
    <input id="name"><script>fetch('https://example.com/leak').catch(e=>console.error('blocked: '+e.message));console.log('loaded');</script></body></html>`);
  await writeFile(join(f.project, 'style.css'), 'h1{color:rgb(10,20,30)}');
  const { session, root } = await f.session();
  t.after(() => f.core.canvas.shutdown());
  const preview = await f.core.rpc('canvas.open', { sessionId: session.id, rootId: root.id, path: 'index.html', width: 800, height: 600 });
  assert.equal(preview.files, 2);
  await f.core.canvas.clickSelector(preview.id, '#more', session.id);
  await f.core.canvas.clickSelector(preview.id, '#more', session.id);
  const inspected = await f.core.canvas.inspect(preview.id, '#title', session.id);
  assert.equal(inspected.text, 'Count: 2');
  await f.core.rpc('canvas.input', { sessionId: session.id, id: preview.id, kind: 'click', x: 0.05, y: 0.4 });
  await f.core.canvas.clickSelector(preview.id, '#name', session.id);
  await f.core.rpc('canvas.input', { sessionId: session.id, id: preview.id, kind: 'type', text: 'Ada' });
  assert.match((await f.core.canvas.inspect(preview.id, undefined, session.id)).html, /Counter/);
  await until(() => f.core.canvas.console(preview.id, session.id).some(m => /blocked/.test(m.text) || /ERR_NAME_NOT_RESOLVED|Refused to connect|Content Security Policy/i.test(m.text)), 10_000);
  assert.ok(f.core.canvas.console(preview.id, session.id).some(m => m.text.includes('loaded')));
  const frame = await f.core.rpc('canvas.frame', { sessionId: session.id, id: preview.id });
  assert.match(frame.data, /^data:image\/jpeg;base64,/);
  const annotation = await f.core.rpc('canvas.annotate', { sessionId: session.id, id: preview.id, x: 0.1, y: 0.05, note: 'Make the heading larger' });
  assert.match(annotation.selector, /h1#title|#title/); assert.equal(annotation.revision, preview.revision); assert.ok(annotation.artifact);
  // Editing the page and reloading is a new revision; the older annotation says it was made on the earlier one.
  await writeFile(join(f.project, 'style.css'), 'h1{color:rgb(200,0,0)}');
  const reloaded = await f.core.rpc('canvas.reload', { sessionId: session.id, id: preview.id });
  assert.notEqual(reloaded.revision, preview.revision);
  assert.equal((await f.core.rpc('canvas.annotations', { sessionId: session.id, id: preview.id }))[0].current, false);
  const shot = await f.core.rpc('canvas.screenshot', { sessionId: session.id, id: preview.id });
  assert.equal(shot.mime, 'image/png');
  const exported = await f.core.rpc('canvas.export', { sessionId: session.id, id: preview.id });
  assert.equal(exported.mime, 'application/zip');
  // Another conversation cannot reach this preview.
  const other = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, capabilities: { files: true } });
  await assert.rejects(f.core.rpc('canvas.frame', { sessionId: other.id, id: preview.id }), /closed/);
  await f.core.rpc('canvas.close', { sessionId: session.id, id: preview.id });
  await writeFile(join(f.project, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text id="caption" y="30">Canvas fixture</text></svg>');
  const drawing = await f.core.rpc('canvas.open', { sessionId: session.id, rootId: root.id, path: 'drawing.svg' });
  assert.equal((await f.core.canvas.inspect(drawing.id, '#caption', session.id)).text, 'Canvas fixture');
  await f.core.rpc('canvas.close', { sessionId: session.id, id: drawing.id });
});
