// PAL Everywhere §16.3: recordings kept as files, with time-coded transcripts, corrections, subtitles and clips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mimeFor, kindFor } from '../broker/artifacts/store.ts';
import { clock, formatSrt, formatVtt, parseCues, spanLabel, timedLines, within } from '../broker/media/recordings.ts';
import { skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';

const ffmpeg = existsSync('/usr/bin/ffmpeg') && existsSync('/usr/bin/ffprobe');
/** 16 kHz mono PCM: a tone, long enough to cut. */
export function wav(seconds: number) {
  const rate = 16000, data = Buffer.alloc(rate * 2 * seconds), head = Buffer.alloc(44);
  for (let i = 0; i < rate * seconds; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const transcript = 'WEBVTT\n\nNOTE made by a fixture\n\n1\n00:00:00.000 --> 00:00:02.000 align:start\n<v Anna>We launch on Monday.\n\n00:00:02.000 --> 00:00:04.500\nThe <i>budget</i> is 4 &lt; 5 &amp; approved.\n\n00:00:04.500 --> 00:00:06.000\nAny questions?\n';

test('timed text: WebVTT and SubRip are read alike, notes are not lines, and both formats round-trip', () => {
  const cues = parseCues(transcript);
  assert.deepEqual(cues, [{ start: 0, end: 2, text: 'We launch on Monday.', speaker: 'Anna' }, { start: 2, end: 4.5, text: 'The budget is 4 < 5 & approved.' }, { start: 4.5, end: 6, text: 'Any questions?' }]);
  assert.deepEqual(parseCues(formatVtt(cues)), cues);
  const srt = formatSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nAnna: We launch on Monday\.\n\n2\n/);
  assert.deepEqual(parseCues(srt.replaceAll('\n', '\r\n')).map(cue => cue.start), [0, 2, 4.5]);
  // Hours are optional, bad times are skipped, and an arrow or a blank line inside text cannot end a line early.
  assert.deepEqual(parseCues('WEBVTT\n\n01:02.500 --> 01:03.000\nshort\n\n99:99.000 --> 99:99.500\nbad\n'), [{ start: 62.5, end: 63, text: 'short' }]);
  const odd = [{ start: 1, end: 2, text: 'a --> b\n\nsecond' }];
  assert.deepEqual(parseCues(formatVtt(odd)), [{ start: 1, end: 2, text: 'a --> b\nsecond' }]);
  assert.deepEqual(parseCues(formatSrt(odd)), [{ start: 1, end: 2, text: 'a → b\nsecond' }]);
  assert.equal(clock(754.9), '12:34'); assert.equal(clock(3723), '1:02:03'); assert.equal(spanLabel(0, 65), '0:00–1:05');
  assert.deepEqual(within(cues, 1.5, 2.5).map(cue => cue.start), [0, 2], 'a part includes every line it touches');
  assert.deepEqual(within(cues, 2, 4.5).map(cue => cue.start), [2], 'but not its neighbours');
  assert.equal(timedLines(cues.slice(0, 1)), '[0:00] Anna: We launch on Monday.');
});

test('recordings are recognised by their container, not by a name alone', () => {
  assert.equal(mimeFor('talk.wav', wav(1)), 'audio/wav');
  assert.equal(mimeFor('talk', Buffer.from('OggS' + '\0'.repeat(20))), 'audio/ogg');
  assert.equal(mimeFor('clip.mov', Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0')), 'video/quicktime');
  assert.equal(mimeFor('note.m4a', Buffer.from('\0\0\0\x20ftypM4A \0\0\0\0')), 'audio/mp4');
  assert.equal(mimeFor('film.mp4', Buffer.from('\0\0\0\x20ftypisom\0\0\0\0')), 'video/mp4');
  assert.equal(mimeFor('film.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'video/webm');
  assert.equal(mimeFor('song.mp3', Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0])), 'audio/mpeg');
  // A playlist named like a recording is text: nothing follows its addresses.
  assert.equal(mimeFor('stream.mp3', Buffer.from('#EXTM3U\nhttp://example.test/a.ts\n')), 'text/plain');
  assert.equal(mimeFor('firmware.bin', Buffer.from([0xff, 0xfb, 0x90, 0])), 'application/octet-stream');
  assert.equal(mimeFor('a.srt', Buffer.from('1\n')), 'application/x-subrip'); assert.equal(kindFor('application/x-subrip', 'a.srt'), 'text');
});

async function kept(t: any, steps?: any) {
  const f = await workbenchFixture(t, steps), { session } = await f.session({ write: false });
  await writeFile(join(f.project, 'Interview.wav'), wav(6));
  const recording = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'Interview.wav') });
  const text = await f.core.workbench.recordings.installTranscript(session.id, { vtt: transcript, source: { name: 'Interview.wav', sha256: recording.sha256, durationSeconds: 6, truncated: false }, recording });
  return { f, session, recording, text };
}

test('a recording opens with its transcript, a transcript opens with its recording, and neither without permission', { skip: skipWithoutHelper }, async t => {
  const { f, session, recording, text } = await kept(t);
  const opened = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId });
  assert.equal(opened.recording.mime, 'audio/wav'); assert.equal(opened.recording.video, false); assert.equal(opened.recording.available, true);
  assert.equal(opened.transcripts.length, 1); assert.equal(opened.transcript.versionId, text.versionId); assert.equal(opened.transcript.total, 3);
  assert.deepEqual(opened.transcript.cues[0], { index: 0, start: 0, end: 2, text: 'We launch on Monday.', speaker: 'Anna' });
  const back = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: text.artifactId });
  assert.equal(back.recording.artifactId, recording.artifactId);
  const page = await f.core.rpc('recordings.cues', { sessionId: session.id, artifactId: text.artifactId, from: 1, limit: 1 });
  assert.deepEqual(page.cues.map((cue: any) => cue.index), [1]); assert.equal(page.next, 2);
  const other = await f.session({ write: false });
  await assert.rejects(f.core.rpc('recordings.open', { sessionId: other.session.id, artifactId: recording.artifactId }), /not available in this conversation/);
  await writeFile(join(f.project, 'notes.txt'), 'plain');
  const plain = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'notes.txt') });
  await assert.rejects(f.core.rpc('recordings.open', { sessionId: session.id, artifactId: plain.artifactId }), /neither a recording nor a transcript/);
  assert.deepEqual((await f.core.rpc('artifacts.list', { sessionId: session.id, kind: 'recording' })).artifacts.map((item: any) => item.id), [recording.artifactId], 'the library can list only recordings');
  // A transcript whose recording was never kept still opens, and says there is nothing to play.
  const alone = await f.core.workbench.recordings.installTranscript(session.id, { vtt: transcript, source: { name: 'Elsewhere.mp3', sha256: 'f'.repeat(64), durationSeconds: 6, truncated: true } });
  const silent = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: alone.artifactId });
  assert.equal(silent.recording, null); assert.equal(silent.transcript.truncated, true);
});

