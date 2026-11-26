import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canonical } from "../broker/graph-memory/canonical.ts";
import { span } from "../broker/graph-memory/ontology.ts";
import { relationalRank, ftsQuery } from "../broker/graph-memory/ranking.ts";
const date = (s: string) => Date.parse(s + "T00:00:00-04:00") * 1000;
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "pal-graph-"));
  const c = new Canonical(directory);
  t.after(() => {
    c.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = c.registerScope({ key: "fixture", label: "Fixture" }).id;
  return { c, scope, directory };
}
function assertion(
  c: Canonical,
  scope: string,
  tool: string,
  from: number | null = date("2026-09-01"),
  to: number | null = null,
  extra: any = {},
) {
  const text = `Atlas uses ${tool} for formatting.`;
  const observation = c.observeText({ scope_id: scope, text, role: "user" });
  return {
    scope_id: scope,
    claim: {
      subject: { type: "Project", name: "Atlas" },
      predicate: "USES_TOOL",
      object: { type: "Tool", name: tool },
      qualifiers: { purpose: "formatting" },
      valid_mode: from === null ? "known_current" : "bounded",
      valid_from_us: from,
      valid_to_us: to,
      time_precision: "date",
      time_zone: "America/New_York",
      ...extra,
    },
    witness: { observation_id: observation.id, quote: text },
  };
}
function toolsAt(c: Canonical, scope: string, world: string, k?: number) {
  return c
    .retrieve({
      scope_id: scope,
      text: "formatting",
      world_at_us: date(world),
      ...(k ? { known_revision: k } : {}),
    })
    .assertions.map((a: any) => a.claim);
}
test('source erasure rederives a repeated claim only from independent surviving evidence',t=>{
  const {c,scope}=fixture(t),first=assertion(c,scope,'Ruff');c.remember(first);
  const second=assertion(c,scope,'Ruff');c.remember(second);
  const before=c.retrieve({scope_id:scope,text:'formatting'});assert.equal(before.assertions.length,1);assert.equal(before.assertions[0].evidence_ids.length,2);
  c.forget({scope_id:scope,id:first.witness.observation_id});
  const after=c.retrieve({scope_id:scope,text:'formatting'});assert.equal(after.assertions.length,1);assert.match(after.assertions[0].claim,/Ruff/);
  assert.equal(after.assertions[0].evidence_ids.length,1);assert.equal(c.support(after.assertions[0].version_id)[0].observation_id,second.witness.observation_id);
});
test('raw retention expires conversation copies and keeps only supporting witnesses',t=>{
  const {c,scope}=fixture(t),text='Atlas uses Ruff for formatting. Unrelated private detail.';
  const observation=c.observeText({scope_id:scope,text});
  const proposal=assertion(c,scope,'Ruff');proposal.witness={observation_id:observation.id,quote:'Atlas uses Ruff for formatting.'};c.remember(proposal);
  c.run('UPDATE payloads SET expires_us=1 WHERE id=(SELECT payload_id FROM observations WHERE id=?)',observation.id);
  const priorRevision=c.revision;assert.equal(c.expire().expired,1);assert.ok(c.revision>priorRevision);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM payloads WHERE body LIKE '%Unrelated private detail%'").n,0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM evidence WHERE witness LIKE '%Unrelated private detail%'").n,0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM retrieval_documents WHERE text LIKE '%Unrelated private detail%'").n,0);
  assert.ok(c.retrieve({scope_id:scope,text:'formatting'}).assertions.some((a:any)=>a.claim.includes('Ruff')));
  c.forget({scope_id:scope,id:observation.id});assert.equal(c.retrieve({scope_id:scope,text:'formatting'}).assertions.length,0);
});
test('multivalued correction replaces its target and preserves other slot members',t=>{
  const {c,scope}=fixture(t),base=assertion(c,scope,'Ruff',null,null,{qualifiers:{}});const first=c.remember(base);
  c.remember(assertion(c,scope,'Kitty',null,null,{qualifiers:{}}));
  const revision=c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?',first.slot_id).aggregate_revision;
  c.remember({...assertion(c,scope,'Black',null,null,{qualifiers:{}}),id:first.id,expected_revision:revision},'correct');
  const claims=c.retrieve({scope_id:scope,text:'Atlas'}).assertions.map((a:any)=>a.claim).join();assert.match(claims,/Black/);assert.match(claims,/Kitty/);assert.doesNotMatch(claims,/Ruff/);
});
test("M01 duplicate observation has one durable revision and source identity", (t) => {
  const { c, scope } = fixture(t);
  const p = {
    scope_id: scope,
    text: "Atlas uses Ruff.",
    role: "user",
    source_event_id: "turn-1",
    session_id: "one",
  };
  const a = c.observeText(p),
    b = c.observeText(p);
  assert.equal(a.id, b.id);
  assert.equal(a.accepted_revision, b.accepted_revision);
  assert.equal(c.health().counts.observations, 1);
});
test("M07 bitemporal correction preserves all four specified date answers", (t) => {
  const { c, scope } = fixture(t);
  const original = c.remember(assertion(c, scope, "Black"));
  const changed = assertion(c, scope, "Ruff", date("2026-09-20"));
  const corrected = c.remember(
    {
      ...changed,
      id: original.id,
      expected_revision: original.aggregate_revision,
    },
    "correct",
  );
  assert.match(toolsAt(c, scope, "2026-09-25").join(), /Ruff/);
  assert.match(
    toolsAt(c, scope, "2026-09-25", original.accepted_revision).join(),
    /Black/,
  );
  assert.match(toolsAt(c, scope, "2026-09-10").join(), /Black/);
  assert.match(toolsAt(c, scope, "2026-09-20").join(), /Ruff/);
  assert.equal(
    c.inspect({ scope_id: scope, id: corrected.id }).history.length,
    3,
  );
});
test("M08 bounded exception returns to prior value and keeps old knowledge", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  c.remember(
    {
      ...assertion(c, scope, "Ruff", date("2026-09-20"), date("2026-09-27")),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  assert.match(toolsAt(c, scope, "2026-09-21").join(), /Ruff/);
  assert.match(toolsAt(c, scope, "2026-09-28").join(), /Black/);
  assert.match(
    toolsAt(c, scope, "2026-09-21", a.accepted_revision).join(),
    /Black/,
  );
});
test("M09 unknown start is never historical proof and plans are not actual facts", (t) => {
  const { c, scope } = fixture(t);
  c.remember(assertion(c, scope, "Black", null));
  assert.deepEqual(toolsAt(c, scope, "2026-09-10"), []);
  c.remember(
    assertion(c, scope, "Ruff", date("2026-10-01"), null, {
      modality: "planned",
    }),
  );
  assert.ok(!toolsAt(c, scope, "2026-10-02").some((s) => s.includes("Ruff")));
});
test("M10 disagreement is versioned and explicit resolution closes all conflicts", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  const b = c.remember(assertion(c, scope, "Ruff"));
  let q = c.retrieve({ scope_id: scope, text: "formatting" });
  assert.equal(q.assertions.length, 0);
  assert.equal(q.conflicts.length, 2);
  assert.match(
    toolsAt(c, scope, "2026-09-25", a.accepted_revision).join(),
    /Black/,
  );
  c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: b.id,
      expected_revision: b.aggregate_revision,
    },
    "resolve",
  );
  q = c.retrieve({ scope_id: scope, text: "formatting" });
  assert.equal(q.conflicts.length, 0);
  assert.equal(q.assertions.length, 1);
});
test("M12 scoped document aliases never falsely merge same basenames", (t) => {
  const { c, scope } = fixture(t);
  const other = c.registerScope({ key: "other", label: "Other" }).id;
  let a: any, b: any, d: any;
  c.tx(() => {
    a = c.entity(scope, { type: "Document", name: "config.json" });
    b = c.entity(scope, { type: "Document", name: "config.json" });
    d = c.entity(other, { type: "Document", name: "config.json" });
  });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, d.id);
});
test("M13 M24 evidence quotes use exact Unicode code point spans and strict proposals", (t) => {
  assert.deepEqual(span("😄\r\nRuff Ruff", "Ruff", 1), { start: 8, end: 12 });
  assert.throws(() => span("Ruff", "ruff", 0));
  const { c, scope } = fixture(t);
  const p = assertion(c, scope, "Black");
  p.witness.quote = "fabricated";
  assert.throws(() => c.remember(p), /quotation/);
  const good = assertion(c, scope, "Ruff");
  assert.throws(() =>
    c.remember({ ...good, claim: { ...good.claim, predicate: "EXECUTE" } }),
  );
  assert.equal(c.health().counts.assertions, 0);
});
test("M02 M03 M04 durable outbox leases repeat and contiguous watermark never skips a gap", (t) => {
  const { c, scope } = fixture(t);
  c.observeText({ scope_id: scope, text: "decision", role: "user" });
  const jobs = c.all(
    "SELECT * FROM outbox WHERE backend='graph' ORDER BY revision",
  );
  c.finishJob({ id: jobs[1].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    0,
  );
  c.finishJob({ id: jobs[0].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    2,
  );
  c.finishJob({ id: jobs[0].id });
  assert.equal(
    c.health().projections.find((p) => p.backend === "graph")!.watermark,
    2,
  );
});
test("outbox retry deadlines remain integers in STRICT SQLite", (t) => {
  const { c, scope } = fixture(t);
  c.observeText({ scope_id: scope, text: "retry a projection", role: "user" });
  const job = c.claimJob({ backend: "graph" });
  assert.ok(job && "id" in job && typeof job.id === "string");

  t.mock.method(Math, "random", () => 0.123456789);
  assert.doesNotThrow(() => c.finishJob({ id: job.id, error: "backend unavailable" }));
  const retried = c.one(
    "SELECT state,next_retry_us,lease_until_us,error_code FROM outbox WHERE id=?",
    job.id,
  );
  assert.equal(retried.state, "retryable");
  assert.equal(Number.isInteger(retried.next_retry_us), true);
  assert.ok(retried.next_retry_us > 0);
  assert.equal(retried.lease_until_us, null);
  assert.equal(retried.error_code, "backend unavailable");
});
test("M05 M27 stale semantic pointers are hydrated and isolated before ranking", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  const old = c.one("SELECT * FROM artifacts WHERE record_id=?", a.id);
  const b = c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  const result = c.retrieve({
    scope_id: scope,
    text: "formatting",
    semantic_ids: [
      {
        artifactId: old.id,
        contentRevision: old.content_revision,
        sourceGeneration: old.source_generation,
      },
    ],
    read_token: b.read_token,
  });
  assert.ok(!result.assertions.some((x) => x.claim.includes("Black")));
  assert.match(result.assertions[0].claim, /Ruff/);
  const other = c.registerScope({ key: "other", label: "Other" }).id;
  assert.equal(
    c.retrieve({ scope_id: other, text: "formatting", semantic_ids: [old.id] })
      .results.length,
    0,
  );
});
test("M06 M25 forgotten sources, witnesses and projections are suppressed before purge", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "SecretTool"));
  const preview = c.forgetPreview({ scope_id: scope, id: a.id });
  assert.ok(preview.count > 1);
  const erased = c.forget({ scope_id: scope, id: a.id });
  assert.equal(erased.suppressed, true);
  assert.equal(erased.purge_complete, false);
  assert.equal(
    c.retrieve({ scope_id: scope, text: "SecretTool" }).results.length,
    0,
  );
  assert.throws(() => c.inspect({ scope_id: scope, id: a.id }), /erased/);
  for (const table of [
    "payloads",
    "evidence",
    "entities",
    "retrieval_documents",
  ])
    assert.ok(
      !JSON.stringify(c.all(`SELECT * FROM ${table}`)).includes("SecretTool"),
    );
  assert.ok(
    !readFileSync(join(c.directory, "erasure-registry.jsonl"), "utf8").includes(
      "SecretTool",
    ),
  );
});
test("M28 pre-erasure backup restoration applies current external registry before serving", async (t) => {
  const { c, scope, directory } = fixture(t);
  const a = c.remember(assertion(c, scope, "ForgottenTool"));
  const backup = join(directory, "before.sqlite");
  await c.backup({ output: backup });
  c.forget({ scope_id: scope, id: a.id });
  const staging = join(directory, "restored");
  await c.restore({ input: backup, staging });
  const restored = new Canonical(staging);
  try {
    assert.equal(
      restored.retrieve({ scope_id: scope, text: "ForgottenTool" }).results
        .length,
      0,
    );
    assert.throws(() => restored.inspect({ scope_id: scope, id: a.id }));
  } finally {
    restored.close();
  }
});
test("M21 M22 M23 assistant text cannot establish successful instrumented outcome", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "I fixed it successfully.",
    role: "assistant",
  });
  assert.throws(
    () =>
      c.remember({
        scope_id: scope,
        claim: {
          subject: { type: "Action", name: "Build" },
          predicate: "HAS_STATE",
          value: "succeeded",
          epistemic_type: "instrumented",
        },
        witness: { observation_id: o.id, quote: "I fixed it successfully." },
      }),
    /instrumented/,
  );
  const before = c.revision;
  c.retrieve({ scope_id: scope, text: "fixed" });
  assert.equal(c.revision, before);
});
test("M31 FTS punctuation/operators are escaped and hostile text cannot execute queries", (t) => {
  const { c, scope } = fixture(t);
  c.saveText({ scope_id: scope, text: "config.json has Unicode Ω and Ruff" });
  for (const text of [
    "config.json",
    '" OR AND "',
    "Ω",
    "Ruff); DROP TABLE entities;--",
  ])
    assert.doesNotThrow(() => c.retrieve({ scope_id: scope, text }));
  assert.ok(ftsQuery('" OR "').includes('"OR"'));
  assert.equal(c.health().counts.observations, 1);
});
test("M33 stale corrections fail without lost update", (t) => {
  const { c, scope } = fixture(t);
  const a = c.remember(assertion(c, scope, "Black"));
  c.remember(
    {
      ...assertion(c, scope, "Ruff"),
      id: a.id,
      expected_revision: a.aggregate_revision,
    },
    "correct",
  );
  assert.throws(
    () =>
      c.remember(
        {
          ...assertion(c, scope, "Other"),
          id: a.id,
          expected_revision: a.aggregate_revision,
        },
        "correct",
      ),
    /changed/,
  );
  assert.match(toolsAt(c, scope, "2026-09-25").join(), /Ruff/);
});
test("M34 episode publication refuses erased sources after freeze", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "A decision was made.",
    role: "user",
    session_id: "thread",
  });
  const episode = c.one("SELECT id FROM episodes WHERE scope_id=?", scope);
  const frozen = c.freezeEpisode({ scope_id: scope, id: episode.id });
  c.forget({ scope_id: scope, id: o.id });
  assert.throws(
    () =>
      c.archiveEpisode({
        scope_id: scope,
        id: episode.id,
        source_generation: frozen.source_generation,
        policy_epoch: frozen.policy_epoch,
        erasure_epoch: frozen.erasure_epoch,
        claims: [
          { text: "A decision was made.", evidence_ids: [o.evidence_id] },
        ],
      }),
    /changed/,
  );
});
test("M35 M36 supplied evidence and citations remain separate, revoked epochs reject response", (t) => {
  const { c, scope } = fixture(t);
  const o = c.observeText({
    scope_id: scope,
    text: "Ruff decision",
    role: "user",
  });
  const q = c.retrieve({ scope_id: scope, text: "Ruff" });
  const args = {
    scope_id: scope,
    response_ref: "response",
    supplied_evidence_ids: [o.evidence_id],
    cited_evidence_ids: [],
    snapshot_revision: q.snapshot.revision,
    policy_epoch: q.snapshot.policy_epoch,
    erasure_epoch: q.snapshot.erasure_epoch,
  };
  const record = c.recordResponse(args);
  assert.equal(record.cited, 0);
  assert.throws(
    () => c.recordResponse({ ...args, cited_evidence_ids: ["invented"] }),
    /not supplied/,
  );
  c.policyUpdate({ policy: { allow_cloud_memory: false } });
  assert.throws(() => c.recordResponse(args), /invalidated/);
});
test("query-conditioned ranker conserves probability with dangling nodes and bounded cycles", () => {
  const p = relationalRank(new Map([["a", 1]]), [
    { from: "a", to: "b", weight: 1 },
    { from: "b", to: "a", weight: 1 },
    { from: "b", to: "c", weight: 2 },
  ]);
  assert.ok(Math.abs([...p.values()].reduce((s, v) => s + v, 0) - 1) < 1e-8);
  assert.equal(relationalRank(new Map(), []).size, 0);
});

