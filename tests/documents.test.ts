// PAL Everywhere §15.2: Markdown, text, tables, transcripts and conversations as Word, PDF and web documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseMarkdown, inlineText, safeHref, type Block } from '../broker/documents/markdown.ts';
import { renderHtml } from '../broker/documents/html.ts';
import { renderDocx } from '../broker/documents/docx.ts';
import { embeddedImage } from '../broker/documents/images.ts';
import { documentHelper } from '../broker/documents/service.ts';
import { templates } from '../broker/documents/templates.ts';
import { Extractor } from '../broker/artifacts/extract.ts';
import { skipWithoutHelper, workbenchFixture, call } from './fixtures/workbench.ts';

const sample = `# Quarterly *report*

An opening with **bold**, _emphasis_, ~~old~~, \`code | x\`, a [link](https://example.test/a?b=1&c=2) and <https://example.test>.
Second line of the same paragraph.

Setext heading
--------------

1. First
2. Second
   - nested *one*
   - nested two

     with a second paragraph
3. Third

- [x] done
- [ ] to do

> Quoted text
> on two lines

| Region | Total | Note |
|:-------|------:|:----:|
| North \\| East | 10 | a |
| South | 2.5 |

\`\`\`python
def total(rows):
    return sum(r["x"] for r in rows)  # <keep> & this
\`\`\`

A claim.[^1] Another.[^two]

[^1]: The first source, https://example.test/source.
[^two]: The second.

---

Last, with snake_case_name and 2 * 3 * 4.
`;
const kinds = (blocks: Block[]) => blocks.map(block => block.type);

test('Markdown becomes a document tree with the structure people wrote', () => {
  const { blocks, notes } = parseMarkdown(sample);
  assert.deepEqual(kinds(blocks), ['heading', 'paragraph', 'heading', 'list', 'list', 'quote', 'table', 'code', 'paragraph', 'rule', 'paragraph']);
  const at = <T extends Block['type']>(index: number, type: T) => { assert.equal(blocks[index].type, type); return blocks[index] as Extract<Block, { type: T }>; };
  assert.equal(inlineText(at(0, 'heading').children), 'Quarterly report'); assert.equal(at(2, 'heading').level, 2);
  assert.deepEqual(at(1, 'paragraph').children.map(child => child.type), ['text', 'strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text', 'link', 'text', 'link', 'text']);
  const list = at(3, 'list'); assert.equal(list.ordered, true); assert.equal(list.items.length, 3);
  const nested = list.items[1].blocks[1]; assert.equal(nested.type, 'list'); assert.deepEqual((nested as any).items.map((item: any) => kinds(item.blocks)), [['paragraph'], ['paragraph', 'paragraph']]);
  assert.deepEqual(at(4, 'list').items.map(item => item.task), [true, false]);
  const table = at(6, 'table'); assert.deepEqual(table.align, ['left', 'right', 'center']); assert.equal(inlineText(table.rows[0][0]), 'North | East'); assert.equal(table.rows[1].length, 3, 'a short row keeps every column');
  assert.match(at(7, 'code').text, /# <keep> & this$/); assert.equal(at(7, 'code').lang, 'python');
  assert.deepEqual(notes.map(note => note.number), [1, 2]); assert.equal(notes[0].children[1].type, 'link');
  assert.equal(inlineText(at(10, 'paragraph').children), 'Last, with snake_case_name and 2 * 3 * 4.');
});

test('nothing in a document becomes markup, a script or an address to fetch', async () => {
  const hostile = '<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![p](http://example.test/track.png) ![f](file:///etc/passwd) <img src=x onerror=y>\n\n| a |\n|---|\n| <b>bold</b> |\n';
  const document = parseMarkdown(hostile);
  const html = renderHtml(document, { title: 'T "quoted" <x>' });
  assert.ok(!/<script|<img|onerror=y>|href="javascript|etc\/passwd"/.test(html.replace(/&lt;[^&]*&gt;/g, '')), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.match(html, /default-src 'none'/); assert.match(html, /<title>T &quot;quoted&quot; &lt;x&gt;<\/title>/);
  const docx = (await renderDocx(document, { title: 'T', page: 'A4', created: 0 })).toString('latin1');
  assert.ok(!/javascript:|track\.png|etc\/passwd/.test(docx), 'no refused address is a relationship');
  assert.equal(safeHref('https://example.test/a b'), 'https://example.test/ab'); assert.equal(safeHref('data:text/html,x'), undefined); assert.equal(safeHref('java\nscript:alert(1)'), undefined);
  // Pathological input stays quick.
  const started = Date.now(); parseMarkdown('*'.repeat(20_000)); parseMarkdown('['.repeat(20_000)); parseMarkdown('> '.repeat(200) + 'x'); parseMarkdown('`'.repeat(5001) + 'a'); parseMarkdown('|'.repeat(5000) + '\n' + '|-'.repeat(5000));
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.throws(() => parseMarkdown('x'.repeat(600_001)), /longer than PAL exports/);
});

test('only images a document already carries are embedded', async () => {
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } }).png().toBuffer(), jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  assert.deepEqual([embeddedImage('data:image/png;base64,' + png.toString('base64'))?.width, embeddedImage('data:image/jpeg;base64,' + jpeg.toString('base64'))?.height], [30, 8]);
  assert.equal(embeddedImage('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')), undefined); assert.equal(embeddedImage('data:image/png;base64,' + jpeg.toString('base64')), undefined); assert.equal(embeddedImage('https://example.test/a.png'), undefined);
  const document = parseMarkdown(`![A red box](data:image/png;base64,${png.toString('base64')})`);
  const docx = await renderDocx(document, { title: 'T', page: 'Letter', created: 0 });
  assert.ok(docx.includes(png.subarray(0, 8)) || docx.includes('word/media/image1.png'));
});

