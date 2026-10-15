# Web and service performance review, 2026-10-15

Baseline: `ef14a31c92c9a31751e089b2893d52c2bd562ff0`. Changes are on
`sheny/web-server-performance`. No dependency, public API, schema or model-prompt changes.

## Scope and assumptions

Reviewed the independent Web importer and service's main execution and read paths.
The deployment remains one Uvicorn/LangGraph process with PostgreSQL, RabbitMQ,
local verified storage, bounded model concurrency, and at most 1,000 final question
nodes. This is a flow-based performance review, not a claim that every source line
or every production workload was profiled.

| Area | Code inspected and conclusion |
| --- | --- |
| Web entry, connection, polling and actions | `App.tsx`, `api.ts`: memory-only credentials, explicit mutations, visibility-aware polling, completed-head reuse and cursor pagination already exist. Retained these safeguards. |
| Web result rendering and search | `ResultReview.tsx`: 20-record pages, collapsed questions, memoized Markdown and lazy raw JSON already bound rendering. Shared option searches repeated the same work for each child; optimized below. |
| Accounts, checkout and downloads | `AccountPanel.tsx`, `Purchase.tsx`, `api.ts`: ledger/order reads are explicit and paged; payment mutations retain request IDs. Large ZIP buffering remains a follow-up candidate. |
| HTTP, authentication and artifact reads | `webapp.py`, `auth.py`, `middleware.py`: authenticated bounded inputs and task ownership remain in place. Artifact membership repeated reference serialization; optimized below. |
| Task detail, preview, history and export | `task_api.py`, `database.py`, `bank_export.py`, read-performance tests: cursor pagination, batched checkpoint-head reads, bounded preview reads, temporary-file ZIPs and single-export admission already exist. No persistent result cache added. |
| Parsing and final merge | `graphs/document.py`, `chunking.py`, `review.py`, `vision.py`: page-input reuse, bounded work, complete-tree handling and source evidence remain unchanged. Duplicate detection repeatedly scanned unrelated associations; optimized below. |
| Extractors and Office | PDF/CSV extractors, isolated worker, `normalization.py`, Office worker: native resource bounds, process isolation and verified normalization are retained. PDFium's thread-safety lock is intentional. |
| Runtime, model calls and accounting | `runtime.py`, `messaging.py`, `capacity.py`, `execution.py`, `llm.py`, `grading.py`, `saas.py`, checkout queries: ownership, delivery receipts, rate limits, frozen integer prices and unknown-usage recovery must not be bypassed for throughput. |
| Build and deployment | Web package/Vite settings, `Dockerfile.server`, Compose quotas and Make targets: lazy result-review loading and WOFF2-only KaTeX assets already exist. No extra workers or dependency changes. |

## Implemented changes

1. **Search each shared option array once per query.** Reject non-review entries
   early, check question text first, then reuse the shared option match. The map
   lives only for that filter evaluation; changing the query, preview or result
   recomputes it. Case-insensitive matching, local option ownership, nulls,
   result counts and review-only filtering are preserved.
2. **Index duplicate-detection associations once.** Find whole trees first.
   Groups crossing tree boundaries or containing invalid members exclude only
   their affected trees, as before. Once all trees are excluded, return immediately.
   Otherwise index groups and visuals by question, preserving association order
   and tree-local positions used in evidence hashes. Candidate detection does not
   remove records; removal still requires the existing explicit opt-in.
3. **Serialize artifact membership metadata once per traversal.** Every nested comparison uses
   the same four reference fields. Account/task ownership, source namespace,
   exact reference membership, verified storage reads and `no-store` responses
   remain required. This adds no cross-request artifact cache.

The first association-index implementation regressed dense cross-tree groups
(a one-shot local probe rose from about 13 ms to 419 ms). It was replaced before
acceptance by the tree-exclusion approach above. The retained benchmark includes
unassociated, per-question and dense cross-tree inputs, rather than only the
favorable workload.

## Measurements

Service measurements are in [the JSON report](../server/reports/web-server-performance-20261015.json).
The script loads the two original function bodies from the selected local Git
baseline, runs them against the current unchanged helpers and the same inputs,
warms both versions, and records five samples per case. All result lists or
response bytes must match their expected values; the JSON retains output hashes
and the [acceptance summary](../server/reports/web-server-performance-20261015-acceptance.json)
records source hashes. Fake task/storage reads exclude database and network latency.
Final CPU timings disable cyclic garbage collection only in the benchmark process,
as Python's `timeit` does. This does not change the service's garbage collector.

