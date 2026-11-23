// PAL Everywhere §8.5 (GUI-01): viewing the desktop is deliberate and announced, frames are still images of the
// chosen display, input is refused with the reason when the computer has no input tool, and a stale frame's tap
// never lands. Uses stand-in hyprctl and grim; never the owner's live session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

const inputTools = ['/usr/bin/ydotool', '/usr/bin/wtype', '/usr/local/bin/ydotool', '/usr/local/bin/wtype'].some(existsSync);

test('a view is announced, shows still frames and says why input is unavailable', { skip: inputTools ? 'this computer has an input tool; the refusal path cannot be shown' : !existsSync('/usr/bin/grim') && !existsSync('/usr/local/bin/grim') ? 'needs grim' : false }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-view-')), bin = join(directory, 'bin');
  t.after(async () => { process.env.PATH = path; await rm(directory, { recursive: true, force: true }); });
  const path = process.env.PATH || '';
  await (await import('node:fs/promises')).mkdir(bin);
  const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  await writeFile(join(directory, 'screen.png'), png);
  await writeFile(join(bin, 'hyprctl'), `#!/bin/sh\necho '[{"name":"DP-1","x":0,"y":0,"width":1920,"height":1080,"scale":1,"focused":true}]'\n`); await chmod(join(bin, 'hyprctl'), 0o755);
  await writeFile(join(bin, 'grim'), `#!/bin/sh\ncat ${join(directory, 'screen.png')}\n`); await chmod(join(bin, 'grim'), 0o755);
  process.env.PATH = bin + ':' + path;
  const core = new Core(new Store(join(directory, 'state')), () => ({ async send() {}, async interrupt() {}, async close() {} }));
  t.after(() => core.close());
  const notices: any[] = []; core.on('notice', notice => notices.push(notice));
  const started = await core.remoteView.start('device-1', 'Pixel');
  assert.equal(started.output, 'DP-1'); assert.equal(started.input.pointer, false); assert.match(started.input.reason!, /ydotool/);
  assert.ok(notices.some(n => n.kind === 'remote-view' && /Pixel is viewing/.test(n.text)), 'the desktop is told');
  const frame = await core.remoteView.frame(started.viewId, 'device-1', 960);
  assert.equal(frame.width, 960); assert.equal(frame.height, 540); assert.match(frame.data, /^data:image\/jpeg;base64,/);
  await assert.rejects(core.remoteView.frame(started.viewId, 'device-2'), /ended/, 'another device cannot use this view');
  await assert.rejects(core.remoteView.send(started.viewId, 'device-1', { kind: 'click', x: 0.5, y: 0.5, frameRevision: frame.revision }), /ydotool/);
  await assert.rejects(core.remoteView.send(started.viewId, 'device-1', { kind: 'click', x: 0.5, y: 0.5, frameRevision: frame.revision - 1 }), /screen changed/);
  await assert.rejects(core.remoteView.send(started.viewId, 'device-1', { kind: 'type', text: 'hello' }), /wtype or ydotool/);
  core.remoteView.end('device-1');
  assert.ok(notices.some(n => /stopped viewing/.test(n.text)));
  await assert.rejects(core.remoteView.frame(started.viewId, 'device-1'), /ended/);
});
