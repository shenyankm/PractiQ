# Ten performance rounds — November 5, 2026

Completed **10 experiments: 7 retained, 3 rejected and reverted**. The initial worktree was clean `main` at `4cdc1b327872d2018444e01ac7e186d1ef468735`; work is on `refactor/performance-ten-rounds`.

The retained production change is limited to `graphs/chunking.py` and `graphs/answer_evidence.py`: source planning/merge, answer proofs, and passive completed-result projection share these helpers. It adds no dependency, persistent cache, schema, API, model call, or automatic retry. The selected scope is service CPU work; App/Web implementations were not changed.

## Per-round acceptance

Each row compares that round against the previously retained state, not against the original source. Values are milliseconds. Negative reductions mean slower candidates. Every pair has equal output SHA-256 values.

| Round | Experiment / selected workload | Before | Candidate | Reduction | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| [1](../../evidence/2026-11-05-ten-rounds/round-01-acceptance.json) | Reuse stripped lines in source-presence planning; 1000 typed | 9.4078 | 8.9778 | 4.6% | Reverted |
| [2](../../evidence/2026-11-05-ten-rounds/round-02-acceptance.json) | Skip table discovery when no tab exists; 1000 typed | 2.0435 | 1.8446 | 9.7% | Retained |
| [3](../../evidence/2026-11-05-ten-rounds/round-03-acceptance.json) | Run item grouping only when requested; 1000 typed | 1.8123 | 1.4605 | 19.4% | Retained |
| [4](../../evidence/2026-11-05-ten-rounds/round-04-acceptance.json) | Serialize the answer payload without the entire question; 1000 typed | 5.8371 | 4.1810 | 28.4% | Retained |
| [5](../../evidence/2026-11-05-ten-rounds/round-05-acceptance.json) | Normalize the expected scalar once; 1000 numeric | 1.2951 | 1.0855 | 16.2% | Retained |
| [6](../../evidence/2026-11-05-ten-rounds/round-06-acceptance.json) | Use string splitting for whitespace-free source lookup; 1500 ascii | 1.5565 | 1.1663 | 25.1% | Retained |
| [7](../../evidence/2026-11-05-ten-rounds/round-07-acceptance.json) | Reuse canonical source parts with an independent deep copy; 1000 partial | 10.5088 | 11.6940 | -11.3% | Reverted |
| [8](../../evidence/2026-11-05-ten-rounds/round-08-acceptance.json) | Skip duplicate fingerprints for trees with an absent quote; 1000 no-quote | 16.3465 | 7.3509 | 55.0% | Reverted |
| [9](../../evidence/2026-11-05-ten-rounds/round-09-acceptance.json) | Use shallow private question copies for tree validation; 1000 typed | 7.2565 | 1.2545 | 82.7% | Retained |
| [10](../../evidence/2026-11-05-ten-rounds/round-10-acceptance.json) | Use string splitting for literal answer normalization; 1500 ascii | 0.5133 | 0.1053 | 79.5% | Retained |

Round-specific controls and boundaries:

- **1:** Unstable small effect across initial and repeated runs; legacy-table cold control initially slowed 4.9%.
- **2:** Legacy table and item-grouping controls retain their original paths.
- **3:** Ordering/matching grouping remains enabled at its existing explicit callers.
- **4:** Reuse the existing StrictModel payload conversion pattern from grading.
- **5:** Only removes repeated normalization for a numeric terminal period; punctuation remains literal.
- **6:** Keep the original absolute-position array and stop after the second source match.
- **7:** Preserving independent proof objects made the candidate slower; no aliased proof shortcut retained.
- **8:** Rejected after error-boundary acceptance. An absent quote could bypass the previous JSON fingerprint rejection of non-finite values in a table `jsonValue`. The focused red regression fails for NaN and both infinities; the candidate was fully reverted.
- **9:** Validator replaces review fields and reads nested content; original questions and lists remain untouched.
- **10:** Whitespace collapses to one ASCII space; Unicode, punctuation, case and answer identity remain covered.

Round 5 had substantial process drift in the unrelated full-answer controls: one baseline process was much slower. Its 59% full-answer median difference is **not** accepted as a speedup. The numeric-only target improved in the initial and repeated measurements; final answer-validation claims below use a separate original-to-final comparison.

## Original source versus final retained source

Fresh isolated processes load both complete source modules before importing their consumers. This avoids comparing old top-level functions against new helper globals. The [complete comparison](../../evidence/2026-11-05-ten-rounds/baseline-to-final.json) includes small, legacy-table, grouped-item, partial-quote, Unicode and no-quote controls.

