# Electron performance audit — November 14, 2026

The current Electron/Node implementation has four retained improvements in three
production files: indexed scoped reads, indexed association attachment, reused
association INSERT statements and bounded mixed-group subset calculation. No
schema, index, archive format, dependency, IPC field or provider policy changes.

Baseline: clean `main` at `d7c05fecafcbe9a41f7feabd43e498a0c6d7a588`.
The benchmark uses preserved baseline/candidate compiled modules, rather than
measurements from the retired Rust/Python runtimes. Raw local evidence is under
`app/.build/performance-audit/`; these generated reports stay out of Git.

## Scope and decisions

| Area | Finding and decision | Evidence / next acceptance |
| --- | --- | --- |
| Selected question/bank reads | **Implemented.** Optional `OR` predicates obscured indexed scopes. Construct only the supplied parameterized predicates, retaining recursive descendants, order and empty-selection behavior. | `readQuestions`; complete row hashes, cross-bank/empty/missing-root regression, detail/edit/paper/export/restore coverage. |
| Group/visual attachment | **Implemented.** Every association scanned all loaded rows and checked a reference array. Reuse an operation-local ID map and visit referenced rows directly. | 2,000 selected questions, 1,000 two-question sections and 1,000 two-question visuals; unchanged ordered output. Document visuals remain bank-scoped and `documentOnly` stays hidden. |
| Import associations | **Implemented.** `putContext` compiled identical INSERTs for every reference. Prepare each statement once within the operation. | 500 questions, 100 sections and 20 visuals: 60,000 associations, source/warning/diagnostic checks and no foreign-key violations. Transaction ownership, validation and error propagation stay with existing callers. |
| Mixed group counts | **Implemented.** The subset loop processed every repeated weight up to the 1,000-question cap. Count equal weights and process binary bundles capped at usable multiplicity. Keep the existing uniform-weight fast path. | Exhaustive subsets for 128 deterministic inputs, zero/oversized weights, late odd group, 1,000 cap, unchanged input and full `queryQuestions` statistics. |
| Repeated session responses | **P2, profile next.** `Sessions.session` reads/parses all mutable attempts and canonicalizes them even when transmitting a delta. `context` rebuilds an ID map per answer. Existing document/attempt caches already avoid some work. | Measure 20/1,000-answer draft writes through actual IPC, response bytes, database-worker queue delay and cache invalidation after grading, favorite updates and restoration. No global mutable snapshot cache added. |
| Checkpoint history | **P2, feasible follow-up.** `SqliteCheckpoints.list` materializes all matching IDs before applying its limit. | Compare long histories and metadata filters. SQL LIMIT is safe only when it cannot discard later metadata matches; preserve ordering, namespace/before semantics and generator consistency. No unmeasured change retained. |
| Passive partial import views | **P2, profile next.** Stopped-task detail can rebuild partial results and read/verify multiple immutable artifacts; preview then reads review units again. | Count bytes/hash/parse operations for repeated `detail`/`preview` with 1/100/1,000 completed units. Prefer request-local reuse; prove task/checkpoint ownership, stale-generation rejection and damage detection. Never bypass checksum/reference validation. |
| Model unit scheduling | **P2, experiment separately.** Text structuring uses bounded batches and waits for the slowest unit before starting the next batch. | A rolling queue may reduce idle capacity under unequal latencies. First prove allocation order, cancellation/draining, unknown-call fencing, budgets and successful-unit reuse with controlled provider substitutes. No concurrency or paid-call change made. |
| PDF/image/Office preparation | **Keep current bounds.** One shared preparation slot, worker termination, byte/pixel/page/time limits and transfer lists already constrain expensive native work. | Profile peak RSS and event-loop delay with large PDFs/XLSX before changing capacity. Office visibility and CRC validation remain mandatory. No new local parser/fallback. |
| Assets, ZIPs, backups | **Keep durability and validation.** Resource checks are deduplicated within `markMissing`; ZIP output uses lazy streams with checksums and bounded publication. Full backup/restore validates immutable history. | Large-media RSS and whole-operation export/restore timing remain useful follow-up measurements. Do not remove fsync, CRC, media validation or recovery fencing to improve a microbenchmark. |
| Renderer | **Existing work bounds retained.** Pages are lazy-loaded; Markdown is memoized; raw records/materials/images load on demand; draft/status work has dedicated regressions. | Run all seven opt-in probes and browser/native workflows. Bundle sizes alone do not establish cold startup, input latency or layout cost; no speculative memoization, virtualization or new dependency added. |
| Startup and packaging | **Measure before changing.** AI worker creation is lazy. Practice database validation and recovery checks protect startup writes. | Current-source cold/warm launch, idle RSS, power use and final DMG need separate controlled measurements. No claim of startup/package-size improvement. |

## Paired measurements

macOS arm64, Apple M4, 16 GiB RAM. Both ordinary Node 22 and Electron's embedded
Node were exercised. The representative table below uses embedded Node 24; the
report records exact runtime versions and compiled-module hashes.

Each variant runs in three independent processes in AB/BA/AB order, with one
warmup and seven measured calls per workload/process: 21 retained samples per
variant. Fixtures, assertions and output hashing are outside the timed section.
All ten complete output hashes match across variants and processes. Major target
improvements repeat in each of the three pairs.

