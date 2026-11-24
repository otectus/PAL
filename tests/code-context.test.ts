// A03: the code index — what it reads, how sure it says it is, what it never reads, and how it goes away again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { CodeIndex, nameWords } from '../broker/code-context/index.ts';
import { parseSource, type Parsed } from '../broker/code-context/languages.ts';
import { tokenize } from '../broker/code-context/tokens.ts';
import { runCode } from '../benchmarks/code/code-questions.ts';

const root = new URL('../', import.meta.url).pathname;
const names = (parsed: Parsed | undefined) => parsed!.symbols.map(symbol => `${symbol.kind} ${symbol.container ? symbol.container + '.' : ''}${symbol.name} ${symbol.line}-${symbol.endLine}`);

test('A03 the TypeScript adapter finds exactly the declarations, spans and imports the compiler finds in this repository', () => {
  const ts = createRequire(import.meta.url)('typescript'), files: string[] = [];
  const walk = (folder: string) => { for (const entry of readdirSync(root + folder, { withFileTypes: true })) { const path = `${folder}/${entry.name}`; if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); } else if (/\.(ts|mjs)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(path); } };
  walk('broker'); walk('tools'); let declared = 0, imports = 0;
  for (const path of files) {
    const text = readFileSync(root + path, 'utf8'), source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), line = (at: number) => source.getLineAndCharacterOfPosition(at).line + 1, truth: string[] = [];
    const add = (name: string, node: any) => truth.push(`${name} ${line(node.getStart(source))}-${line(node.end)}`);
    for (const node of source.statements) {
      if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
      else if (ts.isClassDeclaration(node)) { if (node.name) add(node.name.text, node); for (const member of node.members as any[]) { if (ts.isConstructorDeclaration(member)) add('constructor', member); else if (member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name))) add(member.name.text, member); } }
      else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) add(node.name.text, node);
      else if (ts.isVariableStatement(node) && ts.isIdentifier(node.declarationList.declarations[0].name)) add(node.declarationList.declarations[0].name.text, node);
      else if (ts.isImportDeclaration(node)) { imports++; assert.ok(parseSource(path, text)!.imports.some(item => item.module === node.moduleSpecifier.text), `${path} imports ${node.moduleSpecifier.text}`); }
    }
    const found = parseSource(path, text)!.symbols.filter(symbol => symbol.kind !== 'test').map(symbol => `${symbol.name} ${symbol.line}-${symbol.endLine}`);
    assert.deepEqual([...found].sort(), [...truth].sort(), path); declared += truth.length;
  }
  assert.ok(declared > 3000 && imports > 800, `${declared} declarations, ${imports} imports`);
});

test('A03 comments, strings, templates and regular expressions are never read as code', () => {
  const ids = (text: string, dialect: any = 'script') => tokenize(text, dialect).filter(token => token.kind === 'id').map(token => token.text);
  assert.deepEqual(ids('a // b c\n/* d */ e "f" \'g\' `h ${i + `j ${k}`} l`; /m[/]n/g.test(o)'), ['a', 'e', 'i', 'k', 'test', 'o']);
  assert.deepEqual(ids('x = y / z / w; return /q/; `${/\\$\\{/.test(v) ? "}" : u}`'), ['x', 'y', 'z', 'w', 'return', 'test', 'v', 'u']);
  assert.deepEqual(ids('auto a = R"x(b "c" )y)x"; int d = 1\'000\'000; #define E(f) \\\n  g\nh', 'cpp'), ['auto', 'a', 'int', 'd', 'h']);
  for (const broken of ['"never ends', '`never ${ends', '/* never ends', 'function (', '}}}}', 'class {', '\\', '\u{1f600} a', 'R"x(never'] ) for (const dialect of ['script', 'cpp', 'qml'] as const) { assert.ok(tokenize(broken, dialect)); for (const name of ['a.ts', 'a.cpp', 'a.qml']) assert.ok(parseSource(name, broken)); }
  const started = performance.now(); parseSource('a.ts', '('.repeat(60_000)); parseSource('a.cpp', '{'.repeat(60_000)); parseSource('a.ts', 'a<'.repeat(40_000)); assert.ok(performance.now() - started < 4000, 'hostile input stays bounded');
  assert.equal(parseSource('a.txt', 'x'), undefined);
});

