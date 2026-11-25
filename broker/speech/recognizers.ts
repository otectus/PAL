/**
 * M10: what turns a recording into words. A recognizer is given one 16 kHz WAV file that PAL made and owns, and returns
 * the words, with times when it has them. It never sees a conversation, sends nothing by itself, and what it returns is
 * shown for review like any other transcript. Three kinds exist: a program run for each recording (whisper.cpp), a
 * server on this computer that keeps its model loaded, and the hosted speech services.
 */
import { spawn } from 'node:child_process';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { responseJson } from '../provider-http.ts';
import { isHostedSpeech, type HostedSpeechProvider, type HostedVoice } from '../hosted-speech.ts';
import type { HostedTranscript, TranscriptSpan } from './contracts.ts';
import type { TranscriptionSettings } from '../transcription.ts';
import { background, waitForClose } from './process.ts';

export type RecognitionJob = { wav: string; directory: string; signal: AbortSignal; limitMs: number; /** Dictation, which is waited for; a file is background work. */ interactive: boolean; env: NodeJS.ProcessEnv };
export type Recognition = { text: string; vtt?: string };
export interface Recognizer {
  /** As named in an error. */
  name: string;
  /** Whether enough is set up to offer voice input. */
  configured(settings: TranscriptionSettings): boolean;
  /** Checks what it needs before a recording starts, and returns the recognition itself. */
  prepare(settings: TranscriptionSettings): Promise<(job: RecognitionJob) => Promise<Recognition>>;
}
export type HostedTranscribe = (provider: HostedSpeechProvider, settings: HostedVoice, wav: Buffer, signal: AbortSignal) => Promise<string | HostedTranscript>;

const stamp = (seconds: number) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
const cues = (segments: TranscriptSpan[]) => 'WEBVTT\n\n' + segments.map(span => stamp(span.start) + ' --> ' + stamp(span.end) + '\n' + span.text.replaceAll('-->', '→')).join('\n\n') + '\n';

