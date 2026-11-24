/**
 * The code index of the projects the person chose: what their files declare, import and call, and nothing else of them.
 * It is derived from files that stay where they are, so it can always be thrown away and made again, and it is thrown
 * away as soon as a project is no longer chosen. Every row belongs to one content hash of one file; a file that changed
 * or went takes its rows with it.
 *
 * Relationships are worked out when they are asked for, from what the text states. Each says how sure it is:
 * `certain` when the file says so itself (declared here, or imported by name from there), `possible` when only one thing
 * in the project has that name, and `ambiguous` when several do. A call that fits nothing is left out, never guessed.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { languageOf, type CodeCall, type CodeImport, type Language, type Parsed, type SymbolKind } from './languages.ts';

export type Certainty = 'certain' | 'possible' | 'ambiguous';
export type IndexedSymbol = { id: number; project: string; path: string; language: Language; key: string; name: string; container: string; kind: SymbolKind; line: number; endLine: number; exported: boolean; declaration: boolean; signature: string; doc: string; confidence: 'read' | 'guess' };
/** `candidates` is how many things the name could mean, when the text does not say which. */
export type Relation = { symbol?: IndexedSymbol; path: string; line: number; name: string; certainty: Certainty; how: CodeCall['how']; candidates?: number };
export type IndexedFile = { path: string; language: Language; sha256: string; size: number; mtime: number; problem: string };
const schema = 4;
const callable = new Set<SymbolKind>(['function', 'method', 'class', 'component', 'signal', 'constant', 'type', 'enum']);
/** Methods of the languages' own collections, streams and promises. */
const everyday = new Set('add all append apply at bind call catch clear clone close concat connect contains data delete destroy emit end entries every exec fill filter finally find findIndex first flat flatMap forEach from get has includes indexOf insert isEmpty items join key keys last length list log map match next of off on once open pop prepare push read reduce remove replace reset resolve reverse run set setProperty shift size slice some sort splice split start stop test text then toString trim update value values write'.split(' '));
export const isTestPath = (path: string) => /(^|\/)(tests?|__tests__|spec|specs|androidTest|benchmarks?)\//i.test(path) || /[._-](test|spec)\.[^/]+$/i.test(path) || /(^|\/)test_[^/]+$/i.test(path);

/** The words in a name: runWithRetry and run_with_retry are the same three. */
export const nameWords = (name: string) => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const plainStem = (word: string) => word.length > 4 ? word.replace(/(?:ations?|ions?|ies|ing|ed|es|s)$/, '') : word.replace(/s$/, '');
const spoken = (text: string) => [...new Set([...text.split(/[^\p{L}\p{N}_$]+/u).filter(Boolean), ...nameWords(text)].map(word => word.toLowerCase()))].join(' ');
const stop = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may me my of on or our should so that the their them then there these they this to us use used uses was we were what when where which who why will with would you your pal code file files function functions class method defined implemented'.split(' '));