test('A03 C++ and QML declarations, with their containers, spans and Qt’s own forms', () => {
  assert.deepEqual(names(parseSource('a.h', `#include "b.h"\n#include <vector>\nnamespace one::two {\ntemplate<typename T> class Box final : public Base, private Other {\n  Q_OBJECT\n  Q_PROPERTY(int size READ size NOTIFY sized)\npublic:\n  explicit Box(int n) : m_n(n), m_list{1, 2} { start(); }\n  ~Box() override;\n  Box &operator=(const Box &) = delete;\n  bool operator()(int a) const { return a; }\n  int size() const { return m_n; }\nsignals:\n  void sized();\nprivate:\n  int m_n;\n};\nenum class Kind { A, B };\nusing Alias = int;\nconstexpr int limit = 4;\n}\nint one::two::Box::other(int a) {\n  return helper(a);\n}\nstatic QString helper(int a);`)),
    ['namespace one::two 3-21', 'class one::two.Box 4-17', 'property Box.size 6-6', 'method Box.Box 8-8', 'method Box.~Box 9-9', 'method Box.operator= 10-10', 'method Box.operator() 11-11', 'method Box.size 12-12', 'signal Box.sized 14-14', 'enum one::two.Kind 18-18', 'type one::two.Alias 19-19', 'constant one::two.limit 20-20', 'method Box.other 22-24', 'function helper 25-25']);
  const qml = parseSource('qml/Pane.qml', `import QtQuick\nimport "Help.js" as Help\n// The pane.\nCDialog {\n  id: pane\n  required property var host\n  readonly property list<string> items: ["a { b"]\n  signal chosen(string name)\n  function load() { rpc.call("x", {}, value => { if (value) show(value) }) }\n  component Row: RowLayout { property int index; CText { text: Help.label(1) } }\n  Row { onClicked: pane.load() }\n}\n`)!;
  assert.deepEqual(names(qml), ['component Pane 4-12', 'property Pane.host 6-6', 'property Pane.items 7-7', 'signal Pane.chosen 8-8', 'function Pane.load 9-9', 'component Pane.Row 10-10', 'property Row.index 10-10']);
  assert.deepEqual(qml.imports.map(item => [item.module, item.names[0].local]), [['QtQuick', ''], ['Help.js', 'Help']]);
  assert.ok(qml.calls.some(call => call.name === 'CText' && call.how === 'uses') && qml.calls.some(call => call.name === 'label' && call.receiver === 'Help'));
  assert.deepEqual(nameWords('runHTTPRetry_with-2 parts'), ['run', 'HTTP', 'Retry', 'with', '2', 'parts']);
});