| Workload | Before median | After median | Result |
| --- | ---: | ---: | --- |
| 100 questions, no associations | 1.707 ms | 1.739 ms | No useful gain |
| 100 questions, 100 local groups and visuals | 3.163 ms | 1.989 ms | 1.59x |
| 100 questions, 100 cross-tree sections | 0.768 ms | 0.690 ms | 1.11x |
| 1,000 questions, no associations | 17.261 ms | 18.313 ms | 1.052 ms slower, 6.1% overhead |
| 1,000 questions, 1,000 local groups and visuals | 116.407 ms | 21.449 ms | 5.43x |
| 1,000 questions, 1,000 cross-tree sections | 13.078 ms | 6.906 ms | 1.89x |
| Artifact membership, 100 questions x 20 options | 2.371 ms | 1.059 ms | 2.24x |
| Artifact membership, 1,000 questions x 20 options | 22.082 ms | 10.072 ms | 2.19x |

The added association setup has a small cost when there are no associations. It
is accepted here for the larger measured reduction on associated inputs; this is
not a universal parser speedup. The [GC-enabled serial run](../server/reports/web-server-performance-20261015-gc-enabled.json)
is also retained. Its unassociated 1,000-question samples were noisy (25.417 ms
before, 59.233 ms after), so they are not silently substituted for the controlled
CPU results. Neither run is a production-latency claim.

The Web regression uses one material parent, 999 children and 100 shared options.
Before the change, one missing-keyword search accessed option content **100,000**
times. Afterward it accesses it **100** times. The Chromium production-build check
repeats five distinct searches and requires `[100, 100, 100, 100, 100]`, with no
model-start request. This is a 99.9% reduction in option scans, not a 1,000-fold
claim about total UI latency.

The [browser summary](../server/reports/web-server-performance-20261015-browser.json)
retains the five measured counts, full-suite totals and source/report hashes.
The regression first failed on the baseline implementation before production code
was edited; its first failure reported `100000` accesses against a bound of `100`.

## Acceptance

| Check | Final evidence |
| --- | --- |
| Full service suite | 2,635 passed, 0 failures/errors/skips; 542.8 seconds |
| Service coverage | 94.69% lines, 89.89% branches; combined coverage exceeds the required 90% |
| Fault probes | 61 passed; all four scored probe rates are 100%. The separate `durableCrashRecovery` aggregate remains `NOT_ASSESSED`; do not infer a production recovery guarantee. |
| Service static/fixtures | Locked dependency consistency, Ruff, Pyright and 33 evaluation fixtures passed |
| Service packaging | Wheel and sdist built; package checker verified 39 source files and source/lock/license integrity |
| Web | Locked install, TypeScript, lint, 86 tests, coverage and production build passed; line coverage 97.72% |
| Browser | 27 production-build Chromium checks passed, including five shared-option searches, uploads, partial review, explicit controls, image/ZIP checks, checkout, and rich-content layouts |
| Visual review | Inspected desktop light and narrow dark review screenshots; browser suite also covers 390/1280 rich-content layouts. Generated screenshots remain under ignored `web/test-results/browser/`. |

The full `make verify` invocation first exited with `PROBE_FINGERPRINT_MISMATCH`
after every test had passed: a benchmark-script metadata field was edited while
the suite ran. That edit was reverted. Current service source, scripts and tests
then exactly matched the suite's recorded fingerprint:
`0678ff46deb93c96ba5db4f57b6619a562f3f8a02a8a8f10c9e6633a1704d986`.
Probe scoring was rerun into a fresh `probes-performance-final.json` and passed;
Ruff/Pyright and package gates also passed separately. The original blocked report
was retained. The original Make invocation itself is not reported as exit-zero.
The [acceptance JSON](../server/reports/web-server-performance-20261015-acceptance.json)
keeps this distinction and the exact source hashes.

### PR #241 CI follow-up

