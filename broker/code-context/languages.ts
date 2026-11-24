/**
 * What a file declares, imports and calls, read by one adapter for each family of languages. Nothing is executed and no
 * compiler is asked, so every reading carries its own confidence: `read` for what the text states outright (an import,
 * a declaration), `guess` for what had to be inferred from its shape.
 */
import { closing, tokenize, type Token } from './tokens.ts';

export type Language = 'typescript' | 'cpp' | 'qml';
export type SymbolKind = 'function' | 'class' | 'method' | 'property' | 'type' | 'constant' | 'enum' | 'namespace' | 'component' | 'signal' | 'test';
export type Confidence = 'read' | 'guess';
export type CodeSymbol = { name: string; kind: SymbolKind; container: string; line: number; endLine: number; exported: boolean; /** Declared here and defined elsewhere. */ declaration: boolean; signature: string; doc: string; confidence: Confidence; /** Words that occur in it, for searching. */ body: string };
export type CodeImport = { module: string; names: { imported: string; local: string }[]; line: number };
/** `symbol` is the index of the enclosing symbol, or -1 at the top of the file. */
export type CodeCall = { name: string; receiver: string; how: 'call' | 'new' | 'extends' | 'uses'; line: number; symbol: number };
/** `about` is the comment a file begins with. */
export type Parsed = { language: Language; about: string; symbols: CodeSymbol[]; imports: CodeImport[]; calls: CodeCall[]; truncated: boolean };
export const codeLimits = { symbols: 4000, calls: 20_000, imports: 600, signature: 220, words: 60 };

const byExtension: Record<string, Language> = { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'typescript', '.mjs': 'typescript', '.cjs': 'typescript', '.jsx': 'typescript', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.c': 'cpp', '.qml': 'qml' };
export const languageOf = (path: string): Language | undefined => byExtension[/\.[^./]+$/.exec(path)?.[0].toLowerCase() || ''];
export const languageNames: Record<Language, string> = { typescript: 'TypeScript and JavaScript', cpp: 'C and C++', qml: 'QML' };

const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, '');
const controls = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'async', 'new', 'delete', 'void', 'yield', 'throw', 'do', 'else', 'case', 'in', 'of', 'super', 'import', 'sizeof', 'alignof', 'decltype', 'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'constructor', 'noexcept', 'defined', 'with', 'static_assert', 'explicit', 'operator', 'co_await', 'co_return', 'co_yield']);

