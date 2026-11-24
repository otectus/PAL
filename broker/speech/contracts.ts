export type TranscriptSpan={text:string;start:number;end:number;speaker?:number};
export type HostedTranscript={text:string;language?:string;duration?:number;words?:TranscriptSpan[];segments?:TranscriptSpan[]};
export type HostedTranscriptionOptions={
  /** Explicit Cloud Storage object containing this recording. Required by Google Cloud for audio over about one minute. */
  googleCloudUri?:string;
};
export type SpeechTransport={fetch?:typeof fetch;googleToken?:()=>Promise<string>;sleep?:(milliseconds:number,signal:AbortSignal)=>Promise<void>};
export type SpeechTransportInput=typeof fetch|SpeechTransport;
const sleep=(milliseconds:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  signal.throwIfAborted();
  const onAbort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},milliseconds);
  signal.addEventListener('abort',onAbort,{once:true});
});
export function transport(value:SpeechTransportInput|undefined):Required<Pick<SpeechTransport,'fetch'|'sleep'>>&Pick<SpeechTransport,'googleToken'> {
  if(typeof value==='function')return{fetch:value,sleep};
  return{fetch:value?.fetch||fetch,...(value?.googleToken?{googleToken:value.googleToken}:{}),sleep:value?.sleep||sleep};
}
