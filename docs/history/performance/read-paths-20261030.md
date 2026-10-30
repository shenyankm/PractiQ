# Read-path performance acceptance — October 30, 2026

## Scope and decision

Baseline: `554066175cc464acb47734ef1c3d34dc8d4d1f88`. The requested review had
five recommendations. Four are retained: worker-based chunk planning, typed
HTTP read responses, opt-in metadata previews and cached practice statistics.
Concurrent merge OCR reads were implemented and tested, then removed because
real local-file measurements regressed. That negative result is part of this
acceptance, not a shipped optimization.

No database schema, index, backup format, credential namespace, dependency,
provider concurrency, model-call trigger or unknown-result recovery rule changes.
Source verification, audio redaction and explicit paid-action boundaries remain.
The parser source changes its conservative execution signature: drain unfinished
tasks on their original deployment, or retain that deployment for explicit
recovery. Do not rewrite saved signatures; see
[resume compatibility](../../../server/docs/resume-compatibility.md).

## Evidence and method

Measurements ran on Apple M4 / arm64 macOS with Python 3.14.7 and Node 22.23.2.
Inputs are synthetic. No user database, credentials or paid provider was used.
The raw reports retain all samples, source/probe hashes and output hashes:

- [Service measurements](../../evidence/2026-10-30-read-path-performance/server.json).
- [App summary](../../evidence/2026-10-30-read-path-performance/app.json), with
  [baseline 1](../../evidence/2026-10-30-read-path-performance/app-before-1.json),
  [candidate 1](../../evidence/2026-10-30-read-path-performance/app-after-1.json),
  [baseline 2](../../evidence/2026-10-30-read-path-performance/app-before-2.json),
  [candidate 2](../../evidence/2026-10-30-read-path-performance/app-after-2.json),
  [baseline 3](../../evidence/2026-10-30-read-path-performance/app-before-3.json) and
  [candidate 3](../../evidence/2026-10-30-read-path-performance/app-after-3.json).
- [Rejected OCR candidate](../../evidence/2026-10-30-read-path-performance/rejected-ocr-concurrency.json)
  and its [isolated patch](../../evidence/2026-10-30-read-path-performance/rejected-ocr-concurrency.patch).

The service probe runs three serial before/after pairs, each with one warmup and
seven measured samples. It reuses existing baseline-function and measurement
helpers. Planning clears the source-frame caches before every call. A 5 ms
heartbeat observes event-loop delay; its monitor includes a 1 ms settling wait.
HTTP uses actual FastAPI/ASGI routes with substitute authoritative task/DB reads.
OCR uses temporary local files and real size/hash checks, captures ordered source
evidence, and stops before tree merge. One explicitly labeled workload adds a
controlled 2 ms wait to each read. OS caches are not flushed; GC remains enabled.

The App probe uses three isolated alternating process pairs: before/after,
after/before, before/after. Both checkouts use the same probe and locked
dependencies; normalized `npm ls --all --json` version trees also have identical
hashes, retained in the App summary. Each process runs one warmup and seven measured clear-and-type
sequences per workload. Times below sum React development/JSDOM Profiler render
durations for clearing and typing sixteen characters, including save-state
updates. Full answer-card text, progress and final draft hashes match across all
six processes. Getter counters record noncurrent answer reads without a mock
function in the timed path. Setup, assertions and output hashing are excluded
from the reported render duration.

## Accepted results

### Chunk planning responsiveness

Both ordinary and per-source-unit planning run in the existing drained worker.
No chunk is written before planning succeeds. Regressions check exact spans,
headers, counts, presence hints, chunk bytes, source immutability, worker errors
and cancellation drainage.

| Input | Node median before / after, ms | Maximum heartbeat-delay median before / after, ms |
| --- | ---: | ---: |
| 20 records, about 31k characters | 7.24 / 7.37 | 0.83 / 0.78 |
| 1,000 records, about 1.53m characters | 272.23 / 274.53 | 265.51 / 16.67 |

This is a responsiveness improvement. Total node time and CPU work are not
reduced; the worker has a small scheduling cost. The complete returned plans
have identical hashes.

### Typed detail responses and metadata previews

The detail/preview HTTP routes retain validated Pydantic models. Dictionary
helpers remain available to tools, and export uses the typed detail directly.
Invalid saved question data is still rejected; default HTTP JSON is equivalent.

| Questions | Detail route median before / after, ms | Detail + full preview bytes | Detail + metadata preview bytes |
| --- | ---: | ---: | ---: |
| 20 | 1.23 / 0.94 | 114,955 | 58,075 |
| 1,000 | 35.52 / 20.80 | 5,686,755 | 2,843,975 |

Every synthetic question carries about 2,000 source-text characters. The byte
counts are response-body sizes, not compressed network traffic or browser memory.
The route timings include substitute DB reads and response parsing, so they do
not establish real PostgreSQL or browser latency.

The metadata preview itself is 518 bytes for these resource-free inputs. The API
defaults to the previous complete preview. `include_result=false` omits only the
merged result unit, retaining sources, quality and failures; unmerged partial
candidates remain complete. Web falls back to detail only for a matching
checkpoint, supports older full-preview responses, and still requires a fresh
matching preview for export. Regressions include authentication, invalid query
values, malformed saved content, partial candidates and mismatched checkpoints.

