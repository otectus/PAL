import { resolveProviderEndpoint } from '../provider-registry.ts';
import type { RealtimeEvent, RealtimeProvider, ResolvedRealtimeConfig } from './contracts.ts';
import { realtimeLimits } from './contracts.ts';

export type RealtimeRoute = { baseUrl?: string; variant?: string; deployment?: string };
export type RealtimeAccess = { key(): string; token?: () => Promise<string>; route?: () => RealtimeRoute };
export type RealtimeConnection = { url: string; headers: Record<string, string> };

export type RealtimeProviderCodec = {
  connection(config: ResolvedRealtimeConfig, access: RealtimeAccess, credential: string): RealtimeConnection;
  setup(config: ResolvedRealtimeConfig): unknown;
  begin(config: ResolvedRealtimeConfig): unknown[];
  audio(config: ResolvedRealtimeConfig, value: Buffer): unknown;
  commit(config: ResolvedRealtimeConfig): unknown[];
  cancel(config: ResolvedRealtimeConfig, played?: { itemId?: string; audioEndMs?: number }): unknown[];
  toolResult(config: ResolvedRealtimeConfig, callId: string, name: string, result: unknown): unknown[];
  continue(config: ResolvedRealtimeConfig): unknown[];
  parse(config: ResolvedRealtimeConfig, value: unknown): RealtimeEvent[];
};

function apiFormat(config: ResolvedRealtimeConfig, direction: 'input' | 'output') {
  const value = config[direction];
  if (value.codec === 'pcm16') return { type: 'audio/pcm', rate: value.sampleRate };
  return { type: value.codec === 'g711_ulaw' ? 'audio/pcmu' : 'audio/pcma' };
}
function turnDetection(config: ResolvedRealtimeConfig) {
  return config.turnDetection === 'manual' ? null : { type: config.turnDetection, create_response: true, interrupt_response: true };
}
function functionTools(config: ResolvedRealtimeConfig) {
  return config.tools.map(tool => ({ type: 'function', name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters }));
}
function outputText(value: unknown) { return typeof value === 'string' ? value.slice(0, realtimeLimits.maxTranscriptChars) : ''; }
function errorMessage(value: any) { return outputText(value?.error?.message || value?.message || 'Realtime provider error') || 'Realtime provider error'; }
function argumentsObject(value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > realtimeLimits.maxToolArgumentsBytes) throw new Error('Realtime tool arguments are invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(value || '{}'); } catch { throw new Error('Realtime tool arguments are invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Realtime tool arguments are invalid');
  return parsed as Record<string, unknown>;
}
function asUrl(base: string, fallbackPath: string) {
  const url = new URL(base);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'wss:') throw new Error('Realtime provider endpoints must use secure WebSockets');
  if (!url.pathname || url.pathname === '/') url.pathname = fallbackPath;
  url.username = ''; url.password = ''; url.hash = '';
  return url;
}
function bearer(credential: string) { return { Authorization: `Bearer ${credential}` }; }

