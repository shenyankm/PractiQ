# Python shared-option validation

## Change

`contracts.validate_question_tree` previously serialized every shared-option
child's complete question and its owner's option pool again for each child.
Choice-reference validation only reads the child's `choiceVariant` and the
owner's options. Pass those fields directly and serialize each used owner's
pool once per validation call. The local map is discarded on return: no
cross-request cache, new dependency, schema or public API change.

All callers retain the same shared validator, including result/parse validation,
question finalization and duplicate-tree checks. Ancestry checks, owner scope,
single-choice restrictions, missing/invalid references, answer-label
normalization, exclusive pools and review/material flags remain in place. The
helper does not mutate option dictionaries, and this validator does not change
owner options during a call. No source recognition, model, budget, credential,
queue, checkpoint or artifact behavior changes.

## Measurements

Baseline `a492117f8c9a4fc4de2b24a44dd4cbd4ed2ba69d`, CPython 3.14.7, macOS arm64.
The [raw report](../../../server/reports/python-shared-options-performance.json)
retains samples and probe/function hashes. The benchmark loads only the selected
baseline function from local Git, using the same current schema classes. It
alternates before/after, after/before, before/after; each version/operation/case
has one warmup and seven samples per pair (21 measured samples). GC is enabled.
No other local test/build in this session overlaps the retained measurements.

Fixtures pass the actual `DocumentParseResult` schema. Each word bank has 20
options and permits answer reuse. Each child has 20 supplied text content blocks;
these deliberately exercise rich-content serialization, not typical-document
frequency. The flat 1,000-question control has no shared options. Isolated tree
validation and complete result-model construction are measured separately.
All output hashes match; the source fixture remains unchanged. Setup, patching,
assertions, dumping/hashing output and result destruction are outside timing.

| Fixture | Operation | Before median | After median |
| --- | --- | ---: | ---: |
| One bank, 20 children (21 questions) | Tree validation | 0.457 ms | 0.077 ms |
| Same | Complete result validation | 1.912 ms | 1.533 ms |
| One bank, 100 children (101 questions) | Tree validation | 2.291 ms | 0.336 ms |
| Same | Complete result validation | 9.596 ms | 7.661 ms |
| Nine banks, 100 children each (909 questions) | Tree validation | 20.491 ms | 3.137 ms |
| Same | Complete result validation | 90.188 ms | 72.642 ms |
| 1,000 independent short answers | Tree validation | 0.183 ms | 0.182 ms |
| Same | Complete result validation | 84.294 ms | 85.486 ms |

Shared-option tree medians decrease approximately 83–85%; complete result
validation decreases approximately 19–20%. The flat complete-result control is
1.4% slower, so no improvement is claimed there. These local CPU results do not
establish end-to-end parser speed, production throughput, RSS, storage, HTTP,
worker, checkpoint, Office, Tencent or model latency.

## Validation

The deterministic work-bound regression fails against the baseline because it
serializes entire questions. The candidate verifies two distinct owners and 40
children using only two option serializations, normalized answers, and a second
validation call rejecting changed owner options (no stale cross-call cache).

- Focused composite/schema/duplicate/review regression suite: 94 passed.
- Shared generated contracts: `app/scripts/export-contracts.py --check` passed;
  no generated schema/type changes.
- Ruff and Pyright passed using the service configuration.
- `PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=...` passed: lockfile,
  Ruff, Pyright, evaluation fixtures, all 3,004 tests, 93% coverage, recovery
  probes and wheel/sdist source integrity checks. Disposable PostgreSQL/RabbitMQ
  and model substitutes were used; no real provider calls.
- First attempts are retained: one exposed import-group lint errors (corrected);
  another lacked the checkout's absolute `PYTHONPATH` and failed before tests.
  Neither is counted as a passing verification run.

Local logs remain under ignored
`server/reports/checks/python-shared-options/`. No live model, deployed runtime,
physical-device or native UI acceptance is claimed by this change.

## Reproduction

From the repository root, with the existing Python 3.14+ interpreter:

```sh
PYTHONPATH="$PWD/server/src" python3.14 server/scripts/benchmark_shared_options.py \
  --baseline a492117f --output /absolute/path/report.json
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON=/path/to/python3.14
```

The probe self-checks output equivalence and input stability. Ordinary CI has no
timing threshold. Revert the validator's local option cache/direct field
projection to roll back; no migration or data cleanup is needed.