class Reader {
  tokens: Token[]; text: string; parsed: Parsed;
  constructor(text: string, language: Language) { this.text = text; this.tokens = tokenize(text, language === 'cpp' ? 'cpp' : language === 'qml' ? 'qml' : 'script'); this.parsed = { language, about: (this.tokens[0]?.doc || '').slice(0, 320), symbols: [], imports: [], calls: [], truncated: false }; }
  is(i: number, text: string) { return this.tokens[i]?.text === text && this.tokens[i].kind !== 'string'; }
  id(i: number) { return this.tokens[i]?.kind === 'id'; }
  private signature(from: number, to: number) { return this.text.slice(this.tokens[from].start, this.tokens[Math.max(from, to)].end).replace(/\s+/g, ' ').trim().slice(0, codeLimits.signature); }
  private words(from: number, to: number) { const found = new Set<string>(); for (let i = from; i <= to && found.size < codeLimits.words; i++) if (this.tokens[i].kind === 'id' && this.tokens[i].text.length > 2) found.add(this.tokens[i].text); return [...found].join(' '); }
  add(symbol: { name: string; kind: SymbolKind; container?: string; from: number; to: number; head: number; exported?: boolean; declaration?: boolean; confidence?: Confidence }) {
    if (this.parsed.symbols.length >= codeLimits.symbols) { this.parsed.truncated = true; return -1; }
    const last = this.tokens[Math.min(symbol.to, this.tokens.length - 1)];
    this.parsed.symbols.push({ name: symbol.name.slice(0, 200), kind: symbol.kind, container: symbol.container || '', line: this.tokens[symbol.from].line, endLine: last.line + (last.kind === 'string' ? (last.text.match(/\n/g) || []).length : 0), exported: !!symbol.exported, declaration: !!symbol.declaration,
      signature: this.signature(symbol.from, symbol.head), doc: this.tokens[symbol.from].doc || '', confidence: symbol.confidence || 'read', body: this.words(symbol.from, symbol.to) });
    return this.parsed.symbols.length - 1;
  }
  call(call: CodeCall) { if (this.parsed.calls.length >= codeLimits.calls) { this.parsed.truncated = true; return; } this.parsed.calls.push(call); }
  import(entry: CodeImport) { if (this.parsed.imports.length < codeLimits.imports && entry.module) this.parsed.imports.push(entry); else this.parsed.truncated = true; }
  /** Calls between two tokens, each given to the innermost symbol whose span holds it. */
  calls(spans: { symbol: number; from: number; to: number }[]) {
    const { tokens } = this, ordered = [...spans].sort((a, b) => a.from - b.from || b.to - a.to), open: typeof spans = [];
    let next = 0;
    for (let i = 0; i < tokens.length; i++) {
      while (next < ordered.length && ordered[next].from <= i) open.push(ordered[next++]);
      while (open.length && open.at(-1)!.to < i) open.pop();
      for (let k = open.length - 1; k >= 0; k--) if (open[k].to < i) open.splice(k, 1);
      if (tokens[i].kind !== 'id' || controls.has(tokens[i].text)) continue;
      const symbol = open.at(-1)?.symbol ?? -1, before = tokens[i - 1], after = tokens[i + 1];
      let follow = i + 1;
      // A call with type arguments: name<Type>(…). A comparison never closes before a bracket like this.
      if (after?.text === '<') { let depth = 0, k = follow; for (; k < Math.min(tokens.length, follow + 40); k++) { if (tokens[k].text === '<') depth++; else if (tokens[k].text === '>') { if (!--depth) { k++; break; } } else if (tokens[k].kind === 'punct' && [';', '{', '&&', '||', '=', ')'].includes(tokens[k].text)) { k = follow; break; } } if (k > follow && tokens[k]?.text === '(') follow = k; }
      if (tokens[follow]?.text !== '(') continue;
      const own = symbol >= 0 ? this.parsed.symbols[symbol] : undefined;
      if (own && own.name === tokens[i].text && own.line === tokens[i].line && i <= (ordered.find(span => span.symbol === symbol)?.from ?? -1) + 8 && before?.text !== '.') continue; // Its own declaration.
      const member = before?.text === '.' || before?.text === '?.' || before?.text === '->' || before?.text === '::';
      this.call({ name: tokens[i].text, receiver: member ? tokens[i - 2]?.kind === 'id' ? tokens[i - 2].text : '…' : '', how: before?.text === 'new' && before.kind === 'id' ? 'new' : 'call', line: tokens[i].line, symbol });
    }
  }
}

/** The end of a statement that starts at `i`: its semicolon, or the line break where the next one clearly begins. */
function statementEnd(r: Reader, i: number, stop: number) {
  const starts = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace', 'abstract', 'declare', 'async', 'if', 'for', 'while', 'return', 'throw', 'try', 'switch']);
  for (let k = i; k <= stop; k++) {
    const token = r.tokens[k];
    if (token.kind === 'punct' && ['(', '[', '{'].includes(token.text)) { k = Math.min(closing(r.tokens, k), stop); const next = r.tokens[k + 1]; if (next && k < stop && next.line > r.tokens[k].line && next.kind === 'id' && starts.has(next.text) && r.tokens[k].text === '}') return k; continue; }
    if (r.is(k, ';')) return k;
    if (token.text === '}' && token.kind === 'punct') return k - 1;
    const next = r.tokens[k + 1];
    if (k > i && next && next.line > token.line && next.kind === 'id' && starts.has(next.text) && !(token.kind === 'punct' && !['}', ')', ']'].includes(token.text))) return k;
  }
  return stop;
}
const scriptModifiers = new Set(['export', 'default', 'declare', 'abstract', 'async', 'public', 'private', 'protected', 'static', 'readonly', 'override', 'accessor']);
const testCalls = new Set(['test', 'it', 'describe', 'suite']);

