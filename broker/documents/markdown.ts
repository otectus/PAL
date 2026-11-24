/**
 * Markdown as a document tree, for export to Word, PDF and HTML. It reads what people and models write: headings,
 * paragraphs, emphasis, code, links, lists with tasks, quotes, tables, rules, footnotes and embedded images. Raw HTML is
 * text: nothing in a document can become markup, a script or a fetched address.
 */
export type Inline =
  | { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'break' }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'note'; id: string; number: number };
export type Align = 'left' | 'center' | 'right' | null;
export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: { task?: boolean; blocks: Block[] }[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };
export type Document = { blocks: Block[]; notes: { number: number; children: Inline[] }[] };
export const markdownLimits = { chars: 600_000, depth: 10, columns: 40, rows: 5000 };

/** Only addresses a person would follow; anything else stays text. */
export function safeHref(value: string): string | undefined {
  const href = value.trim().replace(/[\x00-\x20\x7f]/g, '');
  return /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(href) && href.length <= 2048 ? href : undefined;
}

class Parser {
  notes = new Map<string, { number: number; text: string }>();
  private sources = new Map<string, string>();
  private order: string[] = [];

  document(source: string): Document {
    if (source.length > markdownLimits.chars) throw new Error('This document is longer than PAL exports (600,000 characters)');
    const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').split('\n').map(line => line.replace(/\t/g, '    '));
    const body: string[] = [];
    let fence = '';
    for (let i = 0; i < lines.length; i++) {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (mark) { if (!fence) fence = mark[1]; else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && lines[i].trim() === mark[1]) fence = ''; }
      const note = fence ? null : /^\[\^([^\]\s]{1,60})\]:\s*(.*)$/.exec(lines[i]);
      if (!note) { body.push(lines[i]); continue; }
      let text = note[2];
      while (/^ {2,}\S/.test(lines[i + 1] || '')) text += ' ' + lines[++i].trim();
      if (!this.sources.has(note[1])) this.sources.set(note[1], text);
    }
    const blocks = this.blocks(body, 0), notes: Document['notes'] = [];
    // A note may cite another; each is numbered where it is first used.
    for (let i = 0; i < this.order.length && i < 500; i++) notes.push({ number: i + 1, children: this.inline(this.sources.get(this.order[i])!) });
    return { blocks, notes };
  }

  private blocks(lines: string[], depth: number): Block[] {
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/.exec(line);
      if (fence) {
        const body: string[] = []; i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence[2]) && lines[i].trim().replace(fence[2][0] === '`' ? /`/g : /~/g, '') === '')) body.push(lines[i].startsWith(fence[1]) ? lines[i].slice(fence[1].length) : lines[i].trimStart()), i++;
        i++; out.push({ type: 'code', lang: fence[3].trim().split(/\s+/)[0].slice(0, 40), text: body.join('\n') }); continue;
      }
      const heading = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(line);
      if (heading && (heading[2] !== undefined || line.trim() === heading[1])) { out.push({ type: 'heading', level: heading[1].length, children: this.inline(heading[2] || '') }); i++; continue; }
      if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push({ type: 'rule' }); i++; continue; }
      if (/^ {0,3}>/.test(line) && depth < markdownLimits.depth) {
        const body: string[] = [];
        while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || !this.starts(lines[i]))) body.push(lines[i].replace(/^ {0,3}> ?/, '')), i++;
        out.push({ type: 'quote', blocks: this.blocks(body, depth + 1) }); continue;
      }
      const item = this.marker(line);
      if (item && depth < markdownLimits.depth) { const list = this.list(lines, i, depth); out.push(list.block); i = list.next; continue; }
      const table = this.table(lines, i);
      if (table) { out.push(table.block); i = table.next; continue; }
      if (/^ {4}/.test(line)) {
        const body: string[] = [];
        while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) body.push(lines[i].slice(4)), i++;
        while (body.length && !body[body.length - 1].trim()) body.pop();
        out.push({ type: 'code', lang: '', text: body.join('\n') }); continue;
      }
      const paragraph: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        if (paragraph.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i])) { out.push({ type: 'heading', level: lines[i].trim()[0] === '=' ? 1 : 2, children: this.inline(paragraph.join('\n')) }); paragraph.length = 0; i++; break; }
        if (paragraph.length && (this.starts(lines[i]) || this.table(lines, i))) break;
        paragraph.push(lines[i].replace(/^\s+/, '')); i++;
      }
      if (paragraph.length) out.push({ type: 'paragraph', children: this.inline(paragraph.join('\n')) });
    }
    return out;
  }
  /** Whether a line begins another kind of block, so a paragraph or quote before it ends. */
  private starts(line: string) { return /^ {0,3}(#{1,6}\s|`{3,}|~{3,}|>)/.test(line) || /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) || !!this.marker(line); }
  private marker(line: string) {
    const match = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+)(\S.*)$/.exec(line) || /^( {0,3})([-*+]|\d{1,9}[.)])()(\s*)$/.exec(line);
    return match ? { indent: match[1].length, mark: match[2], width: match[1].length + match[2].length + Math.min(Math.max(match[3].length, 1), 4), ordered: /\d/.test(match[2]), text: (match[4] || '').trimEnd() } : undefined;
  }
  private list(lines: string[], from: number, depth: number): { block: Block; next: number } {
    const first = this.marker(lines[from])!, items: { task?: boolean; blocks: Block[] }[] = [];
    let i = from;
    const same = (line: string) => { const mark = this.marker(line); return mark && mark.ordered === first.ordered && (first.ordered || mark.mark === first.mark) ? mark : undefined; };
    while (i < lines.length) {
      const mark = same(lines[i]);
      if (!mark || mark.indent > first.indent + 3) break;
      const body = [mark.text]; i++;
      let loose = false;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { if (lines.slice(i + 1).find(next => next.trim())?.match(/^ */)?.[0].length! >= mark.width) { body.push(''); loose = true; i++; continue; } break; }
        const indent = /^ */.exec(line)![0].length;
        if (indent >= mark.width) { body.push(line.slice(mark.width)); i++; continue; }
        // Two spaces are enough for a nested list in what people write.
        if (indent >= first.indent + 2 && this.marker(line.trimStart())) { body.push(line.slice(Math.min(indent, mark.width))); i++; continue; }
        if (loose || this.starts(line)) break;
        body.push(line.trimStart()); i++;
      }
      while (body.length > 1 && !body[body.length - 1].trim()) body.pop();
      const task = /^\[([ xX])\]\s+/.exec(body[0]);
      if (task) body[0] = body[0].slice(task[0].length);
      items.push({ ...(task ? { task: task[1] !== ' ' } : {}), blocks: this.blocks(body, depth + 1) });
      let ahead = i; while (ahead < lines.length && !lines[ahead].trim()) ahead++;
      if (ahead > i && ahead < lines.length && same(lines[ahead]) && this.marker(lines[ahead])!.indent <= first.indent + 1) i = ahead; else if (ahead > i) break;
    }
    return { block: { type: 'list', ordered: first.ordered, start: first.ordered ? Number(first.mark.slice(0, -1)) : 1, items }, next: i };
  }
  private cells(line: string) {
    const text = line.trim().replace(/^\|/, '').replace(/\|\s*$/, (end, at, whole) => whole[at - 1] === '\\' ? end : ''), cells: string[] = [];
    let cell = '', code = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
      if (text[i] === '`') code = !code;
      if (text[i] === '|' && !code) { cells.push(cell.trim()); cell = ''; continue; }
      cell += text[i];
    }
    cells.push(cell.trim());
    return cells;
  }
  private table(lines: string[], i: number): { block: Block; next: number } | undefined {
    if (!lines[i].includes('|') || !/^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] || '') || !(lines[i + 1] || '').includes('-')) return undefined;
    const head = this.cells(lines[i]), marks = this.cells(lines[i + 1]);
    if (head.length !== marks.length || head.length > markdownLimits.columns || (head.length === 1 && !lines[i].trim().startsWith('|'))) return undefined;
    const align = marks.map(mark => mark.startsWith(':') && mark.endsWith(':') ? 'center' as const : mark.endsWith(':') ? 'right' as const : mark.startsWith(':') ? 'left' as const : null);
    const rows: Inline[][][] = []; let next = i + 2;
    while (next < lines.length && lines[next].trim() && lines[next].includes('|') && rows.length < markdownLimits.rows) {
      const cells = this.cells(lines[next]);
      rows.push(head.map((_cell, column) => this.inline(cells[column] || ''))); next++;
    }
    return { block: { type: 'table', align, head: head.map(cell => this.inline(cell)), rows }, next };
  }

  inline(source: string, depth = 0): Inline[] {
    const out: Inline[] = [];
    let text = '';
    const flush = () => { if (text) { out.push({ type: 'text', text }); text = ''; } };
    let i = 0;
    while (i < source.length) {
      const rest = source.slice(i, i + 4096), c = source[i];
      if (c === '\\' && i + 1 < source.length) { if (source[i + 1] === '\n') { flush(); out.push({ type: 'break' }); i += 2; continue; } if (/[!-/:-@[-`{-~]/.test(source[i + 1])) { text += source[i + 1]; i += 2; continue; } }
      if (c === '\n') { if (text.endsWith('  ')) { text = text.replace(/ +$/, ''); flush(); out.push({ type: 'break' }); } else text = text.replace(/ +$/, '') + ' '; i++; continue; }
      if (c === '`') {
        const run = /^`+/.exec(rest)![0], end = this.closing(source, i + run.length, run);
        if (end >= 0) { flush(); out.push({ type: 'code', text: source.slice(i + run.length, end).replace(/\n/g, ' ').replace(/^ (.*[^ ].*) $/, '$1') }); i = end + run.length; continue; }
        text += run; i += run.length; continue;
      }
      if (c === '<') {
        const line = /^<br\s*\/?>/i.exec(rest); if (line) { flush(); out.push({ type: 'break' }); i += line[0].length; continue; }
        const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest), href = auto && safeHref(auto[1]);
        if (href) { flush(); out.push({ type: 'link', href, children: [{ type: 'text', text: auto![1].replace(/^mailto:/i, '') }] }); i += auto![0].length; continue; }
      }
      if (c === '[' && source[i + 1] === '^') {
        const note = /^\[\^([^\]\s]{1,60})\]/.exec(rest);
        if (note && this.sources.has(note[1])) {
          let number = this.order.indexOf(note[1]) + 1; if (!number) number = this.order.push(note[1]);
          flush(); out.push({ type: 'note', id: note[1], number }); i += note[0].length; continue;
        }
      }
      if ((c === '[' || (c === '!' && source[i + 1] === '[')) && depth < 4) {
        const image = c === '!', open = i + (image ? 2 : 1), close = this.bracket(source, open);
        const target = close >= 0 ? /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+["'(][^"')]*["')])?\s*\)/.exec(source.slice(close + 1, close + 1 + (image ? 8 * 1024 * 1024 : 4096))) : null;
        if (close >= 0 && target) {
          const label = source.slice(open, close); flush();
          if (image) out.push({ type: 'image', src: target[1], alt: label.slice(0, 500) });
          else { const href = safeHref(target[1]); const children = this.inline(label, depth + 1); if (href) out.push({ type: 'link', href, children }); else out.push(...children); }
          i = close + 1 + target[0].length; continue;
        }
      }
      const strong = /^(\*\*|__)(?=\S)/.exec(rest), strike = /^~~(?=\S)/.exec(rest), em = /^([*_])(?=\S)/.exec(rest);
      const mark = strong?.[1] || (strike ? '~~' : em?.[1]);
      if (mark && depth < 8 && !(mark[0] === '_' && /[\p{L}\p{N}]/u.test(source[i - 1] || ''))) {
        const end = this.emphasis(source, i + mark.length, mark);
        if (end >= 0) { flush(); out.push({ type: mark === '~~' ? 'del' : mark.length === 2 ? 'strong' : 'em', children: this.inline(source.slice(i + mark.length, end), depth + 1) }); i = end + mark.length; continue; }
        text += mark; i += mark.length; continue;
      }
      const bare = /^https?:\/\/[^\s<>"'`|]+/i.exec(rest);
      if (bare && !/[\p{L}\p{N}]/u.test(source[i - 1] || '')) {
        let address = bare[0].replace(/[.,;:!?*_~]+$/, ''); while (address.endsWith(')') && !address.includes('(')) address = address.slice(0, -1);
        const href = safeHref(address);
        if (href) { flush(); out.push({ type: 'link', href, children: [{ type: 'text', text: address }] }); i += address.length; continue; }
      }
      text += c; i++;
    }
    flush();
    return out;
  }
  private closing(source: string, from: number, run: string) {
    for (let at = source.indexOf(run, from); at >= 0 && at - from < 20_000; at = source.indexOf(run, at + 1)) {
      if (source[at - 1] === '`') continue;
      if (source[at + run.length] !== '`') return at;
      while (source[at + 1] === '`') at++;
    }
    return -1;
  }
  private bracket(source: string, from: number) {
    let open = 1;
    for (let i = from; i < source.length && i - from < 4000; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === '[') open++; else if (source[i] === ']' && !--open) return i;
    }
    return -1;
  }
  private emphasis(source: string, from: number, mark: string) {
    for (let i = from; i < source.length && i - from < 8000; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === '`') { const run = /^`+/.exec(source.slice(i, i + 64))![0], end = this.closing(source, i + run.length, run); if (end >= 0) { i = end + run.length - 1; continue; } }
      if (source.startsWith('\n\n', i)) return -1;
      if (!source.startsWith(mark, i) || /\s/.test(source[i - 1]) || i === from) continue;
      // A single mark next to its double is the double's business.
      if (mark.length === 1 && (source[i + 1] === mark || source[i - 1] === mark)) { while (source[i + 1] === mark) i++; continue; }
      if (mark[0] === '_' && /[\p{L}\p{N}]/u.test(source[i + mark.length] || '')) continue;
      return i;
    }
    return -1;
  }
}
export function parseMarkdown(source: string): Document { return new Parser().document(source); }
/** A document's plain text in reading order. */
export function inlineText(children: Inline[]): string {
  return children.map(child => child.type === 'text' || child.type === 'code' ? child.text : child.type === 'break' ? '\n' : child.type === 'image' ? child.alt : child.type === 'note' ? `[${child.number}]` : inlineText(child.children)).join('');
}
