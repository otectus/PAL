import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Canonical } from "../broker/graph-memory/canonical.ts";

function memory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "cere-retention-"));
  const canonical = new Canonical(directory);
  t.after(() => { canonical.close(); rmSync(directory, { recursive: true, force: true }); });
  return { canonical, scope: canonical.registerScope({ key: directory, label: "Retention" }).id };
}

function candidate(canonical: Canonical, scope: string, text: string, tool = "pnpm") {
  const source = canonical.observeText({ scope_id: scope, text, role: "user", session_id: "retention" });
  const assertion = canonical.remember({
    scope_id: scope,
    model_proposal: true,
    claim: { subject: { type: "Project", name: "orchid" }, predicate: "USES_TOOL", object: { type: "Tool", name: tool }, modality: "planned" },
    witness: { observation_id: source.id, quote: text },
  });
  assert.equal(canonical.one("SELECT status FROM assertion_versions WHERE version_id=?", assertion.id).status, "candidate");
  return { source, assertion };
}

test("retention planner keeps a pinned candidate recallable with exact evidence after both deadlines", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use pnpm for installs.");
  const pin = canonical.pin({ scope_id: scope, id: record.assertion.id, note: "preserve the plan" });
  const past = Date.now() * 1000 - 1_000_000;
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?", past, record.assertion.id);
  canonical.run("UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)", past, record.source.id);
  canonical.expire();

  const version = canonical.one("SELECT erased,status FROM assertion_versions WHERE version_id=?", record.assertion.id);
  assert.equal(version.erased, 0); assert.equal(version.status, "candidate");
  assert.equal(canonical.one("SELECT erased FROM payloads WHERE id=(SELECT payload_id FROM observations WHERE id=?)", record.source.id).erased, 1, "the unnecessary full turn expires");
  const forecast = canonical.retentionForecast({ scope_id: scope, id: record.assertion.id, now_us: Date.now() * 1000 });
  assert.equal(forecast.recallAllowedByRetention, true);
  assert.deepEqual(forecast.protectionReasons, ["manual_pin"]);
  assert.ok(forecast.requiredEvidenceIds.length > 0);
  const artifact = canonical.one("SELECT id FROM artifacts WHERE record_id=? AND kind='assertion'", record.assertion.id);
  assert.equal(canonical.hydrateArtifact(artifact.id, scope, canonical.revision, undefined, "local")?.assertion.status, "candidate");

  canonical.unpin({ scope_id: scope, pin_id: pin.id });
  assert.equal(canonical.retentionForecast({ scope_id: scope, id: record.assertion.id }).recallAllowedByRetention, false);
  canonical.expire();
  assert.equal(canonical.one("SELECT erased FROM assertion_versions WHERE version_id=?", record.assertion.id).erased, 1);
});

test("a passage pin overlays payload and artifact deadlines, including the exact boundary", (t) => {
  const { canonical, scope } = memory(t);
  const source = canonical.observeText({ scope_id: scope, text: "The deploy key rotates quarterly.", role: "user", session_id: "retention" });
  const baseline = Date.now() * 1000 + 10_000_000;
  canonical.run("UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)", baseline, source.id);
  const atBoundary = canonical.retentionForecast({ scope_id: scope, id: source.id, now_us: baseline });
  assert.equal(atBoundary.recallAllowedByRetention, false, "expiry equality is not eligible");

  canonical.pin({ scope_id: scope, id: source.id });
  canonical.run("UPDATE artifacts SET expires_us=? WHERE record_id=? AND kind='conversation'", baseline, source.id);
  const held = canonical.retentionForecast({ scope_id: scope, id: source.id, now_us: baseline });
  assert.equal(held.recallAllowedByRetention, true);
  const artifact = canonical.one("SELECT id FROM artifacts WHERE record_id=? AND kind='conversation'", source.id);
  assert.ok(canonical.hydrateArtifact(artifact.id, scope, canonical.revision, undefined, "local"));
});

