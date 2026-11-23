// PAL Everywhere §15.2: a CSV's columns, types, missing values and parse problems before analysis; formulas stay text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { previewTable } from '../broker/table-preview.ts';
import { skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';

test('a table preview infers types, counts missing values and names parse problems', () => {
  const preview = previewTable('id,price,when,ok,note\n1,2.5,2026-01-02,yes,"a, quoted\nline"\n2,NA,2026-02-03,no,=SUM(A1)\n3,4\n');
  assert.equal(preview.rows, 3);
  assert.deepEqual(preview.columns.map(c => [c.name, c.type, c.missing]), [['id', 'integer', 0], ['price', 'number', 1], ['when', 'date', 1], ['ok', 'boolean', 1], ['note', 'text', 1]]);
  assert.equal(preview.sample[0][4], 'a, quoted\nline');
  assert.ok(preview.problems.some(p => /different number of fields/.test(p)));
  assert.ok(preview.problems.some(p => /formulas; they are kept as text/.test(p)));
  assert.match(previewTable('a,b\n"open,1\n').problems.join(' '), /never closed/);
});

test('a table in a Workbench folder is previewed with the folder’s read checks', { skip: skipWithoutHelper }, async t => {
  const f = await workbenchFixture(t);
  await writeFile(join(f.project, 'sales.csv'), 'region,units\nnorth,10\nsouth,12\n');
  const { session, root } = await f.session();
  const preview = await f.core.rpc('tables.preview', { sessionId: session.id, rootId: root.id, path: 'sales.csv' });
  assert.equal(preview.rows, 2); assert.deepEqual(preview.columns.map((c: any) => c.type), ['text', 'integer']);
  await assert.rejects(f.core.rpc('tables.preview', { sessionId: session.id, rootId: root.id, path: '../outside.csv' }));
});
