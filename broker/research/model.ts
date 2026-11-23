import { randomUUID } from 'node:crypto';
import type { Core } from '../core.ts';
import type { Session } from '../types.ts';
import { ollamaJson } from '../ollama.ts';
import { apiJson } from '../api-providers.ts';
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
    if (initialRoute !== routeIdentity(core.store.session(session.id)))
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
        ...(format ? { format, think: false } : {}),
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
  const access = core.apiAccess(p, session.id);
  const max = options.maxOutputTokens || 4096;
  const [path, body] =
    p === 'openai'
      ? ['responses', { model: session.model, store: false, input: prompt, max_output_tokens: max }]
      : p === 'anthropic'
        ? ['messages', { model: session.model, messages, max_tokens: max }]
        : p === 'google'
          ? [
              'models/' + encodeURIComponent(session.model) + ':generateContent',
              { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max } },
            ]
          : ['chat/completions', { model: session.model, messages, max_tokens: max, stream: false }];
  const value = await apiJson(
    p,
    access,
    String(path),
    body,
    timeout,
    { beforeAccept: checkRoute },
    2 * 1024 * 1024,
    authorize,
  );
  if (
    value.status === 'incomplete' ||
    value.stop_reason === 'max_tokens' ||
    value.candidates?.[0]?.finishReason === 'MAX_TOKENS' ||
    value.choices?.[0]?.finish_reason === 'length'
  )
    onTruncated?.();
  const u = value.usage || value.usageMetadata || {};
  record({
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount,
    status: 'reported',
  });
  const text =
    p === 'openai'
      ? (value.output || [])
          .flatMap((i: any) => i.content || [])
          .filter((i: any) => i.type === 'output_text')
          .map((i: any) => i.text)
          .join('\n')
      : p === 'anthropic'
        ? (value.content || [])
            .filter((i: any) => i.type === 'text')
            .map((i: any) => i.text)
            .join('\n')
        : p === 'google'
          ? (value.candidates?.[0]?.content?.parts || [])
              .filter((i: any) => !i.thought)
              .map((i: any) => i.text)
              .join('\n')
          : value.choices?.[0]?.message?.content;
  return String(text || '').slice(0, 64_000);
}

export { completeSessionTask as completeResearch };
