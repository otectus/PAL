import type { DatabaseSync } from "node:sqlite";

/**
 * Migration 7 copies every legacy pin into retention_holds, whose unique index allows one active hold
 * per target and reason. Legacy pins had no such constraint, so a store with two active pins on one
 * record failed that copy, rolled back, and failed the same way on every later start. Run inside
 * migration 7's transaction, just before its SQL, this keeps the oldest active pin of each such record
 * with every distinct note of the group, and releases the others at the store's latest revision. No
 * pin is deleted, and the shipped, checksummed migration text is unchanged.
 */
export function repairLegacyPins(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='retention_pins'").get()) return;
  const revision = Number((db.prepare("SELECT COALESCE(MAX(revision),0) AS n FROM commits").get() as { n: number }).n);
  const active = db.prepare(
    "SELECT id,target_kind,target_id,note FROM retention_pins WHERE released_revision IS NULL ORDER BY target_kind,target_id,created_revision,created_us,id",
  ).all() as { id: string; target_kind: string; target_id: string; note: string }[];
  const groups = new Map<string, typeof active>();
  for (const pin of active) {
    const key = pin.target_kind + "\u0000" + pin.target_id;
    groups.set(key, [...(groups.get(key) || []), pin]);
  }
  for (const [kept, ...duplicates] of groups.values()) {
    if (!duplicates.length) continue;
    const note = [...new Set([kept, ...duplicates].map((pin) => pin.note.trim()).filter(Boolean))].join("; ");
    if (note !== kept.note.trim()) db.prepare("UPDATE retention_pins SET note=? WHERE id=?").run(note, kept.id);
    for (const duplicate of duplicates) db.prepare("UPDATE retention_pins SET released_revision=? WHERE id=?").run(revision, duplicate.id);
  }
}

/**
 * Retention storage is kept in its own append-only migration so schema.ts can
 * register it at the next free migration id without making this module depend
 * on the rest of the curation schema landing in parallel.
 */
export const retentionMigrationSql = `
CREATE TABLE retention_holds(
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('observation','assertion','statement')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('manual_pin','review_grace','automatic_preservation','accepted_evidence')),
  created_revision INTEGER NOT NULL,
  created_us INTEGER NOT NULL,
  expires_at_us INTEGER,
  max_expires_at_us INTEGER,
  policy_revision INTEGER NOT NULL,
  source_decision_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  released_revision INTEGER,
  CHECK(expires_at_us IS NULL OR expires_at_us>created_us),
  CHECK(max_expires_at_us IS NULL OR expires_at_us IS NULL OR max_expires_at_us>=expires_at_us)
) STRICT;
CREATE UNIQUE INDEX retention_holds_active ON retention_holds(target_kind,target_id,reason) WHERE released_revision IS NULL;
CREATE INDEX retention_holds_scope ON retention_holds(scope_id,released_revision,expires_at_us,target_kind,target_id);
CREATE INDEX retention_holds_expiry ON retention_holds(released_revision,expires_at_us,target_kind,target_id);
CREATE TABLE retention_hold_evidence(
  hold_id TEXT NOT NULL REFERENCES retention_holds(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  bundle_id TEXT NOT NULL,
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  PRIMARY KEY(hold_id,evidence_id)
) STRICT;
CREATE INDEX retention_hold_evidence_evidence ON retention_hold_evidence(evidence_id,hold_id);
CREATE TABLE retention_policy_changes(
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  previous_policy TEXT NOT NULL,
  next_policy TEXT NOT NULL,
  apply_existing INTEGER NOT NULL CHECK(apply_existing IN (0,1)),
  selection TEXT NOT NULL,
  created_revision INTEGER NOT NULL,
  completed_revision INTEGER,
  undone_revision INTEGER,
  changed_records INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE retention_deadline_changes(
  change_id TEXT NOT NULL REFERENCES retention_policy_changes(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('observation','assertion','statement')),
  target_id TEXT NOT NULL,
  previous_expires_at_us INTEGER,
  next_expires_at_us INTEGER,
  target_revision INTEGER NOT NULL,
  undone_revision INTEGER,
  PRIMARY KEY(change_id,target_kind,target_id)
) STRICT;
INSERT INTO retention_holds(id,scope_id,target_kind,target_id,reason,created_revision,created_us,expires_at_us,max_expires_at_us,policy_revision,source_decision_id,note,released_revision)
SELECT id,scope_id,target_kind,target_id,'manual_pin',created_revision,created_us,NULL,NULL,0,NULL,note,released_revision
FROM retention_pins;
INSERT OR IGNORE INTO retention_hold_evidence(hold_id,evidence_id,bundle_id,required)
SELECT p.id,ae.evidence_id,ae.independence_group,1
FROM retention_pins p
JOIN assertion_versions v ON p.target_kind='assertion' AND v.logical_id=p.target_id AND v.known_to_revision IS NULL AND v.erased=0
JOIN assertion_evidence ae ON ae.version_id=v.version_id AND ae.relation='support'
JOIN evidence e ON e.id=ae.evidence_id AND e.erased=0;
INSERT OR IGNORE INTO retention_hold_evidence(hold_id,evidence_id,bundle_id,required)
SELECT p.id,e.id,e.independence_group,1
FROM retention_pins p
JOIN evidence e ON p.target_kind='observation' AND e.observation_id=p.target_id AND e.erased=0;
`;
