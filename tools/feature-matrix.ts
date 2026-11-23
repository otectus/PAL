/**
 * W11: rewrites the phone operation index (section 4) of docs/FEATURE-MATRIX.md from the gateway
 * schemas, the Android sources that call each operation and the tests that exercise it. The rest of
 * the matrix is written by hand; tests/feature-matrix.test.ts checks both against the code.
 *
 *   node tools/feature-matrix.ts
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kindLabel, methods, permissionLabel } from '../broker/remote/schemas.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name === 'build' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const kotlin = walk(join(root, 'mobile/android')).filter(file => file.endsWith('.kt'));
const android = kotlin.filter(file => file.includes('/src/main/'));
const tests = [...readdirSync(join(root, 'tests')).filter(file => file.endsWith('.ts')).map(file => join(root, 'tests', file)), ...kotlin.filter(file => file.includes('/src/test/') || file.includes('/src/androidTest/'))];
const text = new Map([...android, ...tests].map(file => [file, readFileSync(file, 'utf8')]));
const base = (file: string) => file.split('/').pop()!;
const rows = Object.keys(methods).map(name => {
  // Both columns come from the gateway's operation descriptors (schemas.ts), the table it enforces.
  const permission = permissionLabel(name), kind = kindLabel(name);
  const callers = android.filter(file => text.get(file)!.includes(`"${name}"`)).map(file => base(file).replace('.kt', ''));
  const covered = tests.filter(file => text.get(file)!.includes(`'${name}'`) || text.get(file)!.includes(`"${name}"`)).map(base);
  return `| \`${name}\` | ${permission} | ${kind} | ${callers.join(', ') || '—'} | ${covered.join(', ') || '—'} |`;
});
const path = join(root, 'docs/FEATURE-MATRIX.md'), header = '| Operation | Permission | Kind | Android | Tests |\n| --- | --- | --- | --- | --- |\n';
const matrix = readFileSync(path, 'utf8'), at = matrix.indexOf(header);
if (at < 0) throw new Error('The operation index header is missing from docs/FEATURE-MATRIX.md');
writeFileSync(path, matrix.slice(0, at) + header + rows.join('\n') + '\n');
