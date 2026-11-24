import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bridgePython } from './runtime.ts';
import type { BridgeAccount, BridgeChatRequest, BridgeEmbeddingRequest, BridgeStatus } from './contracts.ts';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void; delta?: (text: string) => void; streamed: number };
type ProcessFactory = () => ChildProcessWithoutNullStreams;

class Worker {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private buffer = '';
  private ready?: Promise<BridgeStatus>;
  private readonly factory: ProcessFactory;
  constructor(factory: ProcessFactory) { this.factory=factory; }
  status(): Promise<BridgeStatus> { return this.start(); }
  private start() {
    if (this.ready) return this.ready;
    this.buffer = '';
    this.ready = new Promise(resolve => {
      let settled = false;
      const settle = (status: BridgeStatus) => { if (!settled) { settled = true; resolve(status); } };
      try {
        const child = this.process = this.factory();
        // What a stopped or failed worker still says does not touch the one that followed it.
        const gone = (error: Error) => { settle({ available: false, running: false, error: error.message }); if (this.process !== child) return; this.process = undefined; this.ready = undefined; this.failed(error); };
        child.stdout.setEncoding('utf8');
        child.stderr.resume();
        child.stdin.on('error', () => { /* The worker ended first; its exit says so. */ });
        child.stdout.on('data', chunk => { if (this.process === child) this.lines(String(chunk), value => {
          if (value?.type === 'ready' && !settled) settle(value.ok ? { available: true, running: true, version: String(value.version || 'unknown') } : { available: false, running: false, error: String(value.error || 'LiteLLM unavailable') });
          else this.message(value);
        }); });
        child.on('error', error => gone((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Python 3 was not found') : error));
        child.on('exit', (code, signal) => gone(new Error(`LiteLLM worker exited (${signal || code})`)));
      } catch (error) { settle({ available: false, running: false, error: error instanceof Error ? error.message : String(error) }); this.process = undefined; this.ready = undefined; }
    });
    return this.ready;
  }
  private lines(chunk: string, each: (value: any) => void) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.stop(new Error('LiteLLM worker exceeded its response limit')); return; }
    for (;;) { const end = this.buffer.indexOf('\n'); if (end < 0) break; const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); try { each(JSON.parse(line)); } catch {} }
  }
  private message(value: any) {
    if (!value || typeof value.id !== 'string') return;
    const pending = this.pending.get(value.id); if (!pending) return;
    if (value.type === 'delta') { if (typeof value.text === 'string' && (pending.streamed += value.text.length) <= 16 * 1024 * 1024) pending.delta?.(value.text); return; }
    this.pending.delete(value.id); pending.cleanup();
    if (value.type === 'result') pending.resolve(value.value);
    else pending.reject(new Error(typeof value.error === 'string' ? value.error : 'LiteLLM bridge failed'));
  }
  private failed(error: Error) { for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); } this.pending.clear(); }
  async call(operation: 'chat' | 'embeddings', payload: unknown, auth: { apiKey: string; baseUrl?: string }, signal: AbortSignal, delta?: (text: string) => void) {
    signal.throwIfAborted();
    // LiteLLM takes seconds to load; stopping the reply does not wait for it.
    let stopped!: () => void; const aborted = new Promise<never>((_, reject) => { stopped = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Bridge request cancelled')); signal.addEventListener('abort', stopped, { once: true }); });
    const status = await Promise.race([this.start(), aborted]).finally(() => signal.removeEventListener('abort', stopped));
    if (!status.available || !this.process) throw new Error(status.error || 'LiteLLM bridge is unavailable');
    signal.throwIfAborted(); const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const abort = () => { this.process?.stdin.write(JSON.stringify({ id, operation: 'cancel' }) + '\n'); this.pending.delete(id); reject(signal.reason instanceof Error ? signal.reason : new Error('Bridge request cancelled')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true }); this.pending.set(id, { resolve, reject, cleanup, delta, streamed: 0 });
      this.process!.stdin.write(JSON.stringify({ id, operation, payload, auth }) + '\n', error => { if (!error) return; const item = this.pending.get(id); this.pending.delete(id); item?.cleanup(); item?.reject(error); });
    });
  }
  stop(reason = new Error('LiteLLM bridge stopped')) { const child = this.process; this.process = undefined; this.ready = undefined; this.buffer = ''; this.failed(reason); child?.kill('SIGTERM'); }
}

