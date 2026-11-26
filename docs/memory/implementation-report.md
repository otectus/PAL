# Implementation and publication status

Date: 2026-09-29. This initial repository publication contains an integrated, experimental graph-memory implementation. It does **not** satisfy every completion criterion in the reference design (`PAL_Graph_Memory_Implementation.md`, kept outside the repository) yet.

## Audit of 2026-11-26

Graph memory remains **experimental**, and the reference-design gates below are unchanged: no evaluation that would close one was run. A full audit of the memory code found ten defects, all fixed with tests; the findings, the fixes and what was checked are in [the audit report](audit-2026-11-26.md). In short: a forget bound to its preview could fail after the conversation history was scrubbed and leave the record recallable; a pending erasure whose record was gone stopped memory from starting; the full-text index, the write-ahead logs and the conversation database kept forgotten text on disk; a knowledge collection without cloud consent was embedded by hosted providers; failed extraction was never retried; a busy memory worker made a search fail instead of answering from keywords; a message could be recorded twice after a recall timeout; and a reply citing evidence it was not given lost its provenance record. Migrations 8 and 9 were added for the index and the extraction retry schedule. A follow-up the same day, released as 2.0.3, resolved everything the report had left open: pre-migration backups are scrubbed by every erasure, the conversation database is rewritten once to clear what earlier forgets left in its free space, a replayed clear is bounded by the store's clock, read-only phone turns leave out earlier copies of their message, knowledge collections are no longer copied into episodes, failed work can be retried from the inspector and the CLI, expiry yields to a recalling turn, an idle memory worker no longer keeps a process alive, and legacy notes addressed to the assistant import as the person's.

## Status reconciled with source (2026-10-20)

Graph memory remains **experimental**. The reference-design gates below are still open; none was closed by this review pass. In particular the recorded extraction rerun's predicate precision is 88.9%, below its 95% gate ([evaluation](evaluation.md)), and 32 of 32 accepted assertions on a small synthetic set does not establish production precision. A representative held-out evaluation was not run: it needs a production-domain corpus, the extraction models and billed cloud calls the owner has not authorized.

Changed in this pass, with tests:

- **Shared scope across providers.** A conversation's memory is its project on its memory server, whichever provider it uses; a paired phone reaches it only while that server is granted (`tests/remote.test.ts`, "project memory is shared across provider conversations…").
- **Phone workflows.** History and evidence (`memory.timeline`), revision-bound corrections and conflict resolution, identity decisions and episode freezing, each witnessed by the person's own statement and refused at a stale revision; erasure receipts kept on the phone and rechecked after reconnect; sanitized health (`memory.health`) without endpoints, models or error text.
- **Restore staging** now copies with a synchronous `VACUUM INTO`, like backups. The asynchronous SQLite backup it replaced was seen once to stall a restore for 30 s under load (`tests/recovery-races.test.ts`).
- **Degradation.** With memory retrieval failing, chat completes within the recall deadline (`tests/core.test.ts`, `tests/degraded-services.test.ts`).

Task creation/binding (item 3), the collector/editor integrations (item 4) and the full M01–M36 failure matrix (item 5) are unchanged.

## Implemented and exercised

- Worker-owned canonical SQLite, strict ontology/DTOs, exact Unicode evidence, scoped entity resolution, atomic FTS changes, mutation revisions, ordered outbox, and read tokens.
- Bitemporal corrections, bounded exceptions, conflicts, source trust, strict extraction proposals, and `gpt-oss:20b-cloud` configuration. The extraction schema now uses the canonical predicate registry rather than free-form predicate names.
- Real Neo4j/Qdrant adapters, immutable embedding identities/generations, stale-pointer rejection, replay/restart behavior, and staged rebuilds.
- Canonical retrieval, context packets, evidence supplied/cited tracking, graph inspector, CLI, transient desktop collectors, and existing broker integration.
- Erasure registry, suppression, lineage cleanup, source-specific independent-support rederivation, raw-retention cleanup, pending projection acknowledgements, and guarded backup restoration. Managed conversation scrubbing records an opaque retry intent before canonical deletion so a restart can complete an interrupted erase.
- Packaged native peer-credential helper, deployment files, operation instructions, pinned dependencies, and isolated installation smoke tooling.

## Checks run for publication

