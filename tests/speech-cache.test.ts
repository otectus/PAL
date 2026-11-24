import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../broker/store.ts';
import { Core } from '../broker/core.ts';
import { Speech, defaultVoice } from '../broker/tts.ts';
import { Spans } from '../broker/spans.ts';
import { ElevenLabs } from '../broker/elevenlabs.ts';
import { IndexTTS } from '../broker/indextts.ts';
import { defaultEmotion, defaultIndexConfig } from '../broker/indextts-config.ts';
import { SpeechCache, defaultSpeechCache, eraseSpeechCopies, speechKey, validateSpeechCache } from '../broker/speech-cache.ts';
import { defaultSettings } from '../broker/types.ts';

/** A store with one saved conversation and one reply in it, and the synthesizers and player as programs that only count. */
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'pal-speech-cache-')), state = join(directory, 'state'), voices = join(directory, 'voices'), calls = join(directory, 'calls');
  await mkdir(voices);
  await writeFile(join(voices, defaultVoice + '.onnx'), 'model'); await writeFile(join(voices, defaultVoice + '.onnx.json'), JSON.stringify({ audio: { sample_rate: 22050 }, language: { code: 'en_US' } }));
  const program = async (name: string, source: string) => { const path = join(directory, name); await writeFile(path, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\n${source}\n`); chmodSync(path, 0o755); return path; };
  const log = (name: string) => `appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + '\\n');`;
  const env: NodeJS.ProcessEnv = { ...process.env, PAL_TTS_DISABLED: '0', PAL_VOICES_DIR: voices,
    PAL_PIPER_BIN: await program('piper.mjs', `${log('piper')} let t='';for await(const c of process.stdin)t+=c; process.stdout.write(Buffer.alloc(4400, t.length % 256));`),
    PAL_APLAY_BIN: await program('aplay.mjs', `let bytes=0;for await(const c of process.stdin)bytes+=c.length; appendFileSync(${JSON.stringify(calls)}, 'played '+bytes+'\\n');`),
    PAL_SOX_BIN: await program('sox.mjs', 'process.stdin.pipe(process.stdout);'),
    PAL_TTS_PYTHON: await program('dispatcher.mjs', 'process.exitCode=69;') };
  const store = new Store(state), settings: any = { ...structuredClone(defaultSettings), ttsProvider: 'local', speechCache: { ...defaultSpeechCache, enabled: true }, speechRate: 1.1 };
  const session: any = { id: randomUUID(), provider: 'codex', mode: 'managed', cwd: directory, title: 'Talk', status: 'idle', created: 1, updated: 1 };
  store.saveSession(session);
  const say = (text: string) => { const id = randomUUID(); store.message({ id, sessionId: session.id, role: 'assistant', text, time: Date.now() } as any); return id; };
  const cache = new SpeechCache(store, () => settings.speechCache), speech = new Speech(() => settings, () => {}, env); speech.cache = cache;
  t.after(async () => { await speech.close(); store.close?.(); await rm(directory, { recursive: true, force: true }); });
  const log_ = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const read = async (messageId: string, text: string, test = false) => { speech.speak(text, test, undefined, undefined, undefined, undefined, { sessionId: session.id, messageId }); await speech.idle(); assert.equal(speech.state.error, ''); };
  const files = () => { try { return readdirSync(join(state, 'speech-cache')); } catch { return []; } };
  return { directory, state, voices, store, settings, session, say, cache, speech, read, files, log: log_, env };
}

test('M11 a reply read again plays what was kept, and any change to how it is made is a new synthesis', async t => {
  const f = await fixture(t), id = f.say('Read me twice.');
  await f.read(id, 'Read me twice.'); await f.read(id, 'Read me twice.');
  assert.deepEqual((await f.log()).filter(line => line === 'piper').length, 1, 'one synthesis'); assert.deepEqual((await f.log()).filter(line => line === 'played 4400').length, 2, 'the same audio both times');
  assert.deepEqual([f.cache.status().items, f.cache.status().hits], [1, 1]);
  // Rate is a synthesis option of a local voice; pitch and volume are applied to the audio afterwards.
  const made = async () => (await f.log()).filter(line => line === 'piper').length;
  f.settings.speechRate = 1.3; await f.read(id, 'Read me twice.'); assert.equal(await made(), 2);
  f.settings.speechPitch = 2; await f.read(id, 'Read me twice.'); assert.equal(await made(), 2); f.settings.speechPitch = 0;
  await f.read(id, 'Read me'); assert.equal(await made(), 3, 'other words');
  // A voice file that was replaced is another voice, whatever its name.
  await appendFile(join(f.voices, defaultVoice + '.onnx'), '-2'); await f.read(id, 'Read me twice.'); assert.equal(await made(), 4);
  await writeFile(join(f.voices, 'other.onnx'), 'model'); await writeFile(join(f.voices, 'other.onnx.json'), JSON.stringify({ audio: { sample_rate: 16000 }, language: { code: 'en_US' } }));
  f.settings.voice = 'other'; await f.read(id, 'Read me twice.'); assert.equal(await made(), 5);
  // Private permissions, and only audio on disk: the words are not there.
  for (const file of f.files()) { const path = join(f.state, 'speech-cache', file); assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(!(await readFile(path)).includes('Read me')); }
  assert.equal(statSync(join(f.state, 'speech-cache')).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM speech_cache').all()).includes('Read me'));
});

test('M11 every hosted option is part of the identity; a repeat sends nothing, and a service that is off plays nothing kept', async t => {
  const f = await fixture(t), id = f.say('Hosted words.'); let sent = 0, facts: any = { model: 'a', voice: 'b', language: 'en-US' };
  f.settings.ttsProvider = 'openai'; f.speech.hosted = async function *() { sent++; yield Buffer.alloc(4800, 3); }; f.speech.hostedFacts = () => facts;
  await f.read(id, 'Hosted words.'); await f.read(id, 'Hosted words.'); assert.equal(sent, 1);
  for (const change of [{ model: 'c' }, { voice: 'c' }, { language: 'de-DE' }, { connectionId: 'x' }, { speakers: [{ speaker: 'A', voice: 'b' }] }]) { const before: number = sent; facts = { ...facts, ...change }; await f.read(id, 'Hosted words.'); assert.equal(sent, before + 1, JSON.stringify(change)); }
  // The same words from another service are another recording.
  f.settings.ttsProvider = 'xai'; const before = sent; await f.read(id, 'Hosted words.'); assert.equal(sent, before + 1);
  // ElevenLabs may not be used until sending text there is allowed; kept audio does not get around that.
  let requests = 0; const eleven: any = { voiceId: 'voice1', modelId: 'm', allowCloud: true };
  f.speech.elevenlabs = new ElevenLabs(() => eleven, () => 'key', () => {}, { env: f.env, fetch: (async () => { requests++; return new Response(Buffer.alloc(4800, 5), { headers: { 'content-type': 'audio/pcm' } }); }) as any });
  f.settings.ttsProvider = 'elevenlabs'; await f.read(id, 'Hosted words.'); await f.read(id, 'Hosted words.'); assert.equal(requests, 1);
  eleven.modelId = 'm2'; await f.read(id, 'Hosted words.'); assert.equal(requests, 2);
  eleven.allowCloud = false; f.speech.speak('Hosted words.', false, undefined, undefined, undefined, undefined, { sessionId: f.session.id, messageId: id }); await f.speech.idle();
  assert.match(f.speech.state.error, /Enable sending spoken text/); assert.equal(requests, 2);
});

test('M11 a cloned voice is read again without loading its model; another profile, emotion or setting is another recording', async t => {
  const f = await fixture(t), id = f.say('Cloned words.'); let loads = 0;
  const profile: any = { id: 'p', name: 'Me', language: 'en', version: '2.5', created: 1, updated: 1, original: '/o', reference: '/r', emotion: defaultEmotion, durationFactor: 1 };
  f.store.set('indextts.voices', [profile]);
  let config: any = { ...defaultIndexConfig, version: '2.5', profileId: 'p' };
  const index = new IndexTTS(f.store, () => config, () => {}, f.env); t.after(() => index.close());
  index.engine = { pid: 1, async load() { loads++; return { languages: ['en'], sampleRate: 24000, device: 'cpu', lowVram: false }; }, async *synthesize(request: any) { yield { generationId: 'stale', pcm: Buffer.alloc(9600, 2) }; yield { generationId: request.generationId, pcm: Buffer.alloc(4800, 1) }; }, async unload() {} } as any;
  f.speech.indextts = index; f.settings.ttsProvider = 'indextts';
  await f.read(id, 'Cloned words.'); await f.read(id, 'Cloned words.');
  assert.equal(loads, 1, 'the model is not loaded for what is already here'); assert.deepEqual((await f.log()).filter(line => line === 'played 4800').length, 2, 'a stale piece is neither played nor kept');
  f.store.set('indextts.voices', [{ ...profile, updated: 2 }]); await f.read(id, 'Cloned words.'); assert.equal(loads, 2, 'an edited profile');
  config = { ...config, seed: 7 }; await f.read(id, 'Cloned words.'); assert.equal(loads, 3, 'another engine setting');
  f.speech.speak('Cloned words.', true, undefined, undefined, { profileId: 'p', emotion: { ...defaultEmotion, alpha: .3 } }, undefined, { sessionId: f.session.id, messageId: id }); await f.speech.idle(); assert.equal(loads, 4, 'another emotion');
});

test('M11 nothing is kept of unbound or temporary words, of a stopped or failed utterance, or while the cache is off', async t => {
  const f = await fixture(t), id = f.say('Bound words.'), source = { sessionId: f.session.id, messageId: id };
  f.speech.speak('No source at all.'); await f.speech.idle(); assert.equal(f.files().length, 0);
  f.speech.speak('Bound words.', false, undefined, undefined, undefined, undefined, { sessionId: randomUUID(), messageId: id }); await f.speech.idle(); assert.equal(f.files().length, 0, 'a message of another conversation');
  f.speech.speak('Gone.', false, undefined, undefined, undefined, undefined, { sessionId: f.session.id, messageId: randomUUID() }); await f.speech.idle(); assert.equal(f.files().length, 0);
  const temporary: any = { ...f.session, id: randomUUID(), temporary: true }; f.store.saveSession(temporary); const secret = randomUUID();
  f.store.message({ id: secret, sessionId: temporary.id, role: 'assistant', text: 'Temporary words.', time: 1 } as any);
  f.speech.speak('Temporary words.', false, undefined, undefined, undefined, undefined, { sessionId: temporary.id, messageId: secret }); await f.speech.idle(); assert.equal(f.files().length, 0);
  // Stopped halfway, or failing after the first audio: the part that was made is not kept.
  f.settings.ttsProvider = 'openai'; f.speech.hostedFacts = () => ({});
  f.speech.hosted = async function *(_p, _t, signal) { yield Buffer.alloc(4800); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
  f.speech.speak('Bound words.', false, undefined, undefined, undefined, undefined, source); for (let i = 0; i < 100 && f.speech.state.state !== 'speaking'; i++) await new Promise(done => setTimeout(done, 20));
  f.speech.stop(); await f.speech.idle(); assert.equal(f.files().length, 0);
  f.speech.hosted = async function *() { yield Buffer.alloc(4800); throw new Error('lost'); };
  f.speech.speak('Bound words.', false, undefined, undefined, undefined, undefined, source); await f.speech.idle(); assert.equal(f.files().length, 0);
  f.speech.hosted = async function *() { yield Buffer.alloc(4800); };
  f.settings.speechCache.enabled = false; f.speech.speak('Bound words.', false, undefined, undefined, undefined, undefined, source); await f.speech.idle(); assert.equal(f.files().length, 0);
  f.settings.speechCache.enabled = true; f.speech.speak('Bound words.', false, undefined, undefined, undefined, undefined, source); await f.speech.idle(); assert.equal(f.files().length, 1);
  // Turning it off deletes what was kept.
  f.settings.speechCache.enabled = false; f.cache.configured(); assert.equal(f.files().length, 0); assert.equal(f.cache.status().items, 0);
});

test('M11 audio leaves with a forgotten message or a deleted conversation, also while it is being made, and no restart brings it back', async t => {
  const f = await fixture(t), keep = f.say('The weather is fine.'), drop = f.say('My password is tangerine.');
  await f.read(keep, 'The weather is fine.'); await f.read(drop, 'My password is tangerine.'); assert.equal(f.files().length, 2);
  eraseSpeechCopies(f.store, f.session.id, message => !message || message.text.includes('tangerine'));
  assert.deepEqual([f.files().length, f.cache.status().items], [1, 1]);
  // The same words in two messages: forgetting one of them takes the recording.
  const twin = f.say('The weather is fine.'); await f.read(twin, 'The weather is fine.'); assert.equal(f.cache.status().items, 1);
  eraseSpeechCopies(f.store, f.session.id, message => message?.id === twin); assert.equal(f.files().length, 0);
  // Deleted while it is synthesized, or its text erased meanwhile: the finished audio is dropped.
  f.settings.ttsProvider = 'openai'; f.speech.hostedFacts = () => ({}); let release = () => {};
  f.speech.hosted = async function *() { yield Buffer.alloc(4800); await new Promise<void>(done => { release = done; }); };
  const during = async (act: () => void) => {
    f.speech.speak('The weather is fine.', false, undefined, undefined, undefined, undefined, { sessionId: f.session.id, messageId: keep });
    for (let i = 0; i < 100 && f.speech.state.state !== 'speaking'; i++) await new Promise(done => setTimeout(done, 20));
    act(); release(); await f.speech.idle(); assert.equal(f.files().length, 0);
  };
  await during(() => f.cache.forgetSession(f.session.id));
  await during(() => f.cache.clear());
  await during(() => f.store.message({ id: keep, sessionId: f.session.id, role: 'assistant', text: '[Content removed by memory erasure]', time: 1 } as any));
  // A file no row names, or a row whose file is gone, does not survive a restart.
  f.settings.ttsProvider = 'local'; const again = f.say('Kept across restarts.'); await f.read(again, 'Kept across restarts.');
  writeFileSync(join(f.state, 'speech-cache', 'orphan.pcm'), 'x'); f.store.db.prepare('INSERT INTO speech_cache VALUES (?,?,?,?,?,?,?)').run('ghost', 'ghost.pcm', '', 22050, 10, Date.now(), Date.now());
  const restarted = new SpeechCache(f.store, () => f.settings.speechCache);
  assert.deepEqual([f.files().length, restarted.status().items, existsSync(join(f.state, 'speech-cache', 'orphan.pcm'))], [1, 1, false]);
  f.store.deleteSession(f.session.id); restarted.forgetSession(f.session.id); assert.equal(f.files().length, 0);
});

test('M11 kept audio is bounded by age and size, and altered audio is made again', async t => {
  const f = await fixture(t), id = f.say('Bounded.');
  await f.read(id, 'Bounded.'); const file = join(f.state, 'speech-cache', f.files()[0]);
  writeFileSync(file, Buffer.alloc(4400, 99)); await f.read(id, 'Bounded.'); assert.equal((await f.log()).filter(line => line === 'piper').length, 2, 'a changed file is not played');
  f.cache.now = () => Date.now() + 8 * 86400_000; f.cache.sweep(); assert.equal(f.files().length, 0, 'older than its days');
  f.cache.now = () => Date.now();
  // The least recently heard goes first.
  f.settings.ttsProvider = 'openai'; f.speech.hostedFacts = () => ({}); f.speech.hosted = async function *() { yield Buffer.alloc(6 * 1024 * 1024); }; f.settings.speechCache.megabytes = 10;
  let clock = Date.now(); f.cache.now = () => clock; const first = f.say('One.'), second = f.say('Two.');
  await f.read(first, 'One.'); clock += 1000; await f.read(second, 'Two.'); assert.equal(f.cache.status().items, 1); assert.ok(f.cache.status().bytes <= 10 * 1024 * 1024);
  f.speech.hosted = async function *() { for (let i = 0; i < 9; i++) yield Buffer.alloc(4 * 1024 * 1024); };
  const long = f.say('A very long reply.'); await f.read(long, 'A very long reply.'); assert.equal(f.cache.status().items, 1, 'one item above 32 MB is played and not kept');
  assert.deepEqual(validateSpeechCache({ days: 30 }), { enabled: false, days: 30, megabytes: 100 });
  for (const bad of [{ days: 0 }, { days: 91 }, { megabytes: 5 }, { megabytes: 5000 }, { enabled: 'yes' }, { other: 1 }, null, []]) assert.throws(() => validateSpeechCache(bad));
  assert.notEqual(speechKey({ a: 1 }), speechKey({ a: '1' })); assert.equal(speechKey({ a: 1, b: undefined, c: [1] }), speechKey({ c: [1], a: 1 }));
});

test('EV-02 repeats are counted only while measurements are on, as counts and nothing else', async t => {
  const f = await fixture(t), spans = new Spans(); f.speech.observed = key => spans.utterance(key);
  f.speech.speak('Before.'); await f.speech.idle(); assert.deepEqual(spans.summary(), { enabled: false });
  spans.configure(true); t.after(() => spans.configure(false));
  for (const text of ['Same.', 'Same.', 'Other.', 'Same.']) { f.speech.speak(text); await f.speech.idle(); }
  assert.deepEqual((spans.summary() as any).speech, { utterances: 4, repeats: 2, repeatShare: .5 });
  f.settings.speechVolume = .5; f.speech.speak('Same.'); await f.speech.idle(); assert.equal((spans.summary() as any).speech.repeats, 2, 'another volume is not a repeat');
  assert.doesNotMatch(JSON.stringify(spans.summary()), /Same|Other|[0-9a-f]{64}/);
  for (let i = 0; i < 300; i++) spans.utterance('k' + i); spans.utterance('k0'); assert.equal((spans.summary() as any).speech.repeats, 2, 'beyond the last 256 nothing is remembered');
  spans.clear(); assert.deepEqual((spans.summary() as any).speech, { utterances: 0, repeats: 0, repeatShare: 0 });
});

test('M11 what is read from a message is bound to it only when those are its words', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-speech-core-'));
  const core = new Core(new Store(directory), () => ({ async send() {}, async interrupt() {}, async close() {} }) as any);
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const session = await core.create({ provider: 'codex', cwd: directory, title: 'Talk', trusted: true }), id = randomUUID();
  core.store.message({ id, sessionId: session.id, role: 'assistant', text: '# Plan\nUse **tangerine** for [the launch](https://example.org/x).', time: 1 } as any);
  const spoken: any[] = []; core.speech.speak = ((...args: any[]) => { spoken.push(args[6]); return true; }) as any;
  for (const [text, sessionId, messageId] of [['Use tangerine for the launch.', session.id, id], ['something else', session.id, id], ['Use tangerine', session.id, randomUUID()], ['Use tangerine', randomUUID(), id], ['Use tangerine', undefined, undefined]] as any) await core.rpc('tts.speak', { text, sessionId, messageId });
  assert.deepEqual(spoken, [{ sessionId: session.id, messageId: id }, undefined, undefined, undefined, undefined]);
  // Forgetting through memory reaches the cache inside the same transaction.
  await core.rpc('settings.update', { speechCache: { enabled: true, days: 30 } }); assert.deepEqual([core.settings.speechCache.days, (await core.rpc('tts.cache', {})).items], [30, 0]);
  core.store.db.prepare('INSERT INTO speech_cache VALUES (?,?,?,?,?,?,?)').run('k', 'f.pcm', '', 24000, 2, Date.now(), Date.now()); core.store.db.prepare('INSERT INTO speech_cache_sources VALUES (?,?,?)').run('k', session.id, id);
  const { eraseWorkingCopies } = await import('../broker/working-erasure.ts');
  eraseWorkingCopies(core.store, core.store.session(session.id), Object.assign((text: string) => text.includes('orchid'), { identifies: () => false })); assert.equal((await core.rpc('tts.cache', {})).items, 1, 'another passage');
  eraseWorkingCopies(core.store, core.store.session(session.id), Object.assign((text: string) => text.includes('tangerine'), { identifies: () => false })); assert.equal((await core.rpc('tts.cache', {})).items, 0);
  assert.equal((await core.rpc('tts.cacheClear', {})).removed, 0);
  await assert.rejects(core.rpc('settings.update', { speechCache: { days: 400 } }), /Keep speech for/);
});
