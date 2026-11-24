import { z } from 'zod';
import type { Core } from './core.ts';
import { responseBytes, responseJson } from './provider-http.ts';
import { resolveProviderEndpoint } from './provider-registry.ts';
import { indexChunks } from './indextts-config.ts';
import { googleCloudTranscribe } from './speech/google-cloud.ts';
import { transport, type HostedTranscript, type HostedTranscriptionOptions, type SpeechTransportInput } from './speech/contracts.ts';
import { wavInfo } from './speech/wav.ts';

export const hostedSpeechProviders=['openai','xai','google','azure_speech','google_cloud','azure_openai','mistral','openrouter'] as const;
export type HostedSpeechProvider=typeof hostedSpeechProviders[number];
const label=z.string().max(128).regex(/^[a-zA-Z0-9._: -]*$/);
const speaker=z.strictObject({speaker:z.string().min(1).max(64).regex(/^[\p{L}\p{N} ._-]+$/u),voice:label,style:z.string().max(256).optional()});
export const voiceSchema=z.strictObject({model:z.string().max(160).regex(/^[a-zA-Z0-9._:/ -]*$/).optional(),voice:label.optional(),language:z.string().regex(/^(?:[a-zA-Z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/).optional(),region:z.string().regex(/^[a-z0-9-]{0,40}$/).optional(),connectionId:z.union([z.uuid(),z.literal('')]).optional(),
  prompt:z.string().max(4096).optional(),timestampGranularities:z.array(z.enum(['word','segment'])).min(1).max(2).refine(value=>new Set(value).size===value.length).optional(),speakers:z.array(speaker).length(2).refine(value=>value[0].speaker!==value[1].speaker,'Speaker names must be distinct').optional()});
export type HostedVoice=z.infer<typeof voiceSchema>;
export function isHostedSpeech(value:unknown): value is HostedSpeechProvider {return hostedSpeechProviders.includes(value as HostedSpeechProvider);}
type Route={url:string;headers:Record<string,string>;deployment?:string};
async function route(core:Core,provider:HostedSpeechProvider,settings:HostedVoice,operation:'in'|'out',runtime=transport(undefined)):Promise<Route> {
  if (provider==='azure_speech') {
    if (!settings.region||!/^[a-z0-9-]{1,40}$/.test(settings.region)) throw new Error('Set the Azure Speech region');
    const key=core.credentials.key(provider);
    if (!key) throw new Error('Add an Azure Speech key');
    return {url:'https://'+settings.region+(operation==='in'?'.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1':'.tts.speech.microsoft.com/cognitiveservices/v1'),headers:{'Ocp-Apim-Subscription-Key':key}};
  }
  if(provider==='google_cloud') {
    let token:string|null|undefined;if(runtime.googleToken)token=await runtime.googleToken();else{const {GoogleAuth}=await import('google-auth-library');token=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getAccessToken();}
    if(!token) throw new Error('Set up Google Cloud Application Default Credentials');
    return {url:operation==='in'?'https://speech.googleapis.com/v1/speech:recognize':'https://texttospeech.googleapis.com/v1/text:synthesize',headers:{Authorization:'Bearer '+token}};
  }
  const access=core.accountAccess(provider,settings.connectionId||undefined),key=access.token?await access.token():access.key();
  if (!key) throw new Error('Configure the selected speech account');
  const selected=access.route?.();
  if(provider==='azure_openai'){
    if(!settings.connectionId||selected?.variant==='legacy'||!selected?.deployment)throw new Error('Choose a named Azure OpenAI v1 audio deployment');
    return {url:resolveProviderEndpoint(provider,selected),deployment:selected.deployment,headers:access.token?{Authorization:'Bearer '+key}:{'api-key':key}};
  }
  return {url:resolveProviderEndpoint(provider,selected),headers:provider==='google'&&!access.token?{'x-goog-api-key':key}:{Authorization:'Bearer '+key}};
}
const xml=(value:string)=>value.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
const xaiRegionalLanguages=new Set(['ar-EG','ar-SA','ar-AE','pt-BR','pt-PT','es-MX','es-ES']);
const xaiLanguage=(value:string|undefined)=>{const language=value||'en';const regional=[...xaiRegionalLanguages].find(entry=>entry.toLowerCase()===language.toLowerCase());return regional||language.split('-')[0].toLowerCase();};
/** Decode the linear PCM WAV returned by recent Gemini TTS models to the playback format. */
export function wavToSpeechPcm(wav:Buffer) {
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid speech WAV');
  let channels=0,rate=0,bits=0,format=0,data:Buffer|undefined;
  for(let offset=12;offset+8<=wav.length;){
    const name=wav.toString('ascii',offset,offset+4),length=wav.readUInt32LE(offset+4),at=offset+8;
    if(length>wav.length-at)throw new Error('Truncated speech WAV');
    if(name==='fmt ' && length>=16){format=wav.readUInt16LE(at);channels=wav.readUInt16LE(at+2);rate=wav.readUInt32LE(at+4);bits=wav.readUInt16LE(at+14);}
    if(name==='data')data=wav.subarray(at,at+length);
    offset=at+length+(length%2);
  }
  const float=format===3&&bits===32,bytesPerSample=float?4:2;
  if(!data?.length||!(float||format===1&&bits===16)||![1,2].includes(channels)||rate<8000||rate>96000||data.length%(channels*bytesPerSample))throw new Error('Unsupported speech WAV format');
  if(!float&&rate===24000&&channels===1)return data;
  const frames=data.length/(bytesPerSample*channels),count=Math.floor(frames*24000/rate);
  if(count>12_000_000)throw new Error('Speech WAV exceeds the playback limit');
  const pcm=Buffer.alloc(count*2);
  const read=(n:number)=>{if(!float)return data!.readInt16LE(n*2);const v=data!.readFloatLE(n*4);if(!Number.isFinite(v))throw new Error('Invalid floating-point speech sample');return Math.max(-32768,Math.min(32767,Math.round(v*32768)));};
  const sample=(i:number)=>channels===1?read(i):(read(i*2)+read(i*2+1))/2;
  for(let n=0;n<count;n++){const position=n*rate/24000,i=Math.floor(position),first=sample(i),second=sample(Math.min(i+1,frames-1));pcm.writeInt16LE(Math.round(first+(second-first)*(position-i)),n*2);}
  return pcm;
}
export async function *synthesize(core:Core,provider:HostedSpeechProvider,settings:HostedVoice,text:string,signal:AbortSignal,input:SpeechTransportInput=fetch) {
  const runtime=transport(input);
  const lang=settings.language||'en-US';
  const pieces=settings.speakers?[text]:indexChunks(text,1000);if(settings.speakers&&(!text.trim()||text.length>10000))throw new Error('Gemini multi-speaker text must contain 1 to 10,000 characters');
  for (const piece of pieces) {
    signal.throwIfAborted();
    const r=await route(core,provider,settings,'out',runtime);
    let url=r.url, body:string, type='application/json';
    if(provider==='mistral'){url+='audio/speech';body=JSON.stringify({model:settings.model||'voxtral-mini-tts-3-0',voice_id:settings.voice||'gb_jane_neutral',input:piece,response_format:'wav'});}
    else if(provider==='openai'||provider==='azure_openai'||provider==='openrouter') {url+='audio/speech';body=JSON.stringify({model:r.deployment||settings.model||(provider==='openrouter'?'openai/gpt-4o-mini-tts':'gpt-4o-mini-tts'),voice:settings.voice||'alloy',input:piece,response_format:'pcm'});}
    else if(provider==='xai') {url+='tts';body=JSON.stringify({text:piece,voice_id:settings.voice||'eve',language:xaiLanguage(settings.language),output_format:{codec:'pcm',sample_rate:24000}});}
    else if(provider==='azure_speech') {type='application/ssml+xml';r.headers['X-Microsoft-OutputFormat']='raw-24khz-16bit-mono-pcm';body='<speak version="1.0" xml:lang="'+xml(lang)+'"><voice name="'+xml(settings.voice||'en-US-JennyNeural')+'">'+xml(piece)+'</voice></speak>';}
    else if(provider==='google_cloud') body=JSON.stringify({input:{text:piece},voice:{languageCode:lang,name:settings.voice||undefined},audioConfig:{audioEncoding:'LINEAR16',sampleRateHertz:24000}});
    else {url+='interactions';const content=settings.speakers?piece.split(/\r?\n/).filter(Boolean).map(line=>{const match=/^([^:]{1,64}):\s*(.+)$/.exec(line);if(!match)throw new Error('Write each Gemini dialogue turn as “Speaker: words” on its own line');const configured=settings.speakers!.find(entry=>entry.speaker===match[1].trim());if(!configured)throw new Error('Every Gemini dialogue turn must use a configured speaker');return{type:'text',text:match[2],annotations:[{type:'speech_metadata',speaker:configured.speaker,...(configured.style?{style:configured.style}:{})}]};}):[{type:'text',text:piece}];if(settings.speakers&&content.length<2)throw new Error('Gemini multi-speaker synthesis needs at least two dialogue turns');body=JSON.stringify({model:settings.model||'gemini-3.8-flash-lite-tts',input:[{type:'user_input',content}],response_format:{type:'audio'},generation_config:{speech_config:settings.speakers?{speakers:settings.speakers.map(({speaker,voice})=>({speaker,voice}))}:[{voice:settings.voice||'Kore'}]}});}
    const res=await runtime.fetch(url,{method:'POST',redirect:'error',signal,headers:{...r.headers,'Content-Type':type},body});
    let pcm:Buffer;
    if (provider==='google' || provider==='google_cloud'||provider==='mistral') {
      const data=await responseJson(res,24*1024*1024);
      const audio=provider==='mistral'?data.audio_data:data.output_audio?.data;
      pcm=Buffer.from(provider==='google_cloud'?data.audioContent||'':audio||'','base64');
    } else {
      if(res.ok && !/^(audio\/|application\/octet-stream)/i.test(res.headers.get('content-type')||'')) {await res.body?.cancel();throw new Error('Speech service returned an unexpected audio format');}
      pcm=await responseBytes(res,16*1024*1024);
    }
    if(pcm.toString('ascii',0,4)==='RIFF')pcm=wavToSpeechPcm(pcm);
    if(!pcm.length || pcm.length%2) throw new Error('Speech service returned invalid PCM audio');
    yield pcm;
  }
}
export async function transcribeDetailed(core:Core,provider:HostedSpeechProvider,settings:HostedVoice,wav:Buffer,signal:AbortSignal,options:HostedTranscriptionOptions={},input:SpeechTransportInput=fetch):Promise<HostedTranscript> {
  if(wav.length>24*1024*1024)throw new Error('The hosted transcription service requires a WAV file up to 24 MiB');const info=wavInfo(wav),runtime=transport(input);
  const r=await route(core,provider,settings,'in',runtime);
  let url=r.url,body:BodyInit;
  if(['xai','openai','mistral','azure_openai','openrouter'].includes(provider)){
    const form=new FormData();const model=r.deployment||settings.model||(provider==='xai'?'grok-voice-transcribe-2.0':provider==='mistral'?'voxtral-mini-transcribe-3':provider==='openrouter'?'openai/whisper-large-v3':'whisper-1');
    form.append('model',model);
    if(settings.language) form.append('language',provider==='xai'?xaiLanguage(settings.language):settings.language.split('-')[0]);
    if(settings.prompt){if(provider==='mistral')form.append('context_bias',settings.prompt);else if(provider==='openai'||provider==='azure_openai')form.append('prompt',settings.prompt);}
    if(provider==='xai'&&settings.language)form.append('format','true');
    if(provider==='mistral'&&settings.timestampGranularities){if(settings.timestampGranularities.includes('word'))throw new Error('Mistral supports segment timestamps only');form.append('timestamp_granularities','segment');}
    if((provider==='openai'||provider==='azure_openai')&&settings.timestampGranularities){if(provider==='openai'&&model!=='whisper-1')throw new Error('OpenAI word and segment timestamps require whisper-1');form.append('response_format','verbose_json');for(const value of settings.timestampGranularities)form.append('timestamp_granularities[]',value);}
    form.append('file',new Blob([new Uint8Array(wav)],{type:'audio/wav'}),'recording.wav');
    url+=provider==='xai'?'stt':'audio/transcriptions';body=form;
  } else if(provider==='azure_speech') {
    url+='?language='+encodeURIComponent(settings.language||'en-US');r.headers['Content-Type']='audio/wav; codecs=audio/pcm; samplerate='+info.sampleRate;body=new Uint8Array(wav);
  } else {
    r.headers['Content-Type']='application/json';
    if(provider==='google_cloud')return googleCloudTranscribe(url,r.headers,wav,info,settings.language||'en-US',signal,options,runtime);
    else {url+='models/'+encodeURIComponent(settings.model||'gemini-flash-lite-latest')+':generateContent';body=JSON.stringify({systemInstruction:{parts:[{text:'Transcribe this audio verbatim. Return only the spoken words.'}]},contents:[{parts:[{inlineData:{mimeType:'audio/wav',data:wav.toString('base64')}}]}]});}
  }
  const data=await responseJson(await runtime.fetch(url,{method:'POST',redirect:'error',headers:r.headers,body,signal}));
  const result=data.text??data.DisplayText??data.results?.map((r:any)=>r.alternatives?.[0]?.transcript||'').join(' ')??data.candidates?.[0]?.content?.parts?.filter((p:any)=>!p.thought).map((p:any)=>p.text||'').join('');
  if(typeof result!=='string'||!result.trim()||result.length>100000)throw new Error('Speech service returned an empty or oversized transcript');
  const spans=(value:any,key:string)=>Array.isArray(value)&&value.length<=10000?value.flatMap((entry:any)=>{const text=entry?.[key];return typeof text==='string'&&text.trim()&&Number.isFinite(entry.start)&&Number.isFinite(entry.end)&&entry.start>=0&&entry.end>=entry.start?[{text:text.trim(),start:entry.start,end:entry.end,...(Number.isSafeInteger(entry.speaker)&&entry.speaker>=0?{speaker:entry.speaker}:{})}]:[]}):[];
  const wordEntries=spans(data.words,'word'),words=wordEntries.length?wordEntries:spans(data.words,'text'),segments=spans(data.segments,'text');
  return{text:result.trim(),...(typeof data.language==='string'?{language:data.language}:{}),...(Number.isFinite(data.duration)?{duration:data.duration}:{}),...(words.length?{words}:{}),...(segments.length?{segments}:{})};
}
export async function transcribe(core:Core,provider:HostedSpeechProvider,settings:HostedVoice,wav:Buffer,signal:AbortSignal,input:SpeechTransportInput=fetch){return(await transcribeDetailed(core,provider,settings,wav,signal,{},input)).text;}

export async function speechVoices(core:Core,provider:HostedSpeechProvider,settings:HostedVoice,signal:AbortSignal,input:SpeechTransportInput=fetch) {
  const runtime=transport(input);
  if(provider!=='azure_speech'&&provider!=='google_cloud')throw new Error('Choose Azure Speech or Google Cloud TTS for voice discovery');
  const r=await route(core,provider,settings,'out',runtime);
  const url=provider==='azure_speech'?r.url.replace(/v1$/,'voices/list'):'https://texttospeech.googleapis.com/v1/voices';
  const data=await responseJson(await runtime.fetch(url,{signal,headers:r.headers,redirect:'error'}));
  const rows=provider==='azure_speech'?data:data.voices;
  if(!Array.isArray(rows))throw new Error('Invalid provider voice catalog');
  return rows.slice(0,4096).flatMap(v=>{const id=v.ShortName||v.name;if(typeof id!=='string')return [];return [{id,name:String(v.DisplayName||id).slice(0,160),languages:provider==='azure_speech'?[v.Locale]:(v.languageCodes||[])}];});
}
