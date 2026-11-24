import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { synthesize,transcribe,transcribeDetailed,voiceSchema } from '../broker/hosted-speech.ts';

function wav(seconds=.1,rate=16000){const bytes=Math.round(seconds*rate)*2,out=Buffer.alloc(44+bytes);out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(bytes,40);return out;}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
async function fakeServer(t:any,handler:(target:string,req:IncomingMessage,res:ServerResponse,bytes:Buffer)=>void|Promise<void>){
  const server=createServer(async(req,res)=>{try{await handler(String(req.headers['x-pal-target']),req,res,await body(req));}catch(error){res.statusCode=500;res.end(error instanceof Error?error.message:String(error));}});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture server unavailable');
  const fetcher:typeof fetch=(target,init={})=>{const headers=new Headers(init.headers);headers.set('x-pal-target',String(target));return fetch(`http://127.0.0.1:${address.port}/`,{...init,headers});};return fetcher;
}
const core:any={credentials:{key:(provider:string)=>provider==='azure_speech'?'azure-key':''},accountAccess:(provider:string)=>({key:()=>provider+'-key',route:()=>({baseUrl:provider==='google'?'https://generativelanguage.googleapis.com/v1beta/':`https://api.${provider}.example/v1/`})})};
const signal=AbortSignal.timeout(5000);
const json=(res:ServerResponse,value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
async function audio(generator:AsyncGenerator<Buffer>){const rows=[];for await(const chunk of generator)rows.push(chunk);return Buffer.concat(rows);}

test('OpenAI uses native multipart prompt/timestamps and keeps ordinary transcription text-only',async t=>{
  const requests:any[]=[],send=await fakeServer(t,(target,req,res,bytes)=>{requests.push({target,type:req.headers['content-type'],body:bytes.toString('utf8')});if(target.endsWith('/audio/transcriptions'))json(res,{text:'hello world',language:'en',duration:1.2,words:[{word:'hello',start:0,end:.5},{word:'world',start:.5,end:1.2}],segments:[{text:'hello world',start:0,end:1.2}]});else{res.setHeader('Content-Type','audio/pcm');res.end(Buffer.from([1,2]));}});
  const settings=voiceSchema.parse({model:'whisper-1',prompt:'PAL product names',timestampGranularities:['word','segment']});
  const detailed=await transcribeDetailed(core,'openai',settings,wav(),signal,{},send);assert.equal(detailed.text,'hello world');assert.deepEqual(detailed.words?.[0],{text:'hello',start:0,end:.5});
  const multipart=requests[0].body;assert.match(requests[0].target,/\/v1\/audio\/transcriptions$/);assert.ok(multipart.indexOf('name="prompt"')<multipart.indexOf('name="file"'));assert.match(multipart,/name="response_format"\r\n\r\nverbose_json/);assert.match(multipart,/name="timestamp_granularities\[\]"/);
  await assert.rejects(transcribeDetailed(core,'openai',{model:'gpt-4o-transcribe',timestampGranularities:['word']},wav(),signal,{},send),/timestamps require whisper-1/);
  assert.equal(await transcribe(core,'openai',{model:'whisper-1'},wav(),signal,send),'hello world');assert.doesNotMatch(requests[1].body,/timestamp_granularities/);
  assert.deepEqual(await audio(synthesize(core,'openai',{model:'gpt-4o-mini-tts',voice:'alloy'},'Read this',signal,send)),Buffer.from([1,2]));assert.deepEqual(JSON.parse(requests[2].body),{model:'gpt-4o-mini-tts',voice:'alloy',input:'Read this',response_format:'pcm'});
});

test('xAI uses current dedicated STT and TTS multipart/JSON contracts with word timestamps',async t=>{
  const requests:any[]=[],send=await fakeServer(t,(target,_req,res,bytes)=>{requests.push({target,body:bytes.toString('utf8')});if(target.endsWith('/stt'))json(res,{text:'hello',language:'en',duration:.4,words:[{text:'hello',start:0,end:.4}]});else{res.setHeader('Content-Type','audio/pcm');res.end(Buffer.from([3,4]));}});
  const result=await transcribeDetailed(core,'xai',{language:'en'},wav(),signal,{},send);assert.equal(result.words?.[0].text,'hello');assert.match(requests[0].body,/name="model"\r\n\r\ngrok-voice-transcribe-2\.0/);assert.ok(requests[0].body.indexOf('name="format"')<requests[0].body.indexOf('name="file"'));
  assert.deepEqual(await audio(synthesize(core,'xai',{voice:'eve',language:'en-US'},'Hello',signal,send)),Buffer.from([3,4]));assert.deepEqual(JSON.parse(requests[1].body),{text:'Hello',voice_id:'eve',language:'en',output_format:{codec:'pcm',sample_rate:24000}});
});

test('Gemini uses generateContent for verbatim transcription and current Interactions multi-speaker TTS',async t=>{
  const requests:any[]=[],send=await fakeServer(t,(target,_req,res,bytes)=>{const value=JSON.parse(bytes.toString());requests.push({target,value});if(target.includes(':generateContent'))json(res,{candidates:[{content:{parts:[{text:'verbatim words'}]}}]});else json(res,{output_audio:{data:Buffer.from([5,6]).toString('base64')}});});
  assert.equal(await transcribe(core,'google',{model:'gemini-flash-lite-latest'},wav(),signal,send),'verbatim words');assert.match(requests[0].target,/models\/gemini-flash-lite-latest:generateContent$/);assert.match(requests[0].value.systemInstruction.parts[0].text,/verbatim/);
  const settings=voiceSchema.parse({model:'gemini-3.8-flash-lite-tts',speakers:[{speaker:'Joe',voice:'Puck',style:'cheerful'},{speaker:'Jane',voice:'Kore',style:'calm'}]});
  assert.deepEqual(await audio(synthesize(core,'google',settings,'Joe: Hello Jane\nJane: Hello Joe',signal,send)),Buffer.from([5,6]));assert.match(requests[1].target,/\/v1beta\/interactions$/);
  assert.deepEqual(requests[1].value.generation_config.speech_config,{speakers:[{speaker:'Joe',voice:'Puck'},{speaker:'Jane',voice:'Kore'}]});assert.deepEqual(requests[1].value.input[0].content[0].annotations,[{type:'speech_metadata',speaker:'Joe',style:'cheerful'}]);
});

test('Azure Speech uses raw WAV recognition and escaped SSML synthesis',async t=>{
  const requests:any[]=[],send=await fakeServer(t,(target,req,res,bytes)=>{requests.push({target,type:req.headers['content-type'],body:bytes});if(target.includes('.stt.'))json(res,{DisplayText:'azure words'});else{res.setHeader('Content-Type','audio/pcm');res.end(Buffer.from([7,8]));}});
  assert.equal(await transcribe(core,'azure_speech',{region:'eastus',language:'en-US'},wav(),signal,send),'azure words');assert.match(requests[0].target,/eastus\.stt\.speech\.microsoft\.com\/speech\/recognition\/conversation\/cognitiveservices\/v1\?language=en-US$/);assert.equal(requests[0].type,'audio/wav; codecs=audio/pcm; samplerate=16000');
  assert.deepEqual(await audio(synthesize(core,'azure_speech',{region:'eastus',voice:'en-US-JennyNeural'},'A < B',signal,send)),Buffer.from([7,8]));assert.match(requests[1].body.toString(),/A &lt; B/);
});

test('Google Cloud uses sync native audio, cancellable long-running operations, and Cloud TTS',async t=>{
  const requests:any[]=[];let polls=0;
  const send=await fakeServer(t,(target,_req,res,bytes)=>{const value=bytes.length?JSON.parse(bytes.toString()):undefined;requests.push({target,value});
    if(target.endsWith('text:synthesize'))return json(res,{audioContent:Buffer.from([9,10]).toString('base64')});
    if(target.endsWith('speech:recognize'))return json(res,{results:[{alternatives:[{transcript:'cloud short',words:[{word:'cloud',startTime:{seconds:'0'},endTime:{nanos:300000000}},{word:'short',startTime:{nanos:300000000},endTime:{seconds:'1'}}]}]}]});
    if(target.endsWith('speech:longrunningrecognize'))return json(res,{name:'7612202767953098924'});
    if(target.endsWith('/v1/operations/7612202767953098924'))return json(res,++polls?{done:true,response:{results:[{alternatives:[{transcript:'cloud long',words:[{word:'long',startTime:{seconds:'1'},endTime:{seconds:'2'}}]}]}]}}:{name:'7612202767953098924'});
    if(target.endsWith(':cancel'))return json(res,{});throw new Error('Unexpected target '+target);
  });
  const runtime={fetch:send,googleToken:async()=> 'adc-token',sleep:async()=>{}};
  const short=await transcribeDetailed(core,'google_cloud',{language:'en-US'},wav(),signal,{},runtime);assert.equal(short.text,'cloud short');assert.equal(short.words?.[1].end,1);assert.equal(requests[0].value.config.sampleRateHertz,16000);
  const long=await transcribeDetailed(core,'google_cloud',{language:'en-US'},wav(61,8000),signal,{googleCloudUri:'gs://pal-audio/recording.wav'},runtime);assert.equal(long.text,'cloud long');assert.equal(requests[1].value.audio.uri,'gs://pal-audio/recording.wav');assert.match(requests[2].target,/\/v1\/operations\/7612202767953098924$/);
  await assert.rejects(transcribeDetailed(core,'google_cloud',{},wav(61,8000),signal,{},runtime),/gs:\/\/ audio URI/);
  assert.deepEqual(await audio(synthesize(core,'google_cloud',{language:'en-US'},'Cloud voice',signal,runtime)),Buffer.from([9,10]));assert.deepEqual(requests.at(-1).value.audioConfig,{audioEncoding:'LINEAR16',sampleRateHertz:24000});

  const cancelled=new AbortController(),cancelRequests:any[]=[];const cancelSend=await fakeServer(t,(target,_req,res,bytes)=>{cancelRequests.push({target,body:bytes.toString()});if(target.endsWith('speech:longrunningrecognize'))json(res,{name:'cancel-me'});else json(res,{});});
  const pending=transcribeDetailed(core,'google_cloud',{},wav(61,8000),cancelled.signal,{googleCloudUri:'gs://pal-audio/cancel.wav'},{fetch:cancelSend,googleToken:async()=> 'adc-token',sleep:async(_ms,abort)=>{cancelled.abort(new Error('Stopped'));abort.throwIfAborted();}});
  await assert.rejects(pending,/Stopped/);assert.ok(cancelRequests.some(request=>request.target.endsWith('/v1/operations/cancel-me:cancel')));
});

test('Azure OpenAI, OpenRouter and Mistral speech bind the selected account and native format',async()=>{
  const id='33333333-3333-4333-8333-333333333333',signal=AbortSignal.timeout(5000);
  for(const provider of ['azure_openai','mistral','openrouter'] as const){
    const core={accountAccess(p:string,connection:string){assert.equal(connection,id);assert.equal(p,provider);
      return {key:()=> 'fixture',route:()=>provider==='azure_openai'?{baseUrl:'https://demo.openai.azure.com/openai',variant:'v1',deployment:'east-audio'}:{}};}} as any;
    const result=await transcribeDetailed(core,provider,{connectionId:id,...(provider==='mistral'?{timestampGranularities:['segment' as const]}:{})},wav(),signal,{},async(url,init)=>{
      const form=init!.body as FormData;assert.ok(form.get('file'));assert.match(String(url),/audio\/transcriptions$/);
      if(provider==='azure_openai'){assert.equal(form.get('model'),'east-audio');assert.equal(new Headers(init!.headers).get('api-key'),'fixture');assert.equal(new URL(String(url)).pathname,'/openai/v1/audio/transcriptions');}
      if(provider==='mistral'){assert.equal(form.get('timestamp_granularities'),'segment');assert.equal(form.get('model'),'voxtral-mini-transcribe-3');}
      if(provider==='openrouter')assert.equal(form.get('model'),'openai/whisper-large-v3');
      return Response.json({text:'Hello',segments:[{text:'Hello',start:0,end:0.1}]});
    });
    assert.equal(result.segments?.[0]?.text,'Hello');
    if(provider==='mistral'){
      const chunks=[];for await(const chunk of synthesize(core,provider,{connectionId:id},'Hello',signal,async(url,init)=>{
        const b=JSON.parse(String(init!.body));assert.equal(b.voice_id,'gb_jane_neutral');assert.equal(b.response_format,'wav');assert.match(String(url),/audio\/speech$/);
        return Response.json({audio_data:wav().toString('base64')});
      }))chunks.push(chunk);assert.ok(chunks[0].length>0);continue;
    }
    const chunks=[];for await(const chunk of synthesize(core,provider,{connectionId:id},'Hello',signal,async(_url,init)=>{
      const b=JSON.parse(String(init?.body));assert.equal(b.model,provider==='azure_openai'?'east-audio':'openai/gpt-4o-mini-tts');assert.equal(b.response_format,'pcm');
      return new Response(new Uint8Array(16),{headers:{'content-type':'audio/pcm'}});
    }))chunks.push(chunk);assert.equal(chunks[0].length,16);
  }
});
