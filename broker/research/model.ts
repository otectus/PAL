import { randomUUID } from 'node:crypto';
import type { Core } from '../core.ts';
import type { Session } from '../types.ts';
import { isCloudModel, ollamaJson } from '../ollama.ts';
import { taskOutput } from '../provider-completion.ts';
import { apiTextRequest } from '../api-providers.ts';
import { isApiProvider } from '../provider-catalog.ts';

export async function completeSessionTask(
  core: Core,
  session: Session,
  prompt: string,
  signal: AbortSignal,
  beforeRequest?: () => Promise<void>,
  format?: Record<string, unknown>,
  onTruncated?: () => void,
  kind = 'research',
  currentSession = () => core.store.session(session.id),
): Promise<string> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    options = session.modelOptions || {};
  const routeIdentity = (s: Session) =>
    JSON.stringify([
      s.provider,
      s.model,
      s.cwd,
      s.connectionId,
      s.connectionRevision,
      s.provider === 'ollama'
        ? s.ollama?.host || core.settings.ollama.host
        : s.provider === 'compatible'
          ? core.chatConnections.endpoint(s).baseUrl
          : '',
    ]);
  const initialRoute = routeIdentity(session);
  const checkRoute = () => {
    timeout.throwIfAborted();
    if (initialRoute !== routeIdentity(currentSession()))
      throw new Error('The conversation model or destination changed. Retry with the current settings.');
  };
  const authorize = async () => {
    checkRoute();
    await beforeRequest?.();
    checkRoute();
  };
  const record = (usage: Record<string, unknown>) =>
    core.store.db
      .prepare('INSERT INTO usage_records VALUES (?,?,?,?,?)')
      .run(
        randomUUID(),
        session.id,
        '',
        Date.now(),
        JSON.stringify({ calls: 1, kind, source: session.provider, model: session.model, ...usage }),
      );
  const messages = [{ role: 'user', content: prompt }];
  if (session.provider === 'ollama') {
    await authorize();
    const value: any = await ollamaJson(
      session.ollama?.host || core.settings.ollama.host,
      'chat',
      {
        model: session.model,
        stream: false,
        ...(format && !isCloudModel(session.model) ? { format } : {}),
        messages,
        options: { temperature: options.temperature, num_ctx: options.contextTokens, num_predict: options.maxOutputTokens },
        keep_alive: options.keepAlive,
      },
      timeout,
      300_000,
    );
    record({ inputTokens: value.prompt_eval_count, outputTokens: value.eval_count, status: 'reported' });
    if (value.done_reason === 'length') onTruncated?.();
    return String(value.message?.content || '').slice(0, 64_000);
  }
  const p = session.provider;
  if (!isApiProvider(p)) throw new Error('Choose an Ollama or managed API conversation for this request');
  core.usage.assertWithinBudget(p);
  const access=core.accountAccess(p,session.connectionId);
  const providerOptions = {...session.api?.options};
  // This worker checkpoints the response body itself. Provider background tickets have no report body.
  delete providerOptions.background;
  const value = await apiTextRequest(p, access, {
    model: session.model, input: prompt, maxOutputTokens: options.maxOutputTokens || 4096, options: providerOptions,
  }, timeout, {beforeAccept: checkRoute}, authorize);
  const output=taskOutput(value);
  record({...output.usage,status:output.usage.inputTokens!==undefined?'reported':'unknown'});
  if (output.finish==='output_limit') onTruncated?.();
  if (!['complete','output_limit'].includes(output.finish)) throw new Error('The provider ended the task with '+output.finish);
  return output.text.slice(0,64_000);
}

export function completeResearch(core: Core, session: Session, prompt: string, signal: AbortSignal,
  authorize: (() => Promise<void>) | undefined, format: Record<string, unknown> | undefined,
  onTruncated: (() => void) | undefined, currentSession: () => Session) {
  return completeSessionTask(core, session, prompt, signal, authorize, format, onTruncated, 'research', currentSession);
}
