import { DatabaseSync } from "node:sqlite";

type Run = (sql: string, ...args: any[]) => unknown;

/**
 * What one erasure target loses: the content of every row that names it, in the order Canonical.suppress
 * has always applied it. Tombstones, erasure jobs, epochs and projection effects are the live store's
 * bookkeeping and stay in suppress. `has` says whether a table exists, so an older store (a pre-migration
 * backup) skips the ones it does not have yet. `keepAssertion` leaves an assertion version whole: suppress
 * re-derives such a version from independent surviving evidence, and a copy must still hold what that
 * re-derivation reads when the registry is replayed on it.
 */
export function scrubRecord(run: Run, has: (table: string) => boolean, target: string, keepAssertion = false) {
  if (has("memory_assessments")) {
    run("UPDATE memory_curation_jobs SET state=CASE WHEN state='applied' THEN 'applied' ELSE 'stale' END,error_code='EVIDENCE_ERASED',lease_token=NULL WHERE id IN (SELECT m.job_id FROM memory_assessments m JOIN memory_assessment_inputs i ON i.assessment_id=m.id WHERE i.input_id=?)", target);
    run("DELETE FROM memory_assessments WHERE id IN (SELECT assessment_id FROM memory_assessment_inputs WHERE input_id=?)", target);
    run("DELETE FROM memory_curation_jobs WHERE version_id=?", target);
    run("DELETE FROM memory_extractor_hints WHERE version_id=?", target);
    run("DELETE FROM memory_synthesis WHERE artifact_id=? OR episode_id=?", target, target);
  }
  if (has("memory_statement_versions"))
    run("UPDATE memory_statement_versions SET text='',erased=1,status='erased' WHERE version_id=?", target);
  run("DELETE FROM retrieval_documents WHERE artifact_id=?", target);
  run("DELETE FROM embedding_records WHERE artifact_id=?", target);
  run("UPDATE artifacts SET invalidated=1 WHERE id=? OR record_id=?", target, target);
  run("UPDATE payloads SET body='',digest='',erased=1 WHERE id=?", target);
  run("UPDATE evidence SET witness='',digest='',locator='{}',erased=1 WHERE id=?", target);
  run("UPDATE observations SET erased=1,extraction_state='erased' WHERE id=?", target);
  run("UPDATE extraction_runs SET status='erased',model_identity='',error_code=NULL WHERE observation_id=?", target);
  if (!keepAssertion)
    run("UPDATE assertion_versions SET erased=1,status='erased',object_entity_id=NULL,value_json='null',qualifiers='{}',time_expression='',predicate='ERASED' WHERE version_id=?", target);
  run("UPDATE entities SET erased=1,name='',external_id=NULL WHERE id=?", target);
  run("DELETE FROM entity_aliases WHERE entity_id=?", target);
  run("DELETE FROM identity_links WHERE left_id=? OR right_id=? OR evidence_id=?", target, target, target);
  run("DELETE FROM event_edges WHERE from_id=? OR to_id=? OR evidence_id=?", target, target, target);
  run("UPDATE events SET erased=1 WHERE id=?", target);
  run("UPDATE episodes SET erased=1,summary_id=NULL WHERE id=?", target);
  run("UPDATE topics SET erased=1,name='',summary_id=NULL WHERE id=?", target);
  run("DELETE FROM topic_links WHERE topic_id=? OR target_id=?", target, target);
  run("UPDATE response_records SET erased=1,response_ref='',supplied_evidence_ids='[]',cited_evidence_ids='[]' WHERE id=?", target);
}

/** One erasure as a copy receives it: its targets, and the assertion versions it re-derived. */
export type CopyErasure = { targets: readonly string[]; keep: readonly string[] };

/**
 * Removes erased content from a copy of the store that PAL keeps, a pre-migration backup, without
 * changing its schema, so it still opens with the version that wrote it. The erasures apply in order;
 * a later one that targets a version an earlier one kept removes it. Only content leaves: the copy gets
 * no tombstones or erasure jobs, so when it is opened, replaying the erasure registry completes the
 * erasure there, re-derivation included. Deleted rows and freed pages are zeroed, and the full-text
 * index drops their entries; the first scrub of a copy also merges away what earlier erasures left in
 * its index. Throws if the copy cannot be changed.
 */
export function scrubCopy(path: string, erasures: readonly CopyErasure[]) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec("PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    const has = (table: string) => tables.has(table);
    const run: Run = (sql, ...args) => db.prepare(sql).run(...args);
    const merged = (db.prepare("SELECT value FROM meta WHERE key='fts_remnants_merged'").get() as { value?: string } | undefined)?.value;
    if (has("memory_fts")) db.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const erasure of erasures) {
        const keep = new Set(erasure.keep), targets = [...new Set(erasure.targets)];
        for (const target of targets) scrubRecord(run, has, target, keep.has(target));
        run("DELETE FROM retrieval_documents WHERE artifact_id IN (SELECT id FROM artifacts WHERE invalidated=1)");
        run("UPDATE fact_slots SET predicate='ERASED:'||id,qualifiers='{}' WHERE NOT EXISTS (SELECT 1 FROM assertion_versions a WHERE a.slot_id=fact_slots.id AND a.erased=0)");
        const encoded = JSON.stringify(targets);
        // A pin's note goes with an erased passage, as in the live store.
        if (has("retention_holds")) {
          run("DELETE FROM retention_hold_evidence WHERE hold_id IN (SELECT id FROM retention_holds WHERE target_kind='observation' AND target_id IN (SELECT value FROM json_each(?)))", encoded);
          run("DELETE FROM retention_holds WHERE target_kind='observation' AND target_id IN (SELECT value FROM json_each(?))", encoded);
        }
        if (has("retention_pins")) run("DELETE FROM retention_pins WHERE target_kind='observation' AND target_id IN (SELECT value FROM json_each(?))", encoded);
      }
      if (!merged && has("memory_fts")) {
        run("INSERT INTO memory_fts(memory_fts) VALUES('optimize')");
        run("INSERT INTO meta VALUES ('fts_remnants_merged','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
