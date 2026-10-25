# Runtime performance acceptance — October 25, 2026

## Scope

Implements the ten recommendations from the review of `562951cd`. No public API,
shared contract, schema, index, dependency, concurrency setting or model prompt was
changed. Service schema 5 and App schema 11 remain intact. No user database,
credential store or real Tencent/model endpoint was opened by these checks.

The code digest changes because parser/Tencent sources changed. Retain the old
deployment for unfinished old executions, or drain them before upgrading. Never
rewrite saved execution signatures; an explicit new parse can incur new charges.
Passive result reads and exports remain available without starting a model.

## Recommendation ledger

| # | Implementation | Regression / evidence |
| --- | --- | --- |
| 1 | Delete source bytes and the submit dictionary after persisting the known Tencent task ID, before polling | Local Base64 and COS frame-lifetime checks in `test_runtime_optimizations.py`; paired retained-buffer probe |
| 2 | Decode externalized units, validate merge inputs, construct final results/quality, and copy partial-projection state through the existing draining thread helper | Off-loop validation/finalization assertions, repeated-cancellation drainage, identical paired 100-page/1000-question output hashes and heartbeat samples |
| 3 | Authorize declared source/visual references from one snapshot; stop at the first matching saved unit | Real checkpoint/local-file cases at 1/30/100 units; one snapshot, one first-unit read, one image read; unrelated corrupt later units untouched |
| 4 | Reuse one task-local RPC client for submit, queries and bounded read retries | Four RPC operations use one client, closed on completion; existing admission, unknown-submit, query retry and cancellation cases retained |
| 5 | Reuse bounded PNG bytes/full-page coordinates after successful decoding | RGB/RGBA/palette cases perform no crop or encoding; oversized reconstruction and JPEG/CMYK validation retained |
| 6 | Filter exact `null` draft text in SQLite before JSON transfer/parsing | Native false/zero/nested-empty/whitespace-null cases; 30k-attempt release probe returns 300 rows instead of 30k, with the same 300 drafts |
| 7 | Build export detail from the initial snapshot | Two task reads rather than three; final checkpoint/state conflict check and archive closure remain |
| 8 | Store JPEG/MPEG/MP4/AAC ZIP members without redundant Deflate | Exact bytes, permissions and compression selection tested; JSON/PNG/WAV retain Deflate level 1 |
| 9 | Skip source-duplicate analysis when source proof is empty | Zero second-pass calls; preceding strict duplicate/tree validation remains; source-proof regressions retained |
| 10 | Use an indexed count per bank and the existing bank-order index | Native empty-bank/composite/leaf/null-mode/tie-order checks; paired 100-bank/100k-question release probe with equal output hashes |

Artifact access still checks the authoritative task, expiry, source namespace, all
four reference fields and requested bytes/checksum. A namespace prefix alone is
never authorization. Declared public visuals are checked instead of recursively
searching arbitrary question JSON for reference-looking dictionaries. Merged
results supersede older unit visuals. An absent or late-unit visual can still
require preceding unit reads; no reverse index or cross-request cache was added.

## Measurements

Final paired measurements are retained as
[service JSON](../../evidence/2026-10-25-runtime-performance/service.json) and
[native JSON](../../evidence/2026-10-25-runtime-performance/native.json).
They use the same host, one warmup and seven timing samples per variant. Timing
probes run separately from tests/build jobs; an earlier concurrent smoke run is
excluded. The service baseline loads explicitly selected trusted Git source from
`562951cd`; native probes contain the old SQL and call the new production reads.

| Workload / work count | Before | After |
| --- | ---: | ---: |
| Local 8 MiB submit: source + Base64 retained in polling frame | 8,388,608 bytes + 11,184,812 characters | 0 / 0 |
| COS 25 MiB submit: source retained in polling frame | 26,214,400 bytes | 0 |
| 100-page / 1000-question merge, median total | 203.49 ms | 200.34 ms |
| Same merge, median maximum heartbeat gap | 105.61 ms | 26.27 ms |
| Same merge, source-proof passes with empty evidence | 1 | 0 |
| Bounded PNG preparation | 30.35 ms | 7.90 ms |
| Same PNG, submitted bytes | 257,004 | 264,160 |
| 1,518,074-byte JPEG ZIP member writing | 22.60 ms | 0.113 ms |
| Same single-member ZIP, archive bytes | 1,518,140 | 1,518,196 |
| Native sparse draft pass, 30k attempts | 2.367 ms / 30,000 rows | 1.494 ms / 300 rows |
| Native 100-bank / 100k-question choices | 12.560 ms | 10.681 ms |

The merge output SHA-256 is identical:
`e416d5543913c91aa232526efaab8ddf45e7f0f4d4333fde925bd245dfc6db79`.
Native bank output SHA-256 is also identical:
`c9470c6a7132254df6de1a3c78cfc687acd1bec1f08b0e3904becff0ebb5c09f`.
Draft totals remain 300. Native timings supersede the review's Python/SQLite
approximation: fewer transferred rows do not imply a 100x native latency gain.

