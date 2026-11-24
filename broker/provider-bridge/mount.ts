import type { Core } from '../core.ts';
import type { BridgeChatRequest, BridgeEmbeddingRequest } from './contracts.ts';
import { LiteLlmBridgeService } from './service.ts';
import { BridgeRuntime } from './runtime.ts';

type Authority = { sessionId: string; expectedSessionRevision: string; expectedProjectRevision: string; connectionId: string; connectionRevision: number };
export class ProviderBridgeMount {
  readonly service: LiteLlmBridgeService;
  readonly runtime: BridgeRuntime;
  private readonly core: Core;
  constructor(core: Core) {
    this.core=core;
    this.runtime = new BridgeRuntime(() => { if (!core.closed) core.changed(); }, () => this.service.stop());
    this.service = new LiteLlmBridgeService(id => {
      let connection; try { connection = core.chatConnections.get(id, 'litellm'); } catch { return undefined; }
      const access = core.accountAccess('litellm', id);
      return { id, revision: connection.revision, apiKey: access.key, ...(connection.variant === 'bridge' ? {} : { baseUrl: connection.compatible?.baseUrl }) };
    });
  }
  private authorize(p: Authority, check?: () => void) {
    check?.(); if (this.core.settings.paused) throw new Error('Provider bridge is paused');
    const session = this.core.store.session(p.sessionId); if (session.temporary) throw new Error('Temporary conversations cannot use the provider bridge');
    if ((session.configRevision || '0') !== p.expectedSessionRevision) throw new Error('Conversation configuration changed. Review and retry.');
    const project = this.core.projects.list().find(project => project.cwd === session.cwd);
    if ((project?.revision || '0') !== p.expectedProjectRevision) throw new Error('Project settings changed. Review and retry.');
    const connection = this.core.chatConnections.get(p.connectionId, 'litellm');
    if (connection.revision !== p.connectionRevision) throw new Error('The LiteLLM account changed. Review and retry.');
  }
  async rpc(method: string, p: any, signal = AbortSignal.timeout(5 * 60_000), check?: () => void) {
    // The environment is the desktop's own: no phone or model installs or removes it.
    if (method === 'providerBridge.runtime') return this.runtime.status();
    if (method === 'providerBridge.install') return this.runtime.install(p);
    if (method === 'providerBridge.remove') return this.runtime.remove(p);
    if (method === 'providerBridge.cancel') return this.runtime.cancel();
    if (method === 'providerBridge.status') { check?.(); return this.service.status(p.connectionId); }
    if (method === 'providerBridge.stop') { check?.(); return this.service.stop(p.connectionId); }
    if (method === 'providerBridge.chat') { this.authorize(p, check); const result = await this.service.chat(p as BridgeChatRequest, signal); this.authorize(p, check); return result; }
    if (method === 'providerBridge.embeddings') { this.authorize(p, check); const result = await this.service.embeddings(p as BridgeEmbeddingRequest, signal); this.authorize(p, check); return result; }
    throw new Error('Unknown provider bridge operation');
  }
  close() { this.service.close(); void this.runtime.close(); }
}