function parseScript(r: Reader) {
  const spans: { symbol: number; from: number; to: number }[] = [];
  const note = (value: Parameters<Reader['add']>[0]) => { const symbol = r.add(value); if (symbol >= 0) spans.push({ symbol, from: value.from, to: value.to }); return symbol; };
  const skipTypes = (i: number, stop: number) => { let depth = 0; for (let k = i; k <= stop; k++) { if (r.is(k, '<')) depth++; else if (r.is(k, '>') || r.is(k, '=>')) { if (r.is(k, '>') && !--depth) return k + 1; } else if (!depth) return k; } return i; };
  /** From a parameter list to the body: past a return type, which may hold braces of its own. */
  const bodyOf = (i: number, stop: number) => {
    let k = i;
    if (r.is(k, ':')) { k++; for (; k <= stop; k++) { if (r.is(k, '{')) { const end = closing(r.tokens, k), after = r.tokens[end + 1]; if (after && (after.text === '{' || after.text === '|' || after.text === '&' || after.text === '[' || after.text === '>' || after.text === '=>')) { k = end; continue; } if (['|', '&', ':', '<', ',', '=>'].includes(r.tokens[k - 1].text) && after?.text === '{') { k = end; continue; } return k; } if (r.is(k, ';') || r.is(k, '=>') && !r.is(k - 1, ')')) return k; if (r.is(k, '(') || r.is(k, '[')) k = closing(r.tokens, k); } }
    return k;
  };
  const importAt = (i: number, stop: number) => {
    const end = statementEnd(r, i, stop), names: CodeImport['names'] = []; let module = '';
    for (let k = i + 1; k <= end; k++) {
      const token = r.tokens[k];
      if (token.kind === 'string') { module = unquote(token.text); break; }
      if (token.text === '*' && r.is(k + 1, 'as') && r.id(k + 2)) { names.push({ imported: '*', local: r.tokens[k + 2].text }); k += 2; continue; }
      if (token.kind === 'id' && !['type', 'from', 'as'].includes(token.text)) { const braces = (() => { let depth = 0; for (let b = i; b < k; b++) { if (r.is(b, '{')) depth++; else if (r.is(b, '}')) depth--; } return depth > 0; })(); if (r.is(k + 1, 'as') && r.id(k + 2)) { names.push({ imported: token.text, local: r.tokens[k + 2].text }); k += 2; } else names.push({ imported: braces ? token.text : 'default', local: token.text }); }
    }
    if (module) r.import({ module, names: names.slice(0, 200), line: r.tokens[i].line });
    return end;
  };
  const members = (from: number, to: number, container: string) => {
    for (let i = from; i < to; i++) {
      const first = i; let exported = true;
      while (r.is(i, '@')) { i++; while (r.id(i) || r.is(i, '.')) i++; if (r.is(i, '(')) i = closing(r.tokens, i) + 1; }
      while (r.id(i) && (scriptModifiers.has(r.tokens[i].text) || ['get', 'set'].includes(r.tokens[i].text)) && (r.id(i + 1) || r.tokens[i + 1]?.kind === 'string' || r.is(i + 1, '[') || r.is(i + 1, '*'))) { if (['private', 'protected'].includes(r.tokens[i].text)) exported = false; i++; }
      if (r.is(i, '*')) i++;
      const name = r.id(i) ? r.tokens[i].text : r.tokens[i]?.kind === 'string' ? unquote(r.tokens[i].text) : '';
      if (!name) { if (r.is(i, '[') || r.is(i, '{') || r.is(i, '(')) i = closing(r.tokens, i); continue; }
      let k = i + 1; if (r.is(k, '?') || r.is(k, '!')) k++;
      if (r.is(k, '<')) k = skipTypes(k, to);
      if (r.is(k, '(')) {
        const params = closing(r.tokens, k), body = bodyOf(params + 1, to - 1);
        if (r.is(body, '{')) { const end = Math.min(closing(r.tokens, body), to); note({ name, kind: 'method', container, from: first, to: end, head: body - 1, exported }); i = end; }
        else { const end = statementEnd(r, params, to - 1); note({ name, kind: 'method', container, from: first, to: end, head: Math.min(params, end), exported, declaration: true }); i = end; }
        continue;
      }
      const end = statementEnd(r, i, to - 1), arrow = (() => { for (let a = i; a <= Math.min(end, i + 60); a++) { if (r.is(a, '=>')) return true; if (r.is(a, '{')) return false; } return false; })();
      const equals = (() => { for (let a = i; a <= end; a++) if (r.is(a, '=')) return a; return -1; })();
      note({ name, kind: arrow && equals > 0 ? 'method' : 'property', container, from: first, to: end, head: Math.min(end, i + 14), exported }); i = end;
    }
  };
  const block = (from: number, to: number, container: string, top: boolean) => {
    for (let i = from; i <= to; i++) {
      const first = i; let exported = false, isDefault = false;
      if (r.is(i, 'import') && !r.is(i + 1, '(') && !r.is(i + 1, '.')) { i = importAt(i, to); continue; }
      if (r.is(i, 'export') && (r.is(i + 1, '{') || r.is(i + 1, '*') || r.is(i + 1, 'type') && r.is(i + 2, '{'))) {
        const end = statementEnd(r, i, to); let module = ''; const names: CodeImport['names'] = [];
        for (let k = i + 1; k <= end; k++) { if (r.tokens[k].kind === 'string') module = unquote(r.tokens[k].text); else if (r.id(k) && !['as', 'from', 'type'].includes(r.tokens[k].text)) { names.push({ imported: r.tokens[k].text, local: '' }); if (r.is(k + 1, 'as')) k += 2; } else if (r.is(k, '*')) names.push({ imported: '*', local: '' }); }
        if (module) r.import({ module, names: names.slice(0, 200), line: r.tokens[i].line });
        i = end; continue;
      }
      while (r.is(i, '@')) { i++; while (r.id(i) || r.is(i, '.')) i++; if (r.is(i, '(')) i = closing(r.tokens, i) + 1; }
      while (r.id(i) && scriptModifiers.has(r.tokens[i].text) && i < to && !r.is(i + 1, '(') && !r.is(i + 1, '=')) { if (r.tokens[i].text === 'export') exported = true; if (r.tokens[i].text === 'default') isDefault = true; i++; }
      const word = r.id(i) ? r.tokens[i].text : '';
      if (word === 'function') {
        let k = i + 1; if (r.is(k, '*')) k++;
        const name = r.id(k) ? r.tokens[k++].text : isDefault ? 'default' : ''; if (r.is(k, '<')) k = skipTypes(k, to);
        if (r.is(k, '(')) { const params = closing(r.tokens, k), body = bodyOf(params + 1, to); if (r.is(body, '{')) { const end = closing(r.tokens, body); if (name) note({ name, kind: 'function', container, from: first, to: end, head: body - 1, exported }); i = end; continue; } const end = statementEnd(r, params, to); if (name) note({ name, kind: 'function', container, from: first, to: end, head: Math.min(params, end), exported, declaration: true }); i = end; continue; }
      }
      if ((word === 'class' || word === 'interface' || word === 'enum' || word === 'namespace' || word === 'module') && (r.id(i + 1) || r.is(i + 1, '{') || r.tokens[i + 1]?.kind === 'string')) {
        const name = r.id(i + 1) ? r.tokens[i + 1].text : isDefault ? 'default' : '', kind: SymbolKind = word === 'class' ? 'class' : word === 'enum' ? 'enum' : word === 'interface' ? 'type' : 'namespace';
        let k = i + 1; while (k <= to && !r.is(k, '{')) { if (r.is(k, '(')) k = closing(r.tokens, k); k++; }
        const end = closing(r.tokens, k), symbol = name ? note({ name, kind, container, from: first, to: end, head: k - 1, exported }) : -1;
        for (let a = i + 1; a < k; a++) if ((r.is(a, 'extends') || r.is(a, 'implements')) && r.id(a + 1)) for (let b = a + 1; b < k && !r.is(b, 'implements'); b++) { if (r.id(b) && (r.is(b - 1, 'extends') || r.is(b - 1, 'implements') || r.is(b - 1, ','))) r.call({ name: r.tokens[b].text, receiver: '', how: 'extends', line: r.tokens[b].line, symbol }); }
        if (word === 'class') members(k + 1, end, name); else if (kind === 'namespace' && r.tokens[i + 1]?.kind !== 'string') block(k + 1, end - 1, name, false);
        i = end; continue;
      }
      if (word === 'type' && r.id(i + 1) && (r.is(i + 2, '=') || r.is(i + 2, '<'))) { const end = statementEnd(r, i, to); note({ name: r.tokens[i + 1].text, kind: 'type', container, from: first, to: end, head: Math.min(end, i + 24), exported }); i = end; continue; }
      if (['const', 'let', 'var'].includes(word)) {
        const end = statementEnd(r, i, to);
        if (r.id(i + 1)) {
          const name = r.tokens[i + 1].text; let equals = -1; for (let k = i + 2; k <= end; k++) { if (['(', '[', '{'].includes(r.tokens[k].text) && r.tokens[k].kind === 'punct') { k = closing(r.tokens, k); continue; } if (r.is(k, '=')) { equals = k; break; } }
          let k = equals + 1; if (r.is(k, 'async')) k++;
          const callable = equals > 0 && (r.is(k, 'function') || r.id(k) && r.is(k + 1, '=>') || (r.is(k, '(') || r.is(k, '<')) && (() => { const open = r.is(k, '<') ? skipTypes(k, end) : k; if (!r.is(open, '(')) return false; const close = closing(r.tokens, open); for (let a = close + 1; a <= Math.min(end, close + 40); a++) { if (r.is(a, '=>')) return true; if (a === close + 1 && !r.is(a, ':')) return false; } return false; })());
          note({ name, kind: callable ? 'function' : 'constant', container, from: first, to: end, head: Math.min(end, i + 18), exported });
          if (r.is(equals + 1, 'require') && r.tokens[equals + 3]?.kind === 'string') r.import({ module: unquote(r.tokens[equals + 3].text), names: [{ imported: 'default', local: name }], line: r.tokens[i].line });
        } else if (r.is(i + 1, '{') && top) { const close = closing(r.tokens, i + 1), at = close + 1; if (r.is(at, '=') && r.is(at + 1, 'require') && r.tokens[at + 3]?.kind === 'string') r.import({ module: unquote(r.tokens[at + 3].text), names: r.tokens.slice(i + 2, close).filter(token => token.kind === 'id').map(token => ({ imported: token.text, local: token.text })), line: r.tokens[i].line }); }
        i = end; continue;
      }
      // A named test, whose body is a test's and not part of the program.
      if (testCalls.has(word) && (r.is(i + 1, '(') || r.is(i + 1, '.') && r.is(i + 3, '('))) {
        const open = r.is(i + 1, '(') ? i + 1 : i + 3, title = r.tokens[open + 1];
        if (title?.kind === 'string') { const end = closing(r.tokens, open); note({ name: unquote(title.text), kind: 'test', container, from: first, to: end, head: open + 1 }); if (word === 'describe' || word === 'suite') block(open + 2, end - 1, unquote(title.text), false); i = end; continue; }
      }
      if (r.tokens[i]?.kind === 'punct' && ['(', '[', '{'].includes(r.tokens[i].text)) i = closing(r.tokens, i);
    }
  };
  block(0, r.tokens.length - 1, '', true);
  r.calls(spans);
}

