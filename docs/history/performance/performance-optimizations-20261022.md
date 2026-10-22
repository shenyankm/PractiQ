# Performance optimization acceptance — 2026-10-22

## Scope and result

All 16 recommendations from the review of `5b673a6e` are implemented. Runtime
changes and regression tests were verified at `55e06cad`; the subsequent commit
adds this evidence and its index link only. Local engineering acceptance passed.
This is not live-provider quality, production latency, or all-platform acceptance.

The implementation preserves API contracts, App schema 11, service schema 5,
immutable practice snapshots, checksums, transaction/recovery boundaries and
explicit paid-action requirements. No dependencies or configuration were added.

## Recommendation coverage

Numbers refer to the original ranked review, not commit order.

| # | Optimization | Evidence |
| --- | --- | --- |
| 1 | Short-circuit null answer-card drafts and reuse calculated states | 999 untouched matching drafts cause zero item-array reads; a partial draft takes one state calculation |
| 2 | Crop only figures without Tencent subimages | All/mixed/no-subimage fixtures retain image bytes, order and coordinates; zero discarded crops |
| 3 | Authorize source artifacts before loading task detail/review | Source reads invoke neither helper at 1/100/300 saved units; checksum and ownership rejection remain tested |
| 4 | Read noncomplete detail directly instead of head then detail | Ten polling rounds per noncomplete state: ten details and zero heads |
| 5 | Mount diagnostic contents on first expansion | Five collapsed updates cause zero diagnostic serializations |
| 6 | Consume the owned selected-question array | A 100,000-byte stem retains its allocation through thawing; immutable source document unchanged |
| 7 | Search shared visual content once per relevant ID | 51 observed content searches instead of 500,001 calculated old rows on the 10,000-root fixture |
| 8 | Reuse prepared association INSERTs | 24,323 rows, identical normalized content hash, rollback regression and paired cache probe |
| 9 | Reuse the validated Tencent result ZIP and member-name set | 30 images: one ZIP opening, zero namelist calls; sequential reads and cancellation drainage |
| 10 | Validate audio durations without rehydrating unrelated content | Current and historical-only audio checks retained; paired narrow/full-duration-pass probe |
| 11 | Reuse one outbox marking connection per nonempty batch | B=1/10/100: one connection; B positive confirms and immediate conditional updates retained |
| 12 | Pause polling outside the records workspace | 60 hidden-workspace seconds: zero additional task reads; state retained on return |
| 13 | Use completed heads for automatic focus/visibility wakes | 20 unchanged wakes: 20 heads and no additional detail/preview reads |
| 14 | Bound recovery preflight verification and discard payload outputs | N=10/100/300, concurrency 1/2/4; all unique objects verified, map results contain only None |
| 15 | Persist page references before provider waits and drop render buffers | Split/unsplit frame and weak-reference assertions; all final pages persisted before submission |
| 16 | Overlap bounded Tencent jobs, decode receipts in source order | Admission two overlaps waits; completion [1,2,3,0] retains [0,1,2,3] receipts; replay sends no additional requests |

Detailed fixtures, limitations and reproduction commands:
[service I/O](../../../server/docs/performance-io.md),
[document pipeline](../../../server/docs/performance-pipeline.md),
[native data](../../../app/docs/performance-native.md),
[frontend](../../../web/docs/performance.md).

## Verification environment and commands

Apple M4, arm64 macOS 27.0.1; Python 3.14.7, Node 22.23.2, Rust/Cargo 1.98.1.
App and Web dependencies were reinstalled using their unchanged lockfiles with
`npm --prefix app ci` and `npm --prefix web ci`; both dependency trees then passed
`npm ls --depth=0`, with Vite 8.3.4. No project virtual environment was created.

```sh
export AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14
export PYTHONPATH="$PWD/server/src"
make verify
make app-check
npm --prefix app run check:ui
npm --prefix app run test:browser
make web-check web-build
make app-build
"$AI_PYTHON" app/scripts/check-bundle.py \
  --bundle "$PWD/app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled" \
  --output /tmp/practiq-performance-acceptance/app-bundle-locked.json
"$AI_PYTHON" app/scripts/check-installer.py \
  --installer "$PWD/app/src-tauri/target/release/bundle/dmg/PractiQ_0.2.0_aarch64.dmg" \
  --output /tmp/practiq-performance-acceptance/app-installer-locked.json
```

