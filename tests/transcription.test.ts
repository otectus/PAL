import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Transcription } from '../broker/transcription.ts';
import { checkSpeechServer, recognizerFor, speechServerAddress } from '../broker/speech/recognizers.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { Speech, defaultVoice } from '../broker/tts.ts';

async function fixture(t: test.TestContext, maximumMilliseconds = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-transcription-'));
  const runtime = join(directory, 'runtime'), log = join(directory, 'calls.jsonl'); await mkdir(runtime);
  const executable = async (name: string, source: string) => {
    const path = join(directory, name); await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 }); return path;
  };
  const recorder = await executable('recorder.mjs', `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const output=process.argv.at(-1);appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'recorder',output})+'\\n');
    writeFileSync(output,Buffer.alloc(256,7));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.exit(0));
    setInterval(()=>{},1000);`);
  const whisper = await executable('whisper-cli.mjs', `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const args=process.argv.slice(2),prefix=args[args.indexOf('--output-file')+1];
    appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'whisper',args,pid:process.pid})+'\\n');
    if(process.env.TRANSCRIPTION_FAIL){console.error('fixture engine failure');process.exit(9)}
    if(process.env.TRANSCRIPTION_HOLD){for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));setInterval(()=>{},1000)}
    else{writeFileSync(prefix+'.txt',process.env.TRANSCRIPTION_TEXT||'Local transcript');if(args.includes('--output-vtt'))writeFileSync(prefix+'.vtt','WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\n'+(process.env.TRANSCRIPTION_TEXT||'Local transcript')+'\\n')}`);
  const model = join(directory, 'model.bin'); await writeFile(model, 'fixture model');
  const settings = { executable: whisper, model }, env = { ...process.env };
  let changes = 0;
  const transcription = new Transcription({
    changed: () => { changes++; }, settings: () => settings, runtimeDirectory: runtime, env, maximumMilliseconds,
    recorder: output => ({ command: recorder, args: [output] }),
  });
  t.after(async () => { await transcription.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const temporary = async () => readdir(join(runtime, 'transcription')).catch(() => []);
  return { directory, runtime, log, recorder, whisper, model, settings, env, transcription, calls, temporary, get changes() { return changes; } };
}

async function until(predicate: () => Promise<boolean> | boolean) {
  for (let index = 0; index < 100; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for transcription fixture');
}

test('voice input has one explicit microphone owner and returns a session-bound editable result', async t => {
  const f = await fixture(t);
  const started = await f.transcription.start({ sessionId: 'session-a' });
  assert.equal(started.state, 'recording'); assert.equal(started.sessionId, 'session-a');
  await assert.rejects(f.transcription.start({ sessionId: 'session-b' }), /already recording/);
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  const result = await f.transcription.finish();
  assert.deepEqual(result, { sessionId: 'session-a', revision: started.revision, text: 'Local transcript' });
  assert.equal(f.transcription.status().state, 'idle');
  assert.deepEqual(await f.temporary(), []);
  const calls = await f.calls(); assert.equal(calls.filter(call => call.tool === 'recorder').length, 1); assert.equal(calls.filter(call => call.tool === 'whisper').length, 1);
});

test('cancel deletes owned audio and never starts transcription', async t => {
  const f = await fixture(t);
  await f.transcription.start({ sessionId: 'session-a' });
  await f.transcription.cancel();
  assert.equal(f.transcription.status().state, 'idle');
  assert.deepEqual(await f.temporary(), []);
  assert.equal((await f.calls()).some(call => call.tool === 'whisper'), false);
});

test('missing configuration and failed local engines are visible and leave no recording', async t => {
  const f = await fixture(t);
  f.settings.executable = '';
  await assert.rejects(f.transcription.start({ sessionId: 'session-a' }), /absolute local whisper.cpp executable/);
  assert.equal(f.transcription.status().state, 'unavailable');
  f.settings.executable = f.whisper; f.env.TRANSCRIPTION_FAIL = '1';
  await f.transcription.start({ sessionId: 'session-a' });
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  await assert.rejects(f.transcription.finish(), /fixture engine failure/);
  assert.equal(f.transcription.status().state, 'error'); assert.match(f.transcription.status().error, /fixture engine failure/);
  assert.deepEqual(await f.temporary(), []);
});

test('cancelled transcription results stay stale and cannot replace a later recording', async t => {
  const f = await fixture(t); f.env.TRANSCRIPTION_HOLD = '1';
  const first = await f.transcription.start({ sessionId: 'old-session' });
  await until(async () => (await f.calls()).some(call => call.tool === 'recorder'));
  const stale = assert.rejects(f.transcription.finish(), /cancelled/);
  await until(async () => (await f.calls()).some(call => call.tool === 'whisper'));
  await f.transcription.cancel();
  await stale;
  delete f.env.TRANSCRIPTION_HOLD; f.env.TRANSCRIPTION_TEXT = 'Fresh transcript';
  const second = await f.transcription.start({ sessionId: 'new-session' });
  await until(async () => (await f.calls()).filter(call => call.tool === 'recorder').length === 2);
  const result = await f.transcription.finish();
  assert.equal(result.sessionId, 'new-session'); assert.equal(result.text, 'Fresh transcript'); assert.ok(second.revision > first.revision);
  assert.equal(f.transcription.status().state, 'idle'); assert.deepEqual(await f.temporary(), []);
});

test('the recording limit stops and removes a capture without invoking whisper.cpp', async t => {
  const f = await fixture(t, 25);
  await f.transcription.start({ sessionId: 'bounded' });
  await until(() => f.transcription.status().state === 'error');
  assert.match(f.transcription.status().error, /60-second recording limit/);
  assert.deepEqual(await f.temporary(), []);
  assert.equal((await f.calls()).some(call => call.tool === 'whisper'), false);
});

test('non-default speech rate uses Piper length_scale without changing default playback', async t => {
  const f = await fixture(t), voices = join(f.directory, 'voices'); await mkdir(voices);
  await writeFile(join(voices, defaultVoice + '.onnx'), 'voice');
  await writeFile(join(voices, defaultVoice + '.onnx.json'), JSON.stringify({ audio: { sample_rate: 16000 }, language: { code: 'en_US' } }));
  const piper = join(f.directory, 'rate-piper.mjs'), aplay = join(f.directory, 'rate-aplay.mjs');
  await writeFile(piper, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(f.log)},JSON.stringify({tool:'rate-piper',args:process.argv.slice(2)})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(128)));`, { mode: 0o755 });
  await writeFile(aplay, `#!${process.execPath}\nprocess.stdin.resume();`, { mode: 0o755 });
  const settings = { voice: defaultVoice, speechEnabled: true, quiet: false, speechRate: 2 };
  const speech = new Speech(() => settings, () => {}, { ...process.env, PAL_TTS_DISABLED: '0', PAL_VOICES_DIR: voices, PAL_PIPER_BIN: piper, PAL_APLAY_BIN: aplay });
  t.after(() => speech.close());
  assert.equal(speech.speak('Faster local speech'), true); await speech.idle();
  const args = (await f.calls()).find(call => call.tool === 'rate-piper').args;
  assert.equal(args[args.indexOf('--length_scale') + 1], '0.5'); assert.equal(speech.state.backend, 'piper');
});

