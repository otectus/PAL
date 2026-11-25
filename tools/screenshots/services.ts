/**
 * Preloaded into the screenshot broker (tools/screenshots/run.sh): connected accounts talk to local stand-ins and
 * OpenRouter's public list is a made-up one, so account and model pages show content without any real service.
 */
if (/broker\/main\.ts$/.test(process.argv[1] || '')) {
  const { Accounts } = await import('../../broker/accounts/service.ts'), { accountServices } = await import('../../tests/fixtures/account-services.ts');
  const services = await accountServices(); services.server.unref();
  const { state } = services, zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = (days: number, hour: number, minute = 0) => { const date = new Date(); date.setDate(date.getDate() + days); date.setHours(hour, minute, 0, 0); return date; };
  const timed = (date: Date) => ({ dateTime: date.toISOString(), timeZone: zone });
  const event = (id: string, summary: string, start: any, end: any, more: any = {}) => state.events.set(id, { id, summary, start, end, etag: '"1"', status: 'confirmed', organizer: { self: true }, htmlLink: 'https://calendar.test/' + id, ...more });
  event('standup', 'Standup', timed(at(1, 9, 30)), timed(at(1, 9, 45)), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] });
  event('review', 'Release 2.4 review', timed(at(1, 14)), timed(at(1, 15)), { location: 'Room 2', attendees: [{ email: 'priya@example.test' }, { email: 'marcus@example.test' }], description: 'Walk through the drafts change.' });
  event('dentist', 'Dentist', timed(at(2, 8, 15)), timed(at(2, 9)));
  event('retro', 'Sprint retrospective', timed(at(3, 16)), timed(at(3, 17)));
  const mail = (id: string, from: string, subject: string, text: string, labels: string[], minutes: number) => state.mail.set(id, { id, threadId: 't-' + id, internalDate: String(Date.now() - minutes * 60_000), labelIds: labels, snippet: text.slice(0, 90),
    payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } }], headers: [{ name: 'From', value: from }, { name: 'To', value: 'demo@example.test' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@example.test>` }] } });
  mail('m1', 'Priya Nair <priya@example.test>', 'Settings page: last two panels', 'The last two panels are ready for review.', ['UNREAD'], 14);
  mail('m2', 'Marcus Bell <marcus@example.test>', 'SSO on staging', 'The staging identity provider accepts our metadata now.', [], 190);
  state.login = 'demo@example.test'; state.tokens.add('ghp_demo_token'); state.devicePending = 0;
  Accounts.defaults = { endpoints: services.endpoints as any, private: true, origins: services.origins as any };
  // Models and prices of makers that do not exist.
  const model = (id: string, name: string, context: number, input: number, output: number, inputs: string[], extra: string[] = []) => ({ id, name, description: 'A model made up for the screenshots.', context_length: context,
    architecture: { input_modalities: inputs, output_modalities: ['text'] }, pricing: { prompt: String(input / 1e6), completion: String(output / 1e6) }, supported_parameters: ['max_tokens', 'temperature', ...extra],
    ...(extra.includes('reasoning') ? { reasoning: { supported_efforts: ['high', 'medium', 'low'] } } : {}), endpoints: ['/api/v1/chat/completions', '/api/v1/responses'] });
  const tools = ['tools', 'tool_choice'], catalog = [
    model('northwind/aurora-large', 'Northwind: Aurora Large', 1_048_576, 3, 15, ['text', 'image', 'file'], [...tools, 'reasoning']),
    model('northwind/aurora-mini', 'Northwind: Aurora Mini', 262_144, 0.25, 1.25, ['text', 'image'], tools),
    model('tidewater/heron-2', 'Tidewater: Heron 2', 524_288, 1.2, 4.8, ['text'], [...tools, 'reasoning']),
    model('tidewater/heron-2-vision', 'Tidewater: Heron 2 Vision', 262_144, 1.6, 6.4, ['text', 'image'], tools),
    model('fjord/kestrel-70b', 'Fjord: Kestrel 70B', 131_072, 0.4, 0.8, ['text'], tools),
    model('fjord/kestrel-8b:free', 'Fjord: Kestrel 8B (free)', 131_072, 0, 0, ['text']),
    model('lumen/quill-3', 'Lumen: Quill 3', 400_000, 2, 10, ['text', 'file'], [...tools, 'reasoning']),
    ...['Basalt', 'Cinder', 'Delta', 'Ember', 'Flint', 'Garnet'].map((name, index) => model(`harbor/${name.toLowerCase()}`, `Harbor: ${name}`, 65_536 * (index + 1), 0.2 * (index + 1), 0.8 * (index + 1), index % 2 ? ['text', 'image'] : ['text'], index % 3 ? tools : [])),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith('https://openrouter.ai/')) return real(input, init);
    return url.endsWith('/api/v1/models') ? Response.json({ data: catalog }) : Response.json({ error: { message: 'Not part of the demo' } }, { status: 404 });
  }) as typeof fetch;
}
