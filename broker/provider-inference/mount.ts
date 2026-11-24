import type { Core } from '../core.ts';
import { routeAllowed, type ArtifactRef, type DestinationPolicy } from '../tools/contracts.ts';
import { huggingFaceTasks, type HuggingFaceInferenceRequest, type JsonInferenceInput, type MistralOcrRequest } from './contracts.ts';
import { ProviderInferenceService, type ProviderInferenceAccount } from './service.ts';

type Ref = { artifactId: string; versionId?: string };
type Authority = { sessionId: string; expectedSessionRevision: string; expectedProjectRevision: string; connectionId: string; connectionRevision: number };
export type MountedInferenceRequest = Authority & {
  task: HuggingFaceInferenceRequest['task']; model: string;
  inputs: { kind: 'text'; value: JsonInferenceInput } | { kind: 'artifacts'; items: Ref[] };
  parameters?: Record<string, unknown>; pooling?: HuggingFaceInferenceRequest['pooling']; normalize?: boolean; outputName?: string;
};
export type MountedOcrRequest = Authority & Omit<MistralOcrRequest, keyof Authority | 'file'> & { source: Ref; outputName?: string };

/** Core/remote mount: resolves broker-owned bytes, rechecks authority, and persists every result with provenance. */
export class ProviderInferenceMount {
  readonly core: Core;
  readonly service: ProviderInferenceService;
  constructor(core: Core) {
    this.core = core;
    this.service = new ProviderInferenceService({
      account: id => this.account(id),
      beforeDispatch: binding => this.account(binding.connectionId),
      dispatched: () => {},
    });
  }
  private account(id: string): ProviderInferenceAccount | undefined {
    let connection;
    try { connection = this.core.chatConnections.get(id); } catch { return undefined; }
    if (connection.kind !== 'huggingface' && connection.kind !== 'mistral') return undefined;
    const access = this.core.accountAccess(connection.kind, connection.id);
    return { id: connection.id, revision: connection.revision, provider: connection.kind, key: access.key, baseUrl: connection.compatible?.baseUrl };
  }
  private authority(p: Authority, provider: 'huggingface' | 'mistral', authorize?: () => void) {
    authorize?.();
    if (this.core.settings.paused) throw new Error('Provider inference is paused');
    const session = this.core.store.session(p.sessionId);
    if (session.temporary) throw new Error('Temporary conversations cannot keep provider inference results');
    if ((session.configRevision || '0') !== p.expectedSessionRevision) throw new Error('Conversation configuration changed. Review and retry.');
    const project = this.core.projects.list().find(project => project.cwd === session.cwd);
    if ((project?.revision || '0') !== p.expectedProjectRevision) throw new Error('Project settings changed. Review and retry.');
    const connection = this.core.chatConnections.get(p.connectionId, provider);
    if (connection.revision !== p.connectionRevision) throw new Error('The provider account changed. Review and retry.');
    return { session, connection };
  }
  private async inputs(p: MountedInferenceRequest, authorize?: () => void) {
    const checked = this.authority(p, 'huggingface', authorize), parents: ArtifactRef[] = [];
    if (p.inputs.kind === 'text') return { checked, value: p.inputs.value, parents, policy: { remote: true, cloud: true } satisfies DestinationPolicy };
    if (!Array.isArray(p.inputs.items) || !p.inputs.items.length || p.inputs.items.length > 8) throw new Error('Choose 1 to 8 artifact inputs');
    const values = [];
    for (const ref of p.inputs.items) {
      const { version, data } = await this.core.workbench.artifacts.bytes(p.sessionId, ref.artifactId, ref.versionId);
      if (!routeAllowed('cloud', version.policy)) throw new Error(`${version.name} does not allow cloud processing`);
      parents.push({ artifactId: version.artifactId, versionId: version.versionId, purpose: 'provider-inference-input' });
      values.push({ mime: version.mime, data });
    }
    return { checked, value: values.length === 1 ? values[0] : values, parents, policy: this.core.workbench.artifacts.inherit(p.sessionId, parents) };
  }
  private recheck(p: Authority, provider: 'huggingface' | 'mistral', parents: ArtifactRef[], authorize?: () => void) {
    this.authority(p, provider, authorize);
    for (const parent of parents) {
      const version = this.core.workbench.artifacts.version(p.sessionId, parent.artifactId, parent.versionId);
      if (!routeAllowed('cloud', version.policy)) throw new Error(`${version.name} no longer allows cloud processing`);
    }
  }
  async run(p: MountedInferenceRequest, signal: AbortSignal, authorize?: () => void) {
    const { value, parents, policy } = await this.inputs(p, authorize);
    this.recheck(p, 'huggingface', parents, authorize);
    const result = await this.service.run({ connectionId: p.connectionId, connectionRevision: p.connectionRevision, task: p.task, model: p.model, inputs: value,
      ...(p.parameters ? { parameters: p.parameters } : {}), ...(p.pooling ? { pooling: p.pooling } : {}), ...(p.normalize !== undefined ? { normalize: p.normalize } : {}) }, signal,
      () => this.recheck(p, 'huggingface', parents, authorize));
    this.recheck(p, 'huggingface', parents, authorize);
    const media = result.kind === 'media', bytes = media ? result.bytes : Buffer.from(JSON.stringify(result, null, 2)), mime = media ? result.mime : 'application/json';
    const extension = media ? mime.split('/')[1]?.replace('jpeg', 'jpg') || 'bin' : 'json';
    const version = await this.core.workbench.artifacts.install({ sessionId: p.sessionId, bytes, name: p.outputName || `${p.task} result.${extension}`, mime, source: media ? 'model-generation' : 'derived', policy,
      parents: parents.map(parent => ({ artifactId: parent.artifactId, versionId: parent.versionId, relation: 'provider-inference-input' })),
      provenance: { kind: 'provider-inference', provider: 'huggingface', connectionId: p.connectionId, connectionRevision: p.connectionRevision, model: p.model, task: p.task, servingProvider: result.servingProvider, processing: 'cloud' } });
    return { result: media ? { ...result, bytes: undefined, byteLength: bytes.length } : result, artifact: { artifactId: version.artifactId, versionId: version.versionId, purpose: 'provider-inference-result' } };
  }
  async ocr(p: MountedOcrRequest, signal: AbortSignal, authorize?: () => void) {
    this.authority(p, 'mistral', authorize);
    const { version: source, data } = await this.core.workbench.artifacts.bytes(p.sessionId, p.source.artifactId, p.source.versionId);
    if (!routeAllowed('cloud', source.policy)) throw new Error(`${source.name} does not allow cloud processing`);
    const parents: ArtifactRef[] = [{ artifactId: source.artifactId, versionId: source.versionId, purpose: 'ocr-source' }];
    this.recheck(p, 'mistral', parents, authorize);
    const { source: provenanceSource, ...result } = await this.service.mistralOcr({ connectionId: p.connectionId, connectionRevision: p.connectionRevision, model: p.model,
      file: { name: source.name, mime: source.mime, bytes: data }, pages: p.pages, tableFormat: p.tableFormat, includeImages: p.includeImages, includeBlocks: p.includeBlocks,
      extractHeader: p.extractHeader, extractFooter: p.extractFooter, confidence: p.confidence }, signal, () => this.recheck(p, 'mistral', parents, authorize));
    this.recheck(p, 'mistral', parents, authorize);
    const markdown = result.pages.map(page => `<!-- page:${page.index} -->\n${page.markdown}`).join('\n\n'), output = await this.core.workbench.artifacts.install({ sessionId: p.sessionId,
      bytes: Buffer.from(markdown), name: p.outputName || source.name.replace(/\.[^.]+$/, '') + ' OCR.md', mime: 'text/markdown', source: 'derived', policy: source.policy,
      parents: [{ artifactId: source.artifactId, versionId: source.versionId, relation: 'mistral-ocr-source' }], provenance: { kind: 'mistral-ocr', provider: 'mistral', connectionId: p.connectionId,
        connectionRevision: p.connectionRevision, model: result.model, processing: 'cloud', sourceSha256: provenanceSource.sha256, pages: result.pages.length } });
    return { result: { ...result, source: provenanceSource }, artifact: { artifactId: output.artifactId, versionId: output.versionId, purpose: 'ocr-markdown' } };
  }
  async rpc(method: string, p: any, signal = AbortSignal.timeout(5 * 60_000), authorize?: () => void) {
    if (method === 'providerInference.context') {
      const session = this.core.store.session(p.sessionId);
      const project = this.core.projects.list().find(row => row.cwd === session.cwd);
      const accounts = this.core.chatConnections.list();
      const current = accounts.find(row => row.id === session.connectionId);
      return {
        sessionRevision: session.configRevision || '0', projectRevision: project?.revision || '0',
        provider: session.provider, connectionName: current?.name, connectionId: current?.id, connectionRevision: current?.revision || 0,
        originalPdf: !session.temporary && ['openai','anthropic','google','xai'].includes(session.provider) && current?.variant !== 'vertex',
        tasks: huggingFaceTasks, accounts: accounts.filter(row => row.kind === 'huggingface' || row.kind === 'mistral')
          .map(({id, revision, kind, name}) => ({id, revision, kind, name})),
      };
    }
    if (method === 'providerInference.run') return this.run(p, signal, authorize);
    if (method === 'providerInference.mistralOcr') return this.ocr(p, signal, authorize);
    throw new Error('Unknown provider inference operation');
  }
}

