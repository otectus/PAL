// The Media pane's times and lines (qml/Recordings.js). mobile TimedTextTest.kt checks the same cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const library: any = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/Recordings.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const cues = [{ start: 0, end: 2, text: 'We launch on Monday.', speaker: 'Anna' }, { start: 2, end: 4.5, text: 'The budget is approved.' }, { start: 4.5, end: 6, text: 'Any questions?' }];

test('times are read and shown the same on both screens', () => {
  assert.equal(library.clock(754.9), '12:34'); assert.equal(library.clock(3723), '1:02:03'); assert.equal(library.range(0, 65), '0:00–1:05');
  assert.deepEqual(['12:34', '1:02:03', ' 75 ', '12:34.5', '1,25'].map(text => library.seconds(text)), [754, 3723, 75, 754.5, 1.25]);
  for (const bad of ['', 'x', '1:75', '1:75:00', '1:2:3:4', '-5', '12:']) assert.equal(library.seconds(bad), undefined, bad);
});
test('lines follow the position, searches name lines, and quotes carry their times', () => {
  assert.deepEqual([library.lineAt(cues.slice(1), 0.5), library.lineAt(cues, 0), library.lineAt(cues, 4.4), library.lineAt(cues, 99), library.lineAt([], 1)], [-1, 0, 1, 2, -1]);
  assert.deepEqual(plain(library.matches(cues, 'anna LAUNCH')), [0]); assert.deepEqual(plain(library.matches(cues, '  ')), []);
  assert.equal(library.quote(cues.slice(0, 2), 'Interview'), '> [0:00] Anna: We launch on Monday.\n> [0:02] The budget is approved.\n> — Interview, 0:00–0:04');
  assert.deepEqual(plain(library.cited('It starts [12:34], again [12:34–12:50], later [1:02:03]. Not [12] or 12:34 alone.')), [{ start: 754, label: '12:34' }, { start: 3723, label: '1:02:03' }].map(item => item.start === 754 ? { start: 754, label: '12:34' } : item));
  assert.equal(library.cited('[0:01] [0:02] [0:03]', 2).length, 2);
});