test('a correction is a new version, a stale one is refused, and the transcript it began from stays', { skip: skipWithoutHelper }, async t => {
  const { f, session, recording, text } = await kept(t), ref = { sessionId: session.id, artifactId: text.artifactId, versionId: text.versionId };
  const next = await f.core.rpc('recordings.correct', { ...ref, edits: [{ index: 0, text: 'We launch on Tuesday.' }, { index: 2, text: '' }] });
  assert.notEqual(next.versionId, text.versionId); assert.equal(next.corrected, true); assert.equal(next.latest, true);
  assert.deepEqual(next.cues.map((cue: any) => [cue.start, cue.text, cue.speaker]), [[0, 'We launch on Tuesday.', 'Anna'], [2, 'The budget is 4 < 5 & approved.', undefined]], 'times and speakers are kept; an emptied line is gone');
  const { data } = await f.core.workbench.artifacts.bytes(session.id, text.artifactId, text.versionId); assert.equal(data.toString(), transcript);
  await assert.rejects(f.core.rpc('recordings.correct', { ...ref, edits: [{ index: 0, text: 'late' }] }), /changed since you opened it/);
  const latest = { ...ref, versionId: next.versionId };
  await assert.rejects(f.core.rpc('recordings.correct', { ...latest, edits: [{ index: 9, text: 'x' }] }), /not in this transcript/);
  await assert.rejects(f.core.rpc('recordings.correct', { ...latest, edits: [{ index: 0, text: 'We launch on Tuesday.' }] }), /Nothing changed/);
  await assert.rejects(f.core.rpc('recordings.correct', { ...latest, edits: [{ index: 0, text: '' }, { index: 1, text: '' }] }), /at least one line/);
  assert.equal((await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId })).transcript.corrected, true, 'the recording shows the corrected transcript');
});

