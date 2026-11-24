/** Mail in one shape for every service, plain text only: what a person reads and what a person sends. */
import { emailAddress } from './events.ts';

export type Address = { name?: string; email: string };
export type MailAttachment = { id: string; name: string; mime: string; bytes: number };
export type MailMessage = { id: string; threadId: string; from?: Address; to: Address[]; cc: Address[]; date: number; subject: string; text: string; truncated?: boolean; unread?: boolean; draft?: boolean; attachments: MailAttachment[]; messageId?: string; references?: string[] };
export type MailSummary = { id: string; threadId: string; from?: Address; date: number; subject: string; snippet: string; unread: boolean };
export type Outgoing = { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; reply?: { threadId: string; messageId: string } };
export const mailLimits = { recipients: 50, subject: 300, text: 100_000, shown: 20_000 };

export function validMail(value: any): Outgoing {
  const list = (name: 'to' | 'cc' | 'bcc') => { const items = value?.[name] ?? []; if (!Array.isArray(items) || !items.every(emailAddress)) throw new Error(`List ${name} as email addresses`); return [...new Set<string>(items.map((item: string) => item.trim()))]; };
  const to = list('to'), cc = list('cc'), bcc = list('bcc');
  if (to.length + cc.length + bcc.length > mailLimits.recipients) throw new Error(`A message has at most ${mailLimits.recipients} recipients`);
  if (typeof value?.subject !== 'string' || value.subject.length > mailLimits.subject || /[\x00-\x1f\x7f]/.test(value.subject)) throw new Error(`Give a subject of one line, up to ${mailLimits.subject} characters`);
  if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > mailLimits.text || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.text)) throw new Error(`Write the message (up to ${mailLimits.text.toLocaleString('en')} characters)`);
  const reply = value.reply; if (reply !== undefined && (typeof reply?.threadId !== 'string' || typeof reply?.messageId !== 'string')) throw new Error('Choose the message this replies to');
  return { to, cc, bcc, subject: value.subject.trim(), text: value.text, ...(reply ? { reply: { threadId: reply.threadId, messageId: reply.messageId } } : {}) };
}
/** A header value that is not plain text, as RFC 2047 encoded words of at most 75 characters each. */
function header(value: string) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = []; let part = '';
  for (const char of value) { if (Buffer.byteLength(part + char) > 42) { words.push(part); part = ''; } part += char; }
  return [...words, part].map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}
/** The message as it is sent: plain text, with its own Message-ID so one that was sent can be found again. */
export function compose(mail: Outgoing, p: { messageId: string; date: Date; inReplyTo?: string; references?: string[] }) {
  const ids = [...(p.references || []), ...(p.inReplyTo ? [p.inReplyTo] : [])].filter(item => /^<[^<>\s]{1,250}>$/.test(item)).slice(-20);
  const lines = [`Date: ${p.date.toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${p.messageId}`, ...(mail.to.length ? [`To: ${mail.to.join(',\r\n ')}`] : []), ...(mail.cc.length ? [`Cc: ${mail.cc.join(',\r\n ')}`] : []), ...(mail.bcc.length ? [`Bcc: ${mail.bcc.join(',\r\n ')}`] : []),
    `Subject: ${header(mail.subject)}`, ...(p.inReplyTo && /^<[^<>\s]{1,250}>$/.test(p.inReplyTo) ? [`In-Reply-To: ${p.inReplyTo}`] : []), ...(ids.length ? [`References: ${[...new Set(ids)].join('\r\n ')}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', ''];
  return Buffer.from(lines.join('\r\n') + '\r\n' + (Buffer.from(mail.text.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g) || []).join('\r\n') + '\r\n');
}
export function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  return (value.match(/(?:"[^"]*"|[^",])+/g) || []).slice(0, 100).flatMap(part => {
    const match = /^\s*(?:"?([^"<]*)"?\s*)?<([^<>]+)>\s*$/.exec(part) || [, '', part.trim()] as (string | undefined)[], email = String(match[2]).trim();
    return email.includes('@') ? [{ email: email.slice(0, 254), ...(match[1]?.trim() ? { name: decodeHeader(match[1].trim()).slice(0, 200) } : {}) }] : [];
  });
}
export function decodeHeader(value: string) {
  return value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([\w-]+)\?([BQbq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, text: string) => {
    const bytes = kind.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replaceAll('_', ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
  }).replace(/[\x00-\x1f\x7f]+/g, ' ');
}
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', euro: '€' };
/** The words of an HTML message. Nothing in it is run, loaded or followed; a link's address is shown beside its text. */
export function htmlText(html: string) {
  return html.slice(0, 2_000_000).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']?(https?:[^"'\s>]+)[^>]*>([\s\S]*?)<\/a\s*>/gi, (_all, href: string, text: string) => { const words = text.replace(/<[^>]*>/g, '').trim(); return !words || words === href ? href : `${words} (${href})`; })
    .replace(/<li\b[^>]*>/gi, '\n• ').replace(/<(br|hr)\b[^>]*>/gi, '\n').replace(/<\/(p|div|h[1-6]|tr|table|blockquote|ul|ol)\s*>/gi, '\n').replace(/<\/t[dh]\s*>/gi, '\t').replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name: string) => { if (name[0] === '#') { const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)); return code > 31 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : ' '; } return entities[name.toLowerCase()] ?? all; })
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function shown(text: string) { const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); return clean.length > mailLimits.shown ? { text: clean.slice(0, mailLimits.shown), truncated: true } : { text: clean }; }