| Command/check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 98 passed, 0 failed |
| `node --test tests/memory.test.ts tests/knowledge.test.ts` | 32 passed, 0 failed |
| `npm run build` | Passed, including native peer-credential module and UI check binary |
| `python3 tools/install-user.py --prefix build/publish-install` | Passed; isolated staging only |
| `python3 tools/check-memory-install.py --root build/publish-install/share/pal` | Passed: installed broker/CLI, peer credentials, immediate recall with projections unavailable, guarded forgetting, immediate suppression, pending purge |
| `build/pal-motion-check` with local dependency library path | 15 passed, 0 failed |
| `build/pal-ui-check searchAndMemory` with local Qt library/plugin paths and Basic style | 3 passed, 0 failed; native graph inspector included |
| Full `build/pal-ui-check` with the same environment | Final run: 18 passed, 2 failed. `mouseFollowingAcrossOutputs` failed its target-output expectation; `expressiveActing` failed its composer-focus timeout. These desktop interaction checks remain unresolved. An earlier inspector Escape failure was fixed and passed the subsequent focused and full runs. |
| `tools/memory-dependencies.sh local-install` then `check` against isolated native dependencies | Passed with Neo4j 5.26.31 / Qdrant 1.19.1 across stop/start: replay, revision gaps, historical correction, erasure, generation isolation, vector retirement and cross-generation deletion |
| Cloud extraction v2 five-case evaluation | 5/5 expected predicates with exact quotes; this is not a production accepted-assertion precision estimate |
| Publication scan | No credential-shaped tokens or private keys found in publishable source; runtime/build data excluded by Git ignore rules |

The full UI command was:

```sh
LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins" \
QT_QUICK_CONTROLS_STYLE=Basic ./build/pal-ui-check
```

Machine-local evidence logs are `/tmp/pal-publish-tests.log`, `/tmp/pal-publish-memory-tests.log`, `/tmp/pal-publish-build.log`, `/tmp/pal-publish-install.log`, `/tmp/pal-publish-installed-smoke.log`, `/tmp/pal-publish-motion.log`, `/tmp/pal-publish-inspector.log`, `/tmp/pal-publish-ui-final.log`, and `/tmp/pal-publish-adapters.log`. These are historical local paths, not artifacts downloadable from GitHub. Reproduction commands and aggregate evaluation results are committed; private state and credentials are not.

## Outstanding reference-design gates

1. The 70-case corpus now has two runners (see [evaluation](evaluation.md)). The disposable 100k-row SQL microbenchmark applies one eligibility predicate to every route and calls the engine's `rrf` and `relationalRank`. Relational recall@10 was 100% in every mode, so the ranker showed no improvement over vector-only (0.0 points, gate failed); the synthetic fact text repeats each query. The canonical-engine runner, `benchmarks/memory/canonical-run.ts`, passes its eligibility, temporal-view, abstention and integrity gates, and its ranker-improvement gate also fails at 0.0 points. Production canonical retrieval with real embeddings and complete Neo4j/Qdrant service integration still needs the representative performance/quality evaluation. No production throughput, VRAM, or end-to-end latency claim is made.
2. The five-case v2 cloud result improved on the preserved v1 60% baseline, but the 95% precision gate for **accepted production assertions** has not been established on a sufficiently representative held-out corpus. The 50-statement EV-01 evaluation of 2026-10-16, run through `Canonical.remember`, accepted nothing from `glm-5.3-flash:cloud` or `nemotron-3-super:cloud`, because both marked every effective time uncertain, and 8 of 8 correct from `gpt-oss:20b-cloud`; the gate stays unmeasured for the first two and is too small a sample to establish for the third (see [evaluation](evaluation.md)). Once the owner decided that a grounded statement naming no time may be accepted, a rerun of `glm-5.3-flash:cloud`, now the default, accepted 32 proposals, all correct, which passes the gate on that synthetic sample of 32; its predicate precision (88.9%) still fails. Ambiguous natural-language effective dates remain reviewable candidates; structured corrections are the tested path.
3. A conversation can be bound to a project task: what is said there is linked to it and comes first in that conversation’s recall, task scope is validated, and finishing the task ends the binding (`tests/task-binding.test.ts`). The inspector lists identity decisions with their witness and undoes them. Identity decisions take effect in recall without rewriting records: unreverted “same” links join entities into one recall class for anchors and graph expansion, “not same” links prevent a join, and reverting a decision restores the previous classes. These responses report `applied: true`; “possible” remains a review note and reports `applied: false` and `recorded_only: true` (`tests/memory-curation.test.ts`, `tests/review-memory.test.ts`). Project-specific versus inherited-scope precedence needs its complete acceptance fixture.
4. Compositor-to-Kitty mapping by window and process (several instances), lock and suspend handling, editor events and durable workspace history are implemented, off by default, and covered by `tests/collectors.test.ts`, which runs real Vim and a Neovim stub. Live acceptance against the owner’s Kitty, an editor in daily use and a real suspend is not recorded. Without workspace history, desktop observations remain transient; unknown context must not be treated as a verified working directory.
5. Strict end-to-end deadlines, all intermediate hydration quotas, comprehensive policy revocation/intake behavior, repeated-source independence, and all required M01–M36 failure combinations need further validation. Existing passing fixtures do not certify the entire matrix.
6. The two desktop UI failures above are from that run. Current full-suite UI results are recorded in [VALIDATION.md](../../VALIDATION.md). Local build/package success and the focused memory inspector test do not replace those checks.

Memory is opt-in, and its README labels these limits. Publishing this source is separate from enabling collectors or restarting an installed user broker. This work staged an installation and exercised disposable dependency services; it did not replace or restart the user's installed PAL application.
