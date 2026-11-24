/** Preloaded into the UI check's own broker: accounts talk to local stand-ins, never to a real service. */
if (/broker\/main\.ts$/.test(process.argv[1] || '')) {
  const { Accounts } = await import('../../broker/accounts/service.ts'), { accountServices } = await import('./account-services.ts');
  const services = await accountServices(); services.server.unref();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone, at = (days: number, hour: number, minute = 0) => { const date = new Date(); date.setDate(date.getDate() + days); date.setHours(hour, minute, 0, 0); return date; };
  const day = (days: number) => { const date = at(days, 12); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  const event = (id: string, summary: string, start: any, end: any, more: any = {}) => services.state.events.set(id, { id, summary, start, end, etag: '"1"', status: 'confirmed', organizer: { self: true }, htmlLink: 'https://calendar.test/' + id, ...more });
  const timed = (date: Date) => ({ dateTime: date.toISOString(), timeZone: zone });
  event('planning', 'Planning', timed(at(0, 10)), timed(at(0, 11)), { location: 'Room 2', attendees: [{ email: 'anna@example.test' }, { email: 'ben@example.test' }], recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'], description: 'Bring the open questions.' });
  event('review', 'Release review', timed(at(1, 14, 30)), timed(at(1, 15)));
  event('trip', 'Team days', { date: day(2) }, { date: day(4) });
  const part = (text: string) => ({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } }] });
  const mail = (id: string, threadId: string, from: string, subject: string, text: string, labels: string[], minutes: number) => services.state.mail.set(id, { id, threadId, internalDate: String(Date.now() - minutes * 60000), labelIds: labels, snippet: text.slice(0, 90), payload: { ...part(text), headers: [{ name: 'From', value: from }, { name: 'To', value: 'me@example.test' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@example.test>` }] } });
  mail('m1', 't1', 'Anna Berg <anna@example.test>', 'Launch plan', 'Hello,\n\nthe plan is attached. Can we talk on Monday?\n\nAnna', ['UNREAD'], 12); mail('m2', 't2', 'Ben Ruiz <ben@example.test>', 'Budget', 'Approved as discussed.', [], 300);
  const file = (id: string, name: string, mimeType: string, content: string, size?: number) => services.state.files.set(id, { id, name, mimeType, size: String(size ?? content.length), headRevisionId: 'r1', modifiedTime: at(-2, 9).toISOString(), webViewLink: 'https://drive.test/' + id, capabilities: { canEdit: true }, content: Buffer.from(content) });
  file('folder', 'Projects', 'application/vnd.google-apps.folder', ''); file('plan', 'Launch plan', 'application/vnd.google-apps.document', '# Launch plan'); file('notes', 'notes.txt', 'text/plain', 'Notes of the meeting', 18400);
  services.state.tokens.add('ghp_1234567890'); services.state.devicePending = 0;
  services.state.issues.push({ number: 7, title: 'A bug', state: 'open', user: { login: 'someone' }, created_at: at(-3, 9).toISOString(), updated_at: at(-1, 9).toISOString(), body: 'Steps to see it.', html_url: 'https://github.test/o/r/issues/7', labels: [] });
  Accounts.defaults = { endpoints: services.endpoints as any, private: true, origins: services.origins as any };
  // OpenRouter's public lists, made up here; nothing else of it is reachable from the UI check.
  const real = globalThis.fetch, makers = ['Anthropic', 'Google', 'OpenAI', 'Mistral', 'Qwen'];
  const catalog = Array.from({ length: 40 }, (_, index) => ({ id: `${makers[index % 5].toLowerCase()}/model-${index}${index % 10 === 7 ? ':free' : ''}`, name: `${makers[index % 5]}: Model ${index}`, description: 'A model made up for the interface check.', context_length: index % 3 ? 131072 * (1 + index % 4) : 1048576,
    architecture: { input_modalities: index % 2 ? ['text'] : ['text', 'image', 'file'], output_modalities: ['text'] }, pricing: index % 10 === 7 ? { prompt: '0', completion: '0' } : { prompt: String((index + 1) / 4e6), completion: String((index + 1) / 1e6) },
    supported_parameters: ['max_tokens', 'temperature', ...(index % 4 ? ['tools', 'tool_choice'] : []), ...(index % 3 ? [] : ['reasoning'])], ...(index % 3 ? {} : { reasoning: { supported_efforts: ['high', 'medium', 'low'] } }), endpoints: index === 39 ? ['/api/v1/batches'] : ['/api/v1/chat/completions', '/api/v1/responses'], expiration_date: index === 3 ? '2027-01-31' : null }));
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith('https://openrouter.ai/')) return real(input, init);
    if (url.endsWith('/api/v1/models')) return Response.json({ data: catalog });
    if (/\/models\/[^/]+\/[^/]+\/endpoints$/.test(url)) return Response.json({ data: { endpoints: [{ provider_name: 'Anthropic', tag: 'anthropic', context_length: 1000000, max_completion_tokens: 64000, pricing: { prompt: '0.000003', completion: '0.000015' }, status: 0, uptime_last_1d: 99.9 }, { provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, quantization: 'fp8', status: -2 }] } });
    return Response.json({ error: { message: 'Not part of the interface check' } }, { status: 404 });
  }) as typeof fetch;
}