| Workload | Before median ms | Final median ms | Reduction |
| --- | ---: | ---: | ---: |
| records, 1000 typed | 2.0655 | 1.4814 | 28.3% |
| answers, 1000 typed | 35.2517 | 31.7717 | 9.9% |
| answers, 1000 table | 32.4738 | 29.2360 | 10.0% |
| evidence, 1000 typed | 14.4255 | 12.2910 | 14.8% |
| evidence, 1000 partial | 12.4972 | 11.0664 | 11.4% |
| trees, 1000 typed | 6.9999 | 1.1730 | 83.2% |
| duplicates, 1000 typed | 18.1886 | 12.7826 | 29.7% |
| duplicates, 1000 no-quote | 16.6535 | 10.5580 | 36.6% |
| projection, 20 typed | 7.1909 | 6.4878 | 9.8% |
| projection, 1000 typed | 312.9562 | 288.0061 | 8.0% |

The saved-result projection uses the real `completed_result` → validated merge → answer/source proof → duplicate checks → result/quality construction path with checksum-verified temporary local storage. It verifies unchanged input state and complete output hashes. The final observed median reduction is 8.0% for 1000 questions and 9.8% for 20 questions. Preliminary large-case projection reductions varied from 3.9% to 5.1%. Process ranges overlap, and the first pair is slightly slower for both sizes even in the final comparison. Do not infer a stable general HTTP/read-latency gain or provider/import speedup from these local samples. The narrower answer/source/tree/duplicate CPU improvements reproduce in the final comparison.

Unchanged source-presence/cold-planning controls vary by about 0–4% in the final comparison; no improvement is claimed for them. Legacy-table record discovery is within 1.7%. Round 8 is excluded from the final implementation regardless of its measured speed: preserving existing malformed-JSON rejection takes precedence.

## Method and evidence

- Apple Silicon macOS, Python 3.14.7; exact platform and source/probe SHA-256 values are in each JSON report.
- Three sequential alternating AB/BA process pairs per comparison; one warmup and seven samples per process, 21 samples per side. GC remains enabled. Performance runs completed before the full test suite.
- Fixture creation and output hashing are outside timers. The full-answer case includes defensive question copies and serialization. Projection includes an unchanged-state hash assertion and verified local reads. Frame caches are warm except the explicitly cold planning workload.
- `round-NN.json` files are preliminary measurements. `round-NN-acceptance.json` files are the final replay with one fixed harness. The preliminary projection is separate. All ten candidate patches are retained, including the three reverted experiments.
- [Benchmark harness](../../../server/scripts/benchmark_ten_rounds.py), [focused regressions](../../../server/tests/test_validation_performance.py), and [reproduction instructions](../../evidence/2026-11-05-ten-rounds/README.md).

## Verification

`app/scripts/export-contracts.py --check` and `app/scripts/check-fixtures.py` passed, confirming derived contract parity and committed consumer fixtures. These checks are not native UI acceptance. Final `make verify` passed: **3773 passed, 0 skipped, 93% combined coverage**, 30 evaluation fixtures, Ruff, Pyright, lock consistency, PostgreSQL/RabbitMQ recovery probes, wheel/sdist build and package source/license integrity. All 66 recorded probes passed; recovery, correct-stop, routing and unknown-usage metrics are 100%. The suite took 829.08 seconds and emitted one pytest/JUnit property warning and five asyncio deprecation warnings. The probe report leaves durable hard-crash recovery `NOT_ASSESSED`; controlled recovery percentages do not establish that separate gate. See the [complete log](../../evidence/2026-11-05-ten-rounds/verify.txt), [verification summary](../../evidence/2026-11-05-ten-rounds/verification-summary.json), [probe report](../../evidence/2026-11-05-ten-rounds/probes.md) and [coverage XML](../../evidence/2026-11-05-ten-rounds/coverage.xml).

The first full verification run was intentionally interrupted after discovering the round-8 error-boundary regression. Its incomplete coverage/probe gates failed and are preserved in `pre-rejection-verify.txt`; that run is not acceptance. The final candidate is checked by a fresh complete run.

Initial verification corrections: the new Unicode regression initially used the wrong exclusive-end offset, and an incomplete composite fixture was already marked for review by normal Pydantic construction. Those test expectations were corrected without changing production validation. Pyright caught an optional TypedDict access and invariant dictionary annotation in the new tests; both were corrected. A later typed `ContentBlock` fixture correction is preserved in `verify-fixture-type-failure.txt`; runtime validation was unchanged. The projection preflight initially lacked read-only configuration; the isolated benchmark worker now explicitly enables `AI_READ_ONLY=1`.

## Scope and rollout limits

No real Tencent/model requests, user data access, provider-latency measurements, RSS/peak-memory claims, GUI/WebView/IPC timings, installer acceptance, hosted CI or deployment are assessed by this local record. PR CI and review are separate gates. Legacy tables only test saved-record compatibility; new CSV uploads remain rejected.

Duplicate detection retains its existing JSON fingerprint validation, including for missing source quotes. Shallow copies are safe because its only writes replace `needsReview`/`missingFields`; it does not mutate nested source fields. If that validator later gains nested mutations, update this copy boundary and its immutability regressions.

Parser implementation changes alter the conservative execution signature. Keep the original deployment for unfinished imports and explicit recovery under [resume compatibility](../../../server/docs/resume-compatibility.md); do not rewrite stored signatures or automatically replay uncertain provider work. No running service was restarted.