| Gate | Result |
| --- | --- |
| Service lock, Ruff, Pyright, evaluation fixtures | Passed |
| Service tests, disposable PostgreSQL/RabbitMQ recovery, coverage | 3,085 passed; 93% aggregate coverage; all four recovery probe metrics 100%; probe status PASSED |
| Service source/wheel build and package integrity | Passed |
| App generated contracts and fixtures | Passed; no generated contract changes |
| App frontend types, lint, unit tests and coverage | 471 passed, 3 skipped; 93.70% lines, 85.98% branches |
| Native Rust tests, formatting and all-target Clippy | 221 passed, 19 ignored; formatting and Clippy passed |
| App browser checks | 173 passed, including desktop, built touch layouts and mocked Android navigation |
| Web types, lint, unit tests and coverage | 179 passed; coverage thresholds passed |
| Web browser checks and production build | 53 passed; build passed |
| macOS App/DMG build and package inspection | Passed; no embedded AI engines; installer SHA-256 `e5521c91b408c4ec0d23f435945507653bedce483eb6ccc4f2ab9e5ac8050b80` |
| Four explicitly selected native release probes | Search, association INSERT, audio-duration pass and snapshot-copy probes passed |
| Independent source review | Server, native and frontend reviewed; follow-up review confirmed all findings resolved |

The 19 ignored Rust tests are not claimed as executed by the ordinary suite;
four bounded release probes were selected separately. Other ignored workloads
remain outside acceptance. Browser Android projects are not actual APK/device tests.

## Measured and deterministic outcomes

The parent repeated the release probes on the integrated native source. Association
INSERT samples with the statement cache disabled were 72.32/70.66/72.63 ms; with
capacity 16 they were 32.43/32.66/32.49 ms. Both variants produced the same
normalized hash `ea10da2681713075d0b998273a2823751c5833b263acff19d0ed907e510741b5`.

The legacy-shaped full audio-duration pass took 231.05/230.46/228.68 ms; the narrow
pass took 6.33/6.13/6.03 ms on the same documents. These numbers exclude the
initial full validation and resource verification: they do not measure total
restore time. Shared-host timings are illustrative, not performance thresholds.

Other outcomes above are deterministic work-count, equivalence or object-lifetime
assertions, not latency/RSS improvements. Tencent overlap uses controlled fake
provider waits, not real-provider throughput. Render/split peak RSS was not measured.

## Failures found and resolved

- The first service command used a stale editable-import environment. Explicit
  `PYTHONPATH` and Python 3.14 selection restored repository-local module discovery;
  the complete verification was rerun successfully.
- A browser test still expected polling on the hidden Import workspace. It now
  verifies no hidden reads, immediate records refresh, preserved uncertain request
  IDs and no automatic mutation replay.
- Independent review found a return-to-records wake lost during an in-flight
  preview, plus raw exceptions from unsupported ZIP versions. New regressions
  failed first, then passed after queued-wake handling and structured ZIP opening
  errors were restored. Malformed UTF-8 ZIP filenames are also covered.
- Review corrected the native timing description: search samples include their
  lightweight assertions and test-only work counter.
- The first parent snapshot release probe omitted `PRACTIQ_BENCH_OUTPUT`. It was
  rerun with a fresh temporary output path and passed; the failure was invocation
  setup, not a product defect.
- Existing local frontend dependencies had Vite 8.3.0. Final App/Web checks,
  browsers, builds and macOS package inspection were repeated after locked
  installation of Vite 8.3.4.

Raw local logs, synthetic snapshot results and package-check JSON remain under
`/tmp/practiq-performance-acceptance/`; normal service reports remain in ignored
`server/reports/checks/`. These paths are local evidence, not committed artifacts
or permanently downloadable files.

## Residual risks and exclusions

Parallel Tencent submission intentionally changes charge timing: later parts may
already be paid when an earlier part fails validation. Cancellation can leave more
known or unknown provider requests. Durable per-part intents, no automatic replay
of unknown submissions, ordered receipts and bounded admission remain enforced.
See the pipeline guide before explicitly resuming or parsing again.

Concurrent file verification may increase disk contention and instantaneous memory;
existing storage concurrency remains the bound. No check, hash, foreign key,
transaction, resource limit or persistence guarantee was removed for speed.

No live Tencent/LLM requests, user databases or credentials were accessed. Real
extraction quality, production latency/RSS, manual native UI, clean-machine signing,
Windows builds, actual Android APK/emulator/device runs and service-image builds
were not verified. Hosted PR CI is separate from these local results. No release
or deployment is authorized by this report.
