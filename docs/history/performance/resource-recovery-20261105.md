# Resource bounds and recovery measurements — November 5, 2026

Baseline: `5973846cfdd2d5ec6948562e443642deb5042a02`. The initial `main`
worktree was clean. Work is isolated on `fix/performance-recovery-20261105`.
All inputs are synthetic; databases, queues and storage are disposable. Existing
development containers and their volumes are excluded. No paid provider calls,
deployment or package publication was performed during these checks.

Raw reports are in [the evidence directory](../../evidence/2026-11-05-performance-recovery/).
Current measurements supersede historical timings only for their stated scope.

## Candidates and decisions

| Candidate | Evidence and impact | Cost / risk | Decision |
| --- | --- | --- | --- |
| Bound checksum work with its verified file read | A blocked hash outlives cancellation outside the storage semaphore; the configured storage timeout does not bound it. Both new regressions fail on the baseline. Every successful read also dispatches stat, read and hash separately. | Small shared-storage change; preserve namespace, size/hash errors, bounded reads and cancellation capacity. | Retained; focused regression and alternating measurements passed. |
| Restore current connected workflow acceptance | The browser harness waits for removed service-token controls and sends an obsolete bearer header. Historical workflow evidence cannot establish current acceptance. | Harness only; retain exact output, ZIP, explicit Start and native persistence gates. | Passed with TXT, Markdown and PNG, production Web/HTTP and release native practice. |
| Avoid repeated asset-inventory membership scans during repair | `preserve_damaged_state` scans all collected assets for each replacement; complete damage scales quadratically before durable file copying. | Temporary bounded membership set; preserve order, indexed/unindexed distinctions, original damaged bytes and publication barriers. | Withdrawn: one diagnostic pair cannot attribute complete-repair variation to this change. No native production change retained. |
| Bound App unit-test discovery | The first complete check discovered a third-party `.build` test and failed after all 542 App tests passed. | Reuse Web's source-only test glob; preserve every source test and all existing local artifacts. | Retained: actual Vitest discovery plus a temporary out-of-scope canary proves all 48 source files remain, and the foreign tests are excluded. |
| Identify interrupted publication remnants under retained sources | A real hard kill leaves unpublished temporary files; the source-level GC protection also protects those bytes indefinitely. Both initial kill regressions select zero cleanup candidates. | Reserved names for new staging files and a narrow existing-GC classification; retain age, ownership, identity and durable inventory safeguards. | Retained: 93 focused checks, four real child-process kills and final full verification pass. No deletion or disk-space reduction is claimed. |
| Change upload publication / connection reuse / broker topology | Existing implementations already bound upload buffers, retain sync barriers, reuse short-operation connections and isolate publisher/consumer sessions. | Durability and paid-work risks exceed an unmeasured speculative benefit. | Retain as controls; run current recovery suites. |

## Verified file reads

`benchmark_io.py --baseline 5973846c` compares the original local Git class and
validator with current code on fresh temporary files. The accepted report is
`service-accepted.json`; `service-initial.json` is the pre-change control and
`service-final.json` is the first candidate run. `service-accepted-read-boundary.json`
retains the accepted first round before the publication-name change. Three process/store pairs
alternate before/after, after/before, before/after. Each pair has a first batch
and seven warm batches per variant: 21 warm samples per workload. Whole-byte
output equality is asserted outside timing. All contents retain their input hash.

Warm batch medians and sample p95, in milliseconds:

| Source / reads per batch / client concurrency | Before median | After median | Before p95 | After p95 | Median reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 KiB / 100 / 1 | 31.150 | 14.682 | 38.505 | 16.247 | 52.9% |
| 4 KiB / 100 / 8 | 29.866 | 15.697 | 32.556 | 16.623 | 47.4% |
| 128 KiB / 40 / 1 | 13.297 | 7.982 | 14.109 | 8.695 | 40.0% |
| 128 KiB / 40 / 8 | 12.601 | 6.896 | 13.138 | 7.717 | 45.3% |
| 25 MiB / 4 / 1 | 42.656 | 41.203 | 44.252 | 42.707 | No material gain claimed |
| 25 MiB / 4 / 4 | 14.817 | 14.346 | 15.690 | 14.738 | No material gain claimed |

The storage worker limit is four. One hundred reads dispatch 200 storage jobs
plus 100 default-executor hash jobs before, versus 100 storage jobs and zero
default-executor jobs afterward. The sequential 4 KiB batch's process CPU median
falls from 26.798 to 12.662 ms. No hash or payload is cached, and there is still
one verified payload read per request. Source-file limits remain enforced.

