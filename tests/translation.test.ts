// PAL Everywhere §16.3: translation keeps structure (markers outside the translated text, code untouched), applies a
// glossary, writes a document's translation as a new linked file and never changes the original.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skipWithoutHelper, workbenchFixture } from './fixtures/workbench.ts';
import { segmentText } from '../broker/translation.ts';

test('segments keep markers and code out of the translated text', () => {
  const segments = segmentText('# Title\n- [x] Done item\n\n```js\nconst a = 1;\n```\n| a | b |\n| --- | --- |\n> Quote');
  assert.deepEqual(segments.filter(s => s.translate).map(s => [s.prefix, s.text]), [['# ', 'Title'], ['- [x] ', 'Done item'], ['', '| a | b |'], ['> ', 'Quote']]);
  assert.ok(segments.some(s => s.prefix === 'const a = 1;' && !s.translate), 'code inside a fence is never sent');
});

test('a document becomes a linked translated file and the original is unchanged', { skip: skipWithoutHelper }, async t => {
  const requests: any[] = [];
  const f = await workbenchFixture(t, [
    body => { requests.push(body); return { content: JSON.stringify({ segments: ['Versionshinweise', 'Der Speicher ist schneller.'] }) }; },
    body => { requests.push(body); return { content: JSON.stringify({ segments: ['nur eins'] }) }; },
  ]);
  await writeFile(join(f.project, 'notes.md'), '# Release notes\n- The cache is faster.\n```\nkeep();\n```\n');
  await f.core.updateSettings({ workbench: { helper: { provider: 'ollama', model: 'plain:latest' } } });
  const { session, root } = await f.session();
  const result: any = await f.core.rpc('translate.run', { sessionId: session.id, targetLanguage: 'German', input: { kind: 'file', rootId: root.id, path: 'notes.md' }, glossary: [{ source: 'cache', target: 'Speicher' }] });
  assert.equal(result.status, 'completed', result.summary);
  assert.match(requests[0].messages[0].content, /cache → Speicher/); assert.doesNotMatch(requests[0].messages[0].content, /keep\(\)/);
  const artifact = result.artifacts[0];
  const { version, data } = await f.core.workbench.artifacts.bytes(session.id, artifact.artifactId, artifact.versionId);
  assert.equal(version.name, 'notes (German).md');
  assert.equal(data.toString('utf8'), '# Versionshinweise\n- Der Speicher ist schneller.\n```\nkeep();\n```\n');
  assert.equal((version as any).provenance.kind, 'translation'); assert.equal((version as any).provenance.source.path, 'notes.md');
  assert.equal(await readFile(join(f.project, 'notes.md'), 'utf8'), '# Release notes\n- The cache is faster.\n```\nkeep();\n```\n');
  // A reply that drops a segment is reported, not patched over.
  const bad: any = await f.core.rpc('translate.run', { sessionId: session.id, targetLanguage: 'German', text: 'One.\nTwo.' });
  assert.equal(bad.status, 'failed'); assert.match(bad.summary, /did not keep the 2 segments/);
});
