/**
 * Splits source text into the few kinds of token the language adapters need. Comments, strings and regular expressions
 * never yield identifiers, so words in them are not mistaken for code. It is a lexer and not a compiler: what it cannot
 * decide it leaves as plain punctuation, and the adapters say how sure they are.
 */
export type Token = { kind: 'id' | 'string' | 'number' | 'punct' | 'regex' | 'directive'; text: string; line: number; start: number; end: number; /** The comment that ends right before this token. */ doc?: string };
export type Dialect = 'script' | 'cpp' | 'qml';

const idStart = /[\p{ID_Start}$_#]/u, idPart = /[\p{ID_Continue}$‌‍]/u;
const asciiStart = (c: number) => c >= 97 && c <= 122 || c >= 65 && c <= 90 || c === 95 || c === 36;
const asciiPart = (c: number) => asciiStart(c) || c >= 48 && c <= 57;
/** After these a slash starts a regular expression; after a value it divides. */
const beforeRegex = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'default']);
const pairs = ['=>', '::', '->', '?.', '...', '&&', '||', '??', '==', '!=', '<=', '>=', '++', '--'];
const plain = (comment: string) => comment.replace(/^\/\*+|\*+\/$/g, '').replace(/^\s*(?:\/\/+|\*)\s?/gm, '').replace(/\s+/g, ' ').trim();

export function tokenize(text: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [], length = text.length;
  let at = 0, line = 1, doc = '', docLine = 0;
  const push = (kind: Token['kind'], start: number, startLine: number) => {
    const token: Token = { kind, text: text.slice(start, at), line: startLine, start, end: at };
    if (doc && startLine - docLine <= 1) token.doc = doc.slice(0, 400);
    doc = ''; tokens.push(token);
  };
  const count = (from: number, to: number) => { for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) line++; };
  /** Inside ${…} an expression begins anew: a slash there starts a regular expression. */
  const expression = () => { const open = at; at += 2; push('punct', open, line); scan('}'); if (text[at] === '}') at++; };
  /** A template literal, whose ${…} parts are tokens of their own. */
  const template = () => {
    const start = at, startLine = line; at++;
    while (at < length) {
      const c = text[at];
      if (c === '\\') { if (text[at + 1] === '\n') line++; at += 2; continue; }
      if (c === '`') { at++; break; }
      if (c === '\n') line++;
      if (c === '$' && text[at + 1] === '{') {
        push('string', start, startLine); expression();
        // The rest of the literal continues as text.
        const rest = at, restLine = line;
        while (at < length && text[at] !== '`') { if (text[at] === '\\') { at += 2; continue; } if (text[at] === '$' && text[at + 1] === '{') { expression(); continue; } if (text[at] === '\n') line++; at++; }
        at = Math.min(length, at + 1); push('string', rest, restLine); return;
      }
      at++;
    }
    push('string', start, startLine);
  };
  function scan(until?: string) {
    let depth = 0;
    while (at < length) {
      const c = text[at], code = text.charCodeAt(at);
      if (code === 10) { line++; at++; continue; }
      if (code === 32 || code === 9 || code === 13 || code === 0xfeff) { at++; continue; }
      if (until && c === until && depth === 0) return;
      if (c === '/' && text[at + 1] === '/') { const start = at; while (at < length && text.charCodeAt(at) !== 10) at++; const said = plain(text.slice(start, at)); doc = docLine === line - 1 && doc ? doc + ' ' + said : said; docLine = line; continue; }
      if (c === '/' && text[at + 1] === '*') { const start = at, end = text.indexOf('*/', at + 2); at = end < 0 ? length : end + 2; count(start, at); doc = plain(text.slice(start, at)); docLine = line; continue; }
      if (dialect === 'cpp' && c === '#') {
        const start = at, startLine = line;
        while (at < length) { if (text[at] === '\\' && (text[at + 1] === '\n' || text.startsWith('\r\n', at + 1))) { at += text[at + 1] === '\r' ? 3 : 2; line++; continue; } if (text[at] === '\n') break; at++; }
        push('directive', start, startLine); continue;
      }
      if (dialect === 'cpp' && (c === 'R' || c === 'u' || c === 'U' || c === 'L')) {
        const raw = /^(?:u8|[uUL])?R"([^\s()\\]{0,16})\(/.exec(text.slice(at, at + 24));
        if (raw) { const start = at, startLine = line, end = text.indexOf(')' + raw[1] + '"', at); at = end < 0 ? length : end + raw[1].length + 2; count(start, at); push('string', start, startLine); continue; }
      }
      if (c === '"' || c === "'") {
        const start = at, startLine = line; at++;
        // An apostrophe in a C++ number separates digits; elsewhere a quote ends at its pair or at the end of the line.
        while (at < length && text[at] !== c) { if (text[at] === '\\') { if (text[at + 1] === '\n') line++; at += 2; continue; } if (text[at] === '\n') break; at++; }
        if (text[at] === c) at++;
        push('string', start, startLine); continue;
      }
      if (c === '`' && dialect !== 'cpp') { template(); continue; }
      if (code >= 48 && code <= 57) { const start = at; while (at < length && (asciiPart(text.charCodeAt(at)) || text[at] === '.' && /\d/.test(text[at + 1] || '') || dialect === 'cpp' && text[at] === "'" && /\d/.test(text[at + 1] || ''))) at++; push('number', start, line); continue; }
      if (asciiStart(code) || (code > 127 || c === '#') && idStart.test(c)) {
        const start = at; at++;
        while (at < length && (asciiPart(text.charCodeAt(at)) || text.charCodeAt(at) > 127 && idPart.test(text[at]))) at++;
        push('id', start, line); continue;
      }
      if (c === '/' && dialect !== 'cpp') {
        const last = tokens.at(-1);
        if (!last || last.kind === 'punct' && ![')', ']', '}', '++', '--'].includes(last.text) || last.kind === 'id' && beforeRegex.has(last.text)) {
          const start = at; let inside = false, ended = false; at++;
          while (at < length && text[at] !== '\n') { if (text[at] === '\\') { at += 2; continue; } if (text[at] === '[') inside = true; else if (text[at] === ']') inside = false; else if (text[at] === '/' && !inside) { at++; ended = true; break; } at++; }
          if (ended) { while (at < length && asciiPart(text.charCodeAt(at))) at++; push('regex', start, line); continue; }
          at = start;
        }
      }
      if (until) { if (c === '{') depth++; else if (c === '}') depth--; }
      const start = at, pair = pairs.find(item => text.startsWith(item, at)); at += pair ? pair.length : text.codePointAt(at)! > 0xffff ? 2 : 1; push('punct', start, line);
    }
  }
  scan();
  return tokens;
}
/** The token that closes the bracket at `open`, or the last token when nothing does. */
export function closing(tokens: Token[], open: number): number {
  const pair: Record<string, string> = { '(': ')', '[': ']', '{': '}' }, stack: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]; if (token.kind !== 'punct') continue;
    if (pair[token.text]) stack.push(pair[token.text]);
    else if (token.text === ')' || token.text === ']' || token.text === '}') {
      // A bracket that closes an outer pair ends the inner ones that were never closed.
      while (stack.length && stack.at(-1) !== token.text) stack.pop();
      stack.pop(); if (!stack.length) return i;
    }
  }
  return tokens.length - 1;
}
