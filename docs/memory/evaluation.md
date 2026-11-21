# Memory evaluation and benchmark results

## Desktop 0.1.6 curation

The release starts with curation Off. No model has a shipped qualification for unattended semantic acceptance. A capability probe verifies response format, references and abstention on a synthetic example. An independent held-out evaluation can qualify an exact assessor/adjudicator pair for specific categories. The gate requires at least 300 accepted decisions, observed precision of at least 99%, a 95% Wilson lower bound of at least 97%, hard-category coverage and category-specific precision checks.

### Local model and recall measurements

The synthetic held-out run used the installed Ollama model `hf.co/empero-ai/Qwen3.8-4B-Distill-GGUF:Q8_0`, digest `2f028bd499903c94579b0d0f4db80d12ca81b6d28ce7978867980248d51404e4`, on a disposable profile with cloud access disabled. The run used an 8,000-token input cap, a 2,000-token output cap, a 60-second per-request deadline and a 24-request daily allowance. It consumed 11 requests, 4,912 input tokens and 2,326 output tokens in 138.4 seconds. Price metadata was unavailable. Seven cases received a “supported” verdict. Four of those were correct, giving 57.1% precision and a 95% Wilson interval of 25.0–84.2%. The assessor classified 7 of 11 overall correctly. One invalid citation counted as an incorrect response. Four of six passages labeled durable crossed the value threshold. Those labels measure support and proposed preservation. They do not measure precision of committed semantic acceptance.

The three false support judgments involved an assistant claiming tests passed, a document asserting verification and an indirect report of a release. All three illustrate why source authority is checked independently of model scores. In an earlier run of the same 11 cases the assessor correctly classified seven, returned three invalid citations and exceeded its output budget once. The broker discarded those invalid responses. These source-group-separated smoke cases were reused during development. They are separate from independent release qualification.

A second test ran the real queue, router, SQLite decision writer, expiry pass and erasure registry together. The four sources were a user preference, a project decision, a plan and an assistant report. Automatic mode preserved the plan and the assistant report as candidates. Invalid citations blocked the preference and decision. No claim was accepted, even with experimental acceptance authorized in that disposable profile. Six requests used 4,377 input and 1,533 output tokens. After forcing both the plan and its source past their deadlines, the original passage had zero bytes and its exact 56-byte quoted excerpt was still recallable. Explicitly forgetting the source removed its recall hits, live payload, evidence, statement, assessment, FTS entry and hold. Projection purge was pending with the fixture services offline. Per-request latency is recorded in the report. Cold model-load latency was not isolated on this shared host.

A separate four-fixture ablation reused the same local model for assessment, adjudication and optional reranking. The deterministic simulation retained 36 bytes, and preservation retained 131 bytes by including a SQLite decision and a tentative migration as uncertain. The simulated experimental acceptance pass accepted the formatter preference and SQLite decision. Both substantive passes left a planned migration and an assistant-reported outcome uncertain. The formatter passage ranked first throughout. The SQLite passage went from absent to first with preservation. The value prior and reranker produced no further improvement on those two questions. Reranking took 688 ms and 649 ms, exceeding the default foreground allowance. The checked-in report identifies the simulated policy, the actual model calls and their timings.

The same extraction-free lexical benchmark ran against starting commit `67e54613646efc17575096dafff4552e89b786b0` and the updated canonical store. LongMemEval measured the first 20 oracle questions. LoCoMo measured the first five questions of the first four conversations. Each query was isolated by scope. Recall counts at least one labeled source among the first five canonical results. No answer generation, network inference or relevance tuning was involved.

| Data | Questions | Starting recall@5 / MRR@5 | Updated recall@5 / MRR@5 |
| --- | ---: | ---: | ---: |
| LongMemEval | 20 | 0.90 / 0.552 | 0.90 / 0.552 |
| LoCoMo | 20 | 0.40 / 0.333 | 0.40 / 0.333 |

The versioned report includes SHA-256 digests of the upstream inputs. The source data remain under their respective licenses, MIT for the cleaned LongMemEval distribution and CC BY-NC 4.0 for LoCoMo. [LongMemEval data revision](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f) · [LoCoMo data revision and license](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376)

### Backlog measurements