test('a Word file holds the whole document, is well formed and names no one', { skip: !existsSync('/usr/bin/unzip') && 'needs unzip' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pal-docx-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'report.docx');
  await writeFile(path, await renderDocx(parseMarkdown(sample + '\nEmoji 🙂 and control \u0001 char.\n'), { title: 'Report & plan', page: 'A4', created: Date.UTC(2026, 10, 23, 12) }));
  const part = (name: string) => execFileSync('/usr/bin/unzip', ['-p', path, name]).toString();
  for (const name of ['\\[Content_Types\\].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', '_rels/.rels'])
    execFileSync('/usr/bin/python3', ['-I', '-c', 'import sys,xml.dom.minidom as m; m.parseString(sys.stdin.buffer.read())'], { input: part(name) });
  const body = part('word/document.xml');
  assert.match(body, /<w:pStyle w:val="Heading1"\/>/); assert.match(body, /<w:tblHeader\/>/); assert.match(body, /<w:strike\/>/); assert.match(body, /w:numId w:val="2"/, 'each list numbers itself'); assert.match(body, /w:hanging="300"\/><\/w:pPr><w:r><w:t xml:space="preserve">☑ /, 'a task keeps its box instead of a bullet'); assert.match(body, /🙂/);
  assert.match(part('word/_rels/document.xml.rels'), /Target="https:\/\/example\.test\/a\?b=1&amp;c=2" TargetMode="External"/);
  const core = part('docProps/core.xml'); assert.match(core, /<dc:title>Report &amp; plan<\/dc:title><dc:creator>PAL<\/dc:creator>/); assert.match(core, /2026-11-23T12:00:00Z/);
  // PAL's own reader finds the same words back.
  const extractor = new Extractor(directory); t.after(() => extractor.close());
  const read = await extractor.parseFile(await import('node:fs/promises').then(fs => fs.readFile(path)), 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const text = read.units.map(unit => unit.text).join('\n');
  for (const expected of ['Quarterly report', 'nested two', 'Quoted text on two lines', 'North | East', 'return sum(r["x"] for r in rows)', 'snake_case_name']) assert.ok(text.includes(expected), expected);
});

test('a PDF is printed with its title, pages and selectable text', { skip: (!documentHelper() && 'needs pal-document') || (!existsSync('/usr/bin/pdftotext') && 'needs poppler') || skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t), { session } = await f.session({ write: false });
  const long = sample + Array.from({ length: 220 }, (_item, index) => `\nParagraph ${index} of a longer document.\n`).join('') + '\n| n | v |\n|---|---|\n' + Array.from({ length: 120 }, (_item, index) => `| ${index} | row ${index} |\n`).join('');
  const version = await f.core.rpc('documents.render', { sessionId: session.id, markdown: long, format: 'pdf', page: 'A4' });
  assert.equal(version.name, 'Quarterly report.pdf'); assert.equal(version.mime, 'application/pdf'); assert.deepEqual(version.provenance.source, { kind: 'text' }); assert.equal(version.provenance.adapter, 'pal-document');
  const path = f.core.workbench.artifacts.objectPath(version.sha256), info = execFileSync('/usr/bin/pdfinfo', [path]).toString(), text = execFileSync('/usr/bin/pdftotext', ['-layout', path, '-']).toString();
  assert.match(info, /Title:\s+Quarterly report/); assert.match(info, /Page size:\s+59[45](\.\d+)? x 84[12](\.\d+)? pts/); const pages = Number(/Pages:\s+(\d+)/.exec(info)![1]); assert.ok(pages >= 8, info);
  for (const expected of ['Quarterly report', 'nested two', 'North | East', 'Paragraph 219', 'row 119', `${pages} / ${pages}`]) assert.ok(text.includes(expected), expected);
  assert.ok(!/<b>|<table/.test(text));
  const letter = await f.core.rpc('documents.render', { sessionId: session.id, markdown: '# One', format: 'pdf', page: 'Letter' });
  assert.match(execFileSync('/usr/bin/pdfinfo', [f.core.workbench.artifacts.objectPath(letter.sha256)]).toString(), /Page size:\s+612 x 792/);
});