test('M20 an imported recording is converted, transcribed for review with its source, and leaves no audio behind', async t => {
  const f = await fixture(t);
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const source = join(f.directory, 'standup.mp3');
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '44100', source]);
  f.env.TRANSCRIPTION_TEXT = 'We agreed to ship on Tuesday.';
  const result = await f.transcription.importFile({ sessionId: 'session-a', path: source });
  assert.equal(result.text, 'We agreed to ship on Tuesday.');
  assert.equal(result.vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWe agreed to ship on Tuesday.\n', 'a file import keeps segment timestamps for its transcript artifact');
  assert.deepEqual([result.source!.name, result.source!.durationSeconds, result.source!.truncated], ['standup.mp3', 2, false]);
  assert.equal(result.source!.sha256, createHash('sha256').update(await readFile(source)).digest('hex'));
  const whisper = (await f.calls()).filter(call => call.tool === 'whisper').at(-1);
  assert.match(whisper.args[whisper.args.indexOf('-f') + 1], /\/audio\.wav$/, 'whisper reads the converted 16 kHz WAV');
  assert.deepEqual(await f.temporary(), [], 'no converted audio remains');
  assert.equal(f.transcription.status().state, 'idle');
  await assert.rejects(f.transcription.importFile({ sessionId: 'session-a', path: join(f.directory, 'model.bin') }), /Choose WAV, MP3/);
  await assert.rejects(f.transcription.importFile({ sessionId: 'session-a', path: 'relative.mp3' }), /Choose an audio or video file/);
});