const cppSkip = new Set(['public', 'private', 'protected', 'signals', 'slots', 'Q_OBJECT', 'Q_GADGET', 'Q_SIGNALS', 'Q_SLOTS', 'QML_ELEMENT', 'QML_SINGLETON', 'Q_INVOKABLE', 'Q_SLOT', 'Q_SIGNAL']);
function parseCpp(r: Reader) {
  const spans: { symbol: number; from: number; to: number }[] = [];
  const note = (value: Parameters<Reader['add']>[0]) => { const symbol = r.add(value); if (symbol >= 0) spans.push({ symbol, from: value.from, to: value.to }); return symbol; };
  const scope = (from: number, to: number, container: string, inClass: boolean) => {
    let visible = true, signals = false;
    for (let i = from; i <= to; i++) {
      const first = i, token = r.tokens[i];
      if (token.kind === 'directive') { const include = /^#\s*include\s*(["<])([^">]+)[">]/.exec(token.text); if (include) r.import({ module: (include[1] === '<' ? '<' : '') + include[2], names: [{ imported: '*', local: '' }], line: token.line }); continue; }
      if (token.kind !== 'id') { if (token.kind === 'punct' && ['(', '[', '{'].includes(token.text)) i = closing(r.tokens, i); continue; }
      // public: private: and Qt's signals: and slots:
      if (inClass && ['public', 'private', 'protected', 'signals', 'Q_SIGNALS'].includes(token.text)) { let k = i + 1; while (r.id(k)) k++; if (r.is(k, ':')) { visible = token.text !== 'private' && token.text !== 'protected'; signals = token.text === 'signals' || token.text === 'Q_SIGNALS'; i = k; continue; } }
      if (cppSkip.has(token.text) && !r.is(i + 1, '(')) continue;
      if (token.text === 'Q_PROPERTY' && r.is(i + 1, '(')) { const close = closing(r.tokens, i + 1), names = r.tokens.slice(i + 2, close).filter(item => item.kind === 'id'); const read = names.findIndex(item => ['READ', 'MEMBER', 'WRITE', 'NOTIFY', 'CONSTANT'].includes(item.text)); if (read > 0) note({ name: names[read - 1].text, kind: 'property', container, from: i, to: close, head: close, exported: true }); i = close; continue; }
      if (token.text === 'template' && r.is(i + 1, '<')) { let depth = 0, k = i + 1; for (; k <= to; k++) { if (r.is(k, '<')) depth++; else if (r.is(k, '>') && !--depth) break; } i = k; continue; }
      if (token.text === 'namespace') { let k = i + 1, name = ''; while (r.id(k) || r.is(k, '::')) { name += r.tokens[k].text; k++; } if (r.is(k, '{')) { const end = closing(r.tokens, k); if (name) note({ name, kind: 'namespace', container, from: first, to: end, head: k - 1, exported: true }); scope(k + 1, end - 1, name || container, false); i = end; continue; } if (r.is(k, '=')) { i = statementEnd(r, i, to); continue; } }
      if (token.text === 'using' || token.text === 'typedef' || token.text === 'friend') { let k = i; while (k <= to && !r.is(k, ';')) { if (r.is(k, '{') || r.is(k, '(')) k = closing(r.tokens, k); k++; } if (token.text === 'using' && r.id(i + 1) && r.is(i + 2, '=')) note({ name: r.tokens[i + 1].text, kind: 'type', container, from: first, to: k, head: Math.min(k, i + 12), exported: visible }); i = k; continue; }
      // Reads up to what decides: a body, the end of a declaration, or an initializer.
      let k = i, open = -1, kind = '', kindAt = -1;
      for (; k <= to; k++) {
        const t = r.tokens[k];
        if (t.kind === 'directive') continue;
        if (t.kind === 'id' && ['class', 'struct', 'union', 'enum'].includes(t.text) && open < 0 && kindAt < 0) { kind = t.text; kindAt = k; }
        if (r.is(k, 'operator') && open < 0) { let a = k + 1; if (r.is(a, '(') && r.is(a + 1, ')')) a += 2; while (a <= to && !r.is(a, '(')) a++; open = a; k = closing(r.tokens, a); continue; }
        if (r.is(k, '(')) { if (open < 0) open = k; k = closing(r.tokens, k); continue; }
        if (r.is(k, '[')) { k = closing(r.tokens, k); continue; }
        if (r.is(k, ';') || r.is(k, '{')) break;
        if (r.is(k, '=') && open < 0) break;
        if (r.is(k, ':') && open > 0 && !r.is(k + 1, ':')) {
          // A constructor's initializer list: name(…) or name{…}, separated by commas, and then the body.
          let a = k + 1;
          while (a <= to) { while (r.id(a) || r.is(a, '::') || r.is(a, '<') || r.is(a, '>')) a++; if (r.is(a, '(') || r.is(a, '{')) a = closing(r.tokens, a) + 1; else break; if (r.is(a, '...')) a++; if (r.is(a, ',')) { a++; continue; } break; }
          k = a - 1; continue;
        }
      }
      if (kind && open < 0 && r.is(k, '{')) {
        let name = ''; for (let a = kindAt + 1; a < k; a++) { if (r.is(a, ':') && !r.is(a + 1, ':')) break; if (r.id(a) && !['class', 'struct', 'final', 'alignas'].includes(r.tokens[a].text)) name = r.tokens[a].text; if (r.is(a, '(')) a = closing(r.tokens, a); }
        const end = closing(r.tokens, k), symbol = name ? note({ name, kind: kind === 'enum' ? 'enum' : kind === 'class' ? 'class' : 'type', container, from: first, to: end, head: k - 1, exported: visible }) : -1;
        for (let a = kindAt; a < k; a++) if (r.is(a, ':') && !r.is(a - 1, ':')) { for (let b = a + 1; b < k; b++) if (r.id(b) && !['public', 'private', 'protected', 'virtual'].includes(r.tokens[b].text) && !r.is(b + 1, '::')) r.call({ name: r.tokens[b].text, receiver: '', how: 'extends', line: r.tokens[b].line, symbol }); break; }
        if (kind !== 'enum') scope(k + 1, end - 1, name || container, true);
        i = end; while (i + 1 <= to && !r.is(i, ';') && r.tokens[i].line === r.tokens[end].line && !r.is(i + 1, '}')) { if (r.is(i + 1, ';')) { i++; break; } if (r.id(i + 1)) i++; else break; }
        continue;
      }
      if (open > first && (r.id(open - 1) || r.is(open - 1, ')') || r.is(open - 1, '=')) && (r.is(k, '{') || r.is(k, ';'))) {
        let at = open - 1, name = r.id(at) ? r.tokens[at].text : '';
        const operator = r.tokens.slice(first, open).findIndex(item => item.kind === 'id' && item.text === 'operator');
        if (operator >= 0) { name = 'operator' + r.tokens.slice(first + operator + 1, open).map(item => item.text).join(''); at = first + operator; }
        if (name && !controls.has(name) || operator >= 0) {
          if (r.is(at - 1, '~')) { name = '~' + name; at--; }
          let owner = container; if (r.is(at - 1, '::') && r.id(at - 2)) owner = r.tokens[at - 2].text;
          const body = r.is(k, '{'), end = body ? closing(r.tokens, k) : k;
          // A name without a type before it is a constructor, a macro, or not a declaration at all.
          const constructs = name === owner || name === '~' + owner, typed = at > first;
          if (body || typed || constructs) note({ name, kind: signals ? 'signal' : owner ? 'method' : 'function', container: owner, from: name.startsWith('~') && r.is(first - 1, '~') ? first - 1 : first, to: end, head: body ? k - 1 : k, exported: visible, declaration: !body && !signals, confidence: constructs || typed ? 'read' : 'guess' });
          i = end; continue;
        }
      }
      if (r.is(k, '{')) { i = closing(r.tokens, k); continue; }
      if (r.is(k, '=')) { i = statementEnd(r, k, to); const name = r.id(k - 1) ? r.tokens[k - 1].text : ''; if (name && !inClass && r.tokens.slice(first, k).some(item => item.text === 'constexpr' || item.text === 'const')) note({ name, kind: 'constant', container, from: first, to: i, head: Math.min(i, k + 8), exported: true }); continue; }
      i = k;
    }
  };
  scope(0, r.tokens.length - 1, '', false);
  r.calls(spans);
}

function parseQml(r: Reader, name: string) {
  const spans: { symbol: number; from: number; to: number }[] = [];
  const note = (value: Parameters<Reader['add']>[0]) => { const symbol = r.add(value); if (symbol >= 0) spans.push({ symbol, from: value.from, to: value.to }); return symbol; };
  const object = (from: number, to: number, container: string, owner: number) => {
    for (let i = from; i <= to; i++) {
      const token = r.tokens[i], first = i;
      if (token.kind !== 'id') { if (token.kind === 'punct' && ['(', '[', '{'].includes(token.text) && !(token.text === '[' || token.text === '{')) i = closing(r.tokens, i); continue; }
      let k = i; while (r.id(k) && ['required', 'readonly', 'default', 'final'].includes(r.tokens[k].text) && (r.id(k + 1))) k++;
      if (r.is(k, 'property') && r.id(k + 1)) { let a = k + 1; while (r.id(a) && (r.is(a + 1, '<') || r.is(a + 1, '.'))) { if (r.is(a + 1, '.')) a += 2; else { while (!r.is(a, '>') && a < to) a++; a++; } } const at = r.id(a + 1) ? a + 1 : a; if (r.id(at)) { note({ name: r.tokens[at].text, kind: 'property', container, from: first, to: at, head: at, exported: true }); i = at; if (r.is(i + 1, ':')) i++; continue; } }
      if (r.is(k, 'property') && r.id(k + 1) === false) continue;
      if (token.text === 'signal' && r.id(i + 1)) { const end = r.is(i + 2, '(') ? closing(r.tokens, i + 2) : i + 1; note({ name: r.tokens[i + 1].text, kind: 'signal', container, from: first, to: end, head: end, exported: true }); i = end; continue; }
      if (token.text === 'function' && r.id(i + 1) && r.is(i + 2, '(')) { const params = closing(r.tokens, i + 2); let body = params + 1; while (body <= to && !r.is(body, '{') && r.tokens[body].line === r.tokens[params].line) body++; if (r.is(body, '{')) { const end = closing(r.tokens, body); note({ name: r.tokens[i + 1].text, kind: 'function', container, from: first, to: end, head: params, exported: true }); i = end; continue; } }
      if (token.text === 'component' && r.id(i + 1) && r.is(i + 2, ':')) { let open = i + 3; while (open <= to && !r.is(open, '{')) open++; const end = closing(r.tokens, open), symbol = note({ name: r.tokens[i + 1].text, kind: 'component', container, from: first, to: end, head: open - 1, exported: true }); const base = r.tokens[open - 1]; if (base?.kind === 'id') r.call({ name: base.text, receiver: '', how: 'extends', line: base.line, symbol }); object(open + 1, end - 1, r.tokens[i + 1].text, symbol); i = end; continue; }
      // An object of some type: what this component is made of.
      let type = i; while (r.is(type + 1, '.') && r.id(type + 2)) type += 2;
      if (/^[A-Z]/.test(r.tokens[type].text) && r.is(type + 1, '{')) { r.call({ name: r.tokens[type].text, receiver: '', how: 'uses', line: r.tokens[type].line, symbol: owner }); const end = closing(r.tokens, type + 1); object(type + 2, end - 1, container, owner); i = end; continue; }
    }
  };
  let i = 0;
  for (; i < r.tokens.length; i++) {
    if (r.is(i, 'import')) {
      const line = r.tokens[i].line, alias = (() => { for (let k = i + 1; k < r.tokens.length && r.tokens[k].line === line; k++) if (r.is(k, 'as') && r.id(k + 1)) return r.tokens[k + 1].text; return ''; })();
      const next = r.tokens[i + 1]; let module = ''; if (next?.kind === 'string') module = unquote(next.text); else for (let k = i + 1; k < r.tokens.length && r.tokens[k].line === line && (r.id(k) || r.is(k, '.')) && !r.is(k, 'as'); k++) module += r.tokens[k].text;
      r.import({ module, names: [{ imported: '*', local: alias }], line });
      while (i + 1 < r.tokens.length && r.tokens[i + 1].line === line) i++;
      continue;
    }
    if (r.is(i, 'pragma')) { const line = r.tokens[i].line; while (i + 1 < r.tokens.length && r.tokens[i + 1].line === line) i++; continue; }
    if (r.id(i) && /^[A-Z]/.test(r.tokens[i].text) && r.is(i + 1, '{')) {
      const end = closing(r.tokens, i + 1), symbol = note({ name, kind: 'component', from: i, to: end, head: i, exported: true });
      r.call({ name: r.tokens[i].text, receiver: '', how: 'extends', line: r.tokens[i].line, symbol });
      object(i + 2, end - 1, name, symbol); i = end;
    }
  }
  r.calls(spans);
}

export function parseSource(path: string, text: string): Parsed | undefined {
  const language = languageOf(path); if (!language) return undefined;
  const reader = new Reader(text, language);
  if (language === 'typescript') parseScript(reader); else if (language === 'cpp') parseCpp(reader); else parseQml(reader, path.split('/').at(-1)!.replace(/\.qml$/, ''));
  return reader.parsed;
}
