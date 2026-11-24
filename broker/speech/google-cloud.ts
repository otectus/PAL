import { responseJson } from '../provider-http.ts';
import type { HostedTranscript,HostedTranscriptionOptions,SpeechTransport } from './contracts.ts';
import type { WavInfo } from './wav.ts';

const operationName=/^(?:(?:projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/locations\/[A-Za-z0-9][A-Za-z0-9._-]*\/)?operations\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const seconds=(value:any)=>Number(value?.seconds||0)+Number(value?.nanos||0)/1e9;
function transcript(data:any):HostedTranscript {
  const results=data?.results;if(!Array.isArray(results)||results.length>10000)throw new Error('Google Cloud Speech returned invalid results');
  const words=[] as NonNullable<HostedTranscript['words']>,segments=[] as NonNullable<HostedTranscript['segments']>;let cursor=0;
  const text=results.flatMap((result:any)=>{const alternative=result?.alternatives?.[0],part=typeof alternative?.transcript==='string'?alternative.transcript.trim():'';if(!part)return[];
    const entries=Array.isArray(alternative.words)?alternative.words:[];for(const word of entries){const value=typeof word.word==='string'?word.word.trim():'';const start=seconds(word.startTime),end=seconds(word.endTime);if(value&&Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>=start)words.push({text:value,start,end,...(Number.isSafeInteger(word.speakerTag)&&word.speakerTag>0?{speaker:word.speakerTag}:{})});}
    const start=words[cursor]?.start,end=words.at(-1)?.end;if(start!==undefined&&end!==undefined)segments.push({text:part,start,end});cursor=words.length;return[part];}).join(' ').trim();
  if(!text||text.length>100000)throw new Error('Speech service returned an empty or oversized transcript');
  return{text,...(words.length?{words}:{}),...(segments.length?{segments}:{}),duration:words.at(-1)?.end};
}

export async function googleCloudTranscribe(url:string,headers:Record<string,string>,wav:Buffer,info:WavInfo,language:string,signal:AbortSignal,options:HostedTranscriptionOptions,runtime:Required<Pick<SpeechTransport,'fetch'|'sleep'>>) {
  if(info.bitsPerSample!==16)throw new Error('Google Cloud Speech requires 16-bit linear PCM WAV audio');
  const config={languageCode:language,encoding:'LINEAR16',sampleRateHertz:info.sampleRate,...(info.channels>1?{audioChannelCount:info.channels,enableSeparateRecognitionPerChannel:true}:{}),enableWordTimeOffsets:true};
  const uri=options.googleCloudUri;
  if(uri!==undefined&&!/^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}\/[\u0020-\u007e]{1,1024}$/.test(uri))throw new Error('Use a valid Google Cloud Storage gs:// audio URI');
  if(info.durationSeconds>60&&!uri)throw new Error('Google Cloud Speech requires a gs:// audio URI for recordings over one minute');
  if(!uri&&wav.length>10*1024*1024)throw new Error('Google Cloud Speech inline recordings must be 10 MiB or smaller');
  const body={config,audio:uri?{uri}:{content:wav.toString('base64')}};
  if(!uri){const data=await responseJson(await runtime.fetch(url,{method:'POST',redirect:'error',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal}));return transcript(data);}
  const startUrl=url.replace(/speech:recognize$/,'speech:longrunningrecognize');
  const operation=await responseJson(await runtime.fetch(startUrl,{method:'POST',redirect:'error',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal}));
  if(typeof operation?.name!=='string'||!operationName.test(operation.name))throw new Error('Google Cloud Speech returned an invalid operation');
  const origin=new URL(startUrl).origin,operationPath=operation.name.includes('/')?operation.name:'operations/'+operation.name,pollUrl=`${origin}/v1/${operationPath}`;
  const cancel=async()=>{try{await runtime.fetch(pollUrl+':cancel',{method:'POST',redirect:'error',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});}catch{}};
  let cancellation:Promise<void>|undefined;const onAbort=()=>{cancellation=cancel();};signal.addEventListener('abort',onAbort,{once:true});
  try {for(let attempt=0;attempt<720;attempt++){signal.throwIfAborted();const state=attempt===0?operation:await responseJson(await runtime.fetch(pollUrl,{headers,redirect:'error',signal}));if(state?.done===true){if(state.error)throw new Error('Google Cloud Speech could not transcribe this recording');return transcript(state.response);}await runtime.sleep(5000,signal);}throw new Error('Google Cloud Speech operation did not finish within one hour');}
  catch(error){if(signal.aborted)await(cancellation||cancel());throw error;}finally{signal.removeEventListener('abort',onAbort);}
}