test('candidate expiration is terminal: an expired candidate is retired, never re-derived from its evidence',t=>{
  const {c,scope}=fixture(t);
  c.remember(assertion(c,scope,'Ruff'));c.remember(assertion(c,scope,'Ruff'));
  const live=()=>c.all("SELECT version_id FROM assertion_versions WHERE erased=0 AND known_to_revision IS NULL"),versions=()=>c.one('SELECT COUNT(*) AS n FROM assertion_versions').n;
  assert.equal(live().length,1);
  c.run("UPDATE assertion_versions SET status='candidate',retention_class='candidate',expires_at_us=1 WHERE erased=0 AND known_to_revision IS NULL");
  const before=versions();
  assert.equal(c.expire().expired,1);
  assert.equal(versions(),before); // retired, not copied with its lapsed expiry
  assert.equal(live().length,0);
  assert.equal(c.expire().expired,0);
  assert.equal(c.retrieve({scope_id:scope,text:'formatting'}).assertions.length,0);
});

test('invalidation names its cause, so retention expiry is told apart from forgets and policy changes',t=>{
  const {c,scope}=fixture(t);
  const causes=()=>c.events.splice(0).filter(e=>e.type==='invalidate').map(e=>e.cause);
  c.remember(assertion(c,scope,'Ruff'));causes();
  c.run("UPDATE assertion_versions SET status='candidate',retention_class='candidate',expires_at_us=1 WHERE erased=0 AND known_to_revision IS NULL");
  assert.equal(c.expire().expired,1);
  assert.deepEqual(causes(),['expiration']);
  const observation=c.observeText({scope_id:scope,text:'Atlas uses Black for formatting.',role:'user'});causes();
  c.forget({scope_id:scope,id:observation.id});
  assert.deepEqual(causes(),['forget']);
  c.policyUpdate({policy:{half_life_days:100}});
  assert.deepEqual(causes(),['policy']);
});

