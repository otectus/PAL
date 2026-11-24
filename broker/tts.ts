import type { HostedSpeechProvider } from './hosted-speech.ts';
import { proseLines } from './markdown-prose.ts';
import type { Provider } from './types.ts';
import type { ElevenLabs } from './elevenlabs.ts';
import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.ts';
import { stripMemoryCitations } from './citations.ts';
import type { IndexTTS } from './indextts.ts';
import type { Emotion } from './indextts-config.ts';
import { audioSelection, chosenDevice, playbackArgs } from './audio-devices.ts';
import { Readable } from 'node:stream';
import { speechKey, type CachedSpeech, type SpeechCache, type SpeechFacts, type SpeechSource } from './speech-cache.ts';

export const defaultVoice = 'en_US-amy-medium';
export const ttsTestLine = "Hello, I'm PAL. Local voice is ready. Let's make a little trouble.";
export function voiceTestLine(name: string) { return ttsTestLine.replace("I'm PAL.", () => `I'm ${name}.`); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type Voice = { id: string; model: string; config: string; sampleRate: number; language: string; backend?: 'kokoro'; runtime?: string; nativeVoice?: string };
type SpeechSettings = { voice: string; speechEnabled: boolean; quiet: boolean; speechProviders?:Partial<Record<Provider,boolean>>; speechRate?: number; speechPitch?: number; speechVolume?: number; ttsProvider?:'local'|'indextts'|'elevenlabs'|HostedSpeechProvider };
type IndexOverrides={profileId?:string;language?:string;emotion?:Emotion;durationFactor?:number};
export type VoiceTuning = { pitch: number; volume: number };
const defaultTuning: VoiceTuning = { pitch: 0, volume: 1 };
type SpeechState = { state: 'idle' | 'preparing' | 'speaking' | 'error'; backend: string; voice: string; error: string; fallback: string; replyId?: string };

export function validateVoice(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Choose a local voice name, without a path or extension');
  return value;
}

export function kokoroManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || join(homedir(), '.local/share');
  const current = join(data, 'pal/kokoro/manifest.json'), legacy = join(data, 'cere/kokoro/manifest.json');
  return resolve(env.PAL_KOKORO_MANIFEST || env.CERE_KOKORO_MANIFEST || (existsSync(current) || !existsSync(legacy) ? current : legacy));
}

const kokoroVoiceNames = new Set(['af_heart','af_bella']);
async function resolveKokoroVoice(id:string, manifestPath:string):Promise<Voice> {
  const nativeVoice=id.slice('kokoro-'.length);
  if(!kokoroVoiceNames.has(nativeVoice))throw new Error(`Kokoro voice ${id} is not supported`);
  let manifest:any;
  try {
    if((await stat(manifestPath)).size>64*1024)throw new Error('manifest is oversized');
    manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  } catch(error:any) {
    if(error.code==='ENOENT')throw new Error(`Kokoro voice ${id} is not installed. Run tools/setup-kokoro.py first`);
    throw new Error(`Kokoro has an invalid runtime manifest at ${manifestPath}`);
  }
  if(manifest?.version!==1||!Array.isArray(manifest.voices)||!manifest.voices.includes(nativeVoice))throw new Error(`Kokoro voice ${id} is not enabled by ${manifestPath}`);
  for(const key of ['python','model','voiceData'] as const)if(typeof manifest[key]!=='string'||!isAbsolute(manifest[key]))throw new Error(`Kokoro manifest ${key} must be an absolute path`);
  try {
    await access(manifest.python,constants.X_OK);
    if(!(await stat(manifest.model)).isFile()||!(await stat(manifest.voiceData)).isFile())throw new Error();
  } catch { throw new Error(`Kokoro runtime files referenced by ${manifestPath} are unavailable`); }
  return {id,backend:'kokoro',runtime:manifest.python,nativeVoice,model:manifest.model,config:manifest.voiceData,sampleRate:24000,language:'en_US'};
}