async function fixture(t: any, files: Record<string, string>, provider = 'openai') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pal-code-'))), cwd = join(base, 'project'), state = join(base, 'state'); await mkdir(cwd);
  const put = async (path: string, text: string) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), text); };
  for (const [path, text] of Object.entries(files)) await put(path, text);
  const core = new Core(new Store(state), () => ({ async send() {}, async interrupt() {}, async close() {} }) as any);
  core.credentials.update('openai', 'test-key');
  const session = await core.create({ provider, model: 'm', cwd, trusted: true, title: 'Code' } as any);
  t.after(async () => { await core.close(); await rm(base, { recursive: true, force: true }); });
  const on = async (extra = {}) => { await core.rpc('code.configure', { sessionId: session.id, enabled: true, ...extra }); await core.code.refresh(cwd); };
  const look = () => { (core.code as any).looked.clear(); };
  const route = (value: string) => (core.workbench as any).routes.set(session.id, { route: value, evidence: 'test', at: Date.now() });
  const around = (name: string, path?: string) => core.rpc('code.around', { sessionId: session.id, name, ...(path ? { path } : {}) });
  const found = async (query: string) => (await core.rpc('code.find', { sessionId: session.id, query })).results.map((row: any) => `${row.path}#${row.name}`);
  return { base, cwd, state, core, session, put, on, look, route, around, found };
}
const project = {
  'src/retry.ts': `/** Tries again after a pause. */\nexport function retry(times: number) { return pause(times); }\nfunction pause(ms: number) { return ms; }\nexport class Queue {\n  private jobs: string[] = [];\n  add(job: string) { this.jobs.push(job); this.drain(); }\n  drain() { return retry(this.jobs.length); }\n  onlyHere() { return 1; }\n  get(key: string) { return key; }\n}\n`,
  'src/use.ts': `import { retry as again, Queue } from './retry.ts';\nimport * as all from './retry.js';\nimport fs from 'node:fs';\nexport const start = () => { again(2); all.retry(3); const q = new Queue(); q.drain(); q.onlyHere(); q.get('x'); new Map().get('y'); fs.readFileSync('z'); };\nexport function retry() { return 'another of the same name'; }\n`,
  'src/other.ts': `export class Stack { drain() { return 1; } }\nexport function caller(x: any) { retry(1); x.drain(); }\n`,
  'tests/retry.test.ts': `import test from 'node:test';\nimport { retry } from '../src/retry.ts';\ntest('tries again', () => { retry(1); });\n`,
  'ui/Help.js': `function label(n) { return n }\n`, 'ui/Main.qml': `import QtQuick\nimport "Help.js" as Help\nItem {\n  function reload() { return Help.label(1) }\n  Button { onClicked: reload() }\n}\n`, 'ui/Button.qml': `Item { signal pressed() }\n`,
  'native/app.h': `class App {\npublic:\n  int run(int a);\n  void paint();\n};\n`, 'native/app.cpp': `#include "app.h"\nstatic int twice(int a) { return a * 2; }\nint App::run(int a) { paint(); return twice(a); }\nvoid App::paint() {}\n`,
};

test('A03 what is certain, possible or ambiguous is said for each relationship, and a call that fits nothing is left out', async t => {
  const f = await fixture(t, project); await f.on();
  const retry = await f.around('retry', 'src/retry.ts'), line = (item: any) => `${item.path}:${item.line} ${item.certainty}`;
  assert.deepEqual(retry.usedBy.map(line), ['src/retry.ts:7 certain', 'src/use.ts:4 certain', 'src/use.ts:4 certain'], 'by its alias, through the namespace, and here; not the unimported one in other.ts');
  assert.deepEqual(retry.tests.map((item: any) => `${line(item)} ${item.symbol.name}`), ['tests/retry.test.ts:3 certain tries again']);
  assert.deepEqual([retry.symbol.about, retry.source, retry.symbol.exported], ['Tries again after a pause.', 'export function retry(times: number) { return pause(times); }', true]);
  assert.deepEqual(retry.uses.map((item: any) => `${item.symbol.name} ${item.certainty}`), ['pause certain']);
  assert.deepEqual(retry.importedBy.map((item: any) => item.path), ['src/use.ts', 'src/use.ts', 'tests/retry.test.ts']);
  const drain = await f.around('Queue.drain'); assert.deepEqual(drain.usedBy.map(line), ['src/retry.ts:6 certain', 'src/other.ts:2 ambiguous', 'src/use.ts:4 ambiguous'], 'two classes have one');
  assert.deepEqual((await f.around('Queue.onlyHere')).usedBy.map(line), ['src/use.ts:4 possible']); assert.deepEqual((await f.around('Queue.get')).usedBy, [], 'a name every collection has says nothing');
  assert.deepEqual((await f.around('Queue')).usedBy.map(line), ['src/use.ts:4 certain']);
  const start = await f.around('start'); assert.deepEqual(start.uses.map((item: any) => `${item.symbol ? item.symbol.container + '.' + item.symbol.name : item.name + '?'} ${item.certainty}${item.candidates ? ' of ' + item.candidates : ''}`), ['.retry certain', '.Queue certain', 'Queue.onlyHere possible', 'drain? ambiguous of 2'], 'which of several is meant is not claimed'); assert.ok(start.outside >= 3);
  assert.deepEqual((await f.around('label')).usedBy.map(line), ['ui/Main.qml:4 certain'], 'QML calls JavaScript it imports'); assert.deepEqual((await f.around('Button')).usedBy.map(line), ['ui/Main.qml:5 certain']);
  assert.deepEqual((await f.around('App.paint')).usedBy?.map(line) ?? 'several', 'several', 'declared in the header and defined in the source');
  assert.deepEqual((await f.around('twice')).usedBy.map(line), ['native/app.cpp:3 certain']);
  // Two things of one name are offered, and a file tells them apart.
  assert.deepEqual((await f.around('retry')).several.map((item: any) => item.path), ['src/retry.ts', 'src/use.ts']);
  assert.deepEqual((await f.around('retry', 'src/use.ts')).symbol.line, 5); await assert.rejects(f.around('nothing'), /has that name now/);
  // Nothing was run to learn this, and the index holds no source text.
  const db = f.core.code.index.db; assert.ok(!JSON.stringify(db.prepare('SELECT * FROM symbols').all()).includes('return ms'));
});