async function localFile(value: unknown, executable: boolean, label: string) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error(`Configure an absolute local ${label} path`);
  const path = await realpath(value);
  if (!(await stat(path)).isFile()) throw new Error(`The configured ${label} is not a file`);
  if (executable) await access(path, constants.X_OK);
  return path;
}
/** whisper.cpp's command, started for each recording. */
export const whisperProgram: Recognizer = {
  name: 'whisper.cpp',
  configured: settings => typeof settings?.executable === 'string' && !!settings.executable.trim() && typeof settings?.model === 'string' && !!settings.model.trim(),
  async prepare(settings) {
    const executable = await localFile(settings?.executable, true, 'whisper.cpp executable'), model = await localFile(settings?.model, false, 'whisper.cpp model');
    return async job => {
      const prefix = join(job.directory, 'transcript');
      const child = spawn(executable, ['-m', model, '-f', job.wav, '--output-txt', '--output-vtt', '--output-file', prefix, '--no-timestamps'], { env: job.env, stdio: ['ignore', 'ignore', 'pipe'] });
      // A04: transcribing a file is background work; dictation keeps normal priority.
      if (!job.interactive) background(child);
      let stderr = '', killTimer: NodeJS.Timeout | undefined;
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
      const closed = waitForClose(child);
      const terminate = () => { child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
      job.signal.addEventListener('abort', terminate, { once: true });
      const timeout = setTimeout(terminate, job.limitMs); timeout.unref();
      try {
        const code = await closed;
        if (job.signal.aborted) throw job.signal.reason;
        if (code !== 0) throw new Error(`whisper.cpp failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw new Error(`Could not start whisper.cpp: ${error.message}`);
        throw error;
      } finally {
        clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
        job.signal.removeEventListener('abort', terminate);
      }
      // Segment timestamps, when whisper.cpp wrote them; the plain text stays the draft.
      return { text: await readFile(prefix + '.txt', 'utf8'), vtt: await readFile(prefix + '.vtt', 'utf8').catch(() => '') };
    };
  },
};

/**
 * A speech server on this computer. Its address has to be a loopback one: a recording never leaves the computer through
 * a setting that says it is local. An address that ends in /v1 speaks the OpenAI-compatible form, any other one
 * whisper.cpp's own server (`whisper-server`).
 */
export function speechServerAddress(value: unknown): URL {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch { throw new Error('Enter the speech server’s address, such as http://127.0.0.1:8080'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('A local speech server has to be on this computer (127.0.0.1 or localhost)');
  if (url.username || url.password || url.search || url.hash || url.href.length > 200) throw new Error('Enter the speech server’s address only, without a name, password or query');
  return url;
}
const compatible = (url: URL) => /\/v1\/?$/.test(url.pathname);
const under = (url: URL, path: string) => new URL(url.pathname.replace(/\/+$/, '') + path, url);
export const whisperServer: Recognizer = {
  name: 'The local speech server',
  configured: settings => { try { speechServerAddress(settings?.serverUrl); return true; } catch { return false; } },
  async prepare(settings) {
    const url = speechServerAddress(settings.serverUrl), model = settings.serverModel || '', language = settings.language || '', prompt = settings.prompt || '';
    return async job => {
      const signal = AbortSignal.any([job.signal, AbortSignal.timeout(job.limitMs)]), form = new FormData();
      form.append('file', new Blob([new Uint8Array(await readFile(job.wav))], { type: 'audio/wav' }), 'recording.wav');
      form.append('response_format', 'verbose_json'); form.append('temperature', '0');
      if (compatible(url)) { form.append('model', model || 'whisper-1'); form.append('timestamp_granularities[]', 'segment'); }
      if (language) form.append('language', language.split('-')[0]);
      if (prompt) form.append('prompt', prompt);
      let data: any;
      try { data = await responseJson(await fetch(under(url, compatible(url) ? '/audio/transcriptions' : '/inference'), { method: 'POST', body: form, signal, redirect: 'error' }), 4 * 1024 * 1024); }
      catch (error: any) {
        if (job.signal.aborted) throw job.signal.reason;
        if (signal.aborted) throw new Error('The local speech server took too long');
        // A request that never reached a server, as opposed to one whose answer was refused.
        throw new Error(error?.message === 'fetch failed' && !/redirect/i.test(String(error.cause?.message)) ? `The local speech server at ${url.host} does not answer. Start it, or choose another way to transcribe.` : 'The local speech server could not transcribe this: ' + String(error?.message || 'it failed').slice(0, 200));
      }
      const text = typeof data?.text === 'string' ? data.text : '';
      const segments: TranscriptSpan[] = (Array.isArray(data?.segments) ? data.segments.slice(0, 10_000) : []).flatMap((entry: any) => typeof entry?.text === 'string' && entry.text.trim() && Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.start >= 0 && entry.end >= entry.start ? [{ text: entry.text.trim(), start: entry.start, end: entry.end }] : []);
      return { text, ...(segments.length ? { vtt: cues(segments) } : {}) };
    };
  },
};
/** Whether a local server answers at all, without sending it any audio. */
export async function checkSpeechServer(value: unknown, signal = AbortSignal.timeout(4000)): Promise<{ answers: boolean; detail: string }> {
  const url = speechServerAddress(value);
  try {
    const response = await fetch(compatible(url) ? under(url, '/models') : url, { signal, redirect: 'manual' }); await response.body?.cancel().catch(() => {});
    return response.status < 500 ? { answers: true, detail: compatible(url) ? 'It answers (OpenAI-compatible).' : 'It answers (whisper.cpp server).' } : { answers: false, detail: `It answered with an error (${response.status}).` };
  } catch { return { answers: false, detail: 'Nothing answers at this address.' }; }
}

/** The models an OpenAI-compatible server on this computer lists. whisper.cpp's own server has one model and no list. */
export async function speechServerModels(value: unknown, send: typeof fetch = fetch, signal = AbortSignal.timeout(4000)): Promise<string[]> {
  const url = speechServerAddress(value);
  if (!compatible(url)) return [];
  let data: any;
  try { data = await responseJson(await send(under(url, '/models'), { signal, redirect: 'error' }), 1024 * 1024); } catch { throw new Error('The speech server did not list its models'); }
  const rows: unknown[] = Array.isArray(data?.data) ? data.data : [];
  return [...new Set(rows.map((row: any) => row?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160))].slice(0, 200);
}

/** The account the person chose, with its own limits. */
export const hostedRecognizer = (transcribe: HostedTranscribe | undefined): Recognizer => ({
  name: 'The hosted speech service',
  configured: () => !!transcribe,
  async prepare(settings) {
    return async job => {
      if (!transcribe || (await stat(job.wav)).size > 24 * 1024 * 1024) throw new Error('Hosted transcription accepts up to 24 MiB of audio');
      const result = await transcribe(settings.provider as HostedSpeechProvider, { model: settings.cloudModel, language: settings.language, region: settings.region, connectionId: settings.connectionId, prompt: settings.prompt, timestampGranularities: settings.timestampGranularities }, await readFile(job.wav), AbortSignal.any([job.signal, AbortSignal.timeout(job.limitMs)]));
      return typeof result === 'string' ? { text: result } : { text: result.text, ...(result.segments?.length ? { vtt: cues(result.segments) } : {}) };
    };
  },
});
export function recognizerFor(settings: TranscriptionSettings, transcribe?: HostedTranscribe): Recognizer {
  return settings?.provider === 'local-server' ? whisperServer : isHostedSpeech(settings?.provider) ? hostedRecognizer(transcribe) : whisperProgram;
}