test('M20 imports share the one voice job, cancel cleanly, and without ffmpeg accept only 16 kHz WAV', async t => {
  const f = await fixture(t);
  const { execFileSync } = await import('node:child_process');
  const wav = join(f.directory, 'note.wav'), loud = join(f.directory, 'loud.wav');
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-ar', '16000', '-ac', '1', wav]);
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-ar', '44100', loud]);
  f.env.TRANSCRIPTION_HOLD = '1';
  const pending = f.transcription.importFile({ sessionId: 'session-a', path: wav });
  for (let index = 0; index < 200 && !(await f.calls()).some(call => call.tool === 'whisper'); index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.transcription.status().state, 'transcribing'); assert.equal(f.transcription.status().file, 'note.wav');
  await assert.rejects(f.transcription.start({ sessionId: 'session-b' }), /already recording|busy/);
  // The import may end before cancel() returns, so what it ends with is awaited from now on.
  const refused = assert.rejects(pending, /cancelled/); await f.transcription.cancel(); await refused;
  assert.deepEqual(await f.temporary(), []);
  delete f.env.TRANSCRIPTION_HOLD;
  const plain = new Transcription({ changed() {}, settings: () => f.settings, runtimeDirectory: f.runtime, env: f.env, ffmpeg: null });
  t.after(() => plain.close());
  assert.equal((await plain.importFile({ sessionId: 'session-a', path: wav })).source!.durationSeconds, null);
  await assert.rejects(plain.importFile({ sessionId: 'session-a', path: loud }), /only 16 kHz WAV/);
  await assert.rejects(plain.importFile({ sessionId: 'session-a', path: join(f.directory, 'standup.ogg') }), /no such file|ENOENT/);
});