/**
 * Copies a live assertion into erased, tombstoned history with an erased artifact and payload each,
 * shaped like the residue the October 2026 candidate-expiry loop left behind.
 */
function erasedHistory(c: Canonical, scope: string, versionId: string, count: number) {
  const columns = c.all("PRAGMA table_info(assertion_versions)").map((r: any) => r.name as string);
  const copy = c.db.prepare(`INSERT INTO assertion_versions(${columns.join(",")}) SELECT ${columns.map((name) => name === "version_id" ? "?" : name === "erased" ? "1" : name === "status" ? "'erased'" : name).join(",")} FROM assertion_versions WHERE version_id=?`);
  const support = c.all("SELECT evidence_id,independence_group FROM assertion_evidence WHERE version_id=? AND relation='support'", versionId);
  const job = randomUUID();
  c.run("INSERT INTO erasure_jobs(id,scope_id,epoch,state,canonical_ack,graph_ack,vector_ack,revision,reason) VALUES (?,?,?,?,?,?,?,?,?)", job, scope, 1, "COMPLETE", 1, 1, 1, c.revision, "expiration");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID(), artifact = randomUUID(), payload = randomUUID();
    copy.run(id, versionId);
    for (const s of support) {
      c.run("INSERT INTO assertion_evidence VALUES (?,?,?,?)", id, s.evidence_id, "support", s.independence_group);
      c.run("INSERT INTO lineage VALUES (?,?,?,?)", id, s.evidence_id, "support", c.revision);
    }
    c.run("INSERT INTO payloads(id,scope_id,body,digest,revision,sensitivity,retention,erased) VALUES (?,?,'','',?,'cloud_allowed','assertion',1)", payload, scope, c.revision);
    c.run("INSERT INTO artifacts(id,scope_id,kind,record_id,payload_id,source_generation,content_revision,known_from_revision,invalidated,sensitivity,erasure_epoch) VALUES (?,?,'assertion',?,?,?,?,?,1,'cloud_allowed',1)", artifact, scope, id, payload, c.revision, c.revision, c.revision);
    c.run("INSERT INTO lineage VALUES (?,?,?,?)", payload, artifact, "content", c.revision);
    for (const target of [id, artifact, payload]) c.run("INSERT INTO tombstones VALUES (?,?,?,?)", target, job, 1, c.revision);
    ids.push(id);
  }
  return ids;
}
const liveVersion = (c: Canonical, scope: string) =>
  c.one("SELECT v.version_id FROM assertion_versions v JOIN entities e ON e.id=v.subject_id WHERE e.name='Atlas' AND e.scope_id=? AND v.erased=0", scope).version_id as string;
