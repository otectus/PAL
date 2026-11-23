import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, schema } from '../broker/graph-memory/schema.ts';
import { Canonical } from '../broker/graph-memory/canonical.ts';

// Checksums that stores record when they apply each migration. The live store has carried all five
// since 15 October 2026, and Canonical.migrate refuses any store whose recorded checksum differs from
// the code's, so editing an applied migration would leave existing memory unreadable. Pin each new
// migration here once it ships.
const applied: Record<number, string> = {
  1: 'f81269ed121069331d357b7244e9605ff810aafc89ffb25bcff0727257acf25a',
  2: '22e189a9a7aecc25c8f4279f80d1c8227b0e7ba91b3fb474ac9bf489914dd2cc',
  3: '8d7400e82b0ad94fcbcf0fb6fb41888f9a6a95995badc3cff77ab58105bc1e73',
  4: '2e488843376a205fba32765044518e735e4a789a1812b6b968975419c2e91e67',
  5: 'fa3a04d5ee812bac2a80d207c533710444649077807a1c54df46117035b1ecf5',
  6: '4175254d9bb46e9084eacf29bb6c28d5ef6f0a2b256231dfaa1db27c5544ffa7',
  7: '27c145c4a88ff46ceda9e2dc733c506d002474bbe584cde230af9a20fe413c62',
};

test('S3 applied memory migrations are never edited', () => {
  const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
  const current = new Map([[1, digest(schema)], ...migrations.map((migration): [number, string] => [migration.id, digest(migration.sql)])]);
  for (const [id, checksum] of Object.entries(applied))
    assert.equal(current.get(Number(id)), checksum, `memory migration ${id} changed: add a new migration; never edit an applied one`);
  assert.deepEqual(migrations.map(migration => migration.id), migrations.map((_, index) => index + 2), 'migrations follow the schema in order');
});

test('S3 migration 7 opens a store whose legacy pins name one record twice', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pal-legacy-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A store written by code that knew migrations 1–6, where retention_pins had no uniqueness.
  const later = migrations.splice(migrations.findIndex(migration => migration.id === 7));
  let scope = '', passage = '', logical = '';
  try {
    const c = new Canonical(directory);
    scope = c.registerScope({ key: 'legacy-pins', label: 'Legacy pins' }).id;
    passage = c.observeText({ scope_id: scope, text: 'The orchid deploy key rotates quarterly.', role: 'user' }).id;
    const source = c.observeText({ scope_id: scope, text: 'Atlas uses Kitty.', role: 'user' });
    const version = c.remember({ scope_id: scope, claim: { subject: { type: 'Project', name: 'Atlas' }, predicate: 'USES_TOOL', object: { type: 'Tool', name: 'Kitty' } }, witness: { observation_id: source.id, quote: 'Atlas uses Kitty.' } }).id;
    logical = c.one('SELECT logical_id FROM assertion_versions WHERE version_id=?', version).logical_id;
    const pin = (id: string, kind: string, target: string, note: string, released: number | null = null) =>
      c.run('INSERT INTO retention_pins VALUES (?,?,?,?,?,?,?,?)', id, scope, kind, target, note, c.revision, Date.now() * 1000, released);
    pin('pin-a', 'observation', passage, 'Needed for the audit');
    pin('pin-b', 'observation', passage, 'Needed for the audit ');
    pin('pin-c', 'observation', passage, 'Legal hold');
    pin('pin-d', 'assertion', logical, '');
    pin('pin-e', 'assertion', logical, 'Team convention');
    pin('pin-f', 'assertion', logical, 'Released long ago', c.revision);
    c.close();
  } finally { migrations.push(...later); }
  const c = new Canonical(directory);
  try {
    assert.equal(c.one('SELECT MAX(id) AS n FROM schema_migrations').n, migrations.at(-1)!.id, 'the store migrates instead of failing on every start');
    assert.deepEqual(c.all("SELECT id,target_kind,note FROM retention_holds WHERE released_revision IS NULL ORDER BY id").map(row => [row.id, row.target_kind, row.note]),
      [['pin-a', 'observation', 'Needed for the audit; Legal hold'], ['pin-d', 'assertion', 'Team convention']], 'the oldest pin of each record stays, with every distinct note');
    assert.equal(c.one('SELECT COUNT(*) AS n FROM retention_holds').n, 6, 'no legacy pin is dropped: duplicates are released, not deleted');
    assert.deepEqual(c.all('SELECT id FROM retention_pins WHERE released_revision IS NOT NULL ORDER BY id').map(row => row.id), ['pin-b', 'pin-c', 'pin-e', 'pin-f']);
    assert.equal(c.pins({ scope_id: scope }).total, 2);
    assert.ok(c.one('SELECT COUNT(*) AS n FROM retention_hold_evidence WHERE hold_id=?', 'pin-a').n > 0, 'the surviving pin holds its passage evidence');
    // The surviving pin still protects its passage from retention expiry.
    c.run('UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)', Date.now() * 1000 - 1_000_000, passage);
    c.expire();
    assert.equal(c.one('SELECT erased FROM observations WHERE id=?', passage).erased, 0);
    assert.equal(c.activePin(logical)?.id, 'pin-d');
  } finally { c.close(); }
});