test('subtitles come out as SRT or WebVTT, whole or for one part, as new linked files', { skip: skipWithoutHelper }, async t => {
  const { f, session, text } = await kept(t), ref = { sessionId: session.id, artifactId: text.artifactId };
  const srt = await f.core.rpc('recordings.subtitles', { ...ref, format: 'srt' });
  assert.equal(srt.name, 'Interview (transcript).srt'); assert.equal(srt.mime, 'application/x-subrip'); assert.equal(srt.parents[0].relation, 'subtitles');
  const part = await f.core.rpc('recordings.subtitles', { ...ref, format: 'vtt', start: 2, end: 6, fromZero: true });
  assert.equal(part.name, 'Interview (transcript) 0.02–0.06.vtt');
  assert.deepEqual(parseCues((await f.core.workbench.artifacts.bytes(session.id, part.artifactId)).data.toString()).map(cue => [cue.start, cue.end]), [[0, 2.5], [2.5, 4]]);
  await assert.rejects(f.core.rpc('recordings.subtitles', { ...ref, format: 'ass' }), /SRT or WebVTT/);
  await assert.rejects(f.core.rpc('recordings.subtitles', { ...ref, format: 'srt', start: 100, end: 200 }), /no text in that part/);
  await assert.rejects(f.core.rpc('recordings.subtitles', { ...ref, format: 'srt', start: 5, end: 2 }), /ends after it starts/);
});

test('a clip is a new file of exactly that part, with its own transcript; the recording is untouched', { skip: skipWithoutHelper || (!ffmpeg && 'needs ffmpeg') }, async t => {
  const { f, session, recording, text } = await kept(t);
  const started = await f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: recording.artifactId, start: 2, end: 4.5, transcript: { artifactId: text.artifactId, versionId: text.versionId } });
  assert.equal(started.state, 'running'); assert.match(started.label, /Clip Interview\.wav 0:02–0:04/);
  await until(() => f.core.workbench.operations.get(started.operationId).state !== 'running', 30_000);
  const operation = f.core.workbench.operations.get(started.operationId);
  assert.equal(operation.state, 'completed', JSON.stringify(operation.error)); assert.deepEqual(operation.results.map(item => item.purpose), ['clip', 'transcript']);
  const clip = f.core.workbench.artifacts.version(session.id, operation.results[0].artifactId);
  assert.equal(clip.parents[0].relation, 'clip'); assert.equal(clip.provenance.method, 'exact'); assert.equal(clip.mime, 'audio/wav');
  const seconds = Number(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f.core.workbench.artifacts.objectPath(clip.sha256)]).toString());
  assert.ok(Math.abs(seconds - 2.5) < 0.1, `the clip is ${seconds} s`);
  const opened = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: clip.artifactId });
  assert.deepEqual(opened.transcript.cues.map((cue: any) => [cue.start, cue.end, cue.text]), [[0, 2.5, 'The budget is 4 < 5 & approved.']]);
  assert.equal((await f.core.workbench.artifacts.bytes(session.id, recording.artifactId)).version.sha256, recording.sha256);
  const past = await f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: recording.artifactId, start: 500, end: 510 });
  await until(() => f.core.workbench.operations.get(past.operationId).state !== 'running', 30_000);
  assert.equal(f.core.workbench.operations.get(past.operationId).state, 'failed'); assert.match(f.core.workbench.operations.get(past.operationId).error!.message, /clip could not be made/);
  await assert.rejects(f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: recording.artifactId, start: 0, end: 1000 }), /up to 15 minutes/);
  await assert.rejects(f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: text.artifactId, start: 0, end: 1 }), /not an audio or video/);
  f.core.workbench.recordings.ffmpeg = null;
  await assert.rejects(f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: recording.artifactId, start: 0, end: 1 }), /needs ffmpeg/);
});