test("forgetting a record with long erased history walks only live records", (t) => {
  const { c, scope } = fixture(t);
  c.remember(assertion(c, scope, "Ruff"));
  const live = liveVersion(c, scope), history = new Set(erasedHistory(c, scope, live, 3000));
  const atlas = c.one("SELECT id FROM entities WHERE name='Atlas' AND scope_id=?", scope).id;
  const started = performance.now(), preview = c.forgetPreview({ scope_id: scope, id: atlas });
  assert.ok(performance.now() - started < 2000, "the preview does not revisit erased history");
  assert.equal(preview.target_ids.filter((id: string) => history.has(id)).length, 0);
  assert.ok(preview.target_ids.includes(live) && preview.target_ids.length < 50, `${preview.target_ids.length} targets`);
  // The erasure that follows the preview reuses it, then the claim is gone.
  assert.equal(c.forgetPreview({ scope_id: scope, id: atlas }), preview);
  c.forget({ scope_id: scope, id: atlas });
  assert.equal(c.retrieve({ scope_id: scope, text: "formatting" }).assertions.length, 0);
});
test("a long walk stops on cancellation or a spent budget, but a transaction always commits", (t) => {
  const { c, scope } = fixture(t);
  const observation = c.observeText({ scope_id: scope, text: "Atlas ships on Fridays." });
  const revision = c.revision, tombstones = () => c.one("SELECT COUNT(*) AS n FROM tombstones").n;
  c.deadline = Date.now() - 1;
  assert.throws(() => c.forgetPreview({ scope_id: scope, id: observation.id }), { code: "DEADLINE_EXCEEDED" });
  assert.throws(() => c.forget({ scope_id: scope, id: observation.id }), { code: "DEADLINE_EXCEEDED" });
  c.deadline = Infinity;
  c.cancelled = () => true;
  assert.throws(() => c.forgetPreview({ scope_id: scope, id: observation.id }), { code: "CANCELLED" });
  assert.equal(c.revision, revision);
  assert.equal(tombstones(), 0);
  // Inside a transaction the same limits never interrupt.
  c.deadline = Date.now() - 1;
  c.tx(() => c.checkpoint());
  assert.equal(c.revision, revision + 1);
  c.cancelled = undefined;
  c.deadline = Infinity;
  c.forget({ scope_id: scope, id: observation.id });
  assert.ok(tombstones() > 0);
});
test("an erasure reuses its preview only until something commits", (t) => {
  const { c, scope } = fixture(t);
  const observation = c.observeText({ scope_id: scope, text: "Atlas uses Ruff for formatting." });
  const first = c.forgetPreview({ scope_id: scope, id: observation.id });
  assert.equal(c.forgetPreview({ scope_id: scope, id: observation.id }), first);
  c.observeText({ scope_id: scope, text: "An unrelated note." });
  const second = c.forgetPreview({ scope_id: scope, id: observation.id });
  assert.notEqual(second, first);
  assert.notEqual(second.selection, first.selection);
});
test("compaction backs up, removes erased residue and keeps erased identifiers rejected", async (t) => {
  const { c, scope, directory } = fixture(t);
  c.remember(assertion(c, scope, "Ruff"));
  const kept = c.observeText({ scope_id: scope, text: "Atlas deploys from the main branch." });
  const gone = c.observeText({ scope_id: scope, text: "Forget this private aside." });
  c.forget({ scope_id: scope, id: gone.id });
  const history = erasedHistory(c, scope, liveVersion(c, scope), 200);
  // Projections have caught up, as they had on the store that motivated compaction.
  c.run("UPDATE outbox SET state='done'");
  c.run("UPDATE projection_state SET watermark=? WHERE active IN (1,2)", c.revision);
  const snapshot = c.snapshot(), tombstones = c.one("SELECT COUNT(*) AS n FROM tombstones").n;
  const output = join(directory, "before-compaction.sqlite");
  const result = await c.compact({ output });
  assert.ok(existsSync(output) && existsSync(output + ".manifest.json"));
  assert.equal(result.backup, output);
  assert.ok(result.removed.assertion_versions >= 200 && result.removed.artifacts >= 200 && result.removed.payloads >= 200, JSON.stringify(result.removed));
  assert.ok(result.removed.lineage >= 400 && result.removed.outbox > 0 && result.removed.mutation_effects > 0, JSON.stringify(result.removed));
  assert.equal(c.one("SELECT COUNT(*) AS n FROM outbox").n, 0);
  assert.equal(result.removed.tombstones, 0);
  assert.equal(result.removed.erasure_jobs, 0);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM tombstones").n, tombstones);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM assertion_versions WHERE erased=1").n, 0);
  assert.deepEqual(c.all("PRAGMA foreign_key_check"), []);
  assert.equal(c.one("PRAGMA integrity_check").integrity_check, "ok");
  // Erased identifiers stay rejected; live memory reads as before.
  assert.throws(() => c.validatePacket({ snapshot_revision: snapshot.revision, policy_epoch: snapshot.policy_epoch, erasure_epoch: snapshot.erasure_epoch, record_ids: [history[0]] }), { code: "SOURCE_CHANGED" });
  assert.throws(() => c.inspect({ scope_id: scope, id: history[0] }), { code: "NOT_FOUND" });
  assert.throws(() => c.inspect({ scope_id: scope, id: gone.id }), { code: "NOT_FOUND" });
  assert.ok(c.retrieve({ scope_id: scope, text: "formatting" }).assertions.some((a: any) => /Ruff/.test(a.claim)));
  assert.ok(c.inspect({ scope_id: scope, id: kept.id }));
  // New memory still records and erases normally after compaction.
  const later = c.observeText({ scope_id: scope, text: "Atlas adds a staging environment." });
  c.forget({ scope_id: scope, id: later.id });
  assert.throws(() => c.inspect({ scope_id: scope, id: later.id }), { code: "NOT_FOUND" });
  // An existing backup is never overwritten.
  await assert.rejects(c.compact({ output }), { code: "INVALID_ARGUMENT" });
});
test("erasure lookups and parent deletes use indexes", (t) => {
  const { c } = fixture(t);
  const plan = (sql: string) => c.all("EXPLAIN QUERY PLAN " + sql).map((r: any) => r.detail).join(" | ");
  assert.match(plan("SELECT id FROM artifacts WHERE record_id='x'"), /artifacts_record/);
  const either = plan("SELECT version_id FROM assertion_versions WHERE subject_id='x' OR object_entity_id='x'");
  assert.match(either, /assertions_subject_any/);
  assert.match(either, /assertions_object_any/);
  assert.match(plan("SELECT 1 FROM commits WHERE delta_payload_id='x'"), /commits_delta/);
  assert.match(plan("SELECT 1 FROM mutation_effects WHERE target_id='x' AND revision>1"), /mutation_effects_target/);
});
test("a failed extraction is tried again after a growing pause, and gives up after its attempts", (t) => {
  const { c, scope } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const source = c.observeText({ scope_id: scope, text: "Atlas uses Kitty for its terminals.", role: "user" });
  const claim = () => c.extractionNext();
  const next = () => { const value = claim(); assert.ok(value, "a run is due"); return value; };
  let run = next();
  assert.equal(run.observation_id, source.id);
  const failed = (id: string) => c.extractionResult({ id, error: "MODEL_UNAVAILABLE_OR_INVALID" });
  failed(run.id);
  assert.equal(claim(), null, "an outage is not retried in a tight loop");
  const due = () => c.run("UPDATE extraction_runs SET next_retry_us=0 WHERE observation_id=? AND status='retryable'", source.id);
  const pauses: number[] = [];
  for (let attempt = 2; ; attempt++) {
    pauses.push(c.one("SELECT next_retry_us AS at FROM extraction_runs WHERE id=?", run.id).at - Date.now() * 1000);
    due();
    run = next();
    assert.equal(run.observation_id, source.id);
    assert.equal(c.one("SELECT attempts FROM extraction_runs WHERE id=?", run.id).attempts, attempt);
    failed(run.id);
    if (c.one("SELECT status FROM extraction_runs WHERE id=?", run.id).status !== "retryable") break;
    assert.ok(attempt < 20, "attempts are bounded");
  }
  assert.ok(pauses.every((pause, index) => index === 0 || pause > pauses[index - 1]), "each pause is longer than the last");
  assert.equal(c.one("SELECT status FROM extraction_runs WHERE id=?", run.id).status, "failed");
  due();
  assert.equal(claim(), null);
  assert.equal(c.health().queues.extraction, 0, "a run that gave up is not reported as queued");
  assert.equal(c.health().queues.extraction_failed, 1);
  // An erasure elsewhere reschedules queued extraction under the new epoch without resetting its pause.
  const other = c.observeText({ scope_id: scope, text: "Borealis uses Fish for its shell.", role: "user" });
  failed(next().id);
  const before = c.one("SELECT attempts,next_retry_us FROM extraction_runs WHERE observation_id=? AND status='retryable'", other.id);
  c.forget({ scope_id: scope, id: c.observeText({ scope_id: scope, text: "Something to forget.", role: "user" }).id });
  const after = c.one("SELECT attempts,next_retry_us FROM extraction_runs WHERE observation_id=? AND status='retryable'", other.id);
  assert.deepEqual([after.attempts, after.next_retry_us], [before.attempts, before.next_retry_us]);
  assert.equal(claim(), null, "the rescheduled run still waits for its pause");
  // Changing the extraction settings (the reconciliation configure runs) tries a run that gave up again.
  c.queue(() => c.reconcileExtraction(true));
  const again = next();
  assert.equal(again.observation_id, source.id, "a run that gave up starts over after a settings change");
  assert.equal(c.one("SELECT attempts FROM extraction_runs WHERE id=?", again.id).attempts, 1);
  assert.equal(c.health().queues.extraction_failed, 0);
});
test("a collection's passages are not archived as episode copies, and copies an earlier version made are retired", async (t) => {
  const { c, scope } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const chunk = (source: string, i: number, text: string) =>
    c.observeText({ scope_id: scope, text, role: "document", kind: "document", session_id: source, source_event_id: `${source}#${i}` });
  const idle = () => c.run("UPDATE events SET captured_us=captured_us-700000000 WHERE scope_id=?", scope);
  const copies = () => c.all("SELECT a.id,a.invalidated,p.erased,p.body FROM artifacts a JOIN payloads p ON p.id=a.payload_id WHERE a.scope_id=? AND a.kind='episode'", scope);
  // A source indexed by an earlier version, whose episode was archived as a copy of its chunks.
  const old = [chunk("file:old.md#1", 0, "The zircon flag enables offline mode."), chunk("file:old.md#1", 1, "Run zircon sync daily.")];
  const episode = c.one("SELECT ep.id FROM episodes ep JOIN episode_events m ON m.episode_id=ep.id JOIN events e ON e.id=m.event_id WHERE e.observation_id=?", old[0].id).id;
  const frozen = c.freezeEpisode({ scope_id: scope, id: episode });
  const witnesses = old.map((o) => c.one("SELECT id,witness FROM evidence WHERE observation_id=?", o.id));
  c.archiveEpisode({ scope_id: scope, id: episode, source_generation: frozen.source_generation, policy_epoch: frozen.policy_epoch, erasure_epoch: frozen.erasure_epoch,
    claims: witnesses.map((w) => ({ text: w.witness, evidence_ids: [w.id] })) });
  assert.equal(copies().filter((row) => !row.invalidated).length, 1);
  // A source indexed now.
  chunk("file:new.md#1", 0, "The heliotrope build runs nightly.");
  chunk("file:new.md#1", 1, "Releases ship every second Tuesday.");
  idle();
  await c.call("maintenance");
  assert.deepEqual(copies().filter((row) => !row.invalidated), [], "neither source keeps an episode copy of its chunks");
  assert.ok(copies().every((row) => row.erased === 1 && row.body === ""), "the retired copy's text is gone");
  assert.equal(c.retrieve({ scope_id: scope, text: "zircon offline mode" }).results.filter((r: any) => r.kind === "episode").length, 0);
  assert.ok(c.retrieve({ scope_id: scope, text: "zircon offline mode" }).results.some((r: any) => r.kind === "document"), "the chunks themselves are unchanged");
});
test("retry starts failed and waiting extraction again at once", (t) => {
  const { c, scope } = fixture(t);
  c.policyUpdate({ policy: { enabled: true } });
  const waiting = c.observeText({ scope_id: scope, text: "Atlas uses Kitty for its terminals.", role: "user" });
  const gaveUp = c.observeText({ scope_id: scope, text: "Borealis uses Fish for its shell.", role: "user" });
  c.run("UPDATE extraction_runs SET status='retryable',attempts=3,next_retry_us=? WHERE observation_id=?", Date.now() * 1000 + 3600e6, waiting.id);
  c.run("UPDATE extraction_runs SET status='failed',attempts=10,next_retry_us=0 WHERE observation_id=?", gaveUp.id);
  assert.equal(c.extractionNext(), null);
  assert.deepEqual(c.retry({}).scheduled, true);
  const runs = c.all("SELECT observation_id,status,attempts FROM extraction_runs WHERE status NOT IN ('superseded') ORDER BY observation_id");
  assert.ok(runs.every((run) => run.status === "pending" && run.attempts === 0), JSON.stringify(runs));
  assert.ok(c.extractionNext(), "a run is due at once");
});
test("importing pre-graph memories keeps a saved note the person's unless it carries the assistant's marker", async (t) => {
  const { c } = fixture(t);
  const row = (id: string, kind: string, text: string) => ({ id, scope: JSON.stringify(["http://127.0.0.1:11434", "/project"]), kind, session_id: "legacy-session", text, created: 1, updated: 1, embedding_key: "", vector: null });
  await c.call("import_legacy", { rows: [
    row("note-user", "saved", "Assistant should always answer in French."),
    row("note-marked", "saved", "Assistant: I will answer in French from now on."),
    row("turn-assistant", "conversation", "Assistant: The build passed on the second try."),
    row("turn-word", "conversation", "Assistant confirmed the build."),
    row("turn-user", "conversation", "Please answer in French."),
  ] });
  const role = (id: string) => c.one("SELECT role FROM observations WHERE source_event_id=?", "legacy:" + id).role;
  assert.equal(role("note-user"), "user", "a note addressed to the assistant is still the person's");
  assert.equal(role("note-marked"), "assistant");
  // Conversation passages keep the earlier rule: a passage that begins with the word is the assistant's,
  // the safer reading for text whose author cannot be checked.
  assert.equal(role("turn-assistant"), "assistant");
  assert.equal(role("turn-word"), "assistant");
  assert.equal(role("turn-user"), "user");
});