test('A03 an answer is about the files as they are: changed, moved, deleted and replaced files take their symbols with them', async t => {
  const f = await fixture(t, project); await f.on();
  const before = await f.around('pause'); assert.equal(before.symbol.line, 3);
  // Moved down a line between two looks: the answer is checked against the file before it is given.
  await f.put('src/retry.ts', '\n' + project['src/retry.ts']); const after = await f.core.rpc('code.around', { sessionId: f.session.id, id: before.symbol.id });
  assert.equal(after.symbol.line, 4); assert.equal(after.source, 'function pause(ms: number) { return ms; }'); assert.notEqual(after.sha256, before.sha256);
  await f.put('src/retry.ts', project['src/retry.ts'].replaceAll('pause', 'rest')); await assert.rejects(f.around('pause'), /has that name now/); f.look(); assert.ok((await f.found('rest')).includes('src/retry.ts#rest'));
  // Written again with the same size and time, and different text: what it says is compared, not only when it was written.
  const stamp = new Date(1_700_000_000_000); await utimes(join(f.cwd, 'src/other.ts'), stamp, stamp); f.look(); await f.around('Stack');
  await f.put('src/other.ts', project['src/other.ts'].replace('Stack', 'Stick')); await utimes(join(f.cwd, 'src/other.ts'), new Date(1_700_000_001_000), new Date(1_700_000_001_000)); f.look(); assert.ok((await f.found('Stick')).includes('src/other.ts#Stick')); assert.ok(!(await f.found('Stack')).includes('src/other.ts#Stack'));
  await rm(join(f.cwd, 'src/other.ts')); f.look(); assert.ok(!(await f.found('Stick')).some((item: string) => item.startsWith('src/other.ts'))); assert.ok(!f.core.code.index.files(f.cwd).has('src/other.ts'));
  await rename(join(f.cwd, 'ui/Help.js'), join(f.cwd, 'ui/Aid.js')); f.look(); assert.ok((await f.found('label')).includes('ui/Aid.js#label'));
  // A file that became a link to somewhere else is not followed.
  await writeFile(join(f.base, 'outside.ts'), 'export function outsideSecret() {}'); await rm(join(f.cwd, 'src/use.ts')); await symlink(join(f.base, 'outside.ts'), join(f.cwd, 'src/use.ts')); f.look();
  assert.deepEqual(await f.found('outsideSecret'), []); assert.ok(!f.core.code.index.files(f.cwd).has('src/use.ts'));
});

test('A03 hidden, generated, ignored, private, oversized and binary files are never read', async t => {
  const body = (name: string) => `export function ${name}() {}\n`;
  const f = await fixture(t, { 'src/seen.ts': body('seenHere'), '.hidden/a.ts': body('neverOne'), 'node_modules/x/a.ts': body('neverTwo'), 'build/a.ts': body('neverThree'), 'ignored/a.ts': body('neverFour'), 'src/gen.ignored.ts': body('neverFive'), 'secret/a.ts': body('neverSix'), 'credentials.ts.key': 'x', 'id_rsa_tool.ts': body('neverSeven'), 'src/big.ts': body('neverEight') + '/*' + 'x'.repeat(800_000) + '*/', 'src/bin.ts': 'export function neverNine() {}\0', '.gitignore': 'ignored/\n*.ignored.ts\n', '.palignore': 'secret/\n' });
  await symlink(join(f.cwd, 'src'), join(f.cwd, 'linked')); await f.on();
  assert.deepEqual([...f.core.code.index.files(f.cwd).keys()].sort(), ['src/big.ts', 'src/bin.ts', 'src/seen.ts']); assert.deepEqual((await f.found('never')), []); assert.deepEqual(await f.found('seenHere'), ['src/seen.ts#seenHere']);
  const status = await f.core.rpc('code.status', { sessionId: f.session.id }); assert.deepEqual([status.files, status.problems, status.symbols], [3, 2, 1]);
  // A .palignore that cannot be read leaves everything out instead of letting everything in.
  await f.put('.palignore', 'x\n'.repeat(400)); f.look(); await f.core.code.refresh(f.cwd).catch(() => {}); assert.equal((await f.core.rpc('code.status', { sessionId: f.session.id })).symbols, 0);
  await f.put('.palignore', ''); await f.core.code.refresh(f.cwd); assert.deepEqual(await f.found('neverSix'), ['secret/a.ts#neverSix'], 'and says nothing more once it is readable');
});