test('a video clip starts where it was asked to, and place and device metadata are not copied', { skip: skipWithoutHelper || (!ffmpeg && 'needs ffmpeg') }, async t => {
  const { f, session } = await kept(t), path = join(f.project, 'walk.mp4');
  execFileSync('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=161x121:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4', '-metadata', 'location=+48.8584+002.2945/', '-metadata', 'comment=private', '-c:v', 'mpeg4', '-g', '100', '-c:a', 'aac', '-y', path]);
  const video = await f.core.rpc('artifacts.import', { sessionId: session.id, path }); assert.equal(video.mime, 'video/mp4');
  const started = await f.core.rpc('recordings.clip', { sessionId: session.id, artifactId: video.artifactId, start: 1.5, end: 3 });
  await until(() => f.core.workbench.operations.get(started.operationId).state !== 'running', 60_000);
  const operation = f.core.workbench.operations.get(started.operationId); assert.equal(operation.state, 'completed', JSON.stringify(operation.error));
  const clip = f.core.workbench.artifacts.version(session.id, operation.results[0].artifactId), file = f.core.workbench.artifacts.objectPath(clip.sha256);
  const probe = JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString());
  assert.equal(operation.details!.method, 'exact'); assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.2, probe.format.duration);
  assert.deepEqual(probe.streams.map((stream: any) => stream.codec_type).sort(), ['audio', 'video']);
  assert.ok(!/48\.8584|private/.test(JSON.stringify(probe.format.tags || {})), 'metadata stays with the original');
});

test('a kept recording is transcribed as a listed operation; its policy decides where it may go; Cancel stops it', { skip: skipWithoutHelper || (!ffmpeg && 'needs ffmpeg') }, async t => {
  const f = await workbenchFixture(t), { session } = await f.session({ write: false });
  const whisper = join(f.directory, 'whisper.mjs'), model = join(f.directory, 'model.bin'), hold = join(f.directory, 'hold');
  await writeFile(model, 'fixture');
  await writeFile(whisper, `#!${process.execPath}\nimport{writeFileSync,existsSync}from'node:fs';const args=process.argv.slice(2),prefix=args[args.indexOf('--output-file')+1];\nif(existsSync(${JSON.stringify(hold)})){process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)}else{writeFileSync(prefix+'.txt','Hello there');writeFileSync(prefix+'.vtt',${JSON.stringify(transcript)})}\n`); await chmod(whisper, 0o755);
  await writeFile(join(f.project, 'memo.wav'), wav(3));
  const recording = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'memo.wav') });
  assert.throws(() => f.core.workbench.recordings.transcribe(session.id, { artifactId: recording.artifactId }), /Set up transcription/);
  await f.core.updateSettings({ transcription: { executable: whisper, model } });
  assert.equal((await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId })).canTranscribe, true);
  const started = await f.core.rpc('recordings.transcribe', { sessionId: session.id, artifactId: recording.artifactId });
  await until(() => f.core.workbench.operations.get(started.operationId).state !== 'running', 20_000);
  const operation = f.core.workbench.operations.get(started.operationId); assert.equal(operation.state, 'completed', JSON.stringify(operation.error));
  const opened = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId });
  assert.equal(opened.transcript.total, 3); assert.equal(opened.transcript.name, 'memo (transcript).vtt'); assert.equal(opened.transcript.engine, 'whisper.cpp');
  await writeFile(hold, '');
  const held = await f.core.rpc('recordings.transcribe', { sessionId: session.id, artifactId: recording.artifactId });
  await until(() => f.core.transcription.status().state === 'transcribing');
  await assert.rejects(f.core.rpc('recordings.transcribe', { sessionId: session.id, artifactId: recording.artifactId }), /busy/);
  await f.core.rpc('operations.cancel', { id: held.operationId });
  await until(() => f.core.workbench.operations.get(held.operationId).state === 'cancelled', 10_000);
  assert.equal(f.core.transcription.status().state, 'idle');
  // A hosted service never receives a recording that was kept for this computer only.
  await f.core.updateSettings({ transcription: { executable: whisper, model, provider: 'openai', cloudModel: 'fixture' } });
  await assert.rejects(f.core.rpc('recordings.transcribe', { sessionId: session.id, artifactId: recording.artifactId }), /only be processed on this computer/);
});

