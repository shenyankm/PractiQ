# Session and checkpoint performance — November 15, 2026

The [second pass](performance-snapshot-associations.md) optimizes snapshot
association restoration and records the newer final build identity. Results below
describe the first pass.

Follow-up to the [Electron performance audit](performance-desktop.md), based on
clean `main` at `c199fe961b605b08c7c266bf683f88f560997184`.
Two production files change; no dependency, schema, IPC or archive format changes.

## Changes and correctness

`Sessions.session` now canonicalizes each mutable attempt once and reuses that
JSON for both the revision hash and delta comparison. The cache retains immutable
strings and ordinals, with the existing 8 MiB serialized-data admission limit.
The canonical hash bytes, snapshot redaction, current database reads, revision
fallback and immutable snapshots are preserved. This reduces serialization work;
it does not eliminate the linear read of all attempts.

`SqliteCheckpoints.list` builds only the supplied parameterized predicates, making
the existing `(thread_id, namespace, id)` primary-key index usable. A zero limit
returns after input validation, without reading history. Metadata filtering still
precedes the yielded-result limit. The candidate ID list is still materialized:
deletion during iteration must not truncate later matches, and insertions after
the first yield must not enter that iteration. No SQL LIMIT or live cursor was
introduced, and unscoped histories still scan/materialize their candidates.

Four added regressions cover work bounds, canonical bytes with nested/escaped
JSON, favorite changes, session switches, restart/stale-key fallback, the cache
size ceiling, query-plan index eligibility, zero-limit validation, namespaces,
before/metadata filtering and insertions/deletions during generator suspension.
The two work-bound tests fail on the baseline and pass on the candidate.

## Measurement method

The extended `app/scripts/benchmark-performance.ts` compares preserved compiled
baseline/candidate modules in three independent processes per variant, in
AB/BA/AB order. Each workload has one warmup and seven measured calls per process
(21 retained samples per variant). Run benchmarks serially, without project
builds/tests in parallel. Reports record the executable, runtime/CPU, harness hash,
compiled-module hashes, individual samples and output hashes.

New save workloads use 20/1,000-question practice sessions and alternate one
answer through the actual `DatabaseClient` worker. Timing includes request
validation, SQLite transaction, session response and worker-thread messaging.
Outside timing, the harness verifies the complete canonical revision hash, exact
single-attempt patch, unchanged snapshot key and absent snapshot retransmission.
Full-session controls also verify complete snapshot responses and revision hashes.
Cross-variant response hashes normalize random IDs, timestamps, revision keys and
the already-asserted alternating boolean. This excludes Electron renderer/preload,
paint, startup, queue contention, providers and final-package latency.

History workloads contain 100,000 synthetic checkpoints across 100 threads and
two namespaces. Complete tuple hashes match, and passive histories must not
change SQLite's total-change counter. The original ten workloads remain controls.
All profiles are disposable; no user databases or credentials are accessed.

## Results and acceptance

Apple M4, macOS arm64, 16 GiB RAM; Electron's embedded Node 24.22.2. The table
uses medians from `accepted-electron.json`. Each of the three paired processes
improves the 1,000-question save and both scoped history workloads.

| Workload | Before ms | After ms | Interpretation |
| --- | ---: | ---: | --- |
| Save one changed answer in 1,000-question session, worker round trip | 6.996 | 4.499 | 35.7% less |
| Scoped latest checkpoint, 100,000 total records | 2.699 | 0.153 | 94.3% less |
| Scoped history with namespace, before and metadata filter | 2.760 | 0.308 | 88.8% less |
| Validated zero limit | 2.752 | 0.0004 | No history query; candidate time is near timer resolution |
| Twenty-question save control | 0.789 | 0.699 | Small absolute difference; no general small-session claim |
| Complete 1,000-question response control | 12.459 | 12.361 | Essentially unchanged |
| Complete twenty-question response control | 0.350 | 0.341 | Essentially unchanged |
| Unscoped history control | 42.040 | 41.390 | Still scans/materializes the full candidate list |

Ordinary Node 22.23.2 independently shows the 1,000-question save decreasing
9.300 → 5.461 ms (41.3%), scoped latest history 2.767 → 0.176 ms (93.6%), and
filtered history 2.961 → 0.276 ms (90.7%). Its small-session save is 0.021 ms
slower and full 1,000-question response is 0.223 ms slower; no improvement is
claimed for those controls. The original unchanged Electron controls fluctuate
in both directions: sparse association reading is 0.946 ms slower (3.8%), and
large context writing is 18.459 ms faster (10.5%). Their compiled modules are
identical. These are disclosed as control variability, not new optimizations.
All 18 normalized output hashes match across variants in both runtimes.

`make verify` passes: 26 CI guards, contracts, maintainer/UI/worker types, lint,
76 release-tool tests, 916 frontend tests (seven existing opt-in probes skipped),
1,835 backend tests and production renderer build. Backend coverage: 91.12%
statements, 86.24% branches, 91.80% functions, 92.73% lines. Final benchmark
tool changes also pass a separate `check:packaging` and their assert-based probes.

The first `make test-e2e` run has 239/240 browser cases passing and stops before
native smoke. The remaining case was interrupted by this agent writing the two
Markdown reports while Vite was running: report creation at 00:23:00.821–822 UTC
was followed by a second document GET at 00:23:00.857, resetting the learning
page to the initial bank page. The trace records the first successful learning
heading check, then a second Vite connection/React initialization. No application
or test behavior was changed to hide the interruption. After writes stopped,
that case passes three consecutive isolated runs and the entire learning suite
passes all 14 cases. This is complete scenario coverage across runs, not a clean
single-run `make test-e2e` pass. The original failure trace/screenshot is retained.

Separately, `npm --prefix app run test:electron` passes actual Electron sandbox,
IPC, worker/LangGraph flows, practice/grading, ZIP round trips and confirmed
backup restoration. Providers are local substitutes; native dialogs are also
substituted. It does not establish installed-package/manual acceptance.

Generated evidence stays under `app/.build/performance-20261115/`, excluded from
Git: `accepted-node.json`, `accepted-electron.json`, `acceptance.json`,
`source-identity.json`, `verify.log`, `e2e.log`, `browser-recheck-three.log`,
`browser-learning-recheck.log`, `electron-smoke.log` and `first-browser-failure/`.
Earlier measurements and first failures remain available; final conclusions use
only the accepted reports. Final compiled module hashes match the measured build.

## Reproduction and limits

Preserve fresh baseline/candidate `desktop:build` outputs as described in the
[original audit](performance-desktop.md#reproduction). The copied builds must
resolve the same locked dependencies. Choose unused report paths:

```sh
node app/scripts/benchmark-performance.ts BEFORE_BUILD AFTER_BUILD NEW_REPORT.json
ELECTRON_RUN_AS_NODE=1 \
  app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  app/scripts/benchmark-performance.ts BEFORE_BUILD AFTER_BUILD NEW_ELECTRON_REPORT.json
make verify
make test-e2e
```

These are local warm synthetic measurements, with no whole-application speedup
or memory/energy claim. Real providers, cold startup, installed DMG performance,
signing/notarization and remote CI are outside this acceptance. Runtime build
fingerprints remain enforced for unfinished AI tasks; this change does not
automatically replay or migrate them.