export function voiceDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.PAL_VOICES_DIR || env.CERE_VOICES_DIR) return [resolve(env.PAL_VOICES_DIR || env.CERE_VOICES_DIR!)];
  const config = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return [...new Set([join(paths().config, 'voices'), join(config, 'pal/voices'), join(config, 'cere/voices')]), join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'piper/voices'),
    join(root, 'voices'), join(root, 'tts/voices'), join(root, 'build/tts/voices')];
}

export async function resolveVoice(id: string, directories = voiceDirectories(), manifestPath = kokoroManifestPath()): Promise<Voice> {
  validateVoice(id);
  if(id.startsWith('kokoro-'))return resolveKokoroVoice(id,manifestPath);
  for (const directory of directories) {
    const model = join(directory, id + '.onnx');
    try { if (!(await stat(model)).isFile()) continue; }
    catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    // A broken override is an actionable error, not permission to use a different voice.
    let config = model + '.json';
    try { await access(config); } catch { config = join(directory, id + '.json'); }
    let metadata: any;
    try {
      if ((await stat(config)).size > 1024 * 1024) throw new Error('oversized configuration');
      metadata = JSON.parse(await readFile(config, 'utf8'));
    } catch { throw new Error(`Voice ${id} needs a valid .onnx.json or .json companion file in ${directory}`); }
    const sampleRate = metadata.audio?.sample_rate;
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error(`Voice ${id} has an invalid audio.sample_rate`);
    const language = typeof metadata.language?.code === 'string' && /^[a-zA-Z_-]{2,32}$/.test(metadata.language.code) ? metadata.language.code : 'en_US';
    return { id, model, config, sampleRate, language };
  }
  throw new Error(`Piper voice ${id} was not found. Add its .onnx and .onnx.json files to ${directories[0]}`);
}

export async function listVoices(directories = voiceDirectories(), manifestPath:string|null = kokoroManifestPath()): Promise<Voice[]> {
  const names = new Set<string>();
  for (const directory of directories) {
    for (const name of await readdir(directory).catch(() => [])) if (name.endsWith('.onnx')) names.add(name.slice(0, -5));
  }
  const voices: Voice[] = [];
  for (const name of [...names].sort()) {
    try { voices.push(await resolveVoice(name, directories)); } catch { /* Incomplete drops are not selectable. */ }
  }
  if(manifestPath)for(const name of kokoroVoiceNames)try{voices.push(await resolveKokoroVoice('kokoro-'+name,manifestPath));}catch{/* An incomplete optional runtime is not selectable. */}
  return voices;
}