test("forecast distinguishes first evidence loss from final independent support loss", (t) => {
  const { canonical, scope } = memory(t);
  const first = candidate(canonical, scope, "orchid plans to use pnpm for installs.");
  const secondSource = canonical.observeText({ scope_id: scope, text: "The orchid install plan uses pnpm.", role: "user", session_id: "other" });
  const secondEvidence = canonical.one("SELECT * FROM evidence WHERE observation_id=?", secondSource.id);
  canonical.run("INSERT INTO assertion_evidence(version_id,evidence_id,relation,independence_group) VALUES (?,?,?,?)",
    first.assertion.id, secondEvidence.id, "support", secondEvidence.independence_group);
  const base = Date.now() * 1000, early = base + 5_000_000, late = base + 15_000_000;
  canonical.run("UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)", early, first.source.id);
  canonical.run("UPDATE payloads SET expires_us=? WHERE id=(SELECT payload_id FROM observations WHERE id=?)", late, secondSource.id);
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE logical_id=(SELECT logical_id FROM assertion_versions WHERE version_id=?)", base + 30_000_000, first.assertion.id);
  const current = canonical.one("SELECT version_id FROM assertion_versions WHERE logical_id=(SELECT logical_id FROM assertion_versions WHERE version_id=?) AND known_to_revision IS NULL", first.assertion.id);
  const forecast = canonical.retentionForecast({ scope_id: scope, id: current.version_id, now_us: base });
  assert.equal(forecast.nextEvidenceLossAtUs, early);
  assert.equal(forecast.lastSupportLossAtUs, late);
  assert.equal(forecast.effectiveExpiresAtUs, late);
  const backlog = canonical.retentionPreview({ scope_id: scope, reason: "review_grace", now_us: base });
  assert.equal(backlog.scope_counts.partial_evidence_loss, 1);
  assert.equal(backlog.scope_counts.next_partial_evidence_loss_at_us, early);
});

test("automatic preservation is finite, evidence-aware, and releases back to baseline", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use bun for installs.", "bun");
  canonical.setMeta("curation_profile", { mode: "assisted", reviewGrace: true, graceDays: 14, preserveDays: 30,
    maxUnresolvedDays: 90, maxProtectedRecords: 10, maxProtectedBytes: 1_000_000, retainCurationEvidence: true, atRiskHours: 48 });
  const at = Date.now() * 1000, baseline = at + 1_000_000, holdEnd = at + 5_000_000;
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?", baseline, record.assertion.id);
  const hold = canonical.preserveRetention({ scope_id: scope, target_kind: "assertion", target_id: record.assertion.id,
    reason: "automatic_preservation", expires_at_us: holdEnd, source_decision_id: "decision-1" });
  const protectedForecast = canonical.retentionForecast({ scope_id: scope, id: record.assertion.id, now_us: at });
  assert.equal(protectedForecast.effectiveExpiresAtUs, holdEnd);
  assert.equal(protectedForecast.recallAllowedByRetention, true);
  canonical.releaseRetention({ scope_id: scope, hold_id: hold.id });
  assert.equal(canonical.retentionForecast({ scope_id: scope, id: record.assertion.id, now_us: baseline }).recallAllowedByRetention, false);
});

test("backlog preview is revision-bound and bulk grace takes a supported backup", async (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use deno for scripts.", "deno");
  canonical.setMeta("curation_profile", { mode: "assisted", reviewGrace: true, graceDays: 14, preserveDays: 30,
    maxUnresolvedDays: 90, maxProtectedRecords: 10, maxProtectedBytes: 1_000_000, retainCurationEvidence: true, atRiskHours: 48 });
  const forgotten = canonical.observeText({ scope_id: scope, text: "temporary registry marker", role: "user", session_id: "registry" });
  canonical.forget({ scope_id: scope, id: forgotten.id });
  const deadline = Date.now() * 1000 + 3_600_000_000;
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?", deadline, record.assertion.id);
  const preview = canonical.retentionPreview({ scope_id: scope, reason: "review_grace" });
  assert.equal(preview.counts.eligible, 1); assert.equal(preview.items[0].target_id, canonical.one("SELECT logical_id FROM assertion_versions WHERE version_id=?", record.assertion.id).logical_id);
  const output = join(canonical.directory, "before-backlog.sqlite");
  const applied = await canonical.retentionProtect({ scope_id: scope, selection: preview.selection, expected_revision: preview.revision,
    reason: "review_grace", output });
  assert.equal(applied.protected, 1); assert.equal(applied.backup, output);
  assert.equal(applied.erasure_registry, output + ".erasure-registry.jsonl"); assert.equal(existsSync(applied.erasure_registry), true);
  assert.ok(readFileSync(applied.erasure_registry, "utf8").length > 0);
  assert.equal(readFileSync(applied.erasure_registry, "utf8"), existsSync(join(canonical.directory, "erasure-registry.jsonl"))
    ? readFileSync(join(canonical.directory, "erasure-registry.jsonl"), "utf8") : "");
  assert.deepEqual(canonical.retentionForecast({ scope_id: scope, id: record.assertion.id }).protectionReasons, ["review_grace"]);
  const second = canonical.retentionPreview({ scope_id: scope, reason: "review_grace" });
  assert.equal(second.counts.already_protected, 1);
});