test('files, tables, transcripts and the conversation export as new linked files; originals and limits stay', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t, [() => ({ content: 'A reply with **bold**.' })]), { session, root } = await f.session({ write: false });
  await writeFile(join(f.project, 'notes.md'), '# Notes\n\nText\n'); await writeFile(join(f.project, 'plain.txt'), 'one\ntwo *not emphasis*\n\nthree\n'); await writeFile(join(f.project, 'page.html'), '<h1>x</h1>');
  await writeFile(join(f.project, 'orders.csv'), 'id,total\n1,10\n2,"a, b"\n'); await writeFile(join(f.project, 'talk.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>Hello\n');
  const html = async (p: any) => { const version = await f.core.rpc('documents.render', { sessionId: session.id, format: 'html', ...p }); return { version, text: (await f.core.workbench.artifacts.bytes(session.id, version.artifactId)).data.toString() }; };
  const notes = await html({ rootId: root.id, path: 'notes.md' }); assert.equal(notes.version.name, 'Notes.html'); assert.equal(notes.version.provenance.source.path, 'notes.md');
  assert.match((await html({ rootId: root.id, path: 'plain.txt' })).text, /<p>one<br>two \*not emphasis\*<\/p>/, 'plain text keeps its lines and is not read as Markdown');
  assert.match((await html({ rootId: root.id, path: 'orders.csv' })).text, /<th[^>]*>id<\/th>/); assert.match((await html({ rootId: root.id, path: 'orders.csv' })).text, /a, b/);
  assert.match((await html({ rootId: root.id, path: 'talk.vtt' })).text, /<code>0:01<\/code> <b>Ada: <\/b>Hello/);
  await assert.rejects(html({ rootId: root.id, path: 'page.html' }), /Export the page from Canvas/);
  const kept = await f.core.rpc('artifacts.import', { sessionId: session.id, path: join(f.project, 'notes.md'), destinations: { cloud: true } });
  const linked = await html({ artifactId: kept.artifactId }); assert.equal(linked.version.parents[0].relation, 'document-export'); assert.deepEqual(linked.version.policy, { remote: true, cloud: true }, 'an export may go where its source may');
  await f.core.send({ id: session.id, text: 'Hello' }); await f.finished(session.id);
  assert.match((await html({ conversation: true })).text, /A reply with <b>bold<\/b>/);
  await assert.rejects(html({ markdown: '# a', conversation: true }), /Choose one thing/); await assert.rejects(html({ markdown: '   ' }), /nothing to export/); await assert.rejects(html({}), /Choose one thing/);
  await assert.rejects(f.core.rpc('documents.render', { sessionId: session.id, markdown: '# a', format: 'rtf' }), /Choose PDF/);
  const { formats } = await f.core.rpc('documents.formats', {}); assert.deepEqual(formats.map((item: any) => item.id), ['pdf', 'docx', 'html', 'md']);
  process.env.PAL_DOCUMENT_HELPER = '/nonexistent';
  try {
    assert.match((await f.core.rpc('documents.formats', {})).formats[0].reason, /not installed/);
    await assert.rejects(f.core.rpc('documents.render', { sessionId: session.id, markdown: '# a', format: 'pdf' }), /export as Word/);
  } finally { delete process.env.PAL_DOCUMENT_HELPER; }
});

test('templates start a document that is saved, revised and exported', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t), { session } = await f.session({ write: false });
  for (const template of templates) {
    const filled = await f.core.rpc('documents.fill', { sessionId: session.id, template: template.id, title: 'Launch\nplan' });
    assert.ok(!/\{\{/.test(filled.markdown), template.id); assert.match(filled.markdown, /^# Launch plan\n/);
  }
  const filled = await f.core.rpc('documents.fill', { sessionId: session.id, template: 'decision' }); assert.match(filled.markdown, /- Date: \d{4}-\d{2}-\d{2}\n/); assert.match(filled.markdown, /- Project: project\n/);
  const saved = await f.core.rpc('documents.save', { sessionId: session.id, title: 'Launch plan', markdown: filled.markdown });
  assert.equal(saved.name, 'Launch plan.md'); assert.equal(saved.mime, 'text/markdown');
  const next = await f.core.rpc('documents.save', { sessionId: session.id, artifactId: saved.artifactId, versionId: saved.versionId, title: 'Launch plan', markdown: '# Changed' });
  assert.equal(next.artifactId, saved.artifactId); assert.equal(next.parents[0].relation, 'edit');
  await assert.rejects(f.core.rpc('documents.fill', { sessionId: session.id, template: 'nope' }), /one of the document templates/);
});

test('a model can make a document only from what it may read', { skip: skipWithoutHelper }, async t => {
  let version = '';
  const f = await workbenchFixture(t, [
    () => call('pal_tools', { add: ['documents_export'] }),
    () => call('documents_export', { format: 'docx', title: 'Plan', markdown: '# Plan\n\nText' }),
    () => ({ content: 'Made it.' }),
  ]);
  const { session } = await f.session({ write: false });
  await f.core.send({ id: session.id, text: 'Make a Word file' }); await f.finished(session.id);
  const result = f.toolResults().find((r: any) => r.name === 'documents_export')?.value;
  assert.equal(result?.status, 'completed', JSON.stringify(result).slice(0, 300)); version = result.artifacts[0].versionId;
  assert.equal(f.core.workbench.artifacts.version(session.id, result.artifacts[0].artifactId, version).name, 'Plan.docx');
});