export class CodeIndex {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA synchronous=NORMAL;');
    if (Number((this.db.prepare('PRAGMA user_version').get() as any).user_version) !== schema) for (const table of this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','files','symbols','imports','calls','words')").all() as any[]) this.db.exec(`DROP TABLE IF EXISTS ${table.name}`);
    // Paths are kept once. The word index holds no text, only which words occur where.
    this.db.exec(`CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, project INTEGER NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, problem TEXT NOT NULL, UNIQUE(project,path));
      CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, file INTEGER NOT NULL, nth INTEGER NOT NULL, name TEXT NOT NULL, container TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL, declaration INTEGER NOT NULL, signature TEXT NOT NULL, doc TEXT NOT NULL, confidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name); CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
      CREATE TABLE IF NOT EXISTS imports(file INTEGER NOT NULL, module TEXT NOT NULL, names TEXT NOT NULL, line INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS imports_file ON imports(file);
      CREATE TABLE IF NOT EXISTS calls(file INTEGER NOT NULL, symbol INTEGER, name TEXT NOT NULL, receiver TEXT NOT NULL, how TEXT NOT NULL, line INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_name ON calls(name); CREATE INDEX IF NOT EXISTS calls_file ON calls(file);
      CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(name, place, said, body, content='', contentless_delete=1, tokenize='porter unicode61');
      PRAGMA user_version=${schema};`);
  }
  close() { this.db.close(); }
  /** A change without a new row. The word index uses row numbers of its own that no JavaScript number holds. */
  private change(sql: string, ...args: (string | number)[]) { const statement = this.db.prepare(sql); statement.setReadBigInts(true); statement.run(...args); }
  private transaction<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private projectId(project: string, create = false): number {
    const row = this.db.prepare('SELECT id FROM projects WHERE path=?').get(project) as any; if (row) return Number(row.id);
    return create ? Number(this.db.prepare('INSERT INTO projects(path) VALUES (?)').run(project).lastInsertRowid) : -1;
  }
  files(project: string): Map<string, IndexedFile> { return new Map((this.db.prepare('SELECT path,language,sha256,size,mtime,problem FROM files WHERE project=?').all(this.projectId(project)) as any[]).map(row => [String(row.path), row as IndexedFile])); }
  private drop(file: number) {
    this.change('DELETE FROM words WHERE rowid IN (SELECT id FROM symbols WHERE file=?)', file);
    for (const table of ['symbols', 'imports', 'calls']) this.change(`DELETE FROM ${table} WHERE file=?`, file);
    this.change('DELETE FROM files WHERE id=?', file);
  }
  private fileId(project: string, path: string) { const row = this.db.prepare('SELECT id FROM files WHERE project=? AND path=?').get(this.projectId(project), path) as any; return row ? Number(row.id) : -1; }
  remove(project: string, path: string) { this.transaction(() => this.drop(this.fileId(project, path))); }
  removeProject(project: string) {
    const id = this.projectId(project);
    this.transaction(() => {
      this.change('DELETE FROM words WHERE rowid IN (SELECT s.id FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=?)', id);
      for (const table of ['symbols', 'imports', 'calls']) this.change(`DELETE FROM ${table} WHERE file IN (SELECT id FROM files WHERE project=?)`, id);
      this.change('DELETE FROM files WHERE project=?', id); this.change('DELETE FROM projects WHERE id=?', id);
    });
    // Deleted pages are overwritten; the space goes back so no copy of a removed project's names stays in the file.
    try { this.db.exec("INSERT INTO words(words) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"); } catch { /* Another reader holds it; the pages are already zeroed. */ }
  }
  touch(project: string, path: string, size: number, mtime: number) { this.change('UPDATE files SET size=?,mtime=? WHERE id=?', size, mtime, this.fileId(project, path)); }
  /** One file's rows, replaced as a whole. */
  replace(project: string, file: IndexedFile, parsed: Parsed | undefined) {
    this.transaction(() => {
      this.drop(this.fileId(project, file.path));
      const id = Number(this.db.prepare('INSERT INTO files(project,path,language,sha256,size,mtime,problem) VALUES (?,?,?,?,?,?,?)').run(this.projectId(project, true), file.path, file.language, file.sha256, file.size, file.mtime, file.problem).lastInsertRowid);
      if (!parsed) return;
      const insert = this.db.prepare('INSERT INTO symbols(file,nth,name,container,kind,line,end_line,exported,declaration,signature,doc,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'), words = this.db.prepare('INSERT INTO words(rowid,name,place,said,body) VALUES (?,?,?,?,?)');
      const ids: number[] = [], seen = new Map<string, number>(), place = `${spoken(file.path.replace(/\.[^.]+$/, ''))} ${parsed.about.toLowerCase()}`;
      for (const symbol of parsed.symbols) {
        const base = `${symbol.container}.${symbol.name}:${symbol.kind}`, nth = seen.get(base) || 0; seen.set(base, nth + 1);
        const row = Number(insert.run(id, nth, symbol.name, symbol.container, symbol.kind, symbol.line, symbol.endLine, symbol.exported ? 1 : 0, symbol.declaration ? 1 : 0, symbol.signature, symbol.doc, symbol.confidence).lastInsertRowid);
        ids.push(row); words.run(row, spoken(symbol.name), `${place} ${spoken(symbol.container)}`, `${spoken(symbol.signature)} ${symbol.doc.toLowerCase()}`, spoken(symbol.body));
      }
      const imported = this.db.prepare('INSERT INTO imports VALUES (?,?,?,?)'); for (const entry of parsed.imports) imported.run(id, entry.module.slice(0, 400), JSON.stringify(entry.names), entry.line);
      const called = this.db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?)'); for (const call of parsed.calls) called.run(id, call.symbol >= 0 ? ids[call.symbol] ?? null : null, call.name.slice(0, 200), call.receiver.slice(0, 200), call.how, call.line);
    });
  }
  counts(project: string) {
    const id = this.projectId(project), files = this.db.prepare("SELECT COUNT(*) AS n, SUM(problem<>'') AS problems FROM files WHERE project=?").get(id) as any, symbols = this.db.prepare('SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=?').get(id) as any;
    const languages = (this.db.prepare('SELECT language, COUNT(*) AS n FROM files WHERE project=? GROUP BY language ORDER BY n DESC').all(id) as any[]).map(row => String(row.language) as Language);
    return { files: Number(files.n), problems: Number(files.problems) || 0, symbols: Number(symbols.n), languages };
  }
  private static columns = 's.id,s.nth,s.name,s.container,s.kind,s.line,s.end_line,s.exported,s.declaration,s.signature,s.doc,s.confidence,f.path,f.language';
  /** The same thing after its file changed: where it is named, what it is, and which of several of that name. */
  private row = (project: string) => (row: any): IndexedSymbol => ({ id: Number(row.id), project, path: row.path, language: row.language, key: `${row.path}#${row.container ? row.container + '.' : ''}${row.name}:${row.kind}${row.nth ? '~' + row.nth : ''}`, name: row.name, container: row.container, kind: row.kind, line: row.line, endLine: row.end_line, exported: !!row.exported, declaration: !!row.declaration, signature: row.signature, doc: row.doc, confidence: row.confidence });
  symbol(project: string, id: number) { const row = this.db.prepare(`SELECT ${CodeIndex.columns} FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=? AND s.id=?`).get(this.projectId(project), id); return row ? this.row(project)(row) : undefined; }
  byKey(project: string, key: string) {
    const parts = /^(.+)#(?:(.*)\.)?([^.]*|.*\S.*):([a-z]+)(?:~(\d+))?$/.exec(key); if (!parts) return undefined;
    return (this.db.prepare(`SELECT ${CodeIndex.columns} FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=? AND f.path=?`).all(this.projectId(project), parts[1]) as any[]).map(this.row(project)).find(symbol => symbol.key === key);
  }
  named(project: string, name: string) { return (this.db.prepare(`SELECT ${CodeIndex.columns} FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=? AND s.name=? ORDER BY s.declaration, s.exported DESC, f.path, s.line LIMIT 60`).all(this.projectId(project), name) as any[]).map(this.row(project)); }
  /** What a question or a name most likely means, best first. */
  find(project: string, query: string, limit = 12): { symbol: IndexedSymbol; why: 'name' | 'words' }[] {
    const asked = query.trim(), found = new Map<number, { symbol: IndexedSymbol; why: 'name' | 'words'; score: number }>();
    const take = (symbol: IndexedSymbol, why: 'name' | 'words', score: number) => { const old = found.get(symbol.id); if (!old || old.score < score) found.set(symbol.id, { symbol, why, score }); };
    // Names written in the question: Class.method, Class::method, file.ts, or the name alone.
    for (const part of new Set(asked.match(/[\p{L}_$][\p{L}\p{N}_$]*(?:(?:\.|::)[\p{L}_$][\p{L}\p{N}_$]*)*/gu) || [])) {
      const pieces = part.split(/\.|::/), name = pieces.at(-1)!, container = pieces.length > 1 ? pieces.at(-2)! : '';
      // An everyday word that happens to be a name is found by its words instead.
      if (stop.has(name.toLowerCase()) || asked !== part && !container && !/[A-Z_$\d]/.test(name.slice(1))) continue;
      for (const symbol of this.named(project, name)) if (!container || symbol.container === container || symbol.path.split('/').at(-1)!.replace(/\.[^.]+$/, '') === container) take(symbol, 'name', 1000 + (container ? 100 : 0));
    }
    const terms = [...new Set(nameWords(asked).map(word => word.toLowerCase()))].filter(word => word.length > 1 && !stop.has(word)).slice(0, 16), tests = /\btests?\b/i.test(asked);
    if (terms.length) {
      const id = this.projectId(project), quoted = (term: string) => `"${term.replaceAll('"', '')}"`;
      const rows = this.db.prepare(`SELECT ${CodeIndex.columns}, bm25(words, 8.0, 3.0, 5.0, 1.0) AS rank FROM words JOIN symbols s ON s.id=words.rowid JOIN files f ON f.id=s.file WHERE words MATCH ? AND f.project=? ORDER BY rank LIMIT 240`).all(terms.map(quoted).join(' OR '), id) as any[];
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=?').get(id) as any).n), ids = rows.map(row => Number(row.id)), among = ids.join(',');
      // A rare word says more than a common one, and a word in the name more than one somewhere in the body.
      const weights = terms.map(term => Math.log(1 + total / (1 + Number((this.db.prepare('SELECT COUNT(*) AS n FROM words WHERE words MATCH ?').get(quoted(term)) as any).n)))), sum = weights.reduce((a, b) => a + b, 0) || 1;
      const places = [['name', 3], ['said', 2], ['place', 1.1], ['body', .55]] as const, best = new Map<number, number[]>(ids.map(row => [row, terms.map(() => 0)]));
      if (ids.length) for (const [at, term] of terms.entries()) for (const [column, weight] of places) for (const hit of this.db.prepare(`SELECT rowid AS id FROM words WHERE words MATCH ? AND rowid IN (${among})`).all(`{${column}} : ${quoted(term)}`) as any[]) { const row = best.get(Number(hit.id))!; row[at] = Math.max(row[at], weight); }
      for (const raw of rows) {
        const symbol = this.row(project)(raw), matched = best.get(symbol.id)!, covered = weights.reduce((value, weight, at) => value + (matched[at] ? weight : 0), 0) / sum;
        let score = weights.reduce((value, weight, at) => value + weight * matched[at], 0) / sum * (.5 + .5 * covered);
        // A name all of whose words were asked for is more likely the one than a longer name that merely contains them.
        const own = nameWords(symbol.name).map(word => plainStem(word.toLowerCase())), wanted = new Set(terms.map(plainStem)), precise = own.length ? own.filter(word => wanted.has(word)).length / own.length : 0;
        score *= 1 + .35 * precise;
        if (!tests && (symbol.kind === 'test' || isTestPath(symbol.path))) score *= .4;
        if (symbol.declaration) score *= .6; if (symbol.kind === 'property' || symbol.kind === 'constant') score *= .85; if (symbol.exported && !symbol.container) score *= 1.08;
        take(symbol, 'words', score - Number(raw.rank) / 1000);
      }
    }
    return [...found.values()].sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.line - b.symbol.line).slice(0, limit).map(({ symbol, why }) => ({ symbol, why }));
  }
  imports(project: string, path: string): CodeImport[] { return (this.db.prepare('SELECT module,names,line FROM imports WHERE file=? ORDER BY line').all(this.fileId(project, path)) as any[]).map(row => ({ module: row.module, names: JSON.parse(row.names), line: row.line })); }
  /** The project's file an import names, or nothing when it is not one of them. */
  resolve(files: Set<string> | Map<string, unknown>, from: string, module: string): string | undefined {
    const has = (path: string) => files.has(path), folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const join = (base: string, rel: string) => { const parts = base ? base.split('/') : []; for (const part of rel.split('/')) { if (part === '' || part === '.') continue; if (part === '..') { if (!parts.length) return undefined; parts.pop(); } else parts.push(part); } return parts.join('/'); };
    if (module.startsWith('<')) return undefined;
    if (/\.(?:h|hh|hpp|hxx|c|cc|cpp|cxx)$/i.test(module)) { const near = join(folder, module); if (near && has(near)) return near; const ends = [...files.keys()].filter(path => path === module || path.endsWith('/' + module)); return ends.length === 1 ? ends[0] : undefined; }
    if (!module.startsWith('.') && !/\.(?:js|mjs|qml)$/.test(module)) return undefined;
    const base = join(folder, module); if (base === undefined) return undefined;
    for (const path of [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx'].map(end => base + end), base.replace(/\.(m|c)?js$/, '.$1ts'), base.replace(/\.jsx?$/, '.tsx'), base + '/index.ts', base + '/index.js']) if (has(path)) return path;
    return undefined;
  }
  /** Files that import a file, with the names they take from it. */
  importers(project: string, path: string, files = this.files(project)): { path: string; line: number; names: CodeImport['names'] }[] {
    const stem = path.split('/').at(-1)!.replace(/\.[^.]+$/, ''), out = [];
    for (const row of this.db.prepare("SELECT f.path,i.module,i.names,i.line FROM imports i JOIN files f ON f.id=i.file WHERE f.project=? AND i.module LIKE ? ESCAPE '\\'").all(this.projectId(project), `%${stem.replace(/[\\%_]/g, '\\$&')}%`) as any[]) if (this.resolve(files, row.path, row.module) === path) out.push({ path: row.path, line: row.line, names: JSON.parse(row.names) });
    return out;
  }
  /** How sure it is that a call in `path` means `target`, or nothing when it does not. */
  private judge(call: { path: string; name: string; receiver: string; how: CodeCall['how']; container: string }, target: IndexedSymbol, rivals: number, taken: Map<string, Map<string, { path: string; imported: string }[]>>): Certainty | undefined {
    const here = call.path === target.path, imported = taken.get(call.path), from = (local: string) => imported?.get(local)?.find(item => item.path === target.path);
    const spoken = languageOf(call.path);
    if (spoken !== target.language) return spoken === 'qml' && target.language === 'typescript' && !target.container && call.receiver && from(call.receiver)?.imported === '*' ? 'certain' : undefined;
    // A method's name that the language itself uses everywhere says nothing about whose method it is.
    const alone: Certainty | undefined = everyday.has(call.name) ? undefined : rivals <= 1 ? 'possible' : 'ambiguous';
    if (target.language === 'typescript') {
      if (!target.container) {
        if (!call.receiver) return from(call.name)?.imported === target.name ? 'certain' : here && call.name === target.name && !imported?.has(call.name) ? 'certain' : undefined;
        if (from(call.receiver)?.imported === '*') return 'certain';
        return undefined;
      }
      if (!call.receiver) return undefined;
      if (call.receiver === 'this') return here && call.container === target.container ? 'certain' : undefined;
      return call.receiver === target.container && (here || !!from(call.receiver)) ? 'certain' : alone;
    }
    if (target.language === 'qml') {
      if (target.kind === 'component') return call.how === 'uses' || call.how === 'extends' ? rivals <= 1 ? 'certain' : 'ambiguous' : undefined;
      if (here && !call.receiver) return 'certain';
      return call.receiver ? alone : undefined;
    }
    if (!target.container) return call.receiver && call.receiver !== '…' ? undefined : here && rivals <= 1 ? 'certain' : alone;
    if (!call.receiver) return call.container === target.container ? 'certain' : target.name === target.container ? alone : undefined;
    return call.receiver === target.container ? 'certain' : alone;
  }
  /** For each file, what its imports bring in under which local name. */
  private taken(project: string, paths: Iterable<string>, files: Map<string, IndexedFile>) {
    const out = new Map<string, Map<string, { path: string; imported: string }[]>>();
    for (const path of new Set(paths)) {
      const names = new Map<string, { path: string; imported: string }[]>(); out.set(path, names);
      for (const entry of this.imports(project, path)) { const target = this.resolve(files, path, entry.module); if (!target) continue; for (const name of entry.names) if (name.local) names.set(name.local, [...(names.get(name.local) || []), { path: target, imported: name.imported }]); }
    }
    return out;
  }
  private rivals(project: string, name: string) { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT s.file,s.container FROM symbols s JOIN files f ON f.id=s.file WHERE f.project=? AND s.name=? AND s.declaration=0)').get(this.projectId(project), name) as any).n); }
  /** Where something is used: the calls that mean it, and the tests among them. */
  users(project: string, target: IndexedSymbol, limit = 60): { used: Relation[]; tests: Relation[]; more: number } {
    const files = this.files(project), aliases = new Set([target.name]);
    if (target.language === 'typescript') for (const importer of this.importers(project, target.path, files)) for (const name of importer.names) if (name.imported === target.name && name.local) aliases.add(name.local);
    const rows = [...aliases].flatMap(name => this.db.prepare('SELECT c.name,c.receiver,c.how,c.line,f.path,s.container AS owner,s.id AS owner_id FROM calls c JOIN files f ON f.id=c.file LEFT JOIN symbols s ON s.id=c.symbol WHERE f.project=? AND c.name=? ORDER BY f.path, c.line LIMIT 1500').all(this.projectId(project), name) as any[]);
    const taken = this.taken(project, rows.map(row => row.path), files), rivals = this.rivals(project, target.name), used: Relation[] = [], tests: Relation[] = [], order = { certain: 0, possible: 1, ambiguous: 2 };
    for (const row of rows) {
      if (Number(row.owner_id) === target.id && target.kind !== 'class' && target.kind !== 'component' && row.name !== target.name) continue;
      const certainty = this.judge({ path: row.path, name: row.name, receiver: row.receiver, how: row.how, container: row.owner || '' }, target, rivals, taken); if (!certainty) continue;
      const symbol = row.owner_id ? this.symbol(project, Number(row.owner_id)) : undefined;
      if (symbol?.id === target.id) continue;
      (symbol?.kind === 'test' || isTestPath(row.path) ? tests : used).push({ ...(symbol ? { symbol } : {}), path: row.path, line: row.line, name: row.name, certainty, how: row.how });
    }
    const tidy = (list: Relation[]) => list.sort((a, b) => order[a.certainty] - order[b.certainty] || a.path.localeCompare(b.path) || a.line - b.line);
    return { used: tidy(used).slice(0, limit), tests: tidy(tests).slice(0, limit), more: Math.max(0, used.length - limit) + Math.max(0, tests.length - limit) };
  }
  /** What something calls. What fits nothing in the project is only counted. */
  uses(project: string, source: IndexedSymbol, limit = 60): { uses: Relation[]; outside: number } {
    const files = this.files(project), rows = this.db.prepare('SELECT c.name,c.receiver,c.how,c.line,s.container AS owner FROM calls c LEFT JOIN symbols s ON s.id=c.symbol WHERE c.file=? AND (c.symbol=? OR c.line BETWEEN ? AND ?) ORDER BY c.line').all(this.fileId(project, source.path), source.id, source.line, source.endLine).map((row: any) => ({ ...row, path: source.path })) as any[];
    const taken = this.taken(project, [source.path], files), out = new Map<string, Relation>(), order = { certain: 0, possible: 1, ambiguous: 2 }; let outside = 0;
    for (const row of rows) {
      const real = taken.get(source.path)?.get(row.name)?.[0]?.imported, name = real && real !== '*' && real !== 'default' ? real : row.name;
      let best: Relation | undefined, could = 0;
      const candidates = this.named(project, name).filter(symbol => callable.has(symbol.kind) && symbol.kind !== 'test' && symbol.id !== source.id && !(source.language !== 'qml' && symbol.language === 'qml')), rivals = this.rivals(project, name);
      for (const symbol of candidates) {
        const certainty = this.judge({ path: row.path, name: row.name, receiver: row.receiver, how: row.how, container: row.owner || source.container }, symbol, rivals, taken); if (!certainty) continue;
        if (certainty === 'ambiguous') could++;
        if (!best || order[certainty] < order[best.certainty] || best.symbol!.declaration && !symbol.declaration && order[certainty] === order[best.certainty]) best = { symbol, path: symbol.path, line: row.line, name, certainty, how: row.how };
      }
      if (!best) { outside++; continue; }
      // Which of several is meant is not known, so none of them is named.
      if (best.certainty === 'ambiguous') best = { path: source.path, line: row.line, name, certainty: 'ambiguous', how: row.how, candidates: could };
      const key = best.symbol ? String(best.symbol.id) : '?' + name; if (!out.has(key)) out.set(key, best);
    }
    return { uses: [...out.values()].sort((a, b) => order[a.certainty] - order[b.certainty] || a.line - b.line).slice(0, limit), outside };
  }
}