test('A03 a project is indexed only when chosen, models read it only where its destinations allow, and off leaves nothing', async t => {
  const f = await fixture(t, project), id = f.session.id, advertised = () => f.core.workbench.registry.advertise(f.core.store.session(id), f.core.workbench.families(f.core.store.session(id))).map(tool => tool.function.name).filter(name => name.startsWith('code_'));
  assert.deepEqual(advertised(), []); await assert.rejects(f.core.rpc('code.find', { sessionId: id, query: 'retry' }), /not indexed/); await assert.rejects(f.core.rpc('code.refresh', { sessionId: id }), /not indexed/);
  // A home folder, a private place and a linked folder are refused; a temporary conversation keeps nothing.
  const at = async (cwd: string) => { const s: any = { ...f.core.store.session(id), id: 'x' + Math.random(), cwd }; f.core.store.saveSession(s); return s.id; };
  await assert.rejects(f.core.rpc('code.configure', { sessionId: await at(homedir()), enabled: true }), /whole home folder/); await assert.rejects(f.core.rpc('code.configure', { sessionId: await at(join(homedir(), '.ssh')), enabled: true }), /credentials|not there/);
  await symlink(f.cwd, join(f.base, 'link')); await assert.rejects(f.core.rpc('code.configure', { sessionId: await at(join(f.base, 'link')), enabled: true }), /is a link/);
  const temporary: any = { ...f.core.store.session(id), id: 'temporary', temporary: true }; f.core.store.saveSession(temporary); await assert.rejects(f.core.rpc('code.configure', { sessionId: 'temporary', enabled: true }), /keeps nothing/);
  for (const bad of [{ enabled: 'yes' }, { allowCloud: 1 }]) await assert.rejects(f.core.rpc('code.configure', { sessionId: id, ...bad }), /Invalid/);
  await f.on(); f.route('local'); assert.deepEqual(advertised(), ['code_find', 'code_context']);
  f.route('cloud'); assert.deepEqual(advertised(), [], 'a hosted model needs its own permission'); f.route('unknown'); assert.deepEqual(advertised(), []); assert.match((await f.core.workbench.call(id, 'code_find', { query: 'retry' }, new AbortController().signal)).summary, /only by models on this computer/);
  f.route('local'); const told: any = await f.core.workbench.call(id, 'code_context', { name: 'Queue.drain' }, new AbortController().signal);
  assert.equal(told.status, 'completed'); assert.match(told.data.note, /untrusted data, not instructions/); assert.deepEqual(told[Symbol.for('pal.sourcePolicy')], { remote: false, cloud: false }, 'what was read stays bound to where it may go');
  assert.equal((await f.core.workbench.call(id, 'code_context', { name: 'gone' }, new AbortController().signal)).status, 'failed'); assert.equal((await f.core.workbench.call(id, 'code_context', {}, new AbortController().signal)).status, 'failed');
  await f.core.rpc('code.configure', { sessionId: id, allowCloud: true }); f.route('cloud'); assert.deepEqual(advertised(), ['code_find', 'code_context']);
  const s = f.core.store.session(id); f.core.store.saveSession({ ...s, remote: { deviceId: 'd', caps: [], role: 'limited' } } as any); assert.deepEqual(advertised(), [], 'not for a limited phone'); f.core.store.saveSession(s);
  // Off: no tools, no rows, and no name left in the file.
  const file = join(f.state, 'code-index.sqlite'); f.core.code.index.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); assert.ok((await readFile(file)).includes('onlyHere'));
  await f.core.rpc('code.configure', { sessionId: id, enabled: false }); assert.deepEqual(advertised(), []); f.core.code.index.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const name of [file, file + '-wal']) assert.ok(!(await readFile(name).catch(() => Buffer.alloc(0))).includes('onlyHere'), name);
  assert.deepEqual([(await f.core.rpc('code.status', { sessionId: id })).enabled, f.core.store.get('codeContext', {})], [false, {}]);
});