test("existing-record policy changes are capture-anchored, journaled, and reversibly restored", async (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use npm for packaging.", "npm");
  const beforeCandidate = canonical.one("SELECT expires_at_us FROM assertion_versions WHERE version_id=?", record.assertion.id).expires_at_us;
  const beforePayload = canonical.one("SELECT p.expires_us FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.id=?", record.source.id).expires_us;
  const preview = canonical.retentionPolicyPreview({ scope_id: scope, raw_turn_days: 45, candidate_days: 20, apply_to_existing: true });
  assert.equal(preview.applies_to, "existing_and_future"); assert.ok(preview.counts.changed >= 2);
  const output = join(canonical.directory, "before-policy.sqlite");
  const applied: any = await canonical.retentionPolicyApply({ scope_id: scope, selection: preview.selection, expected_revision: preview.revision, output });
  assert.equal(applied.complete, true); assert.equal(applied.backup, output);
  const changedCandidate = canonical.one("SELECT expires_at_us,known_from_us FROM assertion_versions WHERE version_id=?", record.assertion.id);
  const changedPayload = canonical.one("SELECT p.expires_us,o.captured_us FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.id=?", record.source.id);
  assert.equal(changedCandidate.expires_at_us, changedCandidate.known_from_us + 20 * 86_400_000_000);
  assert.equal(changedPayload.expires_us, changedPayload.captured_us + 45 * 86_400_000_000);
  const undone = canonical.retentionPolicyUndo({ scope_id: scope, change_id: applied.change_id, expected_revision: canonical.revision });
  assert.equal(undone.complete, true); assert.equal(undone.conflicts, 0);
  assert.equal(canonical.one("SELECT expires_at_us FROM assertion_versions WHERE version_id=?", record.assertion.id).expires_at_us, beforeCandidate);
  assert.equal(canonical.one("SELECT p.expires_us FROM observations o JOIN payloads p ON p.id=o.payload_id WHERE o.id=?", record.source.id).expires_us, beforePayload);
});

test("automatic capacity is exact and never evicts or blocks a manual pin", (t) => {
  const { canonical, scope } = memory(t);
  const first = candidate(canonical, scope, "orchid plans to use vite for the web build.", "vite");
  const second = candidate(canonical, scope, "orchid plans to use gradle for mobile builds.", "gradle");
  canonical.setMeta("curation_profile", { mode: "automatic", reviewGrace: true, graceDays: 14, preserveDays: 30,
    maxUnresolvedDays: 90, maxProtectedRecords: 1, maxProtectedBytes: 1_000_000, retainCurationEvidence: true, atRiskHours: 48 });
  canonical.preserveRetention({ scope_id: scope, target_kind: "assertion", target_id: first.assertion.id,
    reason: "automatic_preservation", source_decision_id: "first" });
  assert.throws(() => canonical.preserveRetention({ scope_id: scope, target_kind: "assertion", target_id: second.assertion.id,
    reason: "automatic_preservation", source_decision_id: "second" }), /capacity is exhausted/);
  const manual = canonical.pin({ scope_id: scope, id: second.assertion.id, note: "explicit user choice" });
  assert.equal(manual.reason, "manual_pin");
  assert.equal(canonical.pins({ scope_id: scope }).total, 1);
});

test("ending the last hold scrubs detached excerpts immediately, before the candidate baseline", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use cargo for packaging.", "cargo");
  const future = Date.now() * 1000 + 86_400_000_000;
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?", future, record.assertion.id);
  const pin = canonical.pin({ scope_id: scope, id: record.assertion.id });
  canonical.run("UPDATE payloads SET expires_us=1 WHERE id=(SELECT payload_id FROM observations WHERE id=?)", record.source.id);
  canonical.expire();
  assert.equal(canonical.one("SELECT erased FROM payloads WHERE id=(SELECT payload_id FROM observations WHERE id=?)", record.source.id).erased, 1);
  assert.ok(canonical.support(record.assertion.id)[0].witness);
  canonical.unpin({ scope_id: scope, pin_id: pin.id });
  assert.equal(canonical.expire().expired, 1);
  assert.equal(canonical.one("SELECT erased FROM assertion_versions WHERE version_id=?", record.assertion.id).erased, 1);
  assert.equal(canonical.one("SELECT COUNT(*) AS n FROM evidence WHERE observation_id=? AND erased=0", record.source.id).n, 0);
});

