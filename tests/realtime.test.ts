import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { resolveRealtimeConfig } from '../broker/realtime/contracts.ts';
import { decodeMobileRealtimeFrame, encodeMobileRealtimeFrame, MobileFrameSequence, mobileRealtimeProtocol } from '../broker/realtime/mobile-frame.ts';
import { realtimeProviderCodecs } from '../broker/realtime/provider-codecs.ts';
import { RealtimeSessions, type RealtimeSocket } from '../broker/realtime/service.ts';

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 0; bufferedAmount = 0; sent: any[] = []; closed?: { code?: number; reason?: string };
  open() { this.readyState = 1; this.emit('open'); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code || 1000, Buffer.from(reason || '')); }
}

function session(provider: 'openai' | 'google' | 'xai', extra: Record<string, unknown> = {}) {
  return resolveRealtimeConfig({ provider, connectionId: `${provider}-account`, model: provider === 'google' ? 'gemini-live' : provider === 'xai' ? 'grok-voice-latest' : 'gpt-realtime', voice: provider === 'google' ? 'Puck' : 'marin', ...extra });
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('realtime configuration negotiates provider audio formats and bounded tools', () => {
  const openai = session('openai'); assert.deepEqual(openai.input, { codec: 'pcm16', sampleRate: 24000, channels: 1 });
  const google = session('google'); assert.equal(google.input.sampleRate, 16000); assert.equal(google.output.sampleRate, 24000);
  assert.throws(() => session('google', { input: { codec: 'opus' } }), /does not support opus/);
  assert.throws(() => session('openai', { input: { sampleRate: 16000 } }), /24000 Hz/);
  assert.throws(() => session('xai', { tools: [{ name: 'same', parameters: {} }, { name: 'same', parameters: {} }] }), /unique/);
});

test('dedicated provider codecs use current realtime endpoints and schemas', () => {
  const openai = session('openai', { turnDetection: 'manual', inputTranscription: true });
  const open = realtimeProviderCodecs.openai.connection(openai, { key: () => 'key' }, 'key');
  assert.match(open.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime$/); assert.equal(open.headers.Authorization, 'Bearer key');
  assert.deepEqual((realtimeProviderCodecs.openai.setup(openai) as any).session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(realtimeProviderCodecs.openai.commit(openai).map((value: any) => value.type), ['input_audio_buffer.commit', 'response.create']);

  const xai = session('xai'); const x = realtimeProviderCodecs.xai.connection(xai, { key: () => 'key' }, 'key');
  assert.match(x.url, /^wss:\/\/api\.x\.ai\/v1\/realtime\?model=grok-voice-latest$/);
  assert.equal((realtimeProviderCodecs.xai.setup(xai) as any).session.audio.input.transcription.model, 'grok-transcribe');
  assert.equal((realtimeProviderCodecs.xai.setup(xai) as any).session.voice, 'marin');

  const google = session('google', { tools: [{ name: 'lookup', parameters: { type: 'object' } }] });
  const developer = realtimeProviderCodecs.google.connection(google, { key: () => 'key' }, 'key');
  assert.match(developer.url, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContent\?key=key$/);
  const setup = realtimeProviderCodecs.google.setup(google) as any;
  assert.equal(setup.setup.model, 'models/gemini-live'); assert.deepEqual(setup.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.setup.tools[0].functionDeclarations[0].name, 'lookup');
  const vertex = realtimeProviderCodecs.google.connection(google, { key: () => 'available', token: async () => 'token', route: () => ({ variant: 'vertex', baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google' }) }, 'token');
  assert.equal(vertex.url, 'wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent');
  assert.deepEqual(vertex.headers, { Authorization: 'Bearer token' });
});

test('provider codecs normalize audio, transcripts, tools, interruption and expiry', () => {
  const open = session('openai');
  assert.deepEqual(realtimeProviderCodecs.openai.parse(open, { type: 'response.output_audio.delta', delta: Buffer.from('audio').toString('base64'), item_id: 'i1' }).map(event => event.type), ['state', 'audio']);
  assert.deepEqual(realtimeProviderCodecs.openai.parse(open, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'lookup', arguments: '{"q":"x"}' })[0], { type: 'tool-call', callId: 'c1', name: 'lookup', arguments: { q: 'x' } });
  const xai = session('xai');
  assert.deepEqual(realtimeProviderCodecs.xai.parse(xai, { type: 'conversation.item.input_audio_transcription.updated', transcript: 'hello' })[0], { type: 'transcript', text: 'hello', input: true, cumulative: true });
  const google = session('google');
  const events = realtimeProviderCodecs.google.parse(google, { serverContent: { interrupted: true, outputTranscription: { text: 'hi' }, modelTurn: { parts: [{ inlineData: { data: Buffer.from('a').toString('base64') } }] }, turnComplete: true } });
  assert.deepEqual(events.map(event => event.type), ['interrupted', 'state', 'transcript', 'state', 'audio', 'turn-complete', 'state']);
  assert.deepEqual(realtimeProviderCodecs.google.parse(google, { goAway: { timeLeft: '10s' } })[0], { type: 'expiring', timeLeft: '10s' });
});

test('mobile realtime framing is authenticated, versioned, bounded and replay-safe', () => {
  const secret = randomBytes(32), sessionId = randomUUID(), now = Date.now();
  const encoded = encodeMobileRealtimeFrame(secret, { sessionId, direction: 'input', codec: 'pcm16', sequence: 0, timestampMs: now, endOfTurn: true, audio: Buffer.from('pcm') });
  assert.equal(encoded.subarray(0, 4).toString(), mobileRealtimeProtocol.magic);
  const sequence = new MobileFrameSequence(sessionId, 'input'), decoded = decodeMobileRealtimeFrame(secret, encoded, sequence, now);
  assert.equal(decoded.audio.toString(), 'pcm'); assert.equal(decoded.endOfTurn, true); assert.equal(sequence.next, 1);
  assert.throws(() => decodeMobileRealtimeFrame(secret, encoded, sequence, now), /Duplicate/);
  const altered = Buffer.from(encoded); altered[40] ^= 1;
  assert.throws(() => decodeMobileRealtimeFrame(secret, altered, undefined, now), /authentication failed/);
  assert.throws(() => decodeMobileRealtimeFrame(secret, encoded, undefined, now + 6 * 60_000), /Stale/);
  assert.throws(() => encodeMobileRealtimeFrame(secret, { sessionId, direction: 'input', codec: 'pcm16', sequence: 1, timestampMs: now, audio: Buffer.alloc(mobileRealtimeProtocol.maxPayloadBytes + 1) }), /size limit/);
});

test('realtime service owns lifecycle, tool dedupe, interruption and mobile sequencing', async () => {
  const sockets: FakeSocket[] = [], events: any[] = [], calls: string[] = [];
  const service = new RealtimeSessions({
    access: () => ({ key: () => 'secret' }),
    event: (sessionId, event) => events.push({ sessionId, ...event }),
    callTool: async (_sessionId, callId) => { calls.push(callId); return { answer: 42 }; },
  }, (_url, _options) => { const socket = new FakeSocket(); sockets.push(socket); setImmediate(() => socket.open()); return socket; });
  const started = await service.start({ provider: 'openai', connectionId: 'account', model: 'gpt-realtime', turnDetection: 'manual', tools: [{ name: 'lookup', parameters: { type: 'object' } }] });
  const socket = sockets[0]; assert.equal(socket.sent[0].type, 'session.update');
  socket.receive({ type: 'session.created' }); assert.equal(service.status(started.sessionId)[0].state, 'listening');
  service.audio(started.sessionId, Buffer.from('pcm'), true);
  assert.deepEqual(socket.sent.slice(-3).map(value => value.type), ['input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  socket.receive({ type: 'response.output_audio.delta', delta: Buffer.from('reply').toString('base64'), item_id: 'item-1' });
  service.interrupt(started.sessionId, { audioEndMs: 125 });
  assert.deepEqual(socket.sent.slice(-2), [{ type: 'response.cancel' }, { type: 'conversation.item.truncate', item_id: 'item-1', content_index: 0, audio_end_ms: 125 }]);
  socket.receive({ type: 'response.output_audio.delta', delta: Buffer.from('tool-preamble').toString('base64'), item_id: 'item-2' });
  // The interrupted audio was discarded. The following turn still has audio queued for playback.
  socket.receive({type:'response.output_audio.delta',delta:Buffer.from('next').toString('base64'),item_id:'item-2'});
  const tool = { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'lookup', arguments: '{}' };
  socket.receive(tool); socket.receive(tool); await tick();
  assert.deepEqual(calls, ['call-1']); assert.equal(socket.sent.filter(value => value.item?.type === 'function_call_output').length, 1);
  const createsBeforeDone=socket.sent.filter(value=>value.type==='response.create').length;
  socket.receive({type:'response.done'});assert.equal(socket.sent.filter(value=>value.type==='response.create').length,createsBeforeDone,'tool continuation waits for playback acknowledgement');
  service.playbackComplete(started.sessionId);assert.equal(socket.sent.filter(value=>value.type==='response.create').length,createsBeforeDone+1);

  const secret = randomBytes(32), timestampMs = Date.now();
  const mobile = encodeMobileRealtimeFrame(secret, { sessionId: started.sessionId, direction: 'input', codec: 'pcm16', sequence: 0, timestampMs, audio: Buffer.from('phone') });
  service.ingestMobileFrame('device-1', mobile, secret);
  assert.throws(() => service.ingestMobileFrame('device-1', mobile, secret), /Duplicate/);
  const output = service.mobileOutputFrame(started.sessionId, 'device-1', secret, Buffer.from('speaker'), timestampMs);
  assert.equal(decodeMobileRealtimeFrame(secret, output, undefined, timestampMs).direction, 'output');
  assert.equal(service.stop(started.sessionId), true); assert.equal(socket.closed?.code, 1000); assert.deepEqual(service.status(), []);
});

test('realtime service fixtures all dedicated providers and never sends platform availability sentinels', async () => {
  for (const provider of ['google', 'xai'] as const) {
    const sockets: FakeSocket[] = [], requested: any[] = [];
    const service = new RealtimeSessions({ access: () => provider === 'google' ? { key: () => 'available', token: async () => 'platform-token', route: () => ({ variant: 'vertex', baseUrl: 'https://us-central1-aiplatform.googleapis.com/' }) } : { key: () => 'xai-key' }, event: () => {} },
      (url, options) => { requested.push({ url, options }); const socket = new FakeSocket(); sockets.push(socket); setImmediate(() => socket.open()); return socket; });
    const started = await service.start({ provider, connectionId: `${provider}-account`, model: provider === 'google' ? 'projects/p/locations/us-central1/publishers/google/models/gemini-live' : 'grok-voice-latest' });
    assert.equal(requested[0].options.headers.Authorization, `Bearer ${provider === 'google' ? 'platform-token' : 'xai-key'}`);
    assert.doesNotMatch(requested[0].url, /available/);
    assert.ok(provider === 'google' ? sockets[0].sent[0].setup : sockets[0].sent[0].type === 'session.update');
    service.stop(started.sessionId);
  }
});


test('Azure v1 realtime uses the reviewed resource and deployment for both auth strategies',()=>{
  const config=resolveRealtimeConfig({provider:'azure_openai',connectionId:'east',model:'east-live'});
  const route=()=>({baseUrl:'https://east.openai.azure.com/openai',variant:'v1',deployment:'east-live'});
  const codec=realtimeProviderCodecs.azure_openai;
  assert.deepEqual(codec.connection(config,{route,key:()=> 'key'},'key'),{url:'wss://east.openai.azure.com/openai/v1/realtime?model=east-live',headers:{'api-key':'key'}});
  assert.deepEqual(codec.connection(config,{route,key:()=> 'identity',token:async()=> 'fresh'},'fresh').headers,{Authorization:'Bearer fresh'});
  assert.throws(()=>codec.connection(config,{route:()=>({...route(),variant:'legacy'}),key:()=> 'key'},'key'),/v1/);
});