A disposable canonical database contained 100,000 searchable artifacts and 10,000 unresolved evidence-backed statements on an Intel Core i7-13700HX with Node 26.13.1. The following timings use the application's SQLite entry points. The fixture used synthetic assessment responses. No provider or projection latency is included.

| Operation | Samples | p50 | p95 |
| --- | ---: | ---: | ---: |
| Forecast with 25 displayed records | 5 | 148.3 ms | 200.3 ms |
| Queue 25 candidates | 10 | 5.9 ms | 7.0 ms |
| Claim and build one assessment bundle | 20 | 7.4 ms | 20.5 ms |
| Validate and commit an assessment | 20 | 8.2 ms | 9.0 ms |
| List 25 review rows | 10 | 1.8 ms | 2.5 ms |

The checkpointed database used 208,437,248 bytes. Queueing 250 items and assessing 20 added 262,144 bytes. Process RSS at completion was 177,192,960 bytes. These are single-machine measurements.

### Reproduction and independent qualification

```sh
node benchmarks/memory/evaluate-curation.ts --local-model "$MODEL" 11
node benchmarks/memory/evaluate-lifecycle.ts --local-model "$MODEL" --output "$REPORT"
node benchmarks/memory/evaluate-canonical-curation.ts "$CANONICAL_REPORT"
node benchmarks/memory/curation-scale.ts
node benchmarks/memory/evaluate-long-recall.ts longmemeval "$LONGMEMEVAL_JSON"
node benchmarks/memory/evaluate-long-recall.ts locomo "$LOCOMO_JSON"
```

For independent calibration, supply a JSON request to `cere memory models evaluate --file request.json` with `max_cases` and `corpus`. The corpus schema in `broker/graph-memory/calibration.ts` requires a version, reviewer identifier and labeled cases. Each case supplies a distinct source, project/conversation group, tuning or held-out split, speaker, exact quote, claim or statement, challenge category, expected support and expected action. Local-only is the default. The evaluator rejects overlapping groups, repeated source passages and incomplete held-out selections. It applies the production semantic gates in a temporary database and records aggregate metrics. Enable a route only after checking who labeled the corpus, its category coverage and its measured errors. No independently human-reviewed release corpus was supplied. Native and compatible cloud transports received fixture validation. Their live factual precision remains unmeasured.

### Release verification

The checkout used Node 26.13.1 with SQLite 3.54.1. `npm run typecheck`, `./node_modules/.bin/tsc -p tsconfig.mobile.json --noEmit`, `node tools/mobile-contract.ts --check` and `npm run build` passed. `npm test` passed 998 of 1,004 tests. Five compositor/media fixture tests and the opt-in IndexTTS test skipped. The production-service tests exercised lease cancellation, correction and temporal inspection, user confirmation, invalid reference rejection, cloud denial, source erasure, stale results and restoring a pre-forget backup.

`ctest --test-dir build --output-on-failure` passed 6 of 6. The offscreen Qt desktop run passed 5 checks including setup and teardown, exercising manual model selection, persisted settings and the memory pin/timeline inspector. Run it with `QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check configureMemoryReviewWithoutChangingChat memoryCurationPinsAndTimeline settingsSectionNavigation`. Qt lint exited successfully with warnings. A staged installation passed `python3 tools/check-memory-install.py --root build/memory-0.1.6/stage/share/cere`, including cross-provider recall and erasure with projection backends offline.

