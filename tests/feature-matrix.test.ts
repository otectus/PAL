/**
 * W11: docs/FEATURE-MATRIX.md stays reconciled with the code. Every phone operation the gateway
 * accepts is in its operation index with the permission and kind the schemas give it; every
 * F01–F98 row of the mobile plan appears exactly once; every test file it names exists.
 */
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { kindLabel, methods, permissionLabel } from '../broker/remote/schemas.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const matrix = readFileSync(join(root, 'docs/FEATURE-MATRIX.md'), 'utf8');

test('the operation index lists every phone operation with its permission and kind', () => {
  const index = matrix.slice(matrix.indexOf('## 4. Phone operation index'));
  const rows = new Map([...index.matchAll(/^\| `([a-zA-Z.]+)` \| ([^|]+) \| ([^|]+) \|/gm)].map(match => [match[1], { permission: match[2].trim(), kind: match[3].trim() }]));
  assert.deepEqual([...rows.keys()].sort(), Object.keys(methods).sort(), 'regenerate the index when operations change');
  for (const [name, row] of rows) {
    assert.deepEqual(row, { permission: permissionLabel(name), kind: kindLabel(name) }, name);
  }
});

test('every mobile plan row appears exactly once', () => {
  const plan = new Set([...readFileSync(join(root, 'mobile/MOBILE_PLAN.md'), 'utf8').matchAll(/^\| (F\d\d) \|/gm)].map(match => match[1]));
  const rows = [...matrix.matchAll(/^\| (F\d\d) \|/gm)].map(match => match[1]);
  assert.equal(plan.size, 98);
  assert.deepEqual([...rows].sort(), [...plan].sort());
  assert.equal(new Set(rows).size, rows.length, 'no row is listed twice');
});

test('every test the matrix names exists', () => {
  const android = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name === 'build' ? [] : entry.isDirectory() ? android(join(dir, entry.name)) : [entry.name]);
  const known = new Set([...readdirSync(join(root, 'tests')), ...android(join(root, 'mobile/android'))]);
  const named = new Set([...matrix.matchAll(/`([\w.-]+\.(?:test\.ts|kt|cpp))`/g)].map(match => match[1]));
  assert.ok(named.size > 20);
  for (const file of named) assert.ok(known.has(file), file + ' is named in the matrix but does not exist');
  assert.ok(existsSync(join(root, 'docs/FEATURE-MATRIX.md')));
});
