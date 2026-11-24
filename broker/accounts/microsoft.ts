/** Outlook calendar, mail and OneDrive through Microsoft Graph. */
import { AccountError, accountLimits, failure } from './http.ts';
import { asker, messageId, type CalendarAdapter, type Credentials, type DriveAdapter, type DriveItem, type Identity, type MailAdapter, type WriteContext } from './adapter.ts';
import { graphRecurrence, type CalendarEvent, type EventInput, type EventTime } from './events.ts';
import { htmlText, shown, type MailMessage, type Outgoing } from './mail.ts';

export const graphOrigin = 'https://graph.microsoft.com';
const query = (base: string, params: Record<string, string | number | undefined>) => { const url = new URL(base); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value)); return url.href.replaceAll('+', '%20'); };
const signalOf = (signal?: AbortSignal) => signal ? { signal } : {};
export async function microsoftIdentity(credentials: Credentials, origin = graphOrigin, signal?: AbortSignal): Promise<Identity> { const { value } = await asker(credentials)({ url: `${origin}/v1.0/me`, ...signalOf(signal) }); return { subject: String(value.id), login: String(value.mail || value.userPrincipalName || value.id) }; }

export function microsoftCalendar(credentials: Credentials, origin = graphOrigin): CalendarAdapter {
  const ask = asker(credentials), base = `${origin}/v1.0/me`, events = (calendar: string) => calendar === 'primary' ? `${base}/calendar/events` : `${base}/calendars/${encodeURIComponent(calendar)}/events`, select = 'id,subject,start,end,isAllDay,location,bodyPreview,body,attendees,recurrence,seriesMasterId,organizer,isOrganizer,isCancelled,webLink,changeKey,originalStartTimeZone,transactionId';
  const headers = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };
  const at = (value: any, allDay: boolean, zone?: string): EventTime => {
    const utc = String(value?.dateTime || '').slice(0, 19); if (allDay) return { date: utc.slice(0, 10) };
    let name = zone && zone !== 'UTC' ? zone : 'UTC'; try { new Intl.DateTimeFormat('en', { timeZone: name }); } catch { name = 'UTC'; }
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utc + 'Z')).map(part => [part.type, part.value]));
    return { dateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`, timeZone: name };
  };
  const repeats = (r: any) => { if (!r?.pattern) return undefined; const unit = { daily: 'day', weekly: 'week', absoluteMonthly: 'month', relativeMonthly: 'month', absoluteYearly: 'year', relativeYearly: 'year' }[r.pattern.type as string] || r.pattern.type; return `Every ${r.pattern.interval === 1 ? unit : `${r.pattern.interval} ${unit}s`}${r.pattern.daysOfWeek?.length ? ` on ${r.pattern.daysOfWeek.join(', ')}` : ''}${r.range?.type === 'endDate' ? ` until ${r.range.endDate}` : r.range?.type === 'numbered' ? `, ${r.range.numberOfOccurrences} times` : ''}`; };
  const event = (calendarId: string, item: any): CalendarEvent => ({ id: item.id, calendarId, title: String(item.subject || '(no title)').slice(0, 300), start: at(item.start, item.isAllDay, item.originalStartTimeZone), end: at(item.end, item.isAllDay, item.originalStartTimeZone), allDay: item.isAllDay === true, ...(item.location?.displayName ? { location: String(item.location.displayName).slice(0, 500) } : {}), ...(item.body?.content?.trim() ? { notes: (item.body.contentType === 'html' ? htmlText(item.body.content) : String(item.body.content)).trim().slice(0, 8000) } : {}),
    attendees: (item.attendees || []).slice(0, 100).map((a: any) => ({ email: a.emailAddress?.address, ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}), ...(a.status?.response ? { answer: a.status.response } : {}) })), ...(repeats(item.recurrence) ? { recurrence: repeats(item.recurrence) } : {}), ...(item.seriesMasterId ? { seriesId: item.seriesMasterId } : {}), ...(item.organizer?.emailAddress?.address ? { organizer: item.organizer.emailAddress.address } : {}), ...(item.isCancelled ? { cancelled: true } : {}), ...(item.webLink ? { link: item.webLink } : {}), revision: item['@odata.etag'] || `W/"${item.changeKey}"`, canEdit: item.isOrganizer !== false });
  const time = (value: EventTime) => 'date' in value ? { dateTime: `${value.date}T00:00:00`, timeZone: 'UTC' } : value;
  const body = (input: EventInput) => ({ subject: input.title, isAllDay: 'date' in input.start, start: time(input.start), end: time(input.end), location: { displayName: input.location ?? '' }, body: { contentType: 'text', content: input.notes ?? '' }, ...(input.attendees ? { attendees: input.attendees.map(address => ({ emailAddress: { address }, type: 'required' })) } : {}), ...(input.recurrence !== undefined ? { recurrence: input.recurrence ? graphRecurrence(input.recurrence, input.start) : null } : {}) });
  const written = (item: any) => ({ id: item.id, ...(item.webLink ? { link: item.webLink } : {}), ...(item['@odata.etag'] ? { revision: item['@odata.etag'] } : {}) });
  return {
    async calendars(signal) { const { value } = await ask({ url: query(`${base}/calendars`, { $top: 100 }), ...signalOf(signal) }); return (value.value || []).map((item: any) => ({ id: item.id, name: item.name, primary: item.isDefaultCalendar === true, canEdit: item.canEdit === true })); },
    async agenda(p, signal) { const calendar = p.calendarId || 'primary', view = calendar === 'primary' ? `${base}/calendar/calendarView` : `${base}/calendars/${encodeURIComponent(calendar)}/calendarView`, { value } = await ask({ url: query(view, { startDateTime: new Date(p.from).toISOString(), endDateTime: new Date(p.to).toISOString(), $orderby: 'start/dateTime', $top: p.limit, $select: select }), headers, ...signalOf(signal) }); return (value.value || []).filter((item: any) => !item.isCancelled).map((item: any) => event(calendar, item)); },
    async event(calendar, id, signal) { return event(calendar, (await ask({ url: query(`${base}/events/${encodeURIComponent(id)}`, { $select: select }), headers, ...signalOf(signal) })).value); },
    // transactionId: Graph makes one event for it however often it is asked.
    async create(calendar, input, context) { return written((await ask({ method: 'POST', url: events(calendar), json: { ...body(input), transactionId: context.key }, ...signalOf(context.signal) })).value); },
    async update(_calendar, id, input, revision, context) { return written((await ask({ method: 'PATCH', url: `${base}/events/${encodeURIComponent(id)}`, json: body(input), headers: { 'If-Match': revision }, ...signalOf(context.signal) })).value); },
    async remove(_calendar, id, revision, context) { await ask({ method: 'DELETE', url: `${base}/events/${encodeURIComponent(id)}`, headers: { 'If-Match': revision }, ...signalOf(context.signal) }); return { id }; },
    async created(calendar, context) { const { value } = await ask({ url: query(events(calendar), { $filter: `createdDateTime ge ${new Date(context.started - 60_000).toISOString()}`, $select: 'id,webLink,transactionId', $top: 50 }), ...signalOf(context.signal) }); const found = (value.value || []).find((item: any) => item.transactionId === context.key); return found ? written(found) : undefined; },
  };
}

export function microsoftMail(credentials: Credentials, origin = graphOrigin): MailAdapter {
  const ask = asker(credentials), base = `${origin}/v1.0/me`, headers = { Prefer: 'outlook.body-content-type="text"' }, select = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,isDraft,hasAttachments,internetMessageId';
  const address = (item: any) => item?.emailAddress?.address ? { email: String(item.emailAddress.address), ...(item.emailAddress.name ? { name: String(item.emailAddress.name).slice(0, 200) } : {}) } : undefined, addresses = (items: any) => (items || []).map(address).filter(Boolean);
  const message = (item: any, attachments: any[] = []): MailMessage => ({ id: item.id, threadId: item.conversationId, ...(address(item.from) ? { from: address(item.from) } : {}), to: addresses(item.toRecipients), cc: addresses(item.ccRecipients), date: Date.parse(item.receivedDateTime) || 0, subject: String(item.subject || '(no subject)').slice(0, 300), ...shown(item.body?.contentType === 'html' ? htmlText(String(item.body.content || '')) : String(item.body?.content || item.bodyPreview || '')), unread: item.isRead === false, draft: item.isDraft === true, attachments: attachments.filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment').slice(0, 30).map(a => ({ id: a.id, name: String(a.name).slice(0, 200), mime: String(a.contentType || ''), bytes: Number(a.size) || 0 })), ...(item.internetMessageId ? { messageId: item.internetMessageId } : {}) });
  const recipients = (list: string[]) => list.map(address => ({ emailAddress: { address } }));
  const fields = (mail: Outgoing) => ({ subject: mail.subject, body: { contentType: 'text', content: mail.text }, toRecipients: recipients(mail.to), ccRecipients: recipients(mail.cc), bccRecipients: recipients(mail.bcc) });
  /** A draft with PAL's own Message-ID, so it can be found whatever happens to the answer. */
  const draft = async (mail: Outgoing, context: WriteContext) => {
    if (!mail.reply) return (await ask({ method: 'POST', url: `${base}/messages`, json: { ...fields(mail), internetMessageId: messageId(context.key) }, ...signalOf(context.signal) })).value;
    const created = (await ask({ method: 'POST', url: `${base}/messages/${encodeURIComponent(mail.reply.messageId)}/createReply`, json: {}, ...signalOf(context.signal) })).value;
    return (await ask({ method: 'PATCH', url: `${base}/messages/${encodeURIComponent(created.id)}`, json: { ...fields(mail), singleValueExtendedProperties: [{ id: 'String {00020329-0000-0000-C000-000000000046} Name pal-write', value: context.key }] }, ...signalOf(context.signal) })).value;
  };
  const marked = async (context: WriteContext) => {
    const { value } = await ask({ url: query(`${base}/messages`, { $filter: `internetMessageId eq '${messageId(context.key)}'`, $select: 'id,isDraft,webLink', $top: 1 }), ...signalOf(context.signal) }); if (value.value?.[0]) return value.value[0];
    return (await ask({ url: query(`${base}/messages`, { $filter: `singleValueExtendedProperties/Any(ep: ep/id eq 'String {00020329-0000-0000-C000-000000000046} Name pal-write' and ep/value eq '${context.key}')`, $select: 'id,isDraft,webLink', $top: 1 }), ...signalOf(context.signal) })).value.value?.[0];
  };
  return {
    async search(text, limit, signal) { const { value } = await ask({ url: query(`${base}/messages`, text.trim() ? { $search: `"${text.replace(/["\\]/g, ' ')}"`, $top: limit, $select: 'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead' } : { $orderby: 'receivedDateTime desc', $top: limit, $select: 'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead' }), ...signalOf(signal) }); const seen = new Set<string>(); return (value.value || []).filter((item: any) => !seen.has(item.conversationId) && seen.add(item.conversationId)).map((item: any) => ({ id: item.conversationId, threadId: item.conversationId, ...(address(item.from) ? { from: address(item.from) } : {}), date: Date.parse(item.receivedDateTime) || 0, subject: String(item.subject || '(no subject)').slice(0, 300), snippet: String(item.bodyPreview || '').slice(0, 300), unread: item.isRead === false })); },
    async thread(id, signal) {
      const { value } = await ask({ url: query(`${base}/messages`, { $filter: `conversationId eq '${id.replaceAll("'", "''")}'`, $top: 50, $select: select }), headers, ...signalOf(signal) }), rows = (value.value || []).sort((a: any, b: any) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
      return Promise.all(rows.map(async (item: any) => message(item, item.hasAttachments ? (await ask({ url: query(`${base}/messages/${encodeURIComponent(item.id)}/attachments`, { $select: 'id,name,contentType,size' }), ...signalOf(signal) })).value.value || [] : [])));
    },
    async attachment(id, attachment, signal) { const url = `${base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}/$value`, reply = await credentials.http.raw({ url, token: await credentials.token(signal), maxBytes: accountLimits.fileBytes, timeoutMs: accountLimits.fileTimeoutMs, headers: { Accept: '*/*' }, ...signalOf(signal) }); if (reply.status !== 200) throw failure({ url }, reply); return reply.body; },
    async draft(mail, context) { const value = await draft(mail, context); return { id: value.id, ...(value.webLink ? { link: value.webLink } : {}) }; },
    async send(mail, context) { const found = await marked(context).catch(() => undefined), value = found?.isDraft ? found : await draft(mail, context); await ask({ method: 'POST', url: `${base}/messages/${encodeURIComponent(value.id)}/send`, ...signalOf(context.signal) }); return { id: value.id }; },
    async sent(context) { const found = await marked(context); return found && !found.isDraft ? { id: found.id, ...(found.webLink ? { link: found.webLink } : {}) } : undefined; },
  };
}