The service merge fixture contains 100 synthetic OCR pages, ten questions per
page and about 2 MB of stems. It uses inline saved units and no real rendering,
file I/O, checkpoint database or provider. Heartbeats request 1 ms sleeps; the
reported value is the median of each run's maximum scheduling gap, not a p95 API
latency. Python's GIL still limits worker-thread responsiveness. Source-buffer
counts describe suspended frame references, not allocator/RSS measurements.

The PNG probe retains identical pixels, not identical compressed output: the new
path keeps the original PNG bytes and can retain a slightly larger submission.
JPEG ZIP timing isolates member writing and compression, not full export or image
validation. The native draft timing isolates the draft pass, not whole history
summaries. No timing assertions or general production speedup are claimed.

## Reproduction

Use the existing Python 3.14+ interpreter and installed locked dependencies, with
no project virtual environment. From the repository root:

```sh
export AI_PYTHON=/path/to/python3.14
PYTHONPATH=server/src "$AI_PYTHON" server/scripts/benchmark_runtime_optimizations.py \
  --baseline-ref 562951cd --output /tmp/practiq-service-runtime.json
PRACTIQ_BENCH_OUTPUT=/tmp/practiq-native-runtime.json \
  TAURI_CONFIG='{"bundle":{"resources":[]}}' \
  cargo test --release --locked --manifest-path app/src-tauri/Cargo.toml \
  --lib runtime_read_stress -- --ignored --nocapture

(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest -q \
  tests/test_runtime_optimizations.py tests/test_artifact_performance.py \
  tests/test_bank_export.py tests/test_tencent.py tests/test_tencent_inputs.py \
  tests/test_document_performance.py tests/test_source_duplicates.py)
make verify
make app-check
npm --prefix app run test:browser
make web-check web-build
make app-build
"$AI_PYTHON" app/scripts/check-bundle.py \
  --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled \
  --output /tmp/practiq-runtime-bundle.json
"$AI_PYTHON" app/scripts/check-installer.py \
  --installer app/src-tauri/target/release/bundle/dmg/PractiQ_0.2.0-beta.1_aarch64.dmg \
  --output /tmp/practiq-runtime-installer.json
```

## Local verification

Toolchain: Python 3.14.7, Node 22.23.2, Rust/Cargo 1.98.1, Vite 8.3.4 on arm64 macOS.

| Gate | Result |
| --- | --- |
| Initial related service regressions | 295 passed |
| Final runtime/artifact/export regressions, after boundary assertions | 159 passed |
| Full service `make verify` on frozen source | Passed: 2,981 tests, 94% aggregate coverage; probe fingerprint accepted, four probe metrics 100%; wheel/sdist build and package integrity passed |
| App contract exporter and fixtures | Passed: 49 shared contract cases and sample |
| App frontend types, lint and unit tests | Passed: 500 passed, 3 skipped |
| Native ordinary tests, formatting and all-target Clippy | Passed: 238 passed, 21 ignored |
| Named native release read probe | Passed: 1 test; 258 unrelated tests filtered out |
| App browser checks | Passed: 150 Chromium checks; mocked native APIs, not manual native WebView |
| Web types, lint, coverage and browser checks | Passed: 209 unit tests, 54 browser checks; 98.12% line coverage |
| Web production build | Passed |
| macOS App and DMG build | Passed: 25.82 MiB App, 11.86 MiB DMG |
| Final App/DMG inspection | Passed: metadata/notices only, no embedded Python/LibreOffice engines |
| Final Ruff/Pyright including the new benchmark script | Passed |
| Diff whitespace check | Passed |

Detailed command logs and package inspection JSON remain locally in
`/tmp/practiq-runtime-acceptance/`; normal service coverage/probe reports are in
ignored `server/reports/checks/`. These local paths are not permanently available
artifacts. The committed measurement JSON and
[source/package hash manifest](../../evidence/2026-10-25-runtime-performance/source-and-packages.json)
identify the measured source and bytes without copying local credentials. The
probe report explicitly retains `durableCrashRecovery: NOT_ASSESSED`; its four
passing fake-service metrics are not a general durable-recovery certification.

## Failures and exclusions

The first seven new focused regressions failed on the baseline as intended:
source retention, per-request clients, redundant PNG crop/encode, and merge work
on the event loop. During implementation, six mock artifact cases used the fake
store's nonproduction path prefix; they were corrected to use real local storage,
not by relaxing namespace validation. Pyright also caught untyped coroutine-frame
inspection and possibly unbound benchmark locals; these were corrected. The first
standalone native command exceeded its harness deadline during the existing long
asset tests; the complete `make app-check` subsequently passed. The first full
service run passed all 2,979 tests with 94% coverage and 100% probe metrics, but
its final gate correctly returned `PROBE_FINGERPRINT_MISMATCH`: the new benchmark
script had changed after test collection. Its failed report/log were retained;
source, tests and scripts were then frozen for a complete rerun, without editing
JUnit fingerprints or relaxing the gate.

No real-provider latency, OCR/model extraction quality, process peak RSS, manual
native UI, clean-machine installation, signing/notarization, service-image build,
production PostgreSQL query plan or hosted CI acceptance is established here.
Ordinary native tests leave opt-in workloads and native credential checks ignored;
only the named release read probe is additionally executed. No deployment or
release is authorized by this report.