[Versioned measurements](../../benchmarks/memory/curation-results-v1.json) · [Operator procedure](operations.md#desktop-016-rollout-and-backlog-preservation)

## Earlier benchmark results

Validation date: 2026-09-29. The checked-in reports contain synthetic identifiers and aggregate measurements only.

## Reproduction

Generate the annotated corpus, type-check the tools, and run both benchmarks:

```sh
node benchmarks/memory/generate-cases.ts
npx tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck \
  benchmarks/memory/*.ts
node benchmarks/memory/run.ts
node benchmarks/memory/canonical-run.ts
node --test tests/review-benchmark.test.ts
```

`run.ts` is a disposable SQL microbenchmark and writes `benchmarks/memory/results.json`. Its workload is rebuilt at `/tmp/cere-memory-benchmark` by default. Set `CERE_MEMORY_BENCH_DIR` to use another private location. Bulk generation uses SQLite `synchronous=NORMAL`; measured correction commits switch to `FULL`. The generated database is not a Cere canonical database.

`canonical-run.ts` is the release check for the memory engine itself and writes `benchmarks/memory/canonical-results.json`. It loads the corpus into a temporary canonical store and evaluates it with `Canonical.retrieve`. Neither runner calls a model or any network service. The regression test replaces `fetch` and fails if either runner calls it.

The corpus in `tests/fixtures/memory/retrieval-cases.json` (schema version 2) contains 70 cases: 10 each for exact identifiers, single-hop relationships, multi-hop relationships, temporal changes, historical views, interrupted tasks, and contradiction/abstention. There are 35 development and 35 held-out cases. Twenty questions require relationship paths. Every case records its source timeline, eligible scope, world time, knowledge revision, expected facts, required assertion/evidence IDs and paths, forbidden facts, abstention decision, repeated sources, and any deletion or policy change. The temporal cases carry an actual correction timeline. Each temporal change adds pre-change and old-knowledge views, and each historical view adds a current-knowledge view. Together with each case's main view, 50 temporal views are evaluated.

Run the separately authorized real extraction evaluation for one model with:

```sh
CERE_ALLOW_CLOUD_EVAL=1 node benchmarks/memory/evaluate-extraction.ts --approve MODEL [--model MODEL] [--digest SHA256]
```

It sends the 50 synthetic statements of `tests/fixtures/memory/extraction-cases.json`, and nothing else, to that model through the local Ollama server, then submits the proposals through `Canonical.remember` in a temporary store. Without `--model` it evaluates the running broker's configured extraction model; `--approve` must name the model, so every cloud model is approved explicitly, and the environment flag prevents accidental cloud execution. Results go to `benchmarks/memory/extraction-results-<model>.json`; the preserved `extraction-results.json` runs are never written. `node --test tests/extraction-eval.test.ts` checks the corpus, the scoring and the canonical pass offline, under the same `fetch` guard.

## Metric status

Both reports mark every gate `passed`, `failed` or `unmeasured`. A metric the workload cannot evaluate is reported as `null` and `unmeasured`, never as a success value.

## 100k SQL microbenchmark

`benchmarks/memory/results.json` is the complete machine-readable result. The run generated 100,000 assertion versions, 10,000 entities, and 10,000 episodes. It builds the corpus timelines as rows: corrections close knowledge intervals, and historical facts are superseded at their recorded revision. Each non-abstaining case also gets one ineligible look-alike of the anchor fact. The look-alikes rotate through six exclusion rules: future-bound, expired, erased, out-of-scope, not-yet-known and disputed. Relationship cases add an expired relation one hop past the first object. Its text shares no query term, so exact and lexical recall cannot reach it and only graph expansion can. Deleted copies, other-scope copies and repeated sources follow the corpus annotations. Synthetic assertion text was 27–72 UTF-8 bytes (mean 41.50). Deterministic hash embeddings used 64 dimensions and are suitable only for repeatable plumbing comparisons.

Machine: 13th Gen Intel Core i7-13700HX, 24 logical CPUs, 31.1 GiB RAM, Linux x64, Node v26.8.2. Generation took 1.595 seconds. The SQLite database was 38,367,232 bytes and process peak RSS was 182,018,048 bytes. GPU/VRAM was not sampled.

| Retrieval mode | Fact recall@10 | Relational recall@10 | Evidence recall@10 | MRR@10 | Temporal views | Unsupported | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vector only | 98.6% | 100.0% | 98.6% | 0.896 | 100% | 0% | 6.66 ms | 9.09 ms | 15.81 ms |
| Exact + lexical + vector (RRF) | 100.0% | 100.0% | 100.0% | 0.892 | 100% | 0% | 6.60 ms | 7.15 ms | 26.75 ms |
| Hybrid + graph (RRF) | 100.0% | 100.0% | 100.0% | 0.889 | 100% | 0% | 6.67 ms | 7.12 ms | 7.42 ms |
| Hybrid + graph + relational ranker | 100.0% | 100.0% | 100.0% | 0.889 | 100% | 0% | 7.01 ms | 7.51 ms | 7.68 ms |

Every route and the final top 10 pass through one eligibility predicate: scope, erasure, status, knowledge interval, world interval and expiry. The final selection is rehydrated and deduplicated by fact before it is scored. Unsupported-claim rate counts any selected fact that is forbidden or ineligible for the view. The fused modes use the engine's `rrf`, and the ranker mode orders graph candidates with the engine's `relationalRank`. Path recall and abstention were 100% in every mode. Estimated tokens, repeated-row merges, and cold/warm timings are in the JSON report. The regression test also runs the workload with eligibility disabled as a negative control, and requires planted rows to raise the unsupported-claim rate and fail its gate.

The relational-recall, unsupported-claim and temporal-view gates passed. The ranker **failed** the gate requiring a five-point relational-recall improvement over vector-only; the difference was 0.0 points. Synthetic fact text repeats the case query, so vector-only already reaches every required fact. This corpus therefore cannot show whether graph expansion or the ranker helps. False merges are **unmeasured** because the SQL workload has no entity resolution. The expected outputs were left unchanged. Production embedding, Neo4j/Qdrant end-to-end retrieval, and a calibrated ranker still need evaluation before release.

Two hundred small `FULL`-synchronous correction transactions measured p50 0.011 ms, p95 0.017 ms, and p99 0.031 ms. This passes the local 100 ms correction target for the synthetic fixture SQL. It excludes the canonical validation/outbox path and is not an end-to-end correction latency claim. Projection catch-up, sustained queues, UI responsiveness, GPU/VRAM, cold model loading, model swapping, and live backend erasure purge remain unmeasured by this workload.

## Canonical-engine corpus run

`benchmarks/memory/canonical-results.json` is the machine-readable result. The runner writes each case through `observeText` and `remember`. Timelines are applied with the `correct` operation, and erased look-alikes are removed with `forget`. It then retrieves each view with the case's anchor entity, known revision and world time. Lexical, anchor and graph recall run through the engine's own eligibility, temporal, conflict and ranking code. No embedding model, Neo4j or Qdrant is involved. The store reached revision 425.

Each non-abstaining case plants one look-alike of the anchor fact: future-bound, planned, erased, out-of-scope, a question-derived proposal, or disputed. The runner also proves that each look-alike is live. A future-bound one is returned for a later world time, and an out-of-scope one is returned in its own scope. Planned, questioned and disputed look-alikes appear as conflicts, and an erased one has no remaining support. All 60 look-alikes met this check.

| Mode | Fact recall@10 | Relational recall@10 | Evidence recall@10 | Path recall | MRR@10 | Temporal views | Abstention | Unsupported | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Relational ranker | 100% | 100% | 100% | 100% | 0.900 | 100% (50) | 100% | 0% | 6.06 ms | 14.57 ms | 20.85 ms |
| Fusion without ranker | 100% | 100% | 100% | 100% | 0.900 | 100% (50) | 100% | 0% | 5.62 ms | 13.07 ms | 23.04 ms |

Integrity fixtures run in a separate store. They check that a positive and negative claim for the same member are both disputed (F-011), and that one extraction batch commits merged and disputed versions (F-012). They also check that a question-derived proposal stays a candidate (F-013), that a child scope resolves an inherited anchor (F-025), and that an uncertain date stays a candidate (F-034). All five hold.

The relational ranker **failed** its improvement gate against fusion without the ranker. The difference was 0.0 points because the corpus graphs are at most two hops deep, with no competing neighbours in the top 10. Accepted-assertion precision on real extraction output and production semantic quality are **unmeasured**. The corpus text is synthetic and anchored by known entity IDs, so this run measures eligibility, temporal and conflict behaviour, not natural-language recall. Latencies are in-process timings on a small store and are not comparable with the 100k workload.

## Natural-language and document-collection baselines

Measured on 2026-10-15 and pinned as floors by the tests named below. Both runners work offline in a temporary canonical store, never call a model or any network service, and report embedding-backed recall as `unmeasured`.

```sh
node benchmarks/memory/nl-baseline.ts
node benchmarks/memory/document-baseline.ts
node --test tests/memory-nl-baseline.test.ts tests/document-baseline.test.ts
```

`nl-baseline.ts` stores 20 preferences, decisions, tasks and facts in everyday wording (`tests/fixtures/memory/natural-language-cases.json`), among 60 filler passages, and asks paraphrased questions without entity anchors. It also plants 3 corrections, 5 questions that should find nothing, 2 look-alikes in another project's scope and 2 forgotten memories.

| Mode | Recall@1 | Recall@8 | MRR@8 | Correction found | Correction ranked first | Abstention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Automatic recall | 0.80 | 0.90 | 0.85 | 1.00 | 0.667 | 0.80 |
| Explicit search | 0.80 | 0.95 | 0.86 | 1.00 | 0.667 | 0.80 |

No other scope's memory and no forgotten memory was returned. Automatic packets stayed at p90 342 estimated tokens and at most 4 items. Correction-first ranking was unstable at first (0.333 or 0.667 between runs), because exactly tied scores fell back to random record IDs; ties now go to the more recently learned record, and the test pins 0.667.

`document-baseline.ts` indexes six project documents into a document collection's own scope with the collection chunker (`tests/fixtures/memory/document-cases.json`) and asks 13 paraphrased questions with the retrieval settings a turn uses (local route, relevance floor, six items), calling the canonical engine directly rather than through the memory worker. Hit@1 is 0.923, hit@3 is 1.0, MRR is 0.962 and abstention on 3 unrelated questions is 0.667. Every returned chunk resolved to its file and content hash, no chunk exceeded its size, a forgotten document returned nothing, and project memory and the collection never answered for each other.

## Real cloud extraction

`benchmarks/memory/extraction-results.json` preserves two actual five-case runs against `gpt-oss:20b-cloud`, digest `9a01793d9ef8de5309f157c06dbcbadfb598001b4a6f13cbc699cdff5042eaae`. The expected labels were unchanged between runs.

The v1 baseline returned five assertions, of which three used the registered expected predicates. Predicate-level precision and case recall were 60%, below the 95% target. The two failures used unsupported predicate names (`PREFERS` and `IS_A_CHECKOUT_OF`) instead of `PREFERS_TOOL` and `CHECKOUT_OF`. Latency was p50 7.354 seconds and p95/max 13.170 seconds.

The v2 prompt and closed ontology schema returned five assertions with all five expected predicates. Predicate-level precision and case recall were 100% on this sample, and all proposals passed the adapter's closed schema and exact-quote validation. Latency was p50 7.749 seconds and p95/max 11.965 seconds. This clears the predicate-level 95% target for this five-case sample and fixes both observed v1 failure modes.

The sample is too small to estimate production-domain quality. The evaluator did not submit these proposals through `Canonical.remember`, so it does not establish canonical accepted-assertion precision or exercise every predicate-specific qualifier and authority rule. Canonical validation remains required, and a larger held-out accepted-precision evaluation remains an unmet release check.

## Extraction through canonical memory (EV-01)

Measured on 2026-10-16 against the three models the next-stage plan named: `glm-5.3-flash:cloud` (configured on the evaluation machine), `nemotron-3-super` (the code default, which the adapter resolves to `nemotron-3-super:cloud`) and `gpt-oss:20b-cloud` (the model of the preserved runs, pinned to their digest). Each run used prompt `cere-extraction-v2` and parser `zod-4-v2`, the production adapter, and the corpus file with SHA-256 `582d3fb61df8a563…`. Results are in `benchmarks/memory/extraction-results-<model>.json`; only the synthetic corpus left the machine.

The corpus `tests/fixtures/memory/extraction-cases.json` holds 50 held-out statements: the five of the preserved runs, at least three for each of the eleven registered predicates (40 statements that hold something to remember, including tool and assistant sources), and 10 that hold nothing (questions, a hypothetical, small talk, an instruction-shaped request, a tool error). Proposals are mapped to claims by `broker/graph-memory/proposals.ts`, the same function the memory worker uses, and submitted through `Canonical.remember` as model proposals in a temporary store, one scope per statement.

- **Predicate precision**: proposals whose predicate is one the statement expects.
- **Proposal precision**: proposals that also match the expected subject (by name, or by type for "I"), object or state value, and polarity.
- **Case recall**: statements with at least one matching proposal.
- **Accepted, candidate, rejected**: what canonical memory did with each proposal. *Held only by the time rule* counts candidates whose single reason was an uncertain effective time, and how many of them matched.

| Model and digest | Extraction failures | Predicate precision | Proposal precision | Case recall | Accepted / candidate / rejected | Time-uncertain proposals | Held only by the time rule (matching) | Statements holding nothing | Latency p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `glm-5.3-flash:cloud` `3e780905abc0` | 3/50 | 41/47 (87.2%) | 38/47 (80.9%) | 38/40 (95.0%) | 0 / 44 / 3 | 47/47 | 33/33 | 5/10, 3 proposals, 0 accepted | 5.0 s / 29.2 s |
| `nemotron-3-super:cloud` `c6398e09afd4` | 2/50 | 39/44 (88.6%) | 38/44 (86.4%) | 38/40 (95.0%) | 0 / 42 / 2 | 44/44 | 33/33 | 6/10, 5 proposals, 0 accepted | 26.9 s / 81.3 s |
| `gpt-oss:20b-cloud` `9a01793d9ef8` | 0/50 | 40/49 (81.6%) | 38/49 (77.6%) | 38/40 (95.0%) | 8 / 35 / 6 | 33/49 | 17/18 | 2/10, 8 proposals, 0 accepted | 6.9 s / 17.9 s |

Gates, as each result file records them:

| Gate | `glm-5.3-flash:cloud` | `nemotron-3-super:cloud` | `gpt-oss:20b-cloud` |
| --- | --- | --- | --- |
| Predicate precision at least 95% | failed (87.2%) | failed (88.6%) | failed (81.6%) |
| Accepted-assertion precision at least 95% | unmeasured (0 accepted) | unmeasured (0 accepted) | passed (8 of 8), on a very small sample |
| No accepted assertion from a statement that holds nothing | passed | passed | passed |

Findings:

1. **The model is not the main obstacle to accepted memory.** The extraction prompt tells every model to leave the interpretation empty and mark the time uncertain when a statement has no effective date, and the worker maps an uncertain time to `time_precision: approximate`, which `Canonical.remember` always keeps as a candidate when the claim is a model proposal. `glm-5.3-flash:cloud` and `nemotron-3-super:cloud` marked every proposal that way, so nothing they proposed could be accepted. Of their candidates, 33 each were held back by that rule alone, and all 33 matched the expected assertion. This is a counterfactual for an owner decision about undated statements, not a measurement of accepted precision. `gpt-oss:20b-cloud` marked 33 of 49 proposals uncertain; the other 16 went through the full rules, and the 8 it accepted were all correct.
2. **The prompt does not list the registered HAS_STATE values** (`open`, `blocked`, `running`, `proposed`, `authorized`, `succeeded`, `failed`, `cancelled`, `closed`, `unknown`). Paraphrased states such as "done" are rejected as unregistered (3, 1 and 1 proposals respectively). Other rejections were entity or literal type mismatches (1 for `nemotron-3-super:cloud`, 3 for `gpt-oss:20b-cloud`) and 2 unregistered qualifiers from `gpt-oss:20b-cloud`.
3. **Statements that hold nothing were never accepted.** The models abstained on 5, 6 and 2 of the 10; every proposal they did make there was held as a candidate or rejected.
4. **Latency matters in production.** The memory worker gives extraction 45 seconds. At that limit, 8 of 50 `nemotron-3-super:cloud` calls (16%) would have failed, against 1 for `glm-5.3-flash:cloud` and none for `gpt-oss:20b-cloud` (maximum 34.9 s). The evaluation allowed 120 seconds. `glm-5.3-flash:cloud` and `nemotron-3-super:cloud` also returned invalid structured output after one repair attempt for 3 and 2 statements.

The live store agrees. A `VACUUM INTO` copy taken on 2026-10-16 (counts only, deleted afterwards) had 96 accepted assertions, none from extraction, and 35 candidates, all from `glm-5.3-flash:cloud` runs: 34 instrumented `HAS_STATE` claims from tool output and one inferred `WORKS_ON` claim. Every one had an approximate time; every one was also ungrounded in the quoted span (28 without the subject, 6 with quotation marks in the sentence, 1 without the value).

Recommendation for the default model: do not keep `nemotron-3-super` as the code default, since about one call in six would time out. The choice between the other two depends on an owner decision about undated statements. Under the current rule, only `gpt-oss:20b-cloud` produces accepted memory (8 of 8 correct), at the lowest predicate precision. If a grounded, undated statement may be accepted, `glm-5.3-flash:cloud`, the configured model, is faster at the median and more precise, and its 33 correct, time-held proposals would become eligible. Either way, rerun this evaluation after a change to the prompt or the time rule. The samples are small, the statements synthetic, and cloud aliases can change behind the same name, so the recorded digests identify what was measured.

## Undated statements and the new default (EV-01 follow-up)

On 2026-10-16 the owner decided the two questions above: a grounded statement that names no time may be accepted, and the code default moves to `glm-5.3-flash:cloud`. When the model marks a time uncertain without stating one, as the prompt asks for an unknown date, extraction now records unknown validity and unknown precision, with no bounds, instead of an approximate time. Only a time that was stated but not resolved is approximate, and that still holds a proposal for review (F-034). The grounding, source, modality and epistemic rules are unchanged, and `Canonical.holdReasons` is now the one rule that `remember`, re-adjudication and this harness apply. Recall shows an accepted claim of unknown validity as an uncertain claim, never as a settled fact or at a historical time. The prompt (`cere-extraction-v2`) and parser (`zod-4-v2`) are unchanged.

`glm-5.3-flash:cloud` was then run again at the same digest on the same corpus, with owner approval; only the synthetic statements left the machine. The rerun replaced `extraction-results-glm-5-3-flash-cloud.json`; the first run's file is in commit `fa1e763`.

| `glm-5.3-flash:cloud` `3e780905abc0` | First run | Rerun with undated statements accepted |
| --- | ---: | ---: |
| Extraction failures | 3/50 | 4/50 |
| Predicate precision | 41/47 (87.2%) | 40/45 (88.9%) |
| Proposal precision | 38/47 (80.9%) | 37/45 (82.2%) |
| Case recall | 38/40 (95.0%) | 37/40 (92.5%) |
| Accepted / candidate / rejected | 0 / 44 / 3 | 32 / 11 / 2 |
| Accepted and correct | none accepted | 32 of 32 |
| Held only by a time rule (matching) | 33 (33) | 2 (2) |
| Statements holding nothing | 5/10 abstained, 3 proposals, 0 accepted | 6/10 abstained, 3 proposals, 0 accepted |
| Latency p50 / p95 / maximum | 5.0 s / 29.2 s / 50.2 s | 5.9 s / 32.4 s / 35.8 s |

Gates of the rerun: predicate precision of at least 95% **failed** (88.9%); accepted-assertion precision of at least 95% **passed** (32 of 32, a small synthetic sample); no accepted assertion from a statement that holds nothing **passed**.

The model still marked every time uncertain (45 of 45), as the prompt asks, and no proposal it gave no time was held for that. Two correct proposals stay candidates only because the model recorded a time for them, which the results do not keep: ext-07 ("These days I mostly work on the Quill project.") and ext-34, whose sentence names no time. The other candidates are ungrounded proposals (questions, a hypothetical, two polarities that differ from their sentence, a missing subject or cue), assistant statements and inferences. The two rejections are `HAS_STATE` values that are not registered, for ext-29 ("stuck until") and ext-35 ("is complete"): finding 2 above, which this change does not address. No call exceeded the worker's 45-second limit. Output varies between runs of the same model, so the two columns differ by more than the rule.

### Pending live candidates

A `VACUUM INTO` copy of the live store taken on 2026-10-16 (deleted afterwards) had 35 pending extraction candidates, all from `glm-5.3-flash:cloud`, all stored as approximate times with no stated time. A dry run of the re-adjudication that `cere memory readjudicate` performs (`Canonical.readjudicate`) on the copy accepted none and rejected all 35, none for its date: every one is ungrounded. Thirty-four are `HAS_STATE` claims proposed from Cere's own action-event records; their quoted fragment lacks the subject (27) or the value (1), or their sentence contains quotation marks (6). The other is a user's instruction proposed as an inferred `WORKS_ON`, whose quotation lacks the subject. Three of the 35 are also not actual (inferred, reported and planned). A full run on a second copy made the same decisions and passed SQLite's integrity check. The live store has not been re-adjudicated: that needs the new broker installed, and [VALIDATION.md](../../VALIDATION.md) records the steps.