async function speechServer(t: test.TestContext, answer: (request: { url: string; body: string; headers: any }) => { status?: number; body?: unknown; headers?: Record<string, string>; hold?: boolean }) {
  const requests: { url: string; body: string; headers: any }[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', part => parts.push(part)); req.on('end', () => {
      const request = { url: req.url!, body: Buffer.concat(parts).toString('latin1'), headers: req.headers }; requests.push(request);
      const value = answer(request); if (value.hold) return;
      res.writeHead(value.status || 200, { 'content-type': 'application/json', ...value.headers }); res.end(typeof value.body === 'string' ? value.body : JSON.stringify(value.body ?? {}));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  return { address: `http://127.0.0.1:${(server.address() as any).port}`, requests };
}

test('M10 a speech server on this computer transcribes without starting a program, with times for a file, and nothing else is sent', async t => {
  const f = await fixture(t), server = await speechServer(t, () => ({ body: { text: ' Hello from the server. ', segments: [{ text: ' Hello', start: 0, end: .5 }, { text: 'from --> the server.', start: .5, end: 1.25 }, { text: '', start: 2, end: 3 }, { text: 'bad', start: 3, end: 1 }] } }));
  Object.assign(f.settings, { executable: '', model: '', provider: 'local-server', serverUrl: server.address, language: 'de-DE', prompt: 'names: Ada' });
  assert.equal(f.transcription.status().state, 'idle', 'an address is all it needs');
  await f.transcription.start({ sessionId: 's' }); await until(async () => (await f.calls()).length > 0);
  assert.equal((await f.transcription.finish()).text, 'Hello from the server.');
  const wav = join(f.directory, 'talk.wav'), header = Buffer.alloc(44); header.write('RIFF', 0); header.write('WAVE', 8); header.writeUInt32LE(16000, 24); await writeFile(wav, Buffer.concat([header, Buffer.alloc(400)]));
  const imported = new Transcription({ changed() {}, settings: () => f.settings, runtimeDirectory: f.runtime, env: f.env, ffmpeg: null }); t.after(() => imported.close());
  const result = await imported.importFile({ sessionId: 's', path: wav });
  assert.equal(result.vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nHello\n\n00:00:00.500 --> 00:00:01.250\nfrom → the server.\n');
  for (const request of server.requests) {
    assert.equal(request.url, '/inference'); assert.deepEqual([...request.body.matchAll(/; name="([^"]+)"/g)].map(match => match[1]), ['file', 'response_format', 'temperature', 'language', 'prompt']);
    assert.ok(!request.headers.authorization && !request.headers.cookie); assert.match(request.body, /name="language"\r\n\r\nde\r\n/);
  }
  assert.ok((await f.calls()).every(call => call.tool === 'recorder'), 'whisper.cpp never ran'); assert.deepEqual(await f.temporary(), []);
  // The OpenAI-compatible form, with a model.
  Object.assign(f.settings, { serverUrl: server.address + '/v1/', serverModel: 'large-v3', language: '', prompt: '' });
  await imported.importFile({ sessionId: 's', path: wav }); const last = server.requests.at(-1)!;
  assert.equal(last.url, '/v1/audio/transcriptions'); assert.match(last.body, /name="model"\r\n\r\nlarge-v3/);
});

test('M10 a local server has to be on this computer, and every way it can fail is said plainly and leaves no audio', async t => {
  for (const bad of ['', 'x', undefined, 'http://example.org', 'http://192.168.1.4:8080', 'http://127.0.0.1.example.org', 'http://user:pw@127.0.0.1:80', 'http://127.0.0.1:80/?a=1', 'ftp://127.0.0.1', 'file:///tmp/x', 'http://127.0.0.1:80/#x', 'http://127.0.0.1/' + 'a'.repeat(300)]) assert.throws(() => speechServerAddress(bad), /speech server/i, String(bad));
  for (const good of ['http://127.0.0.1:8080', 'http://localhost:9/v1', 'http://[::1]:8080', 'https://127.0.0.1:8443/base/']) assert.ok(speechServerAddress(good));
  const f = await fixture(t), wav = join(f.directory, 'talk.wav'), header = Buffer.alloc(44); header.write('RIFF', 0); header.write('WAVE', 8); header.writeUInt32LE(16000, 24); await writeFile(wav, Buffer.concat([header, Buffer.alloc(400)]));
  const settings: any = { executable: f.whisper, model: f.model, provider: 'local-server' }, import_ = async () => { const one = new Transcription({ changed() {}, settings: () => settings, runtimeDirectory: f.runtime, env: f.env, ffmpeg: null }); try { return await one.importFile({ sessionId: 's', path: wav }); } finally { await one.close(); } };
  let reply: any = { body: { text: '' } }; const server = await speechServer(t, () => reply); settings.serverUrl = server.address;
  await assert.rejects(import_(), /local speech server returned an empty transcript/);
  reply = { status: 500, body: 'secret detail' }; await assert.rejects(import_(), /could not transcribe this/);
  reply = { status: 307, headers: { location: 'http://example.org/' } }; await assert.rejects(import_(), /could not transcribe this/); assert.equal(server.requests.length, 3, 'a redirect is not followed');
  reply = { body: { text: 'x'.repeat(100_001) } }; await assert.rejects(import_(), /exceeded 100,000/);
  reply = { body: 'not json' }; await assert.rejects(import_(), /could not transcribe this/);
  // Cancelled while the server works.
  reply = { hold: true }; const slow = new Transcription({ changed() {}, settings: () => settings, runtimeDirectory: f.runtime, env: f.env, ffmpeg: null }); t.after(() => slow.close());
  const pending = slow.importFile({ sessionId: 's', path: wav }), refused = assert.rejects(pending, /cancelled/); await until(() => server.requests.length >= 6); await slow.cancel(); await refused;
  settings.serverUrl = 'http://127.0.0.1:9'; await assert.rejects(import_(), /does not answer. Start it/);
  settings.serverUrl = 'http://192.168.1.4:8080'; await assert.rejects(import_(), /has to be on this computer/);
  assert.deepEqual(await f.temporary(), []); assert.ok(!(await f.calls()).some(call => call.tool === 'whisper'), 'nothing falls back to another engine');
  // Each setting has its one recognizer.
  assert.deepEqual([recognizerFor({ executable: '', model: '' }).name, recognizerFor({ executable: '', model: '', provider: 'local' }).name, recognizerFor(settings).name, recognizerFor({ executable: '', model: '', provider: 'openai' }).name], ['whisper.cpp', 'whisper.cpp', 'The local speech server', 'The hosted speech service']);
  assert.deepEqual((await checkSpeechServer(server.address)).answers === undefined, false); assert.equal((await checkSpeechServer('http://127.0.0.1:9')).answers, false); await assert.rejects(checkSpeechServer('http://example.org'), /on this computer/);
});

test('M10 the choice is kept with the voice settings, and a wrong one changes nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-asr-')), core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }) as any);
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.updateSettings({ transcription: { provider: 'local-server', serverUrl: 'http://127.0.0.1:8080', serverModel: 'small' } });
  assert.deepEqual([core.settings.transcription.provider, core.settings.transcription.serverUrl, (await core.rpc('transcription.status')).state], ['local-server', 'http://127.0.0.1:8080', 'idle']);
  for (const transcription of [{ serverUrl: 'http://example.org' }, { provider: 'somewhere' }, { serverModel: 'a\nb' }, { serverModel: 4 }]) await assert.rejects(core.updateSettings({ transcription: transcription as any }));
  assert.equal(core.settings.transcription.serverUrl, 'http://127.0.0.1:8080');
  await core.updateSettings({ transcription: { provider: 'local' } }); assert.equal((await core.rpc('transcription.status')).state, 'unavailable', 'whisper.cpp still needs its own paths');
});