The first remote [Service quality run](https://github.com/shenyankm/PractiQ/actions/runs/38717793880/job/116364698156)
failed only the new browser comparison-count assertion: all five searches produced
200 comparisons instead of the expected 100. Its 86 component/API tests and the
other 26 browser scenarios passed. CI's `make web-check` uses Vite's development
server, where the existing React StrictMode repeats the memo calculation; the
earlier local browser acceptance used a production build.

The browser test now uses the same `PRACTIQ_WEB_BUILT` mode selection as Playwright's
server configuration: exactly 200 comparisons in development and 100 in production,
for each of five searches. This retains the bounded-work assertion and zero-model-start
check in both modes. No production code or server code changed in this follow-up.
The original benchmark and acceptance files above remain historical records of
the original run; [follow-up evidence](../server/reports/web-server-performance-20261015-ci-followup.json)
records the updated test source and both browser modes.

The [next Service quality run](https://github.com/shenyankm/PractiQ/actions/runs/38718534220/job/116367136563)
passed Web checks, `make verify` (2,628 passed, 7 native-build-guard skips because
the service job lacks pinned Rust 1.98.1; 967.4 seconds
for pytest), probe scoring, packaging and dependency audit. Its combined job
exhausted the 20-minute budget while building the image: service verification
finished at 10:31:20 UTC, image construction began at 10:31:25 UTC, and cancellation
occurred at 10:32:20 UTC. The job budget is now 30 minutes to leave room for the
required image build after the measured test work. No check or service/model
timeout was removed or relaxed. Desktop and Android final gates passed on that
head; the new head must receive its own CI results. The existing workflow/scope
regressions also passed locally: 155 tests. GitHub's job annotation explicitly
reported `The job has exceeded the maximum execution time of 20m0s`.

## Follow-up candidates requiring separate measurement

| Candidate | Concrete trigger and smallest next experiment |
| --- | --- |
| Browser ZIP memory | `exportBank()` keeps streamed chunks, assembles a contiguous byte array, then creates a Blob. Near the 300 MiB bound, measure browser peak memory and cancellation before replacing the contiguous assembly with a bounded Blob path. Blob copying differs by browser; no memory-reduction number is claimed here. |
| Large account ledger | `saas.ledger()` filters by account and orders by descending ledger ID. Existing uniqueness on account/kind/reference does not provide that order. Measure `EXPLAIN (ANALYZE, BUFFERS)` with representative account history before adding an `(account_id, id DESC)` index and its initialization/upgrade checks. |
| Artifact snapshot reads | Each image request still reads preview and detail and traverses saved content. Profile their database, validation and traversal shares before changing snapshot reuse. Any reuse must remain task/account scoped and invalidate on checkpoint changes. |
| Remaining merge CPU | Question validation, evidence hashing and JSON construction still take time even without associations. Profile representative documents before moving more work across threads; preserve validation's review flags and cancellation/storage boundaries. |

## Reproduce

Use an existing Python 3.14+ interpreter; no project `.venv` is needed.

```sh
export AI_PYTHON=/path/to/python3.14
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON="$AI_PYTHON"
make web-install web-check web-build
PRACTIQ_WEB_BUILT=1 npm --prefix web run test:browser
cd server
AI_READ_ONLY=1 AI_SERVICE_TOKEN=benchmark PYTHONPATH=src:. "$AI_PYTHON" \
  -c 'import gc, runpy; gc.disable(); runpy.run_path("scripts/benchmark_web_server.py", run_name="__main__")' \
  --baseline ef14a31c \
  --output reports/web-server-performance-20261015.json
```

The explicit `PYTHONPATH` lets checkout scripts import the local package when the
installed editable-package registration is unavailable. It does not change runtime
configuration. Run benchmarks without concurrent verification for comparison.

## Limits and deployment

The original local acceptance included no paid model calls, live extraction-quality
evaluation, production load test, remote CI, Docker image build or deployment. These CPU improvements
do not establish overall import latency, provider throughput, model accuracy or
maximum concurrent capacity. Chromium checks use fake HTTP data; they do not
establish physical-device or other-browser acceptance.

Parser source changes alter the existing execution code signature. Old unfinished
tasks must use their original deployment to resume, or the user must explicitly
create a new parse task. Do not erase checkpoints or weaken signature validation.
No service restart or task migration was performed. Publication is separate from deployment.