test("protected expired candidates cannot starve an unprotected expiry batch", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use make for builds.", "make");
  const base = canonical.one("SELECT * FROM assertion_versions WHERE version_id=?", record.assertion.id);
  const support = canonical.one("SELECT * FROM assertion_evidence WHERE version_id=?", record.assertion.id);
  canonical.run("UPDATE assertion_versions SET expires_at_us=1 WHERE version_id=?", record.assertion.id);
  canonical.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 110; index++) {
      const suffix = String(index).padStart(3, "0"), version = `protected-${suffix}`, logical = `protected-logical-${suffix}`, hold = `protected-hold-${suffix}`;
      canonical.insert("assertion_versions", { ...base, version_id: version, logical_id: logical, expires_at_us: 1 });
      canonical.insert("assertion_evidence", { ...support, version_id: version });
      canonical.insert("retention_holds", { id: hold, scope_id: scope, target_kind: "assertion", target_id: logical, reason: "manual_pin",
        created_revision: canonical.revision, created_us: Date.now() * 1000, expires_at_us: null, max_expires_at_us: null,
        policy_revision: canonical.epoch("policy"), source_decision_id: null, note: "", released_revision: null });
      canonical.insert("retention_hold_evidence", { hold_id: hold, evidence_id: support.evidence_id, bundle_id: support.independence_group, required: 1 });
    }
    canonical.db.exec("COMMIT");
  } catch (error) { canonical.db.exec("ROLLBACK"); throw error; }
  assert.equal(canonical.expire().expired, 1);
  assert.equal(canonical.one("SELECT erased FROM assertion_versions WHERE version_id=?", record.assertion.id).erased, 1);
  assert.equal(canonical.one("SELECT COUNT(*) AS n FROM assertion_versions WHERE version_id LIKE 'protected-%' AND erased=1").n, 0);
});

test("forgetting one required passage releases its all-required preservation bundle", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use clang for native builds.", "clang");
  const context = canonical.observeText({ scope_id: scope, text: "Native builds are the release target.", role: "user", session_id: "context" });
  const first = canonical.one("SELECT e.* FROM assertion_evidence ae JOIN evidence e ON e.id=ae.evidence_id WHERE ae.version_id=?", record.assertion.id);
  const second = canonical.one("SELECT * FROM evidence WHERE observation_id=?", context.id);
  canonical.insert("assertion_evidence", { version_id: record.assertion.id, evidence_id: second.id, relation: "support", independence_group: second.independence_group });
  const pin = canonical.preserveRetention({ scope_id: scope, target_kind: "assertion", target_id: record.assertion.id,
    reason: "manual_pin", evidence_ids: [first.id, second.id] });
  assert.equal(canonical.one("SELECT COUNT(*) AS n FROM retention_hold_evidence WHERE hold_id=?", pin.id).n, 2);
  canonical.forget({ scope_id: scope, id: context.id });
  assert.equal(canonical.one("SELECT COUNT(*) AS n FROM retention_holds WHERE id=?", pin.id).n, 0);
  assert.equal(canonical.activePin(canonical.one("SELECT logical_id FROM assertion_versions WHERE version_id=?", record.assertion.id).logical_id), null);
});

test("a manual pin retains each independent bundle when another support is forgotten", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use ninja for builds.", "ninja");
  const other = canonical.observeText({ scope_id: scope, text: "The orchid build plan names ninja.", role: "user", session_id: "independent" });
  const evidence = canonical.one("SELECT * FROM evidence WHERE observation_id=?", other.id);
  canonical.insert("assertion_evidence", { version_id: record.assertion.id, evidence_id: evidence.id, relation: "support", independence_group: evidence.independence_group });
  const pin = canonical.pin({ scope_id: scope, id: record.assertion.id });
  assert.equal(canonical.one("SELECT COUNT(DISTINCT bundle_id) AS n FROM retention_hold_evidence WHERE hold_id=?", pin.id).n, 2);
  canonical.forget({ scope_id: scope, id: other.id });
  assert.equal(canonical.one("SELECT COUNT(DISTINCT bundle_id) AS n FROM retention_hold_evidence WHERE hold_id=?", pin.id).n, 1);
  const logical = canonical.one("SELECT logical_id FROM assertion_versions WHERE version_id=?", record.assertion.id).logical_id;
  assert.equal(canonical.activePin(logical)?.id, pin.id);
});

