/** Google Calendar, Gmail and Drive through their REST APIs. */
import { AccountError, accountLimits, failure } from './http.ts';
import { asker, eventId, messageId, type CalendarAdapter, type Credentials, type DriveAdapter, type DriveItem, type Identity, type MailAdapter, type WriteContext } from './adapter.ts';
import { describeRule, rrule, type CalendarEvent, type EventInput, type EventTime } from './events.ts';
import { compose, htmlText, parseAddresses, decodeHeader, shown, type MailMessage } from './mail.ts';

export const googleOrigins = { api: 'https://www.googleapis.com', mail: 'https://gmail.googleapis.com', identity: 'https://openidconnect.googleapis.com' };
const query = (base: string, params: Record<string, string | number | boolean | undefined>) => { const url = new URL(base); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value)); return url.href; };
export async function googleIdentity(credentials: Credentials, origins = googleOrigins, signal?: AbortSignal): Promise<Identity> { const { value } = await asker(credentials)({ url: `${origins.identity}/v1/userinfo`, ...(signal ? { signal } : {}) }); return { subject: String(value.sub), login: String(value.email || value.sub) }; }

export function googleCalendar(credentials: Credentials, origins = googleOrigins): CalendarAdapter {
  const ask = asker(credentials), base = `${origins.api}/calendar/v3`, path = (calendar: string) => `${base}/calendars/${encodeURIComponent(calendar)}/events`;
  const time = (value: any): EventTime => value?.date ? { date: value.date } : { dateTime: String(value?.dateTime || '').slice(0, 19), timeZone: value?.timeZone || 'UTC' };
  // A time with an offset is shown in the event's own zone, as the calendar shows it.
  const local = (value: any): EventTime => { if (value?.date) return { date: value.date }; const zone = value?.timeZone || 'UTC', at = new Date(String(value?.dateTime || '')); if (Number.isNaN(at.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime)) return time(value); const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(part => [part.type, part.value])); return { dateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`, timeZone: zone }; };
  const event = (calendarId: string, item: any): CalendarEvent => ({ id: item.id, calendarId, title: String(item.summary || '(no title)').slice(0, 300), start: local(item.start), end: local(item.end), allDay: !!item.start?.date, ...(item.location ? { location: String(item.location).slice(0, 500) } : {}), ...(item.description ? { notes: htmlText(String(item.description)).slice(0, 8000) } : {}), attendees: (item.attendees || []).slice(0, 100).map((a: any) => ({ email: a.email, ...(a.displayName ? { name: a.displayName } : {}), ...(a.responseStatus ? { answer: a.responseStatus } : {}) })),
    ...(item.recurrence?.length ? { recurrence: item.recurrence.map(describeRule).join('; ') } : {}), ...(item.recurringEventId ? { seriesId: item.recurringEventId } : {}), ...(item.organizer?.email ? { organizer: item.organizer.email } : {}), ...(item.status === 'cancelled' ? { cancelled: true } : {}), ...(item.htmlLink ? { link: item.htmlLink } : {}), revision: item.etag || '', canEdit: item.organizer?.self !== false || item.guestsCanModify === true });
  const body = (input: EventInput) => ({ summary: input.title, start: input.start, end: input.end, location: input.location ?? '', description: input.notes ?? '', ...(input.attendees ? { attendees: input.attendees.map(email => ({ email })) } : {}), ...(input.recurrence !== undefined ? { recurrence: input.recurrence ? [rrule(input.recurrence)] : [] } : {}) });
  const written = (item: any) => ({ id: item.id, ...(item.htmlLink ? { link: item.htmlLink } : {}), ...(item.etag ? { revision: item.etag } : {}) });
  return {
    async calendars(signal) { const { value } = await ask({ url: query(`${base}/users/me/calendarList`, { maxResults: 100 }), ...(signal ? { signal } : {}) }); return (value.items || []).map((item: any) => ({ id: item.id, name: item.summaryOverride || item.summary || item.id, primary: item.primary === true, canEdit: ['owner', 'writer'].includes(item.accessRole), ...(item.timeZone ? { timeZone: item.timeZone } : {}) })); },
    async agenda(p, signal) { const calendar = p.calendarId || 'primary', { value } = await ask({ url: query(path(calendar), { singleEvents: true, orderBy: 'startTime', timeMin: new Date(p.from).toISOString(), timeMax: new Date(p.to).toISOString(), maxResults: p.limit }), ...(signal ? { signal } : {}) }); return (value.items || []).filter((item: any) => item.status !== 'cancelled').map((item: any) => event(calendar, item)); },
    async event(calendar, id, signal) { return event(calendar, (await ask({ url: `${path(calendar)}/${encodeURIComponent(id)}`, ...(signal ? { signal } : {}) })).value); },
    // The event's ID is chosen here, so asking twice can only make one event.
    async create(calendar, input, context) {
      try { return written((await ask({ method: 'POST', url: query(path(calendar), { sendUpdates: input.attendees?.length ? 'all' : 'none' }), json: { id: eventId(context.key), ...body(input) }, ...(context.signal ? { signal: context.signal } : {}) })).value); }
      catch (error) { const found = error instanceof AccountError && error.status === 409 ? await this.created(calendar, context) : undefined; if (found) return found; throw error; }
    },
    async update(calendar, id, input, revision, context) { return written((await ask({ method: 'PATCH', url: query(`${path(calendar)}/${encodeURIComponent(id)}`, { sendUpdates: input.attendees?.length ? 'all' : 'none' }), json: body(input), headers: { 'If-Match': revision }, ...(context.signal ? { signal: context.signal } : {}) })).value); },
    async remove(calendar, id, revision, context) { await ask({ method: 'DELETE', url: query(`${path(calendar)}/${encodeURIComponent(id)}`, { sendUpdates: 'all' }), headers: { 'If-Match': revision }, ...(context.signal ? { signal: context.signal } : {}) }); return { id }; },
    async created(calendar, context) { try { const { value } = await ask({ url: `${path(calendar)}/${eventId(context.key)}`, ...(context.signal ? { signal: context.signal } : {}) }); return value.status === 'cancelled' ? undefined : written(value); } catch (error) { if (error instanceof AccountError && error.code === 'NOT_FOUND') return undefined; throw error; } },
  };
}

export function googleMail(credentials: Credentials, origins = googleOrigins): MailAdapter {
  const ask = asker(credentials), base = `${origins.mail}/gmail/v1/users/me`, signalOf = (signal?: AbortSignal) => signal ? { signal } : {};
  const field = (payload: any, name: string) => (payload?.headers || []).find((item: any) => String(item.name).toLowerCase() === name)?.value as string | undefined;
  const parts = (payload: any): any[] => payload ? [payload, ...(payload.parts || []).flatMap(parts)] : [];
  const decode = (part: any) => { const charset = /charset="?([\w-]+)/i.exec(String((part.headers || []).find((item: any) => String(item.name).toLowerCase() === 'content-type')?.value || ''))?.[1] || 'utf-8', bytes = Buffer.from(part.body?.data || '', 'base64url'); try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); } };
  const message = (item: any): MailMessage => {
    const all = parts(item.payload), plain = all.find(part => part.mimeType === 'text/plain' && part.body?.data && !part.filename), html = all.find(part => part.mimeType === 'text/html' && part.body?.data && !part.filename), raw = plain ? decode(plain) : html ? htmlText(decode(html)) : String(item.snippet || '');
    const references = (field(item.payload, 'references') || '').match(/<[^<>\s]+>/g) || [];
    return { id: item.id, threadId: item.threadId, ...(parseAddresses(field(item.payload, 'from'))[0] ? { from: parseAddresses(field(item.payload, 'from'))[0] } : {}), to: parseAddresses(field(item.payload, 'to')), cc: parseAddresses(field(item.payload, 'cc')), date: Number(item.internalDate) || 0, subject: decodeHeader(field(item.payload, 'subject') || '(no subject)').slice(0, 300), ...shown(raw), unread: (item.labelIds || []).includes('UNREAD'), draft: (item.labelIds || []).includes('DRAFT'),
      attachments: all.filter(part => part.filename && part.body?.attachmentId).slice(0, 30).map(part => ({ id: part.body.attachmentId, name: decodeHeader(part.filename).slice(0, 200), mime: String(part.mimeType), bytes: Number(part.body.size) || 0 })), ...(field(item.payload, 'message-id') ? { messageId: field(item.payload, 'message-id') } : {}), ...(references.length ? { references } : {}) };
  };
  const raw = async (mail: Parameters<MailAdapter['send']>[0], context: WriteContext) => {
    let reply: { inReplyTo?: string; references?: string[] } = {};
    if (mail.reply) { const source = message((await ask({ url: query(`${base}/messages/${encodeURIComponent(mail.reply.messageId)}`, { format: 'full' }), ...signalOf(context.signal) })).value); if (source.threadId !== mail.reply.threadId) throw new Error('This message is not in that conversation'); reply = { ...(source.messageId ? { inReplyTo: source.messageId } : {}), ...(source.references ? { references: source.references } : {}) }; }
    return { raw: compose(mail, { messageId: messageId(context.key), date: new Date(context.started), ...reply }).toString('base64url'), ...(mail.reply ? { threadId: mail.reply.threadId } : {}) };
  };
  return {
    async search(q, limit, signal) {
      const { value } = await ask({ url: query(`${base}/threads`, { q, maxResults: limit }), ...signalOf(signal) });
      return (await Promise.all((value.threads || []).slice(0, limit).map(async (item: any) => {
        const thread = (await ask({ url: `${base}/threads/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, ...signalOf(signal) })).value, last = thread.messages?.at(-1);
        return last ? { id: item.id, threadId: item.id, ...(parseAddresses(field(last.payload, 'from'))[0] ? { from: parseAddresses(field(last.payload, 'from'))[0] } : {}), date: Number(last.internalDate) || 0, subject: decodeHeader(field(thread.messages[0].payload, 'subject') || '(no subject)').slice(0, 300), snippet: htmlText(String(last.snippet || '')).slice(0, 300), unread: thread.messages.some((m: any) => (m.labelIds || []).includes('UNREAD')) } : undefined;
      }))).filter(Boolean) as any;
    },
    async thread(id, signal) { const { value } = await ask({ url: query(`${base}/threads/${encodeURIComponent(id)}`, { format: 'full' }), ...signalOf(signal) }); return (value.messages || []).slice(-50).map(message); },
    async attachment(id, attachment, signal) { const { value } = await ask({ url: `${base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}`, ...signalOf(signal) }); return Buffer.from(value.data || '', 'base64url'); },
    async draft(mail, context) { const { value } = await ask({ method: 'POST', url: `${base}/drafts`, json: { message: await raw(mail, context) }, ...signalOf(context.signal) }); return { id: value.id }; },
    async send(mail, context) { const { value } = await ask({ method: 'POST', url: `${base}/messages/send`, json: await raw(mail, context), ...signalOf(context.signal) }); return { id: value.id }; },
    async sent(context) { const { value } = await ask({ url: query(`${base}/messages`, { q: `rfc822msgid:${messageId(context.key).slice(1, -1)}`, maxResults: 1 }), ...signalOf(context.signal) }); const found = value.messages?.[0]; return found ? { id: found.id } : undefined; },
  };
}