/** Read prose, not fenced code, markdown syntax, memory citations, or link destinations. Bound playback. */
export function speechText(text: string): string {
  const prose: string[] = [];
  let size = 0;
  for (const line of proseLines(stripMemoryCitations(text.slice(0, 100000)))) {
    prose.push(line);
    size += line.length + 1;
    if (size >= 16000) break;
  }
  return prose.join('\n').slice(0, 16000)
    .replace(/!\[[^\]]{0,512}\]\([^\n)]{0,2048}\)/g, ' ')
    .replace(/\[([^\]]{1,512})\]\([^\n)]{0,2048}\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]{1,512}>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[`*_~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
}

type ChildResult = { code: number | null; stdout: string; timedOut: boolean };
/** Own every subprocess; a stopped utterance cannot leave Piper/aplay running. */
function child(command: string, args: string[], options: {
  env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string; timeout: number; line?: (line: string) => void;
}): Promise<ChildResult> {
  options.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const proc = spawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '', pending = '', timedOut = false, killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      proc.kill('SIGTERM');
      killTimer ||= setTimeout(() => proc.kill('SIGKILL'), 750);
      killTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeout);
    timeout.unref();
    options.signal.addEventListener('abort', terminate, { once: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (data: string) => {
      stdout = (stdout + data).slice(-16384);
      pending += data;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { options.line?.(pending.slice(0, end)); pending = pending.slice(end + 1); }
      pending = pending.slice(-16384);
    });
    // Broken pipes are expected if a dependency exits before reading its input.
    proc.stdin.on('error', () => {});
    proc.stdin.end(options.input || '');
    let spawnError: Error | undefined;
    proc.on('error', error => { spawnError = error; });
    proc.on('close', code => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', terminate);
      if (options.signal.aborted) reject(options.signal.reason);
      else if (spawnError) reject(new Error(`Could not start ${command}: ${spawnError.message}`));
      else resolveResult({ code, stdout, timedOut });
    });
  });
}

export async function piperExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.PAL_PIPER_BIN || env.CERE_PIPER_BIN) return env.PAL_PIPER_BIN || env.CERE_PIPER_BIN!;
  for (const path of [join(root, 'tts/piper/piper'), join(root, 'build/tts/piper/piper')]) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try installed Piper. */ }
  }
  return 'piper';
}

/** Local raw PCM stays in pipes: synthesizer -> optional tuning -> player.
 * Every child belongs to this utterance and is reaped before the next begins. */
async function playLocal(command: string, args: string[], input: string, name: string, voice: Voice,
  signal: AbortSignal, env: NodeJS.ProcessEnv, tuning: VoiceTuning, cached?: CachedSpeech): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((done, reject) => {
    // Kept audio (M11) takes the synthesizer's place; what follows it is the same either way.
    const synth = cached?.hit ? undefined : spawn(command, args, {env, stdio:['pipe','pipe','pipe']});
    const source = synth ? synth.stdout : Readable.from(cached!.through(voice.sampleRate, async function *() {}));
    const format = ['-t','raw','-r',String(voice.sampleRate),'-e','signed-integer','-b','16','-L','-c','1'];
    const adjusted = tuning.pitch !== 0 || tuning.volume !== 1;
    // SoX's pitch effect uses cents and preserves duration. Rate remains the
    // engine's native synthesis control; volume never changes system volume.
    const effects = [...(tuning.pitch ? ['pitch',String(tuning.pitch * 100)] : []),
      ...(tuning.volume !== 1 ? ['vol',String(tuning.volume)] : [])];
    const filter = adjusted ? spawn(env.PAL_SOX_BIN || env.CERE_SOX_BIN || 'sox', ['-q','-D',...format,'-',...format,'-',...effects], {env,stdio:['pipe','pipe','pipe']}) : undefined;
    const player = spawn(env.PAL_APLAY_BIN || env.CERE_APLAY_BIN || 'aplay', [...playbackArgs(audioSelection().output),'-q','-t','raw','-r',String(voice.sampleRate),'-f','S16_LE','-c','1'], {env,stdio:['pipe','ignore','ignore']});
    const children = [...(synth ? [{proc:synth,label:name}] : []), ...(filter ? [{proc:filter,label:'Voice tuning (SoX)'}] : []), {proc:player,label:'aplay'}];
    let remaining=children.length, failure:Error|undefined, bytes=0, killTimer:NodeJS.Timeout|undefined;
    const terminate = () => {
      if (!synth) source.destroy();
      for (const {proc} of children) proc.kill('SIGTERM');
      killTimer ||= setTimeout(() => { for (const {proc} of children) proc.kill('SIGKILL'); },750);
      killTimer.unref();
    };
    const fail = (error:Error) => { failure ||= error; terminate(); };
    const timeout=setTimeout(() => fail(new Error(`${name} playback timed out`)),15*60*1000);timeout.unref();
    signal.addEventListener('abort',terminate,{once:true});
    // Pipe backpressure bounds memory even if audio output is slower than synthesis.
    if(synth && cached) synth.stdout.on('data', data => cached.add(data));
    if(filter) source.pipe(filter.stdin);
    const output=filter ? filter.stdout : source;
    output.on('data',data => { bytes+=data.length; });output.pipe(player.stdin);
    synth?.stdin.on('error',()=>{});
    filter?.stdin.on('error',()=>fail(new Error('Voice tuning closed before synthesis finished')));
    player.stdin.on('error',()=>fail(new Error('Audio output closed before speech finished')));
    for(const {proc,label} of children){
      let diagnostics='';
      proc.stderr?.setEncoding('utf8');proc.stderr?.on('data',(data:string)=>{diagnostics=(diagnostics+data).slice(-2000);});
      proc.on('error',()=>fail(new Error(proc===filter
        ? 'Voice tuning needs SoX. Install the sox package, or reset pitch and volume.'
        : `${label} is unavailable. Check the local voice runtime and audio dependencies.`)));
      proc.on('close',code=>{
        if(code!==0&&!signal.aborted)fail(new Error(`${label} failed (exit ${code}). ${diagnostics.trim()||'Check the local voice runtime and audio output.'}`));
        if(--remaining)return;
        clearTimeout(timeout);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',terminate);
        if(signal.aborted)reject(signal.reason);
        else if(failure)reject(failure);
        else if(!bytes)reject(new Error(`${name} produced no audio`));
        else { if(synth) cached?.finish(voice.sampleRate); done(); }
      });
    }
    synth?.stdin.end(input);
  });
}

export async function playPiper(text: string, voice: Voice, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, rate = 1, tuning: VoiceTuning = defaultTuning, cached?: CachedSpeech): Promise<void> {
  const executable = await piperExecutable(env);
  const rateArgs = rate === 1 ? [] : ['--length_scale', String(1 / rate)];
  await playLocal(executable, ['--model',voice.model,'--config',voice.config,...rateArgs,'--output_raw'],text+'\n','Piper',voice,signal,env,tuning,cached);
}

export async function playKokoro(text:string,voice:Voice,signal:AbortSignal,env:NodeJS.ProcessEnv=process.env,rate=1,tuning:VoiceTuning=defaultTuning,cached?:CachedSpeech):Promise<void>{
  if(voice.backend!=='kokoro'||!voice.runtime||!voice.nativeVoice)throw new Error('Kokoro voice metadata is incomplete');
  await playLocal(voice.runtime,[join(root,'broker/kokoro-synth.py'),'--model',voice.model,'--voices',voice.config,'--voice',voice.nativeVoice,'--speed',String(rate)],
    JSON.stringify({text})+'\n','Kokoro',voice,signal,env,tuning,cached);
}
/** A replaced voice file is another voice, whatever its name. */
async function localFacts(voice:Voice,rate:number):Promise<SpeechFacts>{
  const file=async(path:string)=>{const info=await stat(path);return `${info.size}:${info.mtimeMs}`;};
  return {engine:voice.backend||'piper',voice:voice.id,model:await file(voice.model),config:await file(voice.config),sampleRate:voice.sampleRate,language:voice.language,rate};
}

export class Speech {
  indextts?:IndexTTS;
  elevenlabs?:ElevenLabs;
  hosted?:(provider:HostedSpeechProvider,text:string,signal:AbortSignal)=>AsyncIterable<Buffer>;
  state: SpeechState = { state: 'idle', backend: '', voice: defaultVoice, error: '', fallback: '' };
  queue: { text: string; voice: string; rate: number; pitch: number; volume: number; sessionId?: string; replyId?: string; provider?:'local'|'indextts'|'elevenlabs'|HostedSpeechProvider; sourceProvider?:Provider; indexOverrides?:IndexOverrides; source?:SpeechSource }[] = [];
  private activeSession?: string;
  private activeProvider?:Provider;
  private controller?: AbortController;
  private running?: Promise<void>;
  private closed = false;
  private settings: () => SpeechSettings;
  private changed: () => void;
  private env: NodeJS.ProcessEnv;
  constructor(settings: () => SpeechSettings, changed = () => {}, env: NodeJS.ProcessEnv = process.env) {
    this.settings = settings; this.changed = changed; this.env = env;
  }
  snapshot() { return { ...this.state, queued: this.queue.length }; }
  /** M11: audio made for saved messages, when the person keeps it. */
  cache?: SpeechCache;
  /** The voice and options a hosted engine would use, so kept audio is never another voice's. */
  hostedFacts?: (provider: HostedSpeechProvider) => SpeechFacts;
  /** EV-02: an utterance's identity, for counting repeats while measurements are on. */
  observed?: (key: string) => void;
  private kept(facts: SpeechFacts | undefined, item: Speech['queue'][number]) {
    if (!facts) return undefined;
    const whole = { ...facts, text: item.text };
    this.observed?.(speechKey({ ...whole, playback: [item.rate, item.pitch, item.volume] }));
    return this.cache?.use(whole, item.source);
  }
  /** M16: time from an utterance starting to its first audio, reported when measurements are on. */
  timing?: (ms: number, outcome: 'ok' | 'failed' | 'stopped', backend: string) => void;
  private utteranceStarted = 0;
  private update(patch: Partial<SpeechState>) {
    if (patch.state === 'preparing') this.utteranceStarted = performance.now();
    else if (this.utteranceStarted && (patch.state === 'speaking' || patch.state === 'error' || patch.state === 'idle')) {
      this.timing?.(performance.now() - this.utteranceStarted, patch.state === 'speaking' ? 'ok' : patch.state === 'error' ? 'failed' : 'stopped', patch.backend || this.state.backend || '');
      this.utteranceStarted = 0;
    }
    this.state = { ...this.state, ...patch };
    if (patch.state === 'idle' || patch.state === 'error') delete this.state.replyId;
    this.changed();
  }
  speak(text: string, test = false, sessionId?: string, replyId?: string, indexOverrides?:IndexOverrides, sourceProvider?:Provider, source?:SpeechSource): boolean {
    const settings = this.settings();
    if (this.closed || (this.env.PAL_TTS_DISABLED || this.env.CERE_TTS_DISABLED) === '1' || settings.speechVolume === 0 || !test && (!settings.speechEnabled || settings.quiet)) return false;
    if(!test&&sourceProvider&&settings.speechProviders?.[sourceProvider]===false)return false;
    // Protect pronunciation annotations from generic markup removal.
    if(settings.ttsProvider==='indextts'||indexOverrides){
      const annotations:string[]=[];
      text=text.replace(/<[^|>\n]+\|[^>\n]+>/gu,m=>{annotations.push(m);return `\uE000${annotations.length-1}\uE001`;});
      text=speechText(text).replace(/\uE000(\d+)\uE001/g,(_,i)=>annotations[Number(i)]||'');
    }else text = speechText(text);
    if (!text) return false;
    if (test) this.stop();
    // Pinned conversations are an explicit subscription. Never evict their
    // replies when several messages arrive while the previous one is speaking.
    const ordinary = this.queue.filter(item => !item.sessionId);
    if (!sessionId && ordinary.length >= 3) this.queue.splice(this.queue.indexOf(ordinary[0]), 1);
    const rate = Number.isFinite(settings.speechRate) && settings.speechRate! >= .5 && settings.speechRate! <= 2 ? settings.speechRate! : 1;
    const pitch = Number.isFinite(settings.speechPitch) && settings.speechPitch! >= -6 && settings.speechPitch! <= 6 ? settings.speechPitch! : 0;
    const volume = Number.isFinite(settings.speechVolume) && settings.speechVolume! >= 0 && settings.speechVolume! <= 1 ? settings.speechVolume! : 1;
    this.queue.push({ text, sourceProvider, voice: settings.voice, rate, pitch, volume, provider:indexOverrides?'indextts':settings.ttsProvider,indexOverrides, ...(source ? {source} : {}), ...(sessionId ? {sessionId,replyId} : {}) });
    this.pump();
    return true;
  }
  private pump() {
    if (this.running || !this.queue.length || this.closed) return;
    this.running = this.run().finally(() => { this.running = undefined; this.pump(); });
  }
  private async run() {
    const item = this.queue.shift()!, controller = this.controller = new AbortController();
    this.activeSession = item.sessionId;this.activeProvider=item.sourceProvider;
    this.update({ state: 'preparing', voice: item.voice, backend: '', error: '', fallback: '', replyId: item.replyId });
    try {
      // M10: a chosen speaker must be connected; otherwise PipeWire would quietly use another one.
      await chosenDevice('output');
      controller.signal.throwIfAborted();
      if(item.provider && !['local','indextts','elevenlabs'].includes(item.provider)){
        const {playProviderPcm}=await import('./elevenlabs.ts');
        const provider=item.provider as HostedSpeechProvider;
        if(!this.hosted)throw new Error('Hosted speech is unavailable');
        this.update({backend:provider});
        const cached=this.kept({engine:provider,...this.hostedFacts?.(provider)},item),make=(signal:AbortSignal)=>this.hosted!(provider,item.text,signal);
        await playProviderPcm(controller.signal,item,()=>this.update({state:'speaking'}),signal=>cached?cached.through(24000,()=>make(signal)):make(signal),this.env);
        this.update({state:'idle'});return;
      }
      if(item.provider==='elevenlabs'){
        if(!this.elevenlabs)throw new Error('ElevenLabs is unavailable');
        this.update({backend:'elevenlabs'});
        await this.elevenlabs.play(item.text,controller.signal,item,()=>this.update({state:'speaking'}),facts=>this.kept(facts,item));
        this.update({state:'idle'});return;
      }
      if(item.provider==='indextts'){
        if(!this.indextts)throw new Error('IndexTTS is unavailable');
        this.update({backend:'indextts'});
        await this.indextts.play(item.text,controller.signal,item,item.indexOverrides,()=>this.update({state:'speaking'}),facts=>this.kept(facts,item));
        this.update({state:'idle'});return;
      }
      const voice = await resolveVoice(item.voice, voiceDirectories(this.env),kokoroManifestPath(this.env));
      controller.signal.throwIfAborted();
      if(voice.backend==='kokoro'){
        this.update({state:'speaking',backend:'kokoro'});
        await playKokoro(item.text,voice,controller.signal,this.env,item.rate,item,this.kept(await localFacts(voice,item.rate),item));
        this.update({state:'idle'});return;
      }
      let accepted = false, fallback = '';
      // Speech Dispatcher cannot be pointed at a device, so a chosen speaker uses PAL's own player.
      const tuned = item.rate !== 1 || item.pitch !== 0 || item.volume !== 1 || !!audioSelection().output;
      if (!tuned) {
        const connect = new AbortController();
        const timeout = setTimeout(() => connect.abort(new Error('Speech Dispatcher did not connect')), 3000); timeout.unref();
        try {
          const result = await child(this.env.PAL_TTS_PYTHON || this.env.CERE_TTS_PYTHON || 'python3', [join(root, 'broker/speechd-client.py')], {
            env: this.env, signal: AbortSignal.any([controller.signal, connect.signal]), timeout: 15 * 60 * 1000,
            input: JSON.stringify({ text: item.text, voice: voice.id }),
            line: line => {
              if (line === 'accepted') { accepted = true; clearTimeout(timeout); this.observed?.(speechKey({ engine: 'speech-dispatcher', voice: voice.id, text: item.text, playback: [item.rate, item.pitch, item.volume] })); this.update({ state: 'speaking', backend: 'speech-dispatcher' }); }
            },
          });
          if (result.code !== 0 || !accepted) throw new Error(result.timedOut ? 'Speech Dispatcher playback timed out' : 'Speech Dispatcher or its PAL Piper module is unavailable');
        } catch (error: any) {
          controller.signal.throwIfAborted();
          // Never replay an utterance that the dispatcher already accepted.
          if (accepted) throw error;
          fallback = error.message;
        } finally { clearTimeout(timeout); }
      }
      if (fallback || tuned) {
        this.update({ state: 'speaking', backend: 'piper', fallback });
        await playPiper(item.text, voice, controller.signal, this.env, item.rate, item, this.kept(await localFacts(voice, item.rate), item));
      }
      this.update({ state: 'idle' });
    } catch (error: any) {
      this.update(controller.signal.aborted ? { state: 'idle' } : { state: 'error', error: error.message || 'Speech playback failed' });
    } finally { this.controller = undefined; this.activeSession = undefined;this.activeProvider=undefined; }
  }
  stopProviders(providers:readonly Provider[]) {
    this.queue=this.queue.filter(item=>!item.sourceProvider||!providers.includes(item.sourceProvider));
    if(this.activeProvider&&providers.includes(this.activeProvider))this.controller?.abort(new Error('Provider speech disabled'));
    this.changed();
  }
  stopSession(sessionId: string) {
    this.queue = this.queue.filter(item => item.sessionId !== sessionId);
    if (this.activeSession === sessionId) this.controller?.abort(new Error('Conversation speech stopped'));
    this.changed();
  }
  stop() { this.queue = []; this.controller?.abort(new Error('Speech stopped')); if (!this.running) this.update({ state: 'idle' }); }
  async idle() { while (this.running) await this.running; }
  async close() { this.closed = true; this.stop(); await this.idle(); }
}
