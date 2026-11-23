import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { zipFilesAsync, listZip } from '../broker/artifacts/zip.ts';
import { parseCsv, parseXml } from '../broker/artifacts/extract-worker.ts';
import { call, skipWithoutHelper, until, workbenchFixture } from './fixtures/workbench.ts';
import { png } from './fixtures/image-backends.ts';

import { pdf } from './fixtures/document.ts';
const docx = () => zipFilesAsync([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Project brief</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Budget: 5 &amp; counting</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Paint</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') },
  { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0"?><Relationships><Relationship Id="rId9" Type="hyperlink" Target="http://example.com/track.png" TargetMode="External"/></Relationships>') },
  { name: 'word/vbaProject.bin', data: Buffer.from('macro bytes') },
  { name: 'word/embeddings/sheet.xlsx', data: Buffer.from('embedded') },
]);
const xlsx = () => zipFilesAsync([
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="Totals" sheetId="1" r:id="rId1"/><sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>') },
  { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>Month</t></si><si><t>Sales</t></si><si><t>hidden text</t></si></sst>') },
  { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>10</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f>B2*3</f><v>30</v></c></row><row r="4"><c r="B4"><f>SUM(B2:B3)</f><v>999</v></c></row></sheetData></worksheet>') },
  { name: 'xl/worksheets/sheet2.xml', data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row></sheetData></worksheet>') },
  { name: 'xl/externalLinks/externalLink1.xml', data: Buffer.from('<externalLink/>') },
]);

test('CSV and XML parsing keep raw values and never expand declared entities', () => {
  const parsed = parseCsv('name,quote\n"Smith, J","He said ""hi"""\nx,=CMD()\n');
  assert.equal(parsed.delimiter, ','); assert.deepEqual(parsed.rows[1], ['Smith, J', 'He said "hi"']); assert.deepEqual(parsed.rows[2], ['x', '=CMD()']);
  assert.equal(parseCsv('a\tb\n1\t2\n').delimiter, '\t');
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'), /Document type declarations are not processed/);
  assert.equal(parseXml('<a>1 &lt; 2 &amp;&#65;&#x42; &e;</a>').children[0].text, '1 < 2 &AB &e;', 'only built-in and numeric entities are decoded');
});

test('DA04 archives with traversal, encryption or expansion bombs are refused before anything is inflated', async () => {
  await assert.rejects(zipFilesAsync([{ name: '../escape.txt', data: Buffer.from('x') }]), /Invalid or duplicate/);
  const evil = await zipFilesAsync([{ name: 'safe.txt', data: Buffer.from('x') }]);
  const tampered = Buffer.from(evil); const at = tampered.indexOf(Buffer.from('safe.txt'), tampered.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
  tampered.write('../s.txt', at, 'latin1');
  assert.throws(() => listZip(tampered), /unsafe or duplicate name/);
  const bomb = await zipFilesAsync([{ name: 'zeros.bin', data: Buffer.alloc(40 * 1024 * 1024) }]);
  assert.throws(() => listZip(bomb), /suspicious|expands/);
  const encrypted = Buffer.from(evil); const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  assert.throws(() => listZip(encrypted), /encrypted/);
  void deflateRawSync;
});

test('DA01/DA02/DA03 PDF pages, DOCX parts and XLSX cells keep their locations; nothing active runs or is fetched', { skip: skipWithoutHelper || (!existsSync('/usr/bin/pdftotext') ? 'poppler is not installed' : false) }, async t => {
  const f = await workbenchFixture(t, [() => call('files_extract', { path: 'report.pdf' }), () => call('files_extract', { path: 'brief.docx' }), () => call('files_extract', { path: 'sales.xlsx' }), () => ({ content: 'Read them.' })]);
  await writeFile(join(f.project, 'report.pdf'), pdf()); await writeFile(join(f.project, 'brief.docx'), await docx()); await writeFile(join(f.project, 'sales.xlsx'), await xlsx());
  const { session } = await f.session({});
  await f.core.send({ id: session.id, text: 'Read the documents' }); await f.finished(session.id);
  const [report, brief, sales] = f.toolResults().filter((r: any) => r.name === 'files_extract').map((r: any) => r.value);
  assert.equal(report.status, 'completed', report.summary);
  assert.equal(report.data.status, 'partial'); assert.deepEqual(report.data.parts.map((p: any) => p.locator), [{ page: 1 }]);
  assert.match(report.data.parts[0].text, /Quarterly revenue rose/); assert.match(report.data.warnings.join(' '), /page 2; it is probably scanned. Use OCR/);
  assert.deepEqual(report.citations[0].locator, { page: 1 });
  assert.deepEqual(brief.data.parts.map((p: any) => p.locator), [{ paragraph: 1 }, { paragraph: 2 }, { table: 1, rows: 2 }]);
  assert.equal(brief.data.parts[1].text, 'Budget: 5 & counting'); assert.equal(brief.data.parts[2].text, 'Item | Cost\nPaint | 40');
  for (const warning of [/macros; they were not run/, /Embedded objects/, /external content, which was not fetched/]) assert.match(brief.data.warnings.join(' '), warning);
  const cells = sales.data.parts[0];
  assert.deepEqual(cells.locator, { sheet: 'Totals', rows: '1-4' });
  assert.match(cells.text, /B3: =B2\*3 \(cached: 30\)/); assert.match(cells.text, /B4: =SUM\(B2:B3\) \(cached: 999\)/, 'a stale cached value is shown as cached, never recalculated');
  assert.doesNotMatch(JSON.stringify(sales), /hidden text/); assert.match(sales.data.warnings.join(' '), /Hidden sheets were left out: Secret/); assert.match(sales.data.warnings.join(' '), /may be stale/); assert.match(sales.data.warnings.join(' '), /links to other files/);
  // The same bytes and options are not extracted twice.
  const again = await f.core.rpc('artifacts.extract', { sessionId: session.id, artifactId: f.core.workbench.artifacts.version(session.id, report.data.extractionId).parents[0].artifactId });
  assert.equal(again.reused, true);
});

test('an export into a workspace folder is a reviewed change that never overwrites', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t);
  const { session, root } = await f.session();
  const path = join(f.directory, 'chart.png'); await writeFile(path, await png(40, 30));
  const imported = await f.core.rpc('artifacts.import', { sessionId: session.id, path });
  const review = await f.core.rpc('artifacts.export', { sessionId: session.id, artifactId: imported.artifactId, versionId: imported.versionId, rootId: root.id, path: 'out/chart.png' });
  assert.deepEqual(review.operations.map((op: any) => op.kind), ['mkdir', 'export']); assert.match(review.operations[1].review.notes[0], /not kept in sync/);
  assert.equal((await f.core.rpc('changes.apply', { id: review.id, digest: review.digest })).status, 'applied');
  assert.equal((await f.core.rpc('artifacts.get', { sessionId: session.id, artifactId: imported.artifactId })).versions[0].exports[0].destination, join(f.project, 'out/chart.png'));
  await assert.rejects(f.core.rpc('artifacts.export', { sessionId: session.id, artifactId: imported.artifactId, versionId: imported.versionId, rootId: root.id, path: 'out/chart.png' }), /already exists/);
  void until;
});