export function googleDrive(credentials: Credentials, origins = googleOrigins): DriveAdapter {
  const ask = asker(credentials), base = `${origins.api}/drive/v3/files`, upload = `${origins.api}/upload/drive/v3/files`, fields = 'id,name,mimeType,size,modifiedTime,webViewLink,version,headRevisionId,capabilities(canEdit)', signalOf = (signal?: AbortSignal) => signal ? { signal } : {};
  const documents: Record<string, [string, string]> = { 'application/vnd.google-apps.document': ['text/markdown', '.md'], 'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'], 'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'], 'application/vnd.google-apps.drawing': ['image/png', '.png'] };
  const item = (value: any): DriveItem => ({ id: value.id, name: String(value.name || 'Untitled').slice(0, 300), mime: String(value.mimeType), folder: value.mimeType === 'application/vnd.google-apps.folder', ...(value.size ? { bytes: Number(value.size) } : {}), ...(value.modifiedTime ? { modified: Date.parse(value.modifiedTime) } : {}), ...(value.webViewLink ? { link: value.webViewLink } : {}), revision: value.headRevisionId || value.version || '', canEdit: value.capabilities?.canEdit === true && !String(value.mimeType).startsWith('application/vnd.google-apps.'), ...(documents[value.mimeType] ? { exported: documents[value.mimeType][0] } : {}) });
  const literal = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  const list = async (q: string, limit: number, signal?: AbortSignal) => ((await ask({ url: query(base, { q, pageSize: limit, orderBy: 'modifiedTime desc', fields: `files(${fields})`, supportsAllDrives: true, includeItemsFromAllDrives: true }), ...signalOf(signal) })).value.files || []).map(item);
  const bytes = async (url: string, signal?: AbortSignal) => { const reply = await credentials.http.raw({ url, token: await credentials.token(signal), maxBytes: accountLimits.fileBytes, timeoutMs: accountLimits.fileTimeoutMs, headers: { Accept: '*/*' }, ...signalOf(signal) }); if (reply.status !== 200) throw failure({ url }, reply); return reply.body; };
  const multipart = (metadata: unknown, mime: string, content: Buffer) => { const boundary = 'pal-' + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'); return { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--`)]) }; };
  const written = (value: any) => ({ id: value.id, ...(value.webViewLink ? { link: value.webViewLink } : {}), ...(value.headRevisionId ? { revision: value.headRevisionId } : {}) });
  return {
    search: (text, limit, signal) => list(`trashed = false and (name contains ${literal(text)} or fullText contains ${literal(text)})`.slice(0, 2000), limit, signal),
    list: (folder, limit, signal) => list(`trashed = false and ${literal(folder || 'root')} in parents`, limit, signal),
    async item(id, signal) { return item((await ask({ url: query(`${base}/${encodeURIComponent(id)}`, { fields, supportsAllDrives: true }), ...signalOf(signal) })).value); },
    async download(file, signal) {
      if (file.folder) throw new Error('Choose a file, not a folder');
      const as = documents[file.mime];
      if (as) return { bytes: await bytes(query(`${base}/${encodeURIComponent(file.id)}/export`, { mimeType: as[0] }), signal), name: file.name + as[1], mime: as[0] };
      if (file.mime.startsWith('application/vnd.google-apps.')) throw new Error('Google offers no file for this kind of document');
      if ((file.bytes || 0) > accountLimits.fileBytes) throw new Error('This file is larger than PAL imports (50 MB)');
      return { bytes: await bytes(query(`${base}/${encodeURIComponent(file.id)}`, { alt: 'media', supportsAllDrives: true }), signal), name: file.name, mime: file.mime };
    },
    // The file's ID is asked for first, so a repeated upload can only make one file.
    async create(p, context) {
      const id = (await ask({ url: query(`${base}/generateIds`, { count: 1, space: 'drive' }), ...signalOf(context.signal) })).value.ids?.[0];
      const { value } = await ask({ method: 'POST', url: query(upload, { uploadType: 'multipart', fields, supportsAllDrives: true }), ...multipart({ id, name: p.name, mimeType: p.mime, appProperties: { pal: context.key }, ...(p.folderId ? { parents: [p.folderId] } : {}) }, p.mime, p.bytes), timeoutMs: accountLimits.fileTimeoutMs, ...signalOf(context.signal) });
      return written(value);
    },
    async update(id, p, context) {
      const now = await this.item(id, context.signal); if (now.revision !== p.revision) throw new Error('This file changed since it was read. Open it again before writing a new version.');
      const { value } = await ask({ method: 'PATCH', url: query(`${upload}/${encodeURIComponent(id)}`, { uploadType: 'media', fields, supportsAllDrives: true }), headers: { 'Content-Type': p.mime }, body: p.bytes, timeoutMs: accountLimits.fileTimeoutMs, ...signalOf(context.signal) });
      return written(value);
    },
    async created(_p, context) { const found = (await ask({ url: query(base, { q: `appProperties has { key='pal' and value='${context.key.replace(/[^0-9a-f-]/g, '')}' }`, pageSize: 1, fields: `files(${fields})` }), ...signalOf(context.signal) })).value.files?.[0]; return found ? written(found) : undefined; },
  };
}
