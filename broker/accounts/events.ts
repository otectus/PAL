/** Calendar events in one shape for every service: what is asked for, checked before anything is sent. */
export type Recurrence = { every: 'day' | 'week' | 'month' | 'year'; interval: number; days?: Weekday[]; until?: string; count?: number };
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export const weekdays: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export type EventTime = { date: string } | { dateTime: string; timeZone: string };
export type EventInput = { title: string; start: EventTime; end: EventTime; location?: string; notes?: string; attendees?: string[]; recurrence?: Recurrence | null };
export type CalendarEvent = { id: string; calendarId: string; title: string; start: EventTime; end: EventTime; allDay: boolean; location?: string; notes?: string; attendees: { email: string; name?: string; answer?: string }[]; recurrence?: string; seriesId?: string; organizer?: string; cancelled?: boolean; link?: string; revision: string; canEdit: boolean };
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, day = /^\d{4}-\d{2}-\d{2}$/;
export const emailAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@<>",;:\\()[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,250}[A-Za-z0-9])?$/.test(value) && !value.includes('..');
function zone(value: unknown) { if (typeof value !== 'string' || value.length > 64) throw new Error('Name a time zone such as Europe/Berlin'); try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new Error(`${value} is not a time zone PAL knows`); } return value; }
function calendarDay(value: string) { const date = new Date(value.slice(0, 10) + 'T00:00:00Z'); if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error(`${value} is not a date`); return value; }
/** The instant a local time names in its zone; a time a clock change skips is refused, a repeated one takes the first. */
export function instant(time: { dateTime: string; timeZone: string }): number {
  const wanted = Date.parse(time.dateTime.length === 16 ? time.dateTime + ':00Z' : time.dateTime + 'Z');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: time.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const local = (at: number) => { const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value])); return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`); };
  const candidates = [...new Set([wanted - 14 * 3600_000, wanted, wanted + 14 * 3600_000].map(at => wanted - (local(at) - at)))].filter(at => local(at) === wanted).sort((a, b) => a - b);
  if (!candidates.length) throw new Error(`${time.dateTime} does not exist in ${time.timeZone} (the clocks change)`);
  return candidates[0];
}
export function validTime(value: any): EventTime {
  if (typeof value?.date === 'string' && day.test(value.date) && value.dateTime === undefined) return { date: calendarDay(value.date) };
  if (typeof value?.dateTime === 'string' && localTime.test(value.dateTime)) { calendarDay(value.dateTime); const time = { dateTime: value.dateTime.length === 16 ? value.dateTime + ':00' : value.dateTime, timeZone: zone(value.timeZone) }; instant(time); return time; }
  throw new Error('Give a date (2026-05-01), or a local time with its time zone (2026-05-01T09:30, Europe/Berlin)');
}
export function validRecurrence(value: any): Recurrence {
  if (!['day', 'week', 'month', 'year'].includes(value?.every)) throw new Error('A repeat is every day, week, month or year');
  const interval = value.interval ?? 1; if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw new Error('A repeat interval is 1–99');
  const days = value.days === undefined ? undefined : Array.isArray(value.days) && value.days.length && value.days.every((item: any) => weekdays.includes(item)) ? [...new Set(value.days)] as Weekday[] : null;
  if (days === null || days && value.every !== 'week') throw new Error('Weekdays (MO…SU) belong to a weekly repeat');
  if (value.until !== undefined && value.count !== undefined) throw new Error('A repeat ends on a date or after a number of times, not both');
  if (value.until !== undefined && (typeof value.until !== 'string' || !day.test(value.until))) throw new Error('A repeat ends on a date such as 2026-12-31');
  if (value.count !== undefined && (!Number.isInteger(value.count) || value.count < 1 || value.count > 999)) throw new Error('A repeat happens 1–999 times');
  return { every: value.every, interval, ...(days ? { days: days.sort((a, b) => weekdays.indexOf(a) - weekdays.indexOf(b)) } : {}), ...(value.until ? { until: calendarDay(value.until) } : {}), ...(value.count ? { count: value.count } : {}) };
}
export function validEvent(value: any): EventInput {
  if (typeof value?.title !== 'string' || !value.title.trim() || value.title.length > 300 || /[\x00-\x1f]/.test(value.title)) throw new Error('Name the event on one line (up to 300 characters)');
  const start = validTime(value.start), end = validTime(value.end);
  if ('date' in start !== 'date' in end) throw new Error('An event is all day, or it has a start and end time');
  if ('date' in start && 'date' in end ? end.date <= start.date : !('date' in start) && !('date' in end) && instant(end) <= instant(start)) throw new Error('The event must end after it starts (an all-day event ends on the next day)');
  const text = (name: 'location' | 'notes', max: number) => { const item = value[name]; if (item === undefined || item === '') return {}; if (typeof item !== 'string' || item.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item)) throw new Error(`The ${name} is up to ${max} characters`); return { [name]: item }; };
  const attendees = value.attendees ?? []; if (!Array.isArray(attendees) || attendees.length > 50 || !attendees.every(emailAddress)) throw new Error('List up to 50 guests by email address');
  return { title: value.title.trim(), start, end, ...text('location', 500), ...text('notes', 8000), ...(attendees.length ? { attendees: [...new Set<string>(attendees)] } : {}), ...(value.recurrence ? { recurrence: validRecurrence(value.recurrence) } : {}) };
}
export function rrule(r: Recurrence) {
  const until = r.until ? `;UNTIL=${r.until.replaceAll('-', '')}T235959Z` : '';
  return `RRULE:FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[r.every]}${r.interval > 1 ? `;INTERVAL=${r.interval}` : ''}${r.days ? `;BYDAY=${r.days.join(',')}` : ''}${r.count ? `;COUNT=${r.count}` : ''}${until}`;
}
const graphDays: Record<Weekday, string> = { MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday', SU: 'sunday' };
export function graphRecurrence(r: Recurrence, start: EventTime) {
  const date = ('date' in start ? start.date : start.dateTime).slice(0, 10), of = new Date(date + 'T00:00:00Z'), own = weekdays[(of.getUTCDay() + 6) % 7];
  const pattern = r.every === 'day' ? { type: 'daily', interval: r.interval } : r.every === 'week' ? { type: 'weekly', interval: r.interval, daysOfWeek: (r.days || [own]).map(item => graphDays[item]), firstDayOfWeek: 'monday' }
    : r.every === 'month' ? { type: 'absoluteMonthly', interval: r.interval, dayOfMonth: of.getUTCDate() } : { type: 'absoluteYearly', interval: r.interval, dayOfMonth: of.getUTCDate(), month: of.getUTCMonth() + 1 };
  return { pattern, range: { type: r.count ? 'numbered' : r.until ? 'endDate' : 'noEnd', startDate: date, ...(r.count ? { numberOfOccurrences: r.count } : {}), ...(r.until ? { endDate: r.until } : {}) } };
}
export function describeRecurrence(r: Recurrence) {
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[r.every];
  return `Every ${r.interval === 1 ? unit : `${r.interval} ${unit}s`}${r.days ? ` on ${r.days.join(', ')}` : ''}${r.until ? ` until ${r.until}` : r.count ? `, ${r.count} times` : ''}`;
}
/** A repeat rule from a service in words; one PAL cannot describe is shown as the service wrote it. */
export function describeRule(rule: string) {
  const parts = Object.fromEntries(rule.replace(/^RRULE:/, '').split(';').map(part => part.split('=') as [string, string]));
  const every = ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as Record<string, Recurrence['every']>)[parts.FREQ];
  if (!every || Object.keys(parts).some(key => !['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST'].includes(key)) || parts.BYDAY && (every !== 'week' || parts.BYDAY.split(',').some(item => !weekdays.includes(item as Weekday)))) return rule.slice(0, 200);
  return describeRecurrence({ every, interval: Number(parts.INTERVAL) || 1, ...(parts.BYDAY ? { days: parts.BYDAY.split(',') as Weekday[] } : {}), ...(parts.COUNT ? { count: Number(parts.COUNT) } : {}), ...(parts.UNTIL ? { until: `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` } : {}) });
}