test("policy preview is paged and source-driven forecasts honor manual pin overlays", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use meson for builds.", "meson");
  canonical.pin({ scope_id: scope, id: record.assertion.id });
  const base = canonical.one("SELECT * FROM assertion_versions WHERE version_id=?", record.assertion.id);
  const support = canonical.one("SELECT * FROM assertion_evidence WHERE version_id=?", record.assertion.id);
  canonical.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 30; index++) {
      const suffix = String(index).padStart(2, "0"), version = `policy-${suffix}`;
      canonical.insert("assertion_versions", { ...base, version_id: version, logical_id: `policy-logical-${suffix}` });
      canonical.insert("assertion_evidence", { ...support, version_id: version });
    }
    canonical.db.exec("COMMIT");
  } catch (error) { canonical.db.exec("ROLLBACK"); throw error; }
  const preview = canonical.retentionPolicyPreview({ scope_id: scope, raw_turn_days: 1, candidate_days: 7, apply_to_existing: true, limit: 5 });
  assert.equal(preview.items.length, 5); assert.ok(preview.counts.changed > 5); assert.equal(preview.next_cursor, "5");
  const pinned = preview.items.find((item: any) => item.id === record.assertion.id);
  if (pinned) {
    assert.equal(pinned.protected_by_hold, true);
    assert.equal(pinned.next_effective_expires_at_us, null);
    assert.equal(pinned.newly_eligible_deletion, false);
    assert.equal(pinned.baseline_deadline_changed, false);
  } else {
    const page = canonical.retentionPolicyPreview({ scope_id: scope, raw_turn_days: 1, candidate_days: 7, apply_to_existing: true, limit: 50 });
    const item = page.items.find((entry: any) => entry.id === record.assertion.id);
    assert.ok(item);
    assert.equal(item.protected_by_hold, true); assert.equal(item.next_effective_expires_at_us, null); assert.equal(item.baseline_deadline_changed, false);
  }
  const sourcePage = canonical.retentionPolicyPreview({ scope_id: scope, raw_turn_days: 1, candidate_days: 7, apply_to_existing: true, limit: 50 });
  const sourceDriven = sourcePage.items.find((entry: any) => entry.id === "policy-00");
  assert.ok(sourceDriven); assert.equal(sourceDriven.baseline_deadline_changed, false); assert.equal(sourceDriven.effective_deadline_changed, true);
});

test("backlog risk counts cover the whole scope while eligibility stays page-bound", (t) => {
  const { canonical, scope } = memory(t), record = candidate(canonical, scope, "orchid plans to use just for commands.", "just");
  canonical.setMeta("curation_profile", { mode: "assisted", reviewGrace: true, graceDays: 14, preserveDays: 30,
    maxUnresolvedDays: 90, maxProtectedRecords: 100, maxProtectedBytes: 1_000_000, retainCurationEvidence: true, atRiskHours: 48 });
  const deadline = Date.now() * 1000 + 3_600_000_000;
  canonical.run("UPDATE assertion_versions SET expires_at_us=? WHERE version_id=?", deadline, record.assertion.id);
  const base = canonical.one("SELECT * FROM assertion_versions WHERE version_id=?", record.assertion.id);
  const support = canonical.one("SELECT * FROM assertion_evidence WHERE version_id=?", record.assertion.id);
  canonical.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 12; index++) {
      const suffix = String(index).padStart(2, "0"), version = `backlog-${suffix}`;
      canonical.insert("assertion_versions", { ...base, version_id: version, logical_id: `backlog-logical-${suffix}` });
      canonical.insert("assertion_evidence", { ...support, version_id: version });
    }
    canonical.db.exec("COMMIT");
  } catch (error) { canonical.db.exec("ROLLBACK"); throw error; }
  const first = canonical.retentionPreview({ scope_id: scope, reason: "review_grace", limit: 5, timezone: "America/New_York" });
  assert.equal(first.items.length, 5); assert.equal(first.counts.eligible, 5); assert.equal(first.counts.page_at_risk, 5);
  assert.equal(first.counts.at_risk, 13); assert.equal(first.scope_counts.at_risk, 13); assert.equal(first.scope_counts.unresolved, 13);
  assert.equal(first.count_semantics.eligible, "selected_page"); assert.equal(first.count_semantics.at_risk, "whole_scope_unprotected");
  assert.equal(first.timezone, "America/New_York"); assert.equal(first.next_cursor, "5");
  const second = canonical.retentionPreview({ scope_id: scope, reason: "review_grace", limit: 5, cursor: first.next_cursor });
  assert.equal(second.items.length, 5); assert.equal(second.counts.at_risk, 13); assert.equal(second.counts.eligible, 5);
});
