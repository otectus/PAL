/**
 * Recordings: audio and video kept as files of a conversation, with time-coded transcripts (PAL Everywhere §16.3).
 *
 * A recording is an ordinary artifact whose content is audio or video. A transcript is a WebVTT artifact linked to it;
 * a correction is a new version of that transcript, never a rewrite of it, and a clip or a subtitle file is a new
 * artifact that names the exact version it came from. Recordings keep the processing limits they were added with, so
 * nothing here sends one anywhere the owner did not allow.
 *
 * Clips are cut by ffmpeg inside PAL's isolation boundary when it is available: no network, one read-only input. Their
 * metadata (place, device, chapters) is not copied.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Workbench } from '../workbench.ts';
import { privateDir } from '../paths.ts';
import { isHostedSpeech } from '../hosted-speech.ts';
import { routeAllowed, type ArtifactRef } from '../tools/contracts.ts';
import { safeName, type ArtifactVersion } from '../artifacts/store.ts';
import { OperationStore, type Operation } from '../operations/store.ts';
import { isolation, sandboxed } from '../execution/runner.ts';

export type Cue = { start: number; end: number; text: string; speaker?: string };
export const recordingLimits = { cues: 6000, page: 1000, cueChars: 2000, transcriptBytes: 3 * 1024 * 1024, clipSeconds: 15 * 60, clipWallMs: 4 * 60_000, clipBytes: 100 * 1024 * 1024, edits: 200, spanChars: 16_000 };
export const isRecording = (mime: string) => /^(audio|video)\//.test(mime);
export const isTimedText = (mime: string, name = '') => mime === 'text/vtt' || mime === 'application/x-subrip' || /^text\//.test(mime) && /\.(vtt|srt)$/i.test(name);

// ── Timed text ─────────────────────────────────────────────────────────────────────────────────────
const stamp = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
function secondsOf(value: string) {
  const match = stamp.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return undefined;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
}
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '', quot: '"' };
const decode = (text: string) => text.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot);/g, (_whole, name) => entities[name]);
/** Reads WebVTT or SubRip. Blocks without times (headers, notes, styles) are not cues; unreadable times are skipped. */
export function parseCues(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n'), at = lines.findIndex(line => line.includes('-->'));
    if (at < 0 || at > 1 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [from, rest] = lines[at].split('-->'), to = rest.trim().split(/\s+/)[0];
    const start = secondsOf(from), end = secondsOf(to);
    if (start === undefined || end === undefined || end < start) continue;
    let text = lines.slice(at + 1).join('\n').trim(), speaker = '';
    const voice = /^<v(?:\.[^\s>]*)?\s+([^>]{1,80})>/.exec(text);
    if (voice) speaker = decode(voice[1]).trim();
    text = decode(text.replace(/<\/?[a-zA-Z0-9][^>]*>/g, '')).trim();
    if (!text) continue;
    cues.push({ start, end, text: text.slice(0, recordingLimits.cueChars), ...(speaker ? { speaker } : {}) });
    if (cues.length >= recordingLimits.cues) break;
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
function stampOf(value: number, comma = false) {
  const total = Math.max(0, Math.round(value * 1000)), pad = (number: number, width = 2) => String(number).padStart(width, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}${comma ? ',' : '.'}${pad(total % 1000, 3)}`;
}
/** Cue text is one block: blank lines would end it early, and an arrow would look like a time line. */
const cueText = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
export function formatVtt(cues: Cue[]) {
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return 'WEBVTT\n\n' + cues.map(cue => `${stampOf(cue.start)} --> ${stampOf(cue.end)}\n${cue.speaker ? `<v ${escape(cue.speaker.replace(/[\n>]/g, ' '))}>` : ''}${escape(cueText(cue.text))}`).join('\n\n') + '\n';
}
export function formatSrt(cues: Cue[]) {
  return cues.map((cue, index) => `${index + 1}\n${stampOf(cue.start, true)} --> ${stampOf(cue.end, true)}\n${cue.speaker ? cue.speaker + ': ' : ''}${cueText(cue.text).replaceAll('-->', '→')}`).join('\n\n') + '\n';
}
/** 12:34, or 1:02:03 from an hour on. */
export function clock(value: number) {
  const total = Math.max(0, Math.floor(value)), pad = (number: number) => String(number).padStart(2, '0');
  return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}
export const spanLabel = (start: number, end: number) => `${clock(start)}–${clock(end)}`;
/** Cues that overlap a part of the recording, in order. */
export const within = (cues: Cue[], start: number, end: number) => cues.filter(cue => cue.end > start && cue.start < end || cue.start === cue.end && cue.start >= start && cue.start < end);
/** The transcript as a model reads it: each line carries its time, so an answer can cite one. */
export const timedLines = (cues: Cue[]) => cues.map(cue => `[${clock(cue.start)}] ${cue.speaker ? cue.speaker + ': ' : ''}${cue.text.replace(/\n/g, ' ')}`).join('\n');

type Ref = { artifactId: string; versionId: string };
const media: Record<string, { extension: string; codec: string[]; method: 'copy' | 'encode' }> = {
  'audio/mpeg': { extension: 'mp3', codec: ['-c:a', 'copy'], method: 'copy' },
  'audio/wav': { extension: 'wav', codec: ['-c:a', 'copy'], method: 'copy' },
  'audio/ogg': { extension: 'ogg', codec: ['-c:a', 'copy'], method: 'copy' },
  'audio/mp4': { extension: 'm4a', codec: ['-c:a', 'copy'], method: 'copy' },
  'audio/webm': { extension: 'webm', codec: ['-c:a', 'copy'], method: 'copy' },
  'audio/aac': { extension: 'aac', codec: ['-c:a', 'copy'], method: 'copy' },
};
const bound = (value: unknown, label: string) => { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 24 * 3600) throw new Error(`${label} is not a time in this recording`); return Math.round(number * 1000) / 1000; };

export class Recordings {
  workbench: Workbench;
  /** Test seam; null means no ffmpeg on this computer. */
  ffmpeg: string | null = '/usr/bin/ffmpeg';
  constructor(workbench: Workbench) { this.workbench = workbench; }
  private get core() { return this.workbench.core; }
  private get files() { return this.workbench.artifacts; }
  private get db() { return this.core.store.db; }

  private media(sessionId: string, artifactId: unknown, versionId?: unknown) {
    const version = this.files.version(sessionId, artifactId, versionId);
    if (!isRecording(version.mime)) throw new Error(`${version.name} is not an audio or video recording`);
    return version;
  }
  private transcriptVersion(sessionId: string, artifactId: unknown, versionId?: unknown) {
    const version = this.files.version(sessionId, artifactId, versionId);
    if (!isTimedText(version.mime, version.name)) throw new Error(`${version.name} is not a time-coded transcript`);
    if (version.bytes > recordingLimits.transcriptBytes) throw new Error('That transcript is larger than PAL reads (3 MB)');
    return version;
  }
  async cuesOf(sessionId: string, artifactId: unknown, versionId?: unknown) {
    const version = this.transcriptVersion(sessionId, artifactId, versionId);
    const { data } = await this.files.bytes(sessionId, version.artifactId, version.versionId);
    return { version, cues: parseCues(data.toString('utf8')) };
  }
  private describe(version: ArtifactVersion) {
    return { artifactId: version.artifactId, versionId: version.versionId, name: version.name, mime: version.mime, bytes: version.bytes, video: version.mime.startsWith('video/'), created: version.createdAt };
  }
  private describeTranscript(sessionId: string, artifactId: string) {
    const versions = this.files.versions(sessionId, artifactId), latest = versions[versions.length - 1];
    const language = versions.map(version => version.provenance.language).find(value => typeof value === 'string' && value);
    return { artifactId, versionId: latest.versionId, name: latest.name, created: latest.createdAt, versions: versions.length, corrected: versions.some(version => version.provenance.kind === 'transcript-correction'), ...(language ? { language: String(language) } : {}) };
  }
  /** Every transcript of a recording this conversation may read: linked to it, made from the same bytes, or a translation of one. */
  private transcriptsOf(sessionId: string, recording: ArtifactVersion) {
    const found = new Set<string>();
    const add = (rows: any[]) => { for (const row of rows) { const version = JSON.parse(String(row.data)) as ArtifactVersion; if (isTimedText(version.mime, version.name) && this.files.authorized(sessionId, version.artifactId)) found.add(version.artifactId); } };
    add(this.db.prepare("SELECT v.data FROM artifact_derivations d JOIN artifact_versions s ON s.id=d.source_version_id JOIN artifact_versions v ON v.id=d.derived_version_id WHERE s.artifact_id=? AND d.kind='transcript'").all(recording.artifactId));
    add(this.db.prepare("SELECT v.data FROM artifact_versions v JOIN artifact_refs r ON r.artifact_id=v.artifact_id WHERE r.owner_kind='session' AND r.owner_id=? AND json_extract(v.data,'$.provenance.kind')='transcription' AND json_extract(v.data,'$.provenance.sha256')=?").all(sessionId, recording.sha256));
    for (const id of [...found]) add(this.db.prepare("SELECT v.data FROM artifact_derivations d JOIN artifact_versions s ON s.id=d.source_version_id JOIN artifact_versions v ON v.id=d.derived_version_id WHERE s.artifact_id=? AND d.kind='translation'").all(id));
    return [...found].map(id => this.describeTranscript(sessionId, id)).sort((a, b) => b.created - a.created);
  }
  /** The recording a transcript belongs to, when it was kept. */
  private recordingOf(sessionId: string, transcript: ArtifactVersion): ArtifactVersion | undefined {
    const seen = new Set<string>();
    let queue = [transcript.artifactId];
    for (let depth = 0; depth < 5 && queue.length; depth++) {
      const next: string[] = [];
      for (const id of queue) {
        if (seen.has(id) || !this.files.authorized(sessionId, id)) continue;
        seen.add(id);
        for (const version of this.files.versions(sessionId, id)) {
          for (const parent of version.parents) {
            if (!this.files.authorized(sessionId, parent.artifactId)) continue;
            const source = this.files.version(sessionId, parent.artifactId, parent.versionId);
            if (isRecording(source.mime)) return source;
            if (['translation', 'correction', 'subtitles', 'excerpt'].includes(parent.relation)) next.push(parent.artifactId);
          }
          if (typeof version.provenance.sha256 === 'string' && version.provenance.sha256) {
            const row = this.db.prepare("SELECT v.data FROM artifact_versions v JOIN artifact_refs r ON r.artifact_id=v.artifact_id WHERE r.owner_kind='session' AND r.owner_id=? AND json_extract(v.data,'$.sha256')=? LIMIT 1").get(sessionId, version.provenance.sha256);
            if (row) { const source = JSON.parse(String(row.data)) as ArtifactVersion; if (isRecording(source.mime)) return source; }
          }
        }
      }
      queue = next;
    }
  }
  /** What this conversation can listen to or read: kept recordings, then transcripts whose recording was not kept. */
  list(sessionId: string, p: { project?: unknown; query?: unknown } = {}) {
    const query = typeof p.query === 'string' ? p.query.trim().slice(0, 200) : '', project = p.project === true;
    const rows = this.files.list(sessionId, { kind: 'recording', project, query, limit: 100 }).artifacts;
    const recordings = rows.map(item => { const version = this.files.version(sessionId, item.id); return { kind: 'recording' as const, ...this.describe(version), transcripts: this.transcriptsOf(sessionId, version).length, shared: item.sessionId !== sessionId }; });
    const texts = this.files.list(sessionId, { provenanceKind: 'transcription', project, query, limit: 100 }).artifacts
      .concat(this.files.list(sessionId, { provenanceKind: 'transcript-correction', project, query, limit: 100 }).artifacts);
    const alone = [...new Map(texts.map(item => [item.id, item])).values()].flatMap(item => {
      const version = this.files.version(sessionId, item.id);
      return isTimedText(version.mime, version.name) && !this.recordingOf(sessionId, version) ? [{ kind: 'transcript' as const, ...this.describe(version), transcripts: 1, shared: item.sessionId !== sessionId }] : [];
    });
    return { items: [...recordings, ...alone].sort((a, b) => b.created - a.created), canTranscribe: this.core.transcription.status().state !== 'unavailable', canClip: !!this.ffmpeg };
  }
  /** Opens a recording, or a transcript with the recording it belongs to. */
  async open(sessionId: string, p: { artifactId: unknown; versionId?: unknown; transcriptId?: unknown }) {
    const version = this.files.version(sessionId, p.artifactId, p.versionId);
    let recording: ArtifactVersion | undefined, chosen: { artifactId: string; versionId?: string } | undefined;
    if (isRecording(version.mime)) recording = version;
    else if (isTimedText(version.mime, version.name)) { recording = this.recordingOf(sessionId, version); chosen = { artifactId: version.artifactId, versionId: version.versionId }; }
    else throw new Error(`${version.name} is neither a recording nor a transcript`);
    let transcripts = recording ? this.transcriptsOf(sessionId, recording) : [this.describeTranscript(sessionId, version.artifactId)];
    if (chosen && !transcripts.some(item => item.artifactId === chosen!.artifactId)) transcripts = [this.describeTranscript(sessionId, chosen.artifactId), ...transcripts];
    if (typeof p.transcriptId === 'string') { if (!transcripts.some(item => item.artifactId === p.transcriptId)) throw new Error('That transcript does not belong to this recording'); chosen = { artifactId: p.transcriptId }; }
    chosen ||= transcripts.find(item => !item.language) || transcripts[0];
    return { recording: recording ? { ...this.describe(recording), available: await this.files.available(recording) } : null, transcripts,
      transcript: chosen ? await this.page(sessionId, chosen) : null, canTranscribe: this.core.transcription.status().state !== 'unavailable' };
  }
  /** Cues in pages, so a long transcript never has to cross a connection at once. */
  async page(sessionId: string, p: { artifactId: unknown; versionId?: unknown; from?: unknown; limit?: unknown }) {
    const { version, cues } = await this.cuesOf(sessionId, p.artifactId, p.versionId);
    const from = Math.max(0, Math.floor(Number(p.from)) || 0), limit = Math.max(1, Math.min(Math.floor(Number(p.limit)) || 400, recordingLimits.page));
    const artifact = this.files.artifact(version.artifactId), next = from + limit;
    return { artifactId: version.artifactId, versionId: version.versionId, name: version.name, latest: artifact.latestVersionId === version.versionId, corrected: version.provenance.kind === 'transcript-correction',
      engine: typeof version.provenance.engine === 'string' ? version.provenance.engine : '', truncated: version.provenance.truncated === true, total: cues.length, from,
      cues: cues.slice(from, next).map((cue, index) => ({ index: from + index, ...cue })), ...(next < cues.length ? { next } : {}) };
  }

  /** Transcribes a kept recording on this computer, or with the hosted service chosen for voice when its policy allows. */
  transcribe(sessionId: string, p: { artifactId: unknown; versionId?: unknown }) {
    const session = this.core.store.session(sessionId);
    if (session.temporary) throw new Error('Transcribing creates files. Use a saved conversation.');
    const version = this.media(sessionId, p.artifactId, p.versionId);
    const settings = this.core.settings.transcription as { provider?: string } | undefined;
    if (isHostedSpeech(settings?.provider) && !routeAllowed('cloud', version.policy)) throw new Error(`${version.name} may only be processed on this computer. Choose local transcription in Settings › Voice, or allow cloud processing for this file.`);
    const status = this.core.transcription.status();
    if (status.state === 'unavailable') throw new Error('Set up transcription in Settings › Voice first');
    if (status.state === 'recording' || status.state === 'transcribing') throw new Error('Voice input is busy. Finish or cancel it first.');
    return this.run(sessionId, 'extraction', `Transcribe ${version.name}`, [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'transcription-source' }], { sha256: version.sha256 }, async (_operation, signal) => {
      const abort = () => void this.core.transcription.cancel();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await this.core.transcription.importFile({ sessionId, path: this.files.objectPath(version.sha256), name: version.name });
        signal.throwIfAborted();
        const transcript = await this.installTranscript(sessionId, { vtt: result.vtt, text: result.text, source: { name: version.name, sha256: version.sha256, durationSeconds: result.source?.durationSeconds ?? null, truncated: !!result.source?.truncated }, recording: version, hosted: isHostedSpeech(settings?.provider) ? settings!.provider! : '' });
        return { results: [{ artifactId: transcript.artifactId, versionId: transcript.versionId, purpose: 'transcript' }], details: { durationSeconds: result.source?.durationSeconds ?? null, truncated: !!result.source?.truncated, timed: !!result.vtt } };
      } finally { signal.removeEventListener('abort', abort); }
    }, 'transcription');
  }
  /** A transcript file of this conversation, linked to its recording when that was kept. */
  installTranscript(sessionId: string, p: { vtt?: string; text?: string; source: { name: string; sha256: string; durationSeconds: number | null; truncated: boolean }; recording?: ArtifactVersion; hosted?: string }) {
    const base = (p.source.name || 'recording').replace(/\.[^.]+$/, '');
    return this.files.install({ sessionId, bytes: Buffer.from(p.vtt || p.text || ''), name: `${base} (transcript).${p.vtt ? 'vtt' : 'txt'}`, mime: p.vtt ? 'text/vtt' : 'text/plain', source: 'derived', label: 'transcript',
      ...(p.recording ? { policy: p.recording.policy, parents: [{ artifactId: p.recording.artifactId, versionId: p.recording.versionId, relation: 'transcript' }] } : {}),
      provenance: { kind: 'transcription', engine: p.hosted || 'whisper.cpp', source: p.source.name, sha256: p.source.sha256, durationSeconds: p.source.durationSeconds, truncated: p.source.truncated } });
  }
  /** Corrections are a new version; the transcript they started from stays. An empty text removes that line. */
  async correct(sessionId: string, p: { artifactId: unknown; versionId: unknown; edits: unknown }) {
    const { version, cues } = await this.cuesOf(sessionId, p.artifactId, p.versionId);
    if (this.files.artifact(version.artifactId).latestVersionId !== version.versionId) throw Object.assign(new Error('This transcript changed since you opened it. Reload it and apply your corrections again.'), { code: 'REVISION_CONFLICT' });
    if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > recordingLimits.edits) throw new Error(`Correct 1–${recordingLimits.edits} lines at a time`);
    const changed = new Map<number, Cue | undefined>();
    for (const edit of p.edits as any[]) {
      const index = Number(edit?.index);
      if (!Number.isInteger(index) || !cues[index] || changed.has(index)) throw new Error('A correction names a line that is not in this transcript');
      if (typeof edit.text !== 'string' || edit.text.length > recordingLimits.cueChars) throw new Error('A line can have up to 2,000 characters');
      const text = cueText(edit.text), speaker = edit.speaker === undefined ? cues[index].speaker : typeof edit.speaker === 'string' ? edit.speaker.replace(/[\x00-\x1f<>]/g, ' ').trim().slice(0, 80) : undefined;
      changed.set(index, text ? { start: cues[index].start, end: cues[index].end, text, ...(speaker ? { speaker } : {}) } : undefined);
    }
    const next = cues.flatMap((cue, index) => changed.has(index) ? changed.get(index) ? [changed.get(index)!] : [] : [cue]);
    if (!next.length) throw new Error('A transcript keeps at least one line');
    if (JSON.stringify(next) === JSON.stringify(cues)) throw new Error('Nothing changed');
    const body = /\.srt$/i.test(version.name) || version.mime === 'application/x-subrip' ? formatSrt(next) : formatVtt(next);
    const { engine, source, sha256, durationSeconds, truncated, language } = version.provenance as Record<string, any>;
    const saved = await this.files.install({ sessionId, artifactId: version.artifactId, bytes: Buffer.from(body), name: version.name, mime: version.mime, source: 'derived', label: 'transcript', policy: version.policy,
      parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'correction' }],
      provenance: { kind: 'transcript-correction', base: version.versionId, edited: changed.size, ...(engine ? { engine } : {}), ...(source ? { source } : {}), ...(sha256 ? { sha256 } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(truncated ? { truncated } : {}), ...(language ? { language } : {}) } });
    return this.page(sessionId, { artifactId: saved.artifactId, versionId: saved.versionId, limit: recordingLimits.page });
  }
  /** A subtitle file, whole or for one part; a part's times start at zero when it goes with a clip. */
  async subtitles(sessionId: string, p: { artifactId: unknown; versionId?: unknown; format: unknown; start?: unknown; end?: unknown; fromZero?: unknown }) {
    if (p.format !== 'srt' && p.format !== 'vtt') throw new Error('Choose SRT or WebVTT');
    const { version, cues } = await this.cuesOf(sessionId, p.artifactId, p.versionId);
    const part = p.start !== undefined || p.end !== undefined, start = part ? bound(p.start ?? 0, 'The start') : 0, end = part ? bound(p.end, 'The end') : Infinity;
    if (end <= start) throw new Error('Choose a part that ends after it starts');
    const chosen = part ? within(cues, start, end) : cues;
    if (!chosen.length) throw new Error('There is no text in that part');
    const shift = part && p.fromZero === true ? start : 0;
    const rows = chosen.map(cue => ({ ...cue, start: Math.max(0, Math.max(cue.start, part ? start : 0) - shift), end: Math.min(cue.end, end) - shift }));
    const name = version.name.replace(/\.(vtt|srt)$/i, '') + (part ? ` ${spanLabel(start, end).replaceAll(':', '.')}` : '') + '.' + p.format;
    return this.files.install({ sessionId, bytes: Buffer.from(p.format === 'srt' ? formatSrt(rows) : formatVtt(rows)), name, mime: p.format === 'srt' ? 'application/x-subrip' : 'text/vtt', source: 'derived', label: 'subtitles', policy: version.policy,
      parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: part ? 'excerpt' : 'subtitles' }], provenance: { kind: 'subtitles', format: p.format, source: version.name, ...(part ? { start, end } : {}) } });
  }
  /** Cuts one part into a new file. Nothing is re-used or overwritten; asking twice makes two clips. */
  async clip(sessionId: string, p: { artifactId: unknown; versionId?: unknown; start: unknown; end: unknown; transcript?: Ref }) {
    if (this.core.store.session(sessionId).temporary) throw new Error('Clips are files. Use a saved conversation.');
    const version = this.media(sessionId, p.artifactId, p.versionId), start = bound(p.start, 'The start'), end = bound(p.end, 'The end');
    if (end - start < 0.1) throw new Error('Choose a part that ends after it starts');
    if (end - start > recordingLimits.clipSeconds) throw new Error('A clip can be up to 15 minutes long');
    if (!this.ffmpeg) throw new Error('Making clips needs ffmpeg. Install the ffmpeg package.');
    const captions = p.transcript ? await this.cuesOf(sessionId, p.transcript.artifactId, p.transcript.versionId) : undefined;
    const label = spanLabel(start, end);
    return this.run(sessionId, 'export', `Clip ${version.name} ${label}`, [{ artifactId: version.artifactId, versionId: version.versionId, purpose: 'clip-source' }], { sha256: version.sha256, start, end }, async (operation, signal) => {
      const cut = await this.cut(version, start, end, signal);
      signal.throwIfAborted();
      const base = safeName(version.name.replace(/\.[^.]+$/, ''), 'recording');
      const clip = await this.files.install({ sessionId, operationId: operation.id, bytes: cut.bytes, name: `${base} ${label.replaceAll(':', '.')}.${cut.extension}`, mime: cut.mime, source: 'derived', label: 'clip', policy: version.policy,
        parents: [{ artifactId: version.artifactId, versionId: version.versionId, relation: 'clip' }], provenance: { kind: 'clip', start, end, source: version.name, method: cut.method } });
      const results: ArtifactRef[] = [{ artifactId: clip.artifactId, versionId: clip.versionId, purpose: 'clip' }];
      const rows = captions ? within(captions.cues, start, end).map(cue => ({ ...cue, start: Math.max(0, cue.start - start), end: Math.min(cue.end, end) - start })) : [];
      if (rows.length) {
        const text = await this.files.install({ sessionId, operationId: operation.id, bytes: Buffer.from(formatVtt(rows)), name: `${base} ${label.replaceAll(':', '.')} (transcript).vtt`, mime: 'text/vtt', source: 'derived', label: 'transcript', policy: captions!.version.policy,
          parents: [{ artifactId: clip.artifactId, versionId: clip.versionId, relation: 'transcript' }, { artifactId: captions!.version.artifactId, versionId: captions!.version.versionId, relation: 'excerpt' }],
          provenance: { kind: 'transcription', engine: String(captions!.version.provenance.engine || ''), source: clip.name, sha256: clip.sha256, durationSeconds: Math.round(end - start), truncated: false } });
        results.push({ artifactId: text.artifactId, versionId: text.versionId, purpose: 'transcript' });
      }
      return { results, details: { method: cut.method, start, end } };
    }, 'extraction');
  }
  private async cut(version: ArtifactVersion, start: number, end: number, signal: AbortSignal): Promise<{ bytes: Buffer; extension: string; mime: string; method: string }> {
    await this.files.bytes(version.sessionId, version.artifactId, version.versionId);
    const source = this.files.objectPath(version.sha256), video = version.mime.startsWith('video/');
    const audio = media[version.mime] || { extension: 'flac', codec: ['-c:a', 'flac'], method: 'encode' as const };
    const plans: { extension: string; mime: string; method: string; args: string[] }[] = video ? [
      { extension: 'mp4', mime: 'video/mp4', method: 'exact', args: ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'] },
      // Without an H.264 encoder the streams are copied, so the clip starts at the nearest earlier key frame.
      { extension: 'mp4', mime: 'video/mp4', method: 'keyframe', args: ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart'] },
    ] : [{ extension: audio.extension, mime: audio.extension === 'flac' ? 'audio/flac' : version.mime, method: audio.method === 'copy' ? 'exact' : 'encoded', args: ['-map', '0:a:0', ...audio.codec] }];
    let problem = '';
    for (const plan of plans) {
      const common = (input: string, output: string) => [this.ffmpeg!, '-nostdin', '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-threads', '2', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input, '-t', String(end - start), '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-threads', '2', ...plan.args, '-y', output];
      const name = 'clip.' + plan.extension;
      const result = await this.exec(source, common, name, signal);
      // A container without anything in it is not a clip: ffmpeg reports how much it wrote.
      if (result.bytes?.length && result.written) return { bytes: result.bytes, extension: plan.extension, mime: plan.mime, method: plan.method };
      problem = result.problem || 'there is nothing in that part';
      if (result.ended) break;
    }
    throw new Error(`The clip could not be made: ${problem.slice(0, 300)}`);
  }
  private async exec(source: string, argv: (input: string, output: string) => string[], name: string, signal: AbortSignal): Promise<{ bytes?: Buffer; written?: boolean; problem?: string; ended?: boolean }> {
    const written = (progress: string) => Number(/out_time_us=(\d+)\s+(?:(?!out_time_us)[\s\S])*$/.exec(progress)?.[1] || 0) > 0;
    if ((await isolation()).available) {
      const result = await sandboxed({ argv: argv('/work/input', '/work/output/' + name), binds: [{ source, target: '/work/input' }], cwd: '/work', limits: { wallMs: recordingLimits.clipWallMs, outputBytes: recordingLimits.clipBytes, processes: 64, files: 1 }, signal });
      signal.throwIfAborted();
      if (result.timedOut) return { problem: 'it took too long', ended: true };
      if (result.outputProblem) return { problem: result.outputProblem, ended: true };
      return result.exitCode === 0 ? { bytes: result.outputs[0]?.bytes, written: written(result.stdout) } : { problem: result.stderr.trim().split('\n').slice(-1)[0] };
    }
    const directory = await mkdtemp(join(privateDir(join(this.core.store.directory, 'clips')), 'clip-'));
    try {
      const command = argv(source, join(directory, name));
      let progress = '';
      const problem = await new Promise<string>(resolve => execFile(command[0], command.slice(1), { timeout: recordingLimits.clipWallMs, maxBuffer: 1024 * 1024, signal, env: { PATH: '/usr/bin', LANG: 'C.UTF-8' } }, (error, out, stderr) => { progress = String(out); resolve(error ? String(stderr).trim().split('\n').slice(-1)[0] || error.message : ''); }));
      signal.throwIfAborted();
      if (problem) return { problem };
      const bytes = await readFile(join(directory, name));
      return bytes.length > recordingLimits.clipBytes ? { problem: 'it is larger than 100 MiB', ended: true } : { bytes, written: written(progress) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  /** Local work as an operation: listed while it runs, cancellable, and its outcome kept. */
  private run(sessionId: string, kind: 'export' | 'extraction', label: string, inputs: ArtifactRef[], witness: Record<string, unknown>, work: (operation: Operation, signal: AbortSignal) => Promise<{ results: ArtifactRef[]; details?: Record<string, unknown> }>, job: 'transcription' | 'extraction'): Operation {
    const operations = this.workbench.operations;
    let operation = operations.create({ sessionId, kind, origin: 'user', label: label.slice(0, 200), payloadDigest: OperationStore.digest([label, inputs, witness]), witness, inputs, details: {} });
    const controller = new AbortController();
    this.workbench.runControllers.set(operation.id, controller);
    const listed = this.core.jobs.add(job, label, () => { void this.workbench.cancelRun(operation.id); });
    operation = operations.transition(operations.transition(operation.id, 'queued').id, 'running');
    void this.workbench.track((async () => {
      try {
        const outcome = await work(operation, controller.signal);
        operations.transition(operation.id, 'completed', { results: outcome.results, details: { ...operations.get(operation.id).details, ...(outcome.details || {}) } });
      } catch (error: any) {
        const current = operations.get(operation.id);
        if (['running', 'cancel_requested'].includes(current.state)) operations.transition(operation.id, controller.signal.aborted ? current.state === 'cancel_requested' ? 'cancelled' : 'interrupted' : 'failed', { error: { code: String(error?.code || 'failed').slice(0, 60), message: String(error?.message || error).slice(0, 500) } });
      } finally { listed(); this.workbench.runControllers.delete(operation.id); if (!this.core.closed) this.core.changed(); }
    })()).catch(() => {});
    return operation;
  }
}
