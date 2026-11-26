// PAL Everywhere §16.1: a phone's push-to-talk note is transcribed on the desktop and its audio is not kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

const idle = () => ({ async send() {}, async interrupt() {}, async close() {} });
function wav(seconds = 1) {
  const samples = 16000 * seconds, header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

test('a voice note becomes draft text on the desktop and leaves no audio behind', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pal-voice-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}));
  const whisper = join(dir, 'whisper-cli.mjs'), model = join(dir, 'model.bin');
  await writeFile(whisper, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2),prefix=args[args.indexOf('--output-file')+1];writeFileSync(prefix+'.txt',' Please summarize the plan. ');`, { mode: 0o755 });
  await writeFile(model, 'fixture model');
  const core = new Core(new Store(join(dir, 'state')), idle); t.after(() => core.close());
  await core.updateSettings({ transcription: { executable: whisper, model } });
  const session = await core.create({ provider: 'codex', cwd: dir, trusted: true });
  const result = await core.rpc('voice.transcribe', { sessionId: session.id, mime: 'audio/wav', audio: wav().toString('base64') });
  assert.equal(result.text, 'Please summarize the plan.');
  assert.deepEqual((await readdir(core.store.directory)).filter(name => name.startsWith('voice-')), [], 'the audio is deleted after transcription');
  await assert.rejects(core.rpc('voice.transcribe', { sessionId: session.id, mime: 'video/mp4', audio: wav().toString('base64') }), /M4A, AAC, OGG, WebM or WAV/);
  await assert.rejects(core.rpc('voice.transcribe', { sessionId: session.id, mime: 'audio/wav', audio: Buffer.alloc(800 * 1024).toString('base64') }), /two minutes/);
});