test('one part of a transcript goes to the model with its times, and a translation keeps every time', { skip: skipWithoutHelper }, async t => {
  let seen = '';
  const { f, session, recording, text } = await kept(t, [
    (body: any) => { seen = JSON.stringify(body.messages); return { content: 'It is approved [0:02].' }; },
    () => ({ content: JSON.stringify({ segments: ['Wir starten am Montag.', 'Das Budget ist genehmigt.', 'Fragen?'] }) }),
  ]);
  const pinned = await f.core.rpc('references.pin', { sessionId: session.id, ref: { kind: 'artifact', artifactId: text.artifactId, span: { start: 2, end: 4.5 } } });
  assert.equal(pinned.label, 'Interview (transcript).vtt 0:02–0:04');
  const { label: _label, ...ref } = pinned;
  await f.core.send({ id: session.id, text: 'Is it approved?', references: [ref] }); await f.finished(session.id);
  assert.match(seen, /kind=\\?"transcript/); assert.match(seen, /\[0:02\] The budget is 4 < 5 & approved\./); assert.ok(!seen.includes('We launch on Monday'), 'only the part that was picked');
  await assert.rejects(f.core.rpc('references.pin', { sessionId: session.id, ref: { kind: 'artifact', artifactId: recording.artifactId, span: { start: 0, end: 1 } } }), /Only a time-coded transcript/);
  await f.core.updateSettings({ workbench: { helper: { provider: 'ollama', model: 'plain:latest' } } });
  const result = await f.core.rpc('translate.run', { sessionId: session.id, targetLanguage: 'German', input: { artifactId: text.artifactId } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const german = f.core.workbench.artifacts.version(session.id, result.artifacts[0].artifactId);
  assert.equal(german.mime, 'text/vtt'); assert.equal(german.parents[0].relation, 'translation');
  assert.deepEqual(parseCues((await f.core.workbench.artifacts.bytes(session.id, german.artifactId)).data.toString()).map(cue => [cue.start, cue.end, cue.text]), [[0, 2, 'Wir starten am Montag.'], [2, 4.5, 'Das Budget ist genehmigt.'], [4.5, 6, 'Fragen?']]);
  const opened = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId });
  assert.deepEqual(opened.transcripts.map((item: any) => item.language || 'original').sort(), ['German', 'original']); assert.equal(opened.transcript.versionId, text.versionId, 'the original is shown first');
  assert.equal((await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: recording.artifactId, transcriptId: german.artifactId })).transcript.cues[2].text, 'Fragen?');
});

test('transcribing a chosen file keeps no recording; adding the same file later finds its transcript', { skip: skipWithoutHelper || (!ffmpeg && 'needs ffmpeg') }, async t => {
  const f = await workbenchFixture(t), { session } = await f.session({ write: false });
  const whisper = join(f.directory, 'whisper.mjs'), model = join(f.directory, 'model.bin'); await writeFile(model, 'fixture');
  await writeFile(whisper, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';const args=process.argv.slice(2),prefix=args[args.indexOf('--output-file')+1];writeFileSync(prefix+'.txt','Hello');writeFileSync(prefix+'.vtt',${JSON.stringify(transcript)});\n`); await chmod(whisper, 0o755);
  await f.core.updateSettings({ transcription: { executable: whisper, model } });
  const path = join(f.project, 'call.wav'); await writeFile(path, wav(2));
  const result = await f.core.rpc('transcription.importFile', { sessionId: session.id, path });
  assert.equal((await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: result.artifact.artifactId })).recording, null);
  const listed = await f.core.rpc('recordings.list', { sessionId: session.id }); assert.deepEqual(listed.items.map((item: any) => [item.kind, item.name]), [['transcript', 'call (transcript).vtt']]);
  const kept = await f.core.rpc('artifacts.import', { sessionId: session.id, path });
  const opened = await f.core.rpc('recordings.open', { sessionId: session.id, artifactId: result.artifact.artifactId });
  assert.equal(opened.recording.artifactId, kept.artifactId);
  assert.deepEqual((await f.core.rpc('recordings.list', { sessionId: session.id })).items.map((item: any) => [item.kind, item.transcripts]), [['recording', 1]], 'the two are one entry now');
  assert.equal((await readFile(path)).length, wav(2).length, 'the original file is untouched');
});