export function microsoftDrive(credentials: Credentials, origin = graphOrigin): DriveAdapter {
  const ask = asker(credentials), base = `${origin}/v1.0/me/drive`, select = 'id,name,size,file,folder,lastModifiedDateTime,webUrl,eTag,cTag';
  const item = (value: any): DriveItem => ({ id: value.id, name: String(value.name || 'Untitled').slice(0, 300), mime: value.file?.mimeType || (value.folder ? 'folder' : 'application/octet-stream'), folder: !!value.folder, ...(Number.isFinite(value.size) ? { bytes: value.size } : {}), ...(value.lastModifiedDateTime ? { modified: Date.parse(value.lastModifiedDateTime) } : {}), ...(value.webUrl ? { link: value.webUrl } : {}), revision: value.eTag || value.cTag || '', canEdit: !value.folder });
  const written = (value: any) => ({ id: value.id, ...(value.webUrl ? { link: value.webUrl } : {}), ...(value.eTag ? { revision: value.eTag } : {}) });
  const put = async (url: string, p: { mime: string; bytes: Buffer }, extra: Record<string, string>, context: WriteContext) => { if (p.bytes.length > accountLimits.fileBytes) throw new Error('This file is larger than PAL uploads (50 MB)'); return (await ask({ method: 'PUT', url, body: p.bytes, headers: { 'Content-Type': p.mime, ...extra }, timeoutMs: accountLimits.fileTimeoutMs, ...signalOf(context.signal) })).value; };
  const child = (folder: string | undefined, name: string) => `${base}/${folder ? `items/${encodeURIComponent(folder)}` : 'root'}:/${encodeURIComponent(name)}:`;
  return {
    async search(text, limit, signal) { const { value } = await ask({ url: query(`${base}/root/search(q='${encodeURIComponent(text.replaceAll("'", "''"))}')`, { $top: limit, $select: select }), ...signalOf(signal) }); return (value.value || []).slice(0, limit).map(item); },
    async list(folder, limit, signal) { const { value } = await ask({ url: query(`${base}/${folder ? `items/${encodeURIComponent(folder)}` : 'root'}/children`, { $top: limit, $select: select }), ...signalOf(signal) }); return (value.value || []).slice(0, limit).map(item); },
    async item(id, signal) { return item((await ask({ url: query(`${base}/items/${encodeURIComponent(id)}`, { $select: select }), ...signalOf(signal) })).value); },
    async download(file, signal) {
      if (file.folder) throw new Error('Choose a file, not a folder'); if ((file.bytes || 0) > accountLimits.fileBytes) throw new Error('This file is larger than PAL imports (50 MB)');
      const url = `${base}/items/${encodeURIComponent(file.id)}/content`, reply = await credentials.http.raw({ url, token: await credentials.token(signal), maxBytes: accountLimits.fileBytes, timeoutMs: accountLimits.fileTimeoutMs, followContent: true, headers: { Accept: '*/*' }, ...signalOf(signal) });
      if (reply.status !== 200) throw failure({ url }, reply); return { bytes: reply.body, name: file.name, mime: file.mime };
    },
    async create(p, context) { return written(await put(query(`${child(p.folderId, p.name)}/content`, { '@microsoft.graph.conflictBehavior': 'fail' }), p, {}, context)); },
    async update(id, p, context) { return written(await put(`${base}/items/${encodeURIComponent(id)}/content`, p, { 'If-Match': p.revision }, context)); },
    async created(p, context) { try { const { value } = await ask({ url: query(child(p.folderId, p.name).replace(/:$/, ''), { $select: 'id,webUrl,eTag,createdDateTime' }), ...signalOf(context.signal) }); return Date.parse(value.createdDateTime) >= context.started - 60_000 ? written(value) : undefined; } catch (error) { if (error instanceof AccountError && error.code === 'NOT_FOUND') return undefined; throw error; } },
  };
}