Separate traced-allocation batches retain approximately 0.6 MB (small serial),
5.4 MB (typical) and 105 MB (four large returned buffers). Small concurrent
batches vary from 0.856 to 0.868 MB after the change, overlapping the baseline's
0.770 to 0.881 MB. There is no general allocation or RSS reduction claim. The
important resource improvement is that cancellation cannot release the read's
capacity while its checksum worker still retains the payload. The existing
storage deadline now covers the combined stat/read/hash operation rather than
leaving hashing without that deadline.

The first two new regressions fail on the baseline and pass after the fix
(`storage-before.txt`, `storage-focused.txt`, 196 focused tests). They gate a real
hash worker, cancel or time out its request, then prove a subsequent read cannot
start another hash before the first worker exits. Reopening the store still
verifies the published source. Existing tests retain missing/corrupt objects,
namespace escapes, Office validation, partial upload cleanup and sync failures.

`check-repeated-storage.py` separately runs the same 30,000 verified 128 KiB
reads in fresh baseline/current processes: twelve cycles at client concurrency
ten, storage concurrency four, then an idle snapshot. Both retain exactly seven
file descriptors and 131,072 stored payload bytes in every snapshot. After warmup,
the baseline has twelve Python threads and current code has six. Current sampled
RSS stays within 143.8–153.7 MiB, without cumulative growth over these cycles;
baseline samples are 148.1–151.5 MiB. These short instrumented process runs do not
establish long-term leak freedom or a general RSS speedup. CPU includes output
assertions, garbage collection and snapshots and is not used for a speed claim.
The final resource probe followed the connected run in a quiet window; initial
runs with other functional checks active remain as `*-initial.json`. The accepted
timing benchmark ran separately.

`storage-startup.json` distinguishes three fresh Python-process controls from
warm reads of the same 128 KiB input. Process totals are 108.9–120.7 ms, module
imports 76.3–86.5 ms, first verified reads 0.372–0.442 ms, and the median of 25
subsequent reads per process is 0.160–0.207 ms. OS caches remain warm and functional
checks were active. These controls establish neither a startup improvement nor
cold-disk performance; the child program is retained with the raw samples.

## Publication interruption and safe inventory

`publication-before.txt` records two real process-kill failures: a fully written,
synced source/artifact temporary file remains, but source-level protection hides
it from cleanup while that hash is retained. New staging names reserve the
`.practiq-pending-` prefix and the existing GC recognizes only their exact temporary
shape. No valid source or artifact reference can point to those names.

The extended probe kills actual Python children immediately after temporary-file
creation (empty bytes) and after file sync but before rename (complete bytes),
for both streamed uploads and artifacts. After reopening, the original published
artifact still verifies. Advancing only fixture mtimes past retention allows one
pending object to enter the existing durable quarantine inventory. Its exact
bytes remain available, and a second scan is empty. Old ambiguous names, malformed
markers, fresh files and valid retained-source files remain protected. Prefix
recognition does not bypass namespace or symlink checks. All 93 focused storage,
upload, operation and GC checks pass, plus the focused type check.
The new kill drill supplies a synthetic retained-source set; the existing
disposable-database operation tests cover reference collection and ownership.

The GC remains dry-run by default. Quarantine still requires the operator's
existing maintenance/drain/stop and exclusive-ownership procedure, the same
187-day default retention, a fresh recovery manifest, reference and file-identity
rechecks, and the original synchronization ordering. Nothing runs on startup or
during passive reads. No file content is deleted, and moving bytes into quarantine
does not free disk space. Legacy ambiguous temporary names require operator review.

## Queue and native controls

The existing `benchmark_runtime.py` ran three rounds each for 1, 16 and 64
documents, with eight task slots, graph concurrency two and a fixed 100 ms local
model substitute. Every run completed with exactly one recorded model call per
document. Median complete workload time was 0.338, 1.119 and 4.152 seconds;
health-request sample p95 ranged from 0.991 to 1.490 ms. Median queue waits by
round are retained in `runtime-{small,typical,burst}.json`. These measure fresh
runtime instances inside a Python process, not provider throughput or cold
Python startup. This is current-state control evidence, not a database/broker
optimization claim.

The release repair probe now includes all 2,000 resources damaged, alongside
20/200-resource controls with one damaged file. It asserts reopened banks,
roundtrip backups and exact recovery-inventory hashes. Both candidate binaries
produce identical ordered inventory hashes and verified-read counts (41, 401
and 6,000). In the single diagnostic pair, 2,000-resource sample ranges were
29.6–34.7 seconds before and 23.8–28.1 seconds after, while the small control
became slower. Whole-process system CPU changed from 27.45 to 14.21 seconds,
which cannot be explained by replacing only membership comparisons. The baseline
also includes a two-second `sample` observation, and probe formatting changed
without changing its operations. These data do not establish a causal speedup.
The membership candidate and its temporary regression were withdrawn; its exact
patch, binary/source hashes, raw samples and successful inventory regression are
retained. No sync barrier, repair read, schema or backup format changed.