export class LiteLlmBridgeService {
  private workers = new Map<string, { revision: number; worker: Worker }>();
  private readonly account: (id: string) => BridgeAccount | undefined;
  private readonly factory: ProcessFactory;
  // LiteLLM would otherwise fetch a price list from the network whenever it starts.
  constructor(account: (id: string) => BridgeAccount | undefined, factory: ProcessFactory = () => spawn(bridgePython(), ['-I', '-u', fileURLToPath(new URL('./worker.py', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C.UTF-8', LITELLM_LOCAL_MODEL_COST_MAP: 'True', ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}) },
  })) { this.account=account;this.factory=factory; }
  private bound(id: string, revision?: number) {
    const account = this.account(id); if (!account) throw new Error('Configure the LiteLLM account and key');
    if (revision !== undefined && revision !== account.revision) throw new Error('The LiteLLM account changed. Review and retry.');
    let entry = this.workers.get(id); if (entry && entry.revision !== account.revision) { entry.worker.stop(); this.workers.delete(id); entry = undefined; }
    if (!entry) { entry = { revision: account.revision, worker: new Worker(this.factory) }; this.workers.set(id, entry); }
    return { account, worker: entry.worker };
  }
  status(connectionId: string): Promise<BridgeStatus> { return this.bound(connectionId).worker.status(); }
  async chat(request: BridgeChatRequest, signal: AbortSignal, delta?: (text: string) => void) {
    const { account, worker } = this.bound(request.connectionId, request.connectionRevision), apiKey = account.apiKey(); if (!apiKey) throw new Error('Configure the LiteLLM account key');
    const { connectionId: _id, connectionRevision: _revision, ...payload } = request;
    const result = await worker.call('chat', { ...payload, ...(delta ? { stream: true } : {}) }, { apiKey, ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) }, signal, delta);
    if (!result || typeof result.text !== 'string' || result.text.length > 16 * 1024 * 1024 || !Array.isArray(result.toolCalls || []) || (result.toolCalls || []).length > 16) throw new Error('LiteLLM returned an invalid chat response');
    const toolCalls=(result.toolCalls || []).map((call:any)=>{if(typeof call?.name!=='string'||!call.name||typeof call.arguments!=='string'||call.arguments.length>1024*1024)throw new Error('LiteLLM returned an invalid tool call');return{id:typeof call.id==='string'&&call.id?call.id:'call_'+randomUUID().replaceAll('-','').slice(0,24),name:call.name,arguments:call.arguments};});
    const state = result.state && typeof result.state === 'object' && !Array.isArray(result.state) && JSON.stringify(result.state).length <= 1024 * 1024 ? result.state as Record<string, unknown> : undefined;
    const { state: _state, ...rest } = result;
    return { ...rest, toolCalls, ...(state && Object.keys(state).length ? { state } : {}) };
  }
  async embeddings(request: BridgeEmbeddingRequest, signal: AbortSignal) {
    const { account, worker } = this.bound(request.connectionId, request.connectionRevision), apiKey = account.apiKey(); if (!apiKey) throw new Error('Configure the LiteLLM account key');
    const { connectionId: _id, connectionRevision: _revision, ...payload } = request;
    const result = await worker.call('embeddings', payload, { apiKey, ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) }, signal), vectors = result?.vectors;
    if (!Array.isArray(vectors) || vectors.length !== request.input.length) throw new Error('LiteLLM returned an invalid embedding count');
    const dimension = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    if (!dimension || dimension > 16384 || vectors.some((v: unknown) => !Array.isArray(v) || v.length !== dimension || !v.every(Number.isFinite))) throw new Error('LiteLLM returned invalid embeddings');
    return { model: typeof result.model === 'string' ? result.model : request.model, vectors, dimension };
  }
  stop(connectionId?: string) { if (connectionId) { this.workers.get(connectionId)?.worker.stop(); this.workers.delete(connectionId); } else { for (const entry of this.workers.values()) entry.worker.stop(); this.workers.clear(); } return { stopped: true }; }
  close() { this.stop(); }
}
