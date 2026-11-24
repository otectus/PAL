import { randomUUID } from 'node:crypto';

export const realtimeProviderIds = ['openai', 'google', 'xai','azure_openai'] as const;
export type RealtimeProvider = typeof realtimeProviderIds[number];
export type RealtimeCodec = 'pcm16' | 'g711_ulaw' | 'g711_alaw' | 'opus';
export type RealtimeTurnDetection = 'manual' | 'server_vad' | 'semantic_vad';
export type RealtimeState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'awaiting-tool' | 'cancelling' | 'closed' | 'error';

export type RealtimeTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type RealtimeAudioFormat = {
  codec: RealtimeCodec;
  sampleRate: number;
  channels: 1;
};

export type RealtimeSessionConfig = {
  provider: RealtimeProvider;
  connectionId: string;
  model: string;
  voice?: string;
  instructions?: string;
  tools?: RealtimeTool[];
  turnDetection?: RealtimeTurnDetection;
  inputTranscription?: boolean;
  outputTranscription?: boolean;
  input?: Partial<RealtimeAudioFormat>;
  output?: Partial<RealtimeAudioFormat>;
};

export type ResolvedRealtimeConfig = Omit<RealtimeSessionConfig, 'turnDetection' | 'input' | 'output' | 'tools'> & {
  sessionId: string;
  turnDetection: RealtimeTurnDetection;
  input: RealtimeAudioFormat;
  output: RealtimeAudioFormat;
  tools: RealtimeTool[];
};

export type RealtimeEvent =
  | { type: 'state'; state: RealtimeState }
  | { type: 'ready' }
  | { type: 'audio'; audio: Buffer; itemId?: string; responseId?: string }
  | { type: 'transcript'; text: string; input: boolean; cumulative?: boolean; final?: boolean }
  | { type: 'tool-call'; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool-cancelled'; callIds: string[] }
  | { type: 'interrupted' }
  | { type: 'turn-complete' }
  | { type: 'resumption'; token: string; resumable: boolean }
  | { type: 'expiring'; reconnectToken?: string; timeLeft?: string }
  | { type: 'error'; message: string; recoverable: boolean };

export const realtimeLimits = Object.freeze({
  maxAudioChunkBytes: 64 * 1024,
  maxSocketMessageBytes: 2 * 1024 * 1024,
  maxBufferedSocketBytes: 1024 * 1024,
  maxTranscriptChars: 32 * 1024,
  maxTools: 64,
  maxToolArgumentsBytes: 256 * 1024,
});

const codecs: Record<RealtimeProvider, readonly RealtimeCodec[]> = {
  azure_openai:['pcm16','g711_ulaw','g711_alaw'],
  openai: ['pcm16', 'g711_ulaw', 'g711_alaw'],
  google: ['pcm16'],
  xai: ['pcm16', 'g711_ulaw', 'g711_alaw'],
};

function text(value: unknown, name: string, max: number, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${name} is invalid`);
  return value.trim();
}

function audio(provider: RealtimeProvider, direction: 'input' | 'output', value: Partial<RealtimeAudioFormat> | undefined): RealtimeAudioFormat {
  const codec = value?.codec || 'pcm16';
  if (!codecs[provider].includes(codec)) throw new Error(`${provider} realtime does not support ${codec} ${direction} audio`);
  const requiredRate = provider === 'google' ? direction === 'input' ? 16000 : 24000 : 24000;
  const sampleRate = value?.sampleRate || requiredRate;
  if (codec === 'pcm16' && sampleRate !== requiredRate) throw new Error(`${provider} realtime ${direction} PCM must use ${requiredRate} Hz mono audio`);
  if (codec !== 'pcm16' && sampleRate !== 8000) throw new Error(`${codec} must use 8000 Hz mono audio`);
  if (value?.channels !== undefined && value.channels !== 1) throw new Error('Realtime audio must be mono');
  return { codec, sampleRate, channels: 1 };
}

export function resolveRealtimeConfig(value: RealtimeSessionConfig, sessionId = randomUUID()): ResolvedRealtimeConfig {
  if (!value || typeof value !== 'object' || !realtimeProviderIds.includes(value.provider)) throw new Error('Choose a supported realtime provider');
  const connectionId = text(value.connectionId, 'Realtime connection', 128)!;
  const model = text(value.model, 'Realtime model', 256)!;
  const voice = text(value.voice, 'Realtime voice', 128, true);
  const instructions = text(value.instructions, 'Realtime instructions', 32 * 1024, true);
  const turnDetection = value.turnDetection || 'server_vad';
  if (!['manual', 'server_vad', 'semantic_vad'].includes(turnDetection)) throw new Error('Choose a supported realtime turn detection mode');
  if (value.provider === 'google' && turnDetection === 'semantic_vad') throw new Error('Gemini Live does not support semantic VAD');
  const tools = value.tools || [];
  if (!Array.isArray(tools) || tools.length > realtimeLimits.maxTools) throw new Error(`Realtime sessions support at most ${realtimeLimits.maxTools} tools`);
  const names = new Set<string>();
  const checked = tools.map(tool => {
    const name = text(tool?.name, 'Realtime tool name', 128)!;
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || names.has(name)) throw new Error('Realtime tool names must be unique identifiers');
    names.add(name);
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw new Error(`Realtime tool ${name} needs an object schema`);
    return { name, ...(tool.description ? { description: text(tool.description, 'Realtime tool description', 4096)! } : {}), parameters: structuredClone(tool.parameters) };
  });
  return { ...value, sessionId, provider: value.provider, connectionId, model, ...(voice ? { voice } : {}), ...(instructions ? { instructions } : {}), tools: checked,
    turnDetection, input: audio(value.provider, 'input', value.input), output: audio(value.provider, 'output', value.output),
    inputTranscription: value.inputTranscription !== false, outputTranscription: value.outputTranscription !== false };
}

