/** What every account adapter offers; a service an account does not have is absent. */
import type { AccountHttp, AccountRequest } from './http.ts';
import type { CalendarEvent, EventInput } from './events.ts';
import type { MailMessage, MailSummary, Outgoing } from './mail.ts';

export type Identity = { subject: string; login: string };
/** Who to act as: the token is read for each request, so one that was just refreshed is used. */
export type Credentials = { http: AccountHttp; token: (signal?: AbortSignal) => Promise<string> };
/** A write that was made: where it is, and what to look for if its answer was lost. */
export type Written = { id: string; link?: string; revision?: string };
export type WriteContext = { key: string; started: number; signal?: AbortSignal };
export type CalendarAdapter = {
  calendars(signal?: AbortSignal): Promise<{ id: string; name: string; primary: boolean; canEdit: boolean; timeZone?: string }[]>;
  agenda(p: { calendarId?: string; from: number; to: number; limit: number }, signal?: AbortSignal): Promise<CalendarEvent[]>;
  event(calendarId: string, id: string, signal?: AbortSignal): Promise<CalendarEvent>;
  create(calendarId: string, event: EventInput, context: WriteContext): Promise<Written>;
  update(calendarId: string, id: string, event: EventInput, revision: string, context: WriteContext): Promise<Written>;
  remove(calendarId: string, id: string, revision: string, context: WriteContext): Promise<Written>;
  /** Whether a create whose answer was lost took effect. */
  created(calendarId: string, context: WriteContext): Promise<Written | undefined>;
};
export type MailAdapter = {
  search(query: string, limit: number, signal?: AbortSignal): Promise<MailSummary[]>;
  thread(id: string, signal?: AbortSignal): Promise<MailMessage[]>;
  attachment(messageId: string, attachmentId: string, signal?: AbortSignal): Promise<Buffer>;
  /** A draft at the service, so it can be finished anywhere. */
  draft(mail: Outgoing, context: WriteContext): Promise<Written>;
  send(mail: Outgoing, context: WriteContext): Promise<Written>;
  sent(context: WriteContext): Promise<Written | undefined>;
};
export type DriveItem = { id: string; name: string; mime: string; folder: boolean; bytes?: number; modified?: number; link?: string; revision: string; canEdit: boolean; exported?: string };
export type DriveAdapter = {
  search(query: string, limit: number, signal?: AbortSignal): Promise<DriveItem[]>;
  list(folderId: string | undefined, limit: number, signal?: AbortSignal): Promise<DriveItem[]>;
  item(id: string, signal?: AbortSignal): Promise<DriveItem>;
  download(item: DriveItem, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string; mime: string }>;
  create(p: { folderId?: string; name: string; mime: string; bytes: Buffer }, context: WriteContext): Promise<Written>;
  update(id: string, p: { mime: string; bytes: Buffer; revision: string }, context: WriteContext): Promise<Written>;
  created(p: { folderId?: string; name: string }, context: WriteContext): Promise<Written | undefined>;
};
export const clip = (value: unknown, limit: number) => { const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }; };
export const asker = (credentials: Credentials) => async <T = any>(request: AccountRequest) => credentials.http.json<T>({ ...request, token: await credentials.token(request.signal) });
/** Letters a calendar service accepts as an event's own ID, made from PAL's write ID. */
export const eventId = (key: string) => 'pal' + key.replace(/[^0-9a-f]/g, '');
export const messageId = (key: string) => `<${key}@mail.pal.invalid>`;
