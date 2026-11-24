import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// qml/CommandLine.js splits what a person types in Workbench › Runs into a program and its arguments.
const library: any = vm.createContext({});
vm.runInContext(readFileSync(new URL('../qml/CommandLine.js', import.meta.url), 'utf8').replace(/^\.pragma library\s*/, ''), library);
const split = (text: string) => JSON.parse(JSON.stringify(library.split(text)));

test('words, quotes and backslashes become exact arguments', () => {
  assert.deepEqual(split('npm test'), { argv: ['npm', 'test'], problem: '' });
  assert.deepEqual(split('  printf   "%s\\n"  \'a b\' c\\ d  ""').argv, ['printf', '%s\\n', 'a b', 'c d', '']);
  assert.deepEqual(split('grep "say \\"hi\\"" file.txt').argv, ['grep', 'say "hi"', 'file.txt']);
  assert.deepEqual(split("sh -c 'ls | wc -l'"), { argv: ['sh', '-c', 'ls | wc -l'], problem: '' });
  assert.deepEqual(split('--flag=\'x y\'z').argv, ['--flag=x yz']);
  assert.deepEqual(split('   '), { argv: [], problem: '' });
});
test('an open quote or a bare shell operator is reported, and an operator inside an argument is not', () => {
  assert.match(split('echo "unfinished').problem, /quote is not closed/);
  for (const line of ['ls | wc', 'a && b', 'make > out.txt', 'sleep 1 ; echo x', 'run 2>&1']) assert.match(split(line).problem, /shell operator/, line);
  for (const line of ['awk a|b', 'echo "a && b"', "echo 'x > y'", 'echo a\\ \\| b']) assert.equal(split(line).problem, '', line);
  assert.match(split(Array.from({ length: 65 }, () => 'a').join(' ')).problem, /64 arguments/);
});