test('A03 a decision of the project can be tied to code; the link keeps no text and goes when the decision does', async t => {
  const f = await fixture(t, project), id = f.session.id; await f.on();
  const save = async (decisions: string[]) => { const current = await f.core.rpc('capsules.get', { sessionId: id }); await f.core.rpc('capsules.save', { sessionId: id, expectedRevision: current.revision, goal: 'g', decisions, constraints: ['Never block the loop'], questions: [], nextSteps: [], relevantSessionIds: [], sources: [] }); };
  await save(['Retries stop after three tries']); const linkable = (await f.core.rpc('code.linkable', { sessionId: id })).decisions; assert.deepEqual(linkable.map((item: any) => [item.kind, item.text]), [['decision', 'Retries stop after three tries'], ['constraint', 'Never block the loop']]);
  const retry = await f.around('retry', 'src/retry.ts'); const { id: link } = await f.core.rpc('code.link', { sessionId: id, key: retry.symbol.key, decision: linkable[0].hash });
  assert.equal((await f.core.rpc('code.link', { sessionId: id, key: retry.symbol.key, decision: linkable[0].hash })).id, link, 'once'); assert.ok(!JSON.stringify(f.core.store.get('codeLinks', {})).includes('three tries'));
  assert.deepEqual((await f.around('retry', 'src/retry.ts')).decisions, [{ id: link, text: 'Retries stop after three tries' }]);
  await assert.rejects(f.core.rpc('code.link', { sessionId: id, key: 'nope', decision: linkable[0].hash }), /no longer in the index/); await assert.rejects(f.core.rpc('code.link', { sessionId: id, key: retry.symbol.key, decision: 'f'.repeat(64) }), /no longer in the project/);
  // The code went: the link stays and says so. The decision went, or was forgotten: the link goes.
  await f.put('src/retry.ts', project['src/retry.ts'].replaceAll('retry', 'attempt')); f.look(); await f.found('attempt'); assert.deepEqual((await f.core.rpc('code.status', { sessionId: id })).links.map((item: any) => item.missing), [true]);
  await f.put('src/retry.ts', project['src/retry.ts']); f.look(); await f.found('retry'); assert.equal((await f.around('retry', 'src/retry.ts')).decisions.length, 1);
  await save(['Something else']); assert.deepEqual((await f.around('retry', 'src/retry.ts')).decisions, []); assert.deepEqual(f.core.store.get('codeLinks', {}), {});
  const again = (await f.core.rpc('code.linkable', { sessionId: id })).decisions[1]; const made = await f.core.rpc('code.link', { sessionId: id, key: (await f.around('Queue')).symbol.key, decision: again.hash }); assert.equal((await f.core.rpc('code.unlink', { sessionId: id, id: made.id })).removed, true);
});

test('A03 the index answers this repository’s questions better than plain search, and no expected answer has gone missing', async () => {
  const report = await runCode();
  assert.deepEqual(report.unknown, [], 'an answer in tests/fixtures/code-questions.json no longer exists: update the question');
  assert.ok(report.symbols > 8000 && report.indexingMs < 60_000);
  assert.ok(report.tuned.hitAt5 >= 0.85 && report.held.hitAt5 >= 0.7, JSON.stringify([report.tuned.hitAt5, report.held.hitAt5])); assert.ok(report.held.hitAt1 >= 0.4, `first ${report.held.hitAt1}`);
  for (const set of [report.tuned, report.held]) assert.ok(set.fileAt5 >= set.plainSearchFileAt5, `${set.fileAt5} against ${set.plainSearchFileAt5}`);
});