`check-test-discovery.py` uses Vitest's actual file-list command with the old and
new configuration and an ephemeral `.build` canary. It asserts exact equality
between current discovery and all source test files. No artifact is deleted or
third-party test module executed by this discovery check. The initial failed App
check remains in `app-check-first.txt`; it does not count as acceptance.

## Current acceptance

| Gate | Current result |
| --- | --- |
| `make verify` | Final run passed: 3,736 tests, 93% coverage (90% required), Ruff, Pyright, lockfile, 30 fixtures, all recovery probes, source/wheel build and archive checks. Six existing warnings remain. The first 3,721-test round is retained separately. |
| `make web-check web-build` | Passed: 270 unit tests, one opt-in benchmark skipped, 57 Chromium checks and production build. |
| `make app-check` | Passed after fixing discovery: 51 shared fixtures plus sample; frontend types/lint and 542 tests (six opt-in cases skipped); 277 native tests (27 ignored entry points/benchmarks); formatting and Clippy. |
| Connected workflow | Passed: three source imports, exact export/HTTP equality and ZIP hashes, real release SQLite practice, saved/reopened scores and backup restoration. All 24 repeated native cases pass. |
| Repeated storage / discovery | Both fresh-process resource probes and baseline/current discovery canary assertions pass. |

The full service suite includes real process kills at outbox, publication, queue,
model, provider-completion, receipt, saved-unit, final-checkpoint and saved-result
boundaries. Known local work recovers, while an unacknowledged provider result
remains unknown until an explicit recovery action. Broker disconnect/restart,
ambiguous confirms/acks, duplicate deliveries, ownership loss, cancellation,
unreadable checkpoints, partial export and storage fault probes all pass. The
native suite includes forced termination before/after database publication and
resource repair, interrupted SQLite writes and sidecar initialization, and
restart resolution before offline database writes. Disk-full/read-only/partial
write checks are injected faults, not physical disk exhaustion or power cuts.

The final connected run is in `workflow-final/report.json` (the first round remains
under `workflow/`), with separate source, export,
browser, native and event evidence. Selecting a file causes zero mutations;
each explicit Start creates one task and one model-substitute call. Passive
review/export preserves usage and unknown-call records. No bearer header is sent.
Imported review flags remain visible in the screenshots and downloaded banks.

| Fixture | Start → visible result | ZIP download | Start → native practice restored |
| --- | ---: | ---: | ---: |
| TXT | 3,364.3 ms | 75.4 ms | 3,643.1 ms |
| Markdown | 3,245.5 ms | 49.9 ms | 3,396.0 ms |
| PNG | 3,212.4 ms | 67.2 ms | 3,418.7 ms |

These tiny fixtures include the existing polling interval and synthetic provider
responses. Browser DOM-content-loaded observations are 31.5–63.2 ms; no >50 ms
long task was observed in these three cases. Service-PID sampled peak RSS is
173,719,552 bytes over 141 samples. It excludes renderer/Office/browser/native,
database/broker processes and can miss brief peaks. These are current controls,
not before/after improvements, production capacity estimates or p95 estimates.

The existing opt-in large-result probe also passes on current Web code: 1,000
questions, 2,000 issues and ten page changes retain complete output hashes.
Seven samples format quality once on the sources tab (median 0.277 ms) and zero
times while paging questions. `web-large-result.json` measures native JSON
formatting in React/JSDOM, not complete browser render latency or a new speedup.

## Scope and continuation

Use `environment.json`, source/probe hashes and the final verification report to
check freshness before continuing. Local verified-file microbenchmarks are not
model, Tencent, browser or end-to-end import performance. Synthetic queue runs
include a fixed 100 ms model substitute and cannot establish provider throughput.
First batches follow fixture publication; OS caches are not flushed, so they are
not cold-disk measurements. No physical power-loss or multi-host disaster recovery
claim is made.

The demonstrated high-priority faults are closed: checksum work can no longer
escape storage capacity/deadlines, and unrelated local artifacts can no longer
break App checks. Aged, recognized remnants from interrupted publications can be
safely inventoried and quarantined without moving valid retained-source files.
The connected acceptance harness matches the current personal
service. The speculative native membership change is absent from production.

All retained changes have current-source acceptance, and no measured high-value
candidate remains open. Before another round, compare the source/probe hashes
and retained diff with the new checkout, then measure a newly demonstrated
bottleneck. Longer production soak, real Tencent/model latency and
quality, installer/WebView/clean-machine acceptance and host/disk/power-loss
recovery remain separate, unassessed evidence layers. They are not prerequisites
for this local reversible phase, and no production state, provider budget or
deployment was changed. An upgrade changes the conservative execution signature;
retain the original deployment for unfinished imports rather than rewriting saved
signatures or replaying uncertain paid work.
