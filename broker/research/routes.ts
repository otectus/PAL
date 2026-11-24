import type { Core } from '../core.ts';
import type { ModelOption, Session } from '../types.ts';
import { apiProviders, providerLabels, type ApiProvider } from '../provider-catalog.ts';
import { z } from 'zod';

const researchProviders: ['ollama', ...ApiProvider[]] = ['ollama', ...apiProviders];
type ResearchProvider = (typeof researchProviders)[number];
function supported(provider: string): provider is ResearchProvider {
  return (researchProviders as readonly string[]).includes(provider);
}
export const routeFields = {
  provider: z.enum(researchProviders).optional(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[^\x00-\x1f\x7f]+$/)
    .optional(),
  connectionId: z.uuid().optional(),
};
type Choice = { provider?: ResearchProvider; model?: string; connectionId?: string };
export type ResearchBinding = Required<Pick<Choice, 'provider' | 'model'>> & {
  connectionId?: string;
  connectionRevision?: number;
  ollamaHost?: string;
  compatibleUrl?: string;
  modelOptions?: Session['modelOptions'];
  apiOptions?: Record<string, unknown>;
};

export function bindResearch(core: Core, owner: Session, choice: Choice): ResearchBinding {
  const provider = choice.provider ?? owner.provider;
  if (!supported(provider)) throw new Error('Select an Ollama or managed API model for research');
  const inherit = !choice.provider && !choice.connectionId;
  const connectionId = inherit ? owner.connectionId : choice.connectionId;
  const connection = connectionId ? core.chatConnections.get(connectionId) : undefined;
  if (connection && provider !== connection.kind)
    throw new Error('The selected connection belongs to another provider');
  const model = choice.model || (inherit ? owner.model : '');
  if (!model) throw new Error('Select a research model');
  const same = provider === owner.provider && model === owner.model && connectionId === owner.connectionId;
  const binding: ResearchBinding = {
    provider,
    model,
    connectionId,
    connectionRevision: connection?.revision,
    modelOptions: same ? owner.modelOptions : undefined,
    apiOptions: same ? owner.api?.options : undefined,
  };
  if (provider === 'ollama') {
    binding.ollamaHost =
      connection?.ollama?.host || (inherit ? owner.ollama?.host : undefined) || core.settings.ollama.host;
    const catalog = core.capabilities.ollama;
    if (
      binding.ollamaHost === core.settings.ollama.host &&
      catalog?.modelsStatus === 'ready' &&
      !catalog.models.some((entry: ModelOption) => entry.id === model)
    )
      throw new Error('Choose an available Ollama chat model');
  } else if (provider === 'compatible') {
    const endpoint = connection?.compatible || core.settings.compatible;
    if (!endpoint.baseUrl) throw new Error('Configure the compatible endpoint before starting research');
    binding.compatibleUrl = endpoint.baseUrl;
  }
  return binding;
}

export function researchSession(core: Core, owner: Session, binding: ResearchBinding): Session {
  if (binding.connectionId && core.chatConnections.get(binding.connectionId).revision !== binding.connectionRevision)
    throw new Error('The research connection changed. Start a new run to approve the updated destination.');
  const routed = {
    ...owner,
    provider: binding.provider,
    model: binding.model,
    modelOptions: binding.modelOptions,
    api: binding.provider === 'ollama' ? undefined : { tools: false, options: binding.apiOptions },
    connectionId: binding.connectionId,
    connectionRevision: binding.connectionRevision,
    ollama: binding.ollamaHost ? { host: binding.ollamaHost, tools: false } : undefined,
  };
  if (binding.provider === 'compatible' && core.chatConnections.endpoint(routed).baseUrl !== binding.compatibleUrl)
    throw new Error('The research endpoint changed. Start a new run with the updated destination.');
  return routed;
}

type RouteRow = { provider: ResearchBinding['provider']; model: string; connectionId?: string; label: string };
export async function researchRoutes(core: Core, owner: Session) {
  const groups: Promise<RouteRow[]>[] = [];
  function group(
    provider: RouteRow['provider'],
    label: string,
    load: () => Promise<ModelOption[]>,
    connectionId?: string,
  ) {
    groups.push(
      load().then((models) => {
        const choices = models.map((m) => ({
          provider,
          model: m.id,
          connectionId,
          label: label + ' · ' + (m.displayName || m.id),
        }));
        if (provider !== 'ollama' && !choices.length)
          choices.push({ provider, model: '', connectionId, label: label + ' · Enter model ID' });
        return choices;
      }),
    );
  }
  const cached = (provider: RouteRow['provider']) =>
    core.capabilities[provider]?.modelsStatus === 'ready'
      ? Promise.resolve(core.capabilities[provider].models as ModelOption[])
      : core.refreshProviderModels(provider);
  group('ollama', 'Ollama', () => cached('ollama'));
  for (const p of researchProviders) {
    if (p === 'ollama') continue;
    if (p === 'compatible' ? !core.settings.compatible.baseUrl : !core.credentials.key(p)) continue;
    group(p, providerLabels[p], () => cached(p));
  }
  for (const conn of core.chatConnections.list().filter((c) => !c.migrated)) {
    if (supported(conn.kind))
      group(conn.kind, conn.name, async () => (await core.rpc('connections.models', { id: conn.id })).models, conn.id);
  }
  const rows = (await Promise.allSettled(groups)).flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
  if (supported(owner.provider) && owner.model) {
    const current = rows.findIndex(
      (r) => r.provider === owner.provider && r.model === owner.model && r.connectionId === owner.connectionId,
    );
    if (current >= 0) rows.unshift(...rows.splice(current, 1));
    else if (owner.provider !== 'ollama' || owner.connectionId || owner.ollama?.host === core.settings.ollama.host)
      rows.unshift({
        provider: owner.provider,
        model: owner.model,
        connectionId: owner.connectionId,
        label: providerLabels[owner.provider] + ' · ' + owner.model,
      });
  }
  return rows;
}