| Workload | Before median ms | After median ms | Change |
| --- | ---: | ---: | ---: |
| Two-node detail in 27,002-node database | 1.773 | 0.248 | 86.0% less |
| Two-node bank in the same database | 1.791 | 0.213 | 88.1% less |
| Twenty selected details | 2.555 | 0.343 | 86.6% less |
| Complete statistics for 27,000 nodes | 64.103 | 44.685 | 30.3% less |
| 10,000 mixed weights, count kernel | 7.929 | 0.125 | 98.4% less |
| 60,000 import associations | 327.505 | 150.236 | 54.1% less |
| Read 2,000 rows with sparse sections/visuals | 70.250 | 23.102 | 67.1% less |
| Small import control: 20 rows / two sections / one visual | 0.638 | 0.507 | 20.5% less |
| Unchanged twenty-row list control | 4.260 | 4.518 | 0.258 ms more |
| Small count control: twenty mixed weights | 0.0046 | 0.0016 | Too small for a useful latency claim |

The unchanged list control fluctuates in both directions across Node/runtime
runs; its embedded-runtime pooled median is 6.1% slower (0.258 ms). This is
disclosed rather than treated as a list improvement. None of the retained changes
alters that no-search/no-statistics query path. No whole-application speedup is
inferred from these local operations.

Context timing includes transaction entry and synthetic cleanup, but excludes
commit/fsync, normalization, foreign-key assertions and rollback. It establishes
reduced association-writing CPU/work, **not** complete import durability latency.
Sparse reads include ordinary hydration and `markMissing`; fixture visuals have
descriptions but no media bytes. Large-media decode/hash performance is unmeasured.
Data is synthetic and OS caches are warm; IPC, browser layout, providers, cold
disk, peak memory and installed-package latency are excluded from the comparison.

## Reproduction

Build and preserve the baseline before modifying production sources. `desktop:build`
replaces `.build/electron`, so copy each output before another build. Keep the
locked dependencies accessible from both copied module trees. Choose previously
unused `before`/`after` directories rather than copying over existing outputs.

```sh
npm --prefix app run desktop:build
mkdir -p app/.build/performance-audit
cp -R app/.build/electron app/.build/performance-audit/before
# Apply the candidate, then build and preserve it separately.
npm --prefix app run desktop:build
cp -R app/.build/electron app/.build/performance-audit/after
node app/scripts/benchmark-performance.ts \
  app/.build/performance-audit/before app/.build/performance-audit/after \
  app/.build/performance-audit/new-comparison.json
ELECTRON_RUN_AS_NODE=1 \
  app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  app/scripts/benchmark-performance.ts \
  app/.build/performance-audit/before app/.build/performance-audit/after \
  app/.build/performance-audit/new-electron-comparison.json
```

Run comparisons serially, without builds/tests at the same time. Reports reject
existing destinations. The script asserts equivalent complete output hashes,
unchanged inputs, no writes during passive reads and valid association foreign
keys. It creates/deletes only its own temporary synthetic profiles.

## Acceptance

`make verify` passes: 26 CI guards, 76 release-tool regressions, 916 frontend
tests (seven opt-in probes skipped), 1,831 backend tests, contracts, maintainer/UI/
worker types, lint and production renderer build. Backend coverage: 91.06%
statements, 86.13% branches, 91.74% functions, 92.72% lines. The benchmark is also
included in maintainer-tool type checking. Focused question/list/package tests
pass all 22 cases.

`make test-e2e` also passes: all 240 Chromium scenarios and actual Electron
smoke. Native smoke covers sandbox/IPC, compiled workers, Tencent ZIP codecs,
text/OCR/PDF/image completion, bounded preparation, source/task recovery,
passive exports, SQLite CRUD, practice/grading, OS-encrypted test credentials,
all-type ZIP round trips, and Settings import/backup/confirmed restoration.
Profiles and provider endpoints are temporary/local; native dialogs are
substituted. This establishes actual Electron execution separately from browser
mocks, without claiming paid-provider quality or final-installer acceptance.

All seven default-skipped frontend probes were then enabled and passed in serial
focused runs: answer-card statistics, review-quality serialization, practice
typing, answer display, editor snapshots, word counting and exam statistics.
Their JSON reports retain work counts/output checks and local timings; there is
no frontend before/after speedup claim because frontend production code did not
change. Logs and the machine-readable `acceptance.json`, `source-identity.json`,
`frontend-probes.json` and both paired reports remain under the evidence directory.

`git diff --check`, removal-manifest checks, chart/data consistency and Markdown
links to removed reports pass. Final compiled modules and execution identity
match the candidate used for the embedded-Node benchmark. The next useful
measurement is 1,000-answer save latency through actual IPC; checkpoint history
and partial-preview read counts follow, before changing provider scheduling.

## Report cleanup and limits

At the user's request, 73 retired Rust/Python performance narratives and top-level
measurement reports were removed. Documentation navigation now points here;
citations in retained historical documents use the exact pre-cleanup Git revision.
Standalone frontend reports, raw evidence directories, live-quality records,
regression corpora and ignored local data remain. The local deletion manifest
records paths, sizes and hashes. No whole historical directory was removed.

There is no schema migration or saved-data rewrite. Existing execution build
fingerprints remain enforced: an unfinished AI task must retain its original
compatible build or use the explicit supported recovery/reparse flow. No paid
provider, signing, notarization, remote CI, clean-machine or final-DMG performance
acceptance is established by this audit.