### Practice statistics

Saved status counts and progress now share the existing saved-state memoization.
Only the current draft's contribution changes while typing. Completion-dialog
counts are also reused instead of scanning all drafts while closed. Existing
button memoization, status ordering and submitted/skipped precedence remain.

| Questions / mode | Render median before / after, ms | Noncurrent answer reads per sequence before / after |
| --- | ---: | ---: |
| 20 / practice | 8.46 / 9.89 | 646 / 0 |
| 20 / self-test | 7.42 / 8.55 | 969 / 0 |
| 1,000 / practice | 28.91 / 26.83 | 33,966 / 0 |
| 1,000 / self-test | 26.80 / 24.12 | 50,949 / 0 |

The large cases improve render time by about 7–10%. Small controls are about
1–1.4 ms slower across an entire clear-and-type sequence; this is not a universal
latency improvement. Eliminated repeated reads are the deterministic acceptance
signal. Existing regressions also verify false answers, clearing drafts, saved
updates, navigation, completion and unchanged noncurrent buttons.

## Rejected concurrent OCR reads

The candidate used the existing storage concurrency (four), returned only decoded
evidence text in source order, preserved failed-page barriers and drained workers
on error/cancellation. It added no schema, cache or provider call. A first version
also offloaded each page's decode, which added thread-switching overhead; removing
that extra switch did not establish a local-file benefit.

| OCR workload, about 20 KiB/page | Sequential before / concurrent candidate median, ms |
| --- | ---: |
| 30 pages, real temporary local files | 13.07 / 13.96 |
| 100 pages, real temporary local files | 42.41 / 46.14 |
| 30 pages, same files plus controlled 2 ms/read delay | 105.35 / 35.05 |

Only the controlled-latency case improved. The real-file cases were about 7–9%
slower, so production retains sequential OCR reads. The final service report
includes sequential-vs-sequential controls; those rows are not claimed as gains.
The rejected patch is evidence for an experiment, not an instruction to enable
it. Revisit only with a representative deployed-storage workload and measured
benefit; synthetic waits alone do not justify shipping it.

## Reproduce

Use an existing Python 3.14+ interpreter with locked service/dev dependencies and
no project virtual environment. From `server/`:

```sh
PYTHONPATH=src:. "$AI_PYTHON" scripts/benchmark_read_paths.py \
  --baseline 554066175cc464acb47734ef1c3d34dc8d4d1f88 \
  --output /tmp/read-path-server.json
"$AI_PYTHON" -m pytest -q tests/test_read_path_optimizations.py
```

To reproduce the rejected experiment, use a disposable checkout of this change,
apply the retained OCR patch, then repeat the same service probe. Do not apply it
to a deployment or rewrite saved execution signatures.

Create a detached disposable checkout at the baseline, copy the current
`app/src/ContentPerformance.test.tsx` into its matching location, and install its
unchanged locked App dependencies with `npm ci`. In each checkout's `app/`, run
the following in alternating before/after, after/before, before/after order with
a different output path each time:

```sh
PRACTIQ_BENCH_OUTPUT=/tmp/answer-card-statistics.json \
  node node_modules/vitest/vitest.mjs run src/ContentPerformance.test.tsx \
  -t 'answer-card statistics probe'
```

## Validation and limits

| Check | Local result |
| --- | --- |
| `make verify AI_PYTHON=...` | Passed: lockfile, Ruff, Pyright, evaluation fixtures, 3,491 tests, 93% aggregate coverage, all four recovery probe metrics at 100%, sdist/wheel build and package source/lock integrity |
| `make web-check web-build AI_PYTHON=...` | Passed: 233 unit tests, one opt-in probe skipped; 98.56% line / 90.96% branch coverage; 56 browser tests; static build |
| `npm --prefix app run check:ui` | Passed: types, lint, 502 unit tests; five skipped; 93.78% line / 86.03% branch coverage |
| `npm --prefix app run test:browser` | Passed: all 150 browser tests, including built macOS browser configuration |
| `"$AI_PYTHON" app/scripts/export-contracts.py --check` | Passed; no generated schema changes |
| Focused export, HTTP-error and new planning/read regressions | Passed: 91 tests |
| Paired probes, installed App dependency-tree comparison, local Markdown targets and `git diff --check` | Passed; 63 local link targets checked |

The first full service run stopped at an export test whose `_task_detail` fake
still returned a dictionary. That test waited indefinitely for a later event;
the run was interrupted and its incomplete coverage/recovery reports were not
accepted. The fake now returns the validated model, and its wait has a timeout
and task cleanup. A second export fake and the HTTP-error entry-point fake were
updated too. All 91 focused tests passed before restarting the complete check.
The first report/log remain under `/tmp/practiq-read-path-first-verify-reports/`
and `/tmp/practiq-read-path-first-verify.log` on the validation host; these are not
committed or permanently downloadable evidence.

The focused regressions and paired probes use substitutes; no live Tencent/LLM
quality, production throughput, allocator/RSS, native WebView, hardware audio,
clean-machine install, signing or release acceptance is established. No native
storage or packaging code changed. Hosted CI is separate from local checks.
