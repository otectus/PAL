import { WebSocket } from 'ws';
import type { ClientOptions, RawData } from 'ws';
import type { RealtimeEvent, RealtimeSessionConfig, RealtimeState, ResolvedRealtimeConfig } from './contracts.ts';
import { realtimeLimits, resolveRealtimeConfig } from './contracts.ts';
import { decodeMobileRealtimeFrame, encodeMobileRealtimeFrame, MobileFrameSequence, mobileRealtimeProtocol } from './mobile-frame.ts';
import type { RealtimeAccess } from './provider-codecs.ts';
import { realtimeProviderCodecs } from './provider-codecs.ts';

export type RealtimeSocket = {
  readyState: number;
  bufferedAmount: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: RawData, binary: boolean) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
};
export type RealtimeSocketFactory = (url: string, options: ClientOptions) => RealtimeSocket;

export type RealtimeHooks = {
  access(provider: ResolvedRealtimeConfig['provider'], connectionId: string): RealtimeAccess;
  event(sessionId: string, event: RealtimeEvent): void;
  /** This must enter PAL's existing permission/approval loop; the realtime transport never bypasses it. */
  callTool?(sessionId: string, callId: string, name: string, argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
};

type LiveSession = {
  config: ResolvedRealtimeConfig;
  socket: RealtimeSocket;
  state: RealtimeState;
  abort: AbortController;
  closed: boolean;
  completedCalls: Set<string>;
  pendingCalls: Set<string>;
  lastItemId?: string;
  inputActive: boolean;
  playbackPending: boolean;
  turnCompleteObserved: boolean;
  awaitingContinuation: boolean;
  inputSequences: Map<string, MobileFrameSequence>;
  outputSequences: Map<string, number>;
};

function socketFactory(url: string, options: ClientOptions): RealtimeSocket {
  return new WebSocket(url, { ...options, perMessageDeflate: false, maxPayload: realtimeLimits.maxSocketMessageBytes });
}
function socketText(data: RawData) {
  const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (bytes.length > realtimeLimits.maxSocketMessageBytes) throw new Error('Realtime provider message exceeded its size limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function safeToolResult(value: unknown) {
  let encoded: string;
  try { encoded = JSON.stringify(value === undefined ? null : value); } catch { throw new Error('Realtime tool result is not JSON'); }
  if (Buffer.byteLength(encoded) > realtimeLimits.maxToolArgumentsBytes) throw new Error('Realtime tool result exceeded its size limit');
  return JSON.parse(encoded);
}

export class RealtimeSessions {
  readonly hooks: RealtimeHooks;
  readonly makeSocket: RealtimeSocketFactory;
  private sessions = new Map<string, LiveSession>();
  constructor(hooks: RealtimeHooks, makeSocket: RealtimeSocketFactory = socketFactory) { this.hooks = hooks; this.makeSocket = makeSocket; }

  private live(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new Error('Realtime session is not active');
    return session;
  }
  private transition(session: LiveSession, state: RealtimeState) {
    if (session.state === state) return;
    session.state = state; this.hooks.event(session.config.sessionId, { type: 'state', state });
  }
  private send(session: LiveSession, values: unknown | unknown[]) {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) throw new Error('Realtime provider connection is not open');
    if (session.socket.bufferedAmount > realtimeLimits.maxBufferedSocketBytes) throw new Error('Realtime provider connection is backpressured');
    for (const value of Array.isArray(values) ? values : [values]) session.socket.send(JSON.stringify(value));
  }

  async start(value: RealtimeSessionConfig, sessionId?: ReturnType<typeof import("node:crypto").randomUUID>) {
    const config = resolveRealtimeConfig(value, sessionId);
    if ([...this.sessions.values()].some(session => !session.closed && session.config.connectionId === config.connectionId)) throw new Error('This account already has an active realtime session');
    const access = this.hooks.access(config.provider, config.connectionId), available = access.key();
    const credential = access.token ? await access.token() : available;
    if (!credential) throw new Error(`Add a key for ${config.provider} realtime in Settings → Connections`);
    if(config.provider==='azure_openai')config.model=access.route?.().deployment||config.model;
    const codec = realtimeProviderCodecs[config.provider], connection = codec.connection(config, access, credential);
    const socket = this.makeSocket(connection.url, { headers: connection.headers });
    const session: LiveSession = { config, socket, state: 'connecting', abort: new AbortController(), closed: false, completedCalls: new Set(), pendingCalls: new Set(), inputActive: false, playbackPending: false, turnCompleteObserved: false, awaitingContinuation: false, inputSequences: new Map(), outputSequences: new Map() };
    this.sessions.set(config.sessionId, session);
    socket.on('message', (data, binary) => this.message(session, data, binary));
    socket.on('error', error => this.failure(session, error));
    socket.on('close', () => this.closed(session));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Realtime connection timed out')); } }, 15000);
      timeout.unref();
      socket.on('close', () => { clearTimeout(timeout); if (!settled) { settled = true; reject(new Error('Realtime connection closed during setup')); } });
      socket.on('open', () => {
        if (settled) return; clearTimeout(timeout); settled = true;
        try { this.send(session, codec.setup(config)); resolve(); } catch (error) { reject(error); }
      });
      socket.on('error', error => { clearTimeout(timeout); if (!settled) { settled = true; reject(error); } });
    }).catch(error => { this.stop(config.sessionId); throw error; });
    return { sessionId: config.sessionId, provider: config.provider, model: config.model, input: config.input, output: config.output, turnDetection: config.turnDetection, mobile: mobileRealtimeProtocol };
  }

  private message(session: LiveSession, data: RawData, binary: boolean) {
    if (session.closed) return;
    try {
      if (binary && session.config.provider!=='google') throw new Error('Unexpected binary message from realtime provider');
      const raw = JSON.parse(socketText(data));
      for (const event of realtimeProviderCodecs[session.config.provider].parse(session.config, raw)) this.providerEvent(session, event);
    } catch (error) { this.failure(session, error instanceof Error ? error : new Error('Invalid realtime provider message')); }
  }
  private providerEvent(session: LiveSession, event: RealtimeEvent) {
    if (event.type === 'state') { if (!(event.state === 'listening' && (session.pendingCalls.size || session.awaitingContinuation))) this.transition(session, event.state); }
    else if (event.type === 'ready') { this.hooks.event(session.config.sessionId, event); this.transition(session, 'listening'); }
    else if (event.type === 'audio') { session.lastItemId = event.itemId || session.lastItemId; session.playbackPending = true; this.transition(session, 'speaking'); this.hooks.event(session.config.sessionId, event); }
    else if (event.type === 'interrupted') { session.playbackPending = false; this.hooks.event(session.config.sessionId, event); this.transition(session, 'listening'); }
    else if (event.type === 'tool-call') this.toolCall(session, event);
    else if (event.type === 'tool-cancelled') {
      for (const id of event.callIds) session.pendingCalls.delete(id);
      this.hooks.event(session.config.sessionId, event);
      if (!session.pendingCalls.size) this.transition(session, 'listening');
    } else {
      if (event.type === 'turn-complete') { session.turnCompleteObserved = true; this.maybeContinue(session); }
      this.hooks.event(session.config.sessionId, event);
      if (event.type === 'error' && !event.recoverable) { this.transition(session, 'error'); this.stop(session.config.sessionId); }
    }
  }
  private toolCall(session: LiveSession, event: Extract<RealtimeEvent, { type: 'tool-call' }>) {
    if (!event.callId || !event.name || session.completedCalls.has(event.callId) || session.pendingCalls.has(event.callId)) return;
    session.pendingCalls.add(event.callId); session.awaitingContinuation = true; this.transition(session, 'awaiting-tool'); this.hooks.event(session.config.sessionId, event);
    if (!this.hooks.callTool) return;
    void this.hooks.callTool(session.config.sessionId, event.callId, event.name, event.arguments, session.abort.signal).then(
      result => this.completeTool(session.config.sessionId, event.callId, event.name, result),
      error => this.completeTool(session.config.sessionId, event.callId, event.name, { error: error instanceof Error ? error.message.slice(0, 4096) : 'Tool failed' }),
    ).catch(() => {});
  }
  completeTool(sessionId: string, callId: string, name: string, result: unknown) {
    const session = this.live(sessionId);
    if (session.completedCalls.has(callId)) return;
    if (!session.pendingCalls.delete(callId)) throw new Error('Realtime tool call is not pending');
    this.send(session, realtimeProviderCodecs[session.config.provider].toolResult(session.config, callId, name, safeToolResult(result)));
    session.completedCalls.add(callId);
    if (session.config.provider === 'google') { session.awaitingContinuation = false; this.transition(session, 'thinking'); }
    else this.maybeContinue(session);
  }
  private maybeContinue(session: LiveSession) {
    if (!session.awaitingContinuation || !session.turnCompleteObserved || session.pendingCalls.size || session.playbackPending) return;
    this.send(session, realtimeProviderCodecs[session.config.provider].continue(session.config));
    session.awaitingContinuation = false; session.turnCompleteObserved = false; this.transition(session, 'thinking');
  }

  audio(sessionId: string, audio: Uint8Array, endOfTurn = false) {
    const session = this.live(sessionId);
    if (session.state === 'awaiting-tool' || session.state === 'cancelling') throw new Error('Realtime audio is paused');
    const value = Buffer.from(audio);
    if (!value.length || value.length > realtimeLimits.maxAudioChunkBytes) throw new Error('Realtime audio chunk is empty or too large');
    if (!session.inputActive) { this.send(session, realtimeProviderCodecs[session.config.provider].begin(session.config)); session.inputActive = true; }
    this.send(session, realtimeProviderCodecs[session.config.provider].audio(session.config, value));
    if (endOfTurn) this.commit(sessionId);
  }
  commit(sessionId: string) {
    const session = this.live(sessionId);
    this.send(session, realtimeProviderCodecs[session.config.provider].commit(session.config));
    session.inputActive = false;
    this.transition(session, 'thinking');
  }
  interrupt(sessionId: string, played: { itemId?: string; audioEndMs?: number } = {}) {
    const session = this.live(sessionId);
    session.playbackPending = false; this.hooks.event(sessionId, { type: 'interrupted' }); this.transition(session, 'cancelling');
    this.send(session, realtimeProviderCodecs[session.config.provider].cancel(session.config, { itemId: played.itemId || session.lastItemId, audioEndMs: played.audioEndMs }));
    this.transition(session, 'listening');
  }
  playbackComplete(sessionId: string) { const session = this.live(sessionId); session.playbackPending = false; this.maybeContinue(session); }
  stop(sessionId: string) {
    const session = this.sessions.get(sessionId); if (!session || session.closed) return false;
    session.closed = true; session.abort.abort(new Error('Realtime session stopped'));
    session.pendingCalls.clear(); session.inputSequences.clear(); session.outputSequences.clear();
    try { session.socket.close(1000, 'session stopped'); } catch {}
    this.transition(session, 'closed'); this.sessions.delete(sessionId); return true;
  }
  close() { for (const id of [...this.sessions.keys()]) this.stop(id); }
  private closed(session: LiveSession) {
    if (session.closed) return;
    session.closed = true; session.abort.abort(new Error('Realtime provider disconnected')); this.transition(session, 'closed'); this.sessions.delete(session.config.sessionId);
  }
  private failure(session: LiveSession, error: Error) {
    if (session.closed) return;
    this.hooks.event(session.config.sessionId, { type: 'error', message: error.message.slice(0, 4096), recoverable: false });
    this.transition(session, 'error');
    try { session.socket.close(1011, 'provider error'); } catch {}
  }

  status(sessionId?: string) {
    const values = sessionId ? [this.sessions.get(sessionId)].filter(Boolean) as LiveSession[] : [...this.sessions.values()];
    return values.map(session => ({ sessionId: session.config.sessionId, provider: session.config.provider, connectionId: session.config.connectionId, model: session.config.model, state: session.state, input: session.config.input, output: session.config.output, turnDetection: session.config.turnDetection }));
  }
  mobileOffer(sessionId: string) { const session = this.live(sessionId); return { sessionId, ...mobileRealtimeProtocol, input: session.config.input, output: session.config.output }; }
  ingestMobileFrame(deviceId: string, bytes: Uint8Array, pairingSecret: Uint8Array, expectedSessionId?: string) {
    const decoded = decodeMobileRealtimeFrame(pairingSecret, bytes);
    if(expectedSessionId && decoded.sessionId!==expectedSessionId)throw new Error('Incorrect realtime session');
    const session = this.live(decoded.sessionId);
    if (decoded.direction !== 'input' || decoded.codec !== session.config.input.codec) throw new Error('Realtime mobile audio did not match the negotiated input');
    let sequence = session.inputSequences.get(deviceId);
    if (!sequence) { sequence = new MobileFrameSequence(decoded.sessionId, 'input'); session.inputSequences.set(deviceId, sequence); }
    sequence.check(decoded); sequence.accept(); this.audio(decoded.sessionId, decoded.audio, decoded.endOfTurn); return { sequence: decoded.sequence };
  }
  mobileOutputFrame(sessionId: string, deviceId: string, pairingSecret: Uint8Array, audio: Uint8Array, timestampMs = Date.now()) {
    const session = this.live(sessionId), sequence = session.outputSequences.get(deviceId) || 0;
    if (sequence > 0xffff_fffe) throw new Error('Realtime audio sequence is exhausted');
    const frame = encodeMobileRealtimeFrame(pairingSecret, { sessionId, direction: 'output', codec: session.config.output.codec, sequence, timestampMs, audio: Buffer.from(audio) });
    session.outputSequences.set(deviceId, sequence + 1); return frame;
  }

  async rpc(method: string, params: any) {
    if (method === 'realtime.start') return this.start(params);
    if (method === 'realtime.status') return this.status(params?.sessionId);
    if (method === 'realtime.audio') { this.audio(params.sessionId, Buffer.from(params.audio, 'base64'), params.endOfTurn === true); return { accepted: true }; }
    if (method === 'realtime.commit') { this.commit(params.sessionId); return { accepted: true }; }
    if (method === 'realtime.interrupt') { this.interrupt(params.sessionId, { itemId: params.itemId, audioEndMs: params.audioEndMs }); return { accepted: true }; }
    if (method === 'realtime.playbackComplete') { this.playbackComplete(params.sessionId); return { accepted: true }; }
    if (method === 'realtime.toolResult') { this.completeTool(params.sessionId, params.callId, params.name, params.result); return { accepted: true }; }
    if (method === 'realtime.stop') return { stopped: this.stop(params.sessionId) };
    throw new Error('Unknown realtime operation');
  }
}