function openAiLike(provider: 'openai' | 'xai' | 'azure_openai'): RealtimeProviderCodec {
  return {
    connection(config, access, credential) {
      if(provider==='azure_openai'){
        const route=access.route?.();
        if(!route?.baseUrl||!route.deployment||route.variant==='legacy')throw new Error('Choose a named Azure OpenAI v1 realtime deployment');
        const url=asUrl(resolveProviderEndpoint(provider,route),'');url.pathname+='realtime';url.searchParams.set('model',route.deployment);
        return {url:url.href,headers:access.token?bearer(credential):{'api-key':credential}};
      }
      const fallback = provider === 'openai' ? 'wss://api.openai.com/v1/realtime' : 'wss://api.x.ai/v1/realtime';
      const url = asUrl(access.route?.().baseUrl || fallback, '/v1/realtime');
      if (!url.pathname.endsWith('/realtime')) url.pathname = url.pathname.replace(/\/+$/, '') + '/realtime';
      url.searchParams.set('model', access.route?.().deployment || config.model);
      return { url: url.toString(), headers: bearer(credential) };
    },
    setup(config) {
      const shared = { ...(config.instructions ? { instructions: config.instructions } : {}), ...(functionTools(config).length ? { tools: functionTools(config), tool_choice: 'auto' } : {}) };
      if (provider === 'xai') return { type: 'session.update', session: { ...shared, ...(config.voice ? { voice: config.voice } : {}), turn_detection: turnDetection(config),
        audio: { input: { format: apiFormat(config, 'input'), ...(config.inputTranscription ? { transcription: { model: 'grok-transcribe' } } : {}) }, output: { format: apiFormat(config, 'output') } } } };
      return { type: 'session.update', session: { ...shared, type: 'realtime', model: config.model, output_modalities: ['audio'], audio: {
        input: { format: apiFormat(config, 'input'), ...(config.inputTranscription ? { transcription: { model: 'gpt-4o-mini-transcribe' } } : {}), turn_detection: turnDetection(config) },
        output: { format: apiFormat(config, 'output'), ...(config.voice ? { voice: config.voice } : {}) },
      } } };
    },
    begin() { return []; },
    audio(_config, value) { return { type: 'input_audio_buffer.append', audio: value.toString('base64') }; },
    commit(config) { return config.turnDetection === 'manual' ? [{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }] : []; },
    cancel(_config, played) {
      return [{ type: 'response.cancel' }, ...(played?.itemId && Number.isFinite(played.audioEndMs) ? [{ type: 'conversation.item.truncate', item_id: played.itemId, content_index: 0, audio_end_ms: Math.max(0, Math.floor(played.audioEndMs!)) }] : [])];
    },
    toolResult(_config, callId, _name, result) { return [{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }]; },
    continue() { return [{ type: 'response.create' }]; },
    parse(_config, raw) {
      const value = raw as any, type = value?.type;
      if (type === 'session.created' || type === 'session.updated') return [{ type: 'ready' }];
      if (type === 'input_audio_buffer.speech_started') return [{ type: 'interrupted' }, { type: 'state', state: 'listening' }];
      if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') return [{ type: 'state', state: 'thinking' }];
      if (type === 'response.output_audio.delta' || type === 'response.audio.delta') return [{ type: 'state', state: 'speaking' }, { type: 'audio', audio: Buffer.from(value.delta || '', 'base64'), itemId: value.item_id, responseId: value.response_id }];
      if (type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta' || type === 'response.text.delta') return [{ type: 'transcript', text: outputText(value.delta), input: false }];
      if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') return [{ type: 'transcript', text: outputText(value.transcript || value.text), input: false, final: true }];
      if (type === 'conversation.item.input_audio_transcription.delta') return [{ type: 'transcript', text: outputText(value.delta), input: true }];
      if (type === 'conversation.item.input_audio_transcription.updated') return [{ type: 'transcript', text: outputText(value.transcript || value.text), input: true, cumulative: true }];
      if (type === 'conversation.item.input_audio_transcription.completed') return [{ type: 'transcript', text: outputText(value.transcript), input: true, final: true }];
      if (type === 'response.function_call_arguments.done') return [{ type: 'tool-call', callId: String(value.call_id || value.item_id || ''), name: String(value.name || ''), arguments: argumentsObject(value.arguments) }];
      if (type === 'response.output_item.done' && value.item?.type === 'function_call') return [{ type: 'tool-call', callId: String(value.item.call_id || value.item.id || ''), name: String(value.item.name || ''), arguments: argumentsObject(value.item.arguments) }];
      if (type === 'response.done') return [{ type: 'turn-complete' }, { type: 'state', state: 'listening' }];
      if (type === 'session.expiring' || type === 'realtime.session_expiring') return [{ type: 'expiring', reconnectToken: value.reconnect_token }];
      if (type === 'error') return [{ type: 'error', message: errorMessage(value), recoverable: value.error?.fatal !== true }];
      return [];
    },
  };
}

const googleCodec: RealtimeProviderCodec = {
  connection(config, access, credential) {
    const route = access.route?.() || {}, vertex = route.variant === 'vertex';
    let url: URL;
    if (route.baseUrl) {
      url = asUrl(route.baseUrl, vertex ? '/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent' : '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
      if (!/\/BidiGenerateContent$/.test(url.pathname)) url.pathname = vertex ? '/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent' : '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
    } else url = new URL('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
    if (!access.token) url.searchParams.set('key', credential);
    return { url: url.toString(), headers: access.token ? bearer(credential) : {} };
  },
  setup(config) {
    const model = config.model.includes('/') ? config.model : `models/${config.model}`;
    return { setup: { model, generationConfig: { responseModalities: ['AUDIO'], ...(config.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } } : {}) },
      ...(config.instructions ? { systemInstruction: { parts: [{ text: config.instructions }] } } : {}),
      ...(config.tools.length ? { tools: [{ functionDeclarations: config.tools.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parametersJsonSchema: tool.parameters })) }] } : {}),
      ...(config.inputTranscription ? { inputAudioTranscription: {} } : {}), ...(config.outputTranscription ? { outputAudioTranscription: {} } : {}),
      realtimeInputConfig: { automaticActivityDetection: config.turnDetection === 'manual' ? { disabled: true } : { disabled: false } },
    } };
  },
  begin(config) { return config.turnDetection === 'manual' ? [{ realtimeInput: { activityStart: {} } }] : []; },
  audio(config, value) { return { realtimeInput: { audio: { mimeType: `audio/pcm;rate=${config.input.sampleRate}`, data: value.toString('base64') } } }; },
  commit(config) { return config.turnDetection === 'manual' ? [{ realtimeInput: { activityEnd: {} } }] : []; },
  cancel(config) { return config.turnDetection === 'manual' ? [{ realtimeInput: { activityStart: {} } }] : []; },
  toolResult(_config, callId, name, result) { return [{ toolResponse: { functionResponses: [{ id: callId, name, response: { result } }] } }]; },
  continue() { return []; },
  parse(_config, raw) {
    const value = raw as any, events: RealtimeEvent[] = [];
    if (value?.setupComplete !== undefined) return [{ type: 'ready' }, { type: 'state', state: 'listening' }];
    if (value?.error) return [{ type: 'error', message: errorMessage(value), recoverable: false }];
    if (value?.goAway) return [{ type: 'expiring', timeLeft: outputText(value.goAway.timeLeft) }];
    if (value?.sessionResumptionUpdate?.newHandle) return [{ type: 'resumption', token: String(value.sessionResumptionUpdate.newHandle), resumable: value.sessionResumptionUpdate.resumable === true }];
    if (value?.toolCallCancellation?.ids) events.push({ type: 'tool-cancelled', callIds: value.toolCallCancellation.ids.map(String) });
    for (const call of value?.toolCall?.functionCalls || []) events.push({ type: 'tool-call', callId: String(call.id || ''), name: String(call.name || ''), arguments: call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {} });
    const content = value?.serverContent;
    if (content?.interrupted) events.push({ type: 'interrupted' }, { type: 'state', state: 'listening' });
    if (content?.inputTranscription?.text) events.push({ type: 'transcript', text: outputText(content.inputTranscription.text), input: true, cumulative: true });
    if (content?.interimInputTranscription?.text) events.push({ type: 'transcript', text: outputText(content.interimInputTranscription.text), input: true, cumulative: true });
    if (content?.outputTranscription?.text) events.push({ type: 'transcript', text: outputText(content.outputTranscription.text), input: false });
    for (const part of content?.modelTurn?.parts || []) if (part?.inlineData?.data) events.push({ type: 'state', state: 'speaking' }, { type: 'audio', audio: Buffer.from(part.inlineData.data, 'base64') });
    if (content?.turnComplete) events.push({ type: 'turn-complete' }, { type: 'state', state: 'listening' });
    return events;
  },
};

export const realtimeProviderCodecs: Readonly<Record<RealtimeProvider, RealtimeProviderCodec>> = {
  openai: openAiLike('openai'),
  azure_openai: openAiLike('azure_openai'),
  google: googleCodec,
  xai: openAiLike('xai'),
};

