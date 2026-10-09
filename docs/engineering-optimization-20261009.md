# Engineering optimization evidence (2026-10-09)

This record covers one bounded engineering round after the PostgreSQL runtime migration. Its initial main baseline is `6574bb2d68bf94f0e199c8e8dbb09fb8fcd9b170` ([PR #167](https://github.com/shenyankm/PractiQ/pull/167)). Each experiment below has its own frozen source, inputs, configuration and cache boundary. The AI service, import Web frontend and offline practice application retain their independent responsibilities. No public API, question-bank ZIP, practice snapshot, backup schema or credential namespace changed.

This is an evidence journal, not release acceptance. Single-machine deployment means one service process, PostgreSQL and persistent local files. Hosted CI, local native tests, browser substitutes, emulator tests and real models are identified separately. Old reports retain their original dataset/version boundaries, including failures.

## Bounded candidates and decisions

Priority reflects measured benefit, correctness and recovery risk. Rejected experiments were reverted before delivery. Subsequent distribution checks exposed three concrete packaging gaps; they were added to this finite list rather than folded into unrelated optimizations.

| Priority / candidate | Problem evidence and frozen baseline | Scope and acceptance criterion | Risk and rollback | Decision |
| --- | --- | --- | --- | --- |
| 1. Web font formats | The complete static directory at `6574bb2` contains unused WOFF/TTF fallbacks in addition to the supported WOFF2 faces | Web bundling only; preserve all 20 font faces, formula rendering and browser/font checks; compare three clean and three incremental builds | Older unsupported browser fallback; revert bundling filter | Adopted, [#168](https://github.com/shenyankm/PractiQ/pull/168): full static resources 2,059,410 → 1,240,096 bytes (39.8% lower). Initial JS/CSS and observed build speed did not improve |
| 2. Duplicate service Web build | Service CI at `5b9210e` builds Web before `make image-check`, whose prerequisite builds it again | Existing workflow/Make targets; retain all frontend checks, one Web build, identical assets and image runtime content | Missing build input if prerequisites change; revert workflow line | Adopted, [#172](https://github.com/shenyankm/PractiQ/pull/172): two builds → one; local paired timings improve, total CI ranges overlap |
| 3. Shared payload verification | Storage and Office independently implement the same byte-count/SHA-256 errors; Office hashing blocks its event loop at `7920df8` | Reuse existing asynchronous validator at both trust boundaries; preserve size/checksum rejection, cancellation and engine/file ordering | Thread hashing continues after caller cancellation; engine access must still stop; revert shared helper/callers | Adopted, [#173](https://github.com/shenyankm/PractiQ/pull/173): 25 MiB hash duration stays near 9.4 ms; maximum heartbeat gap improves in three paired probes |
| 4. Production restart/readiness | Production Compose at `5b9210e` has resource quotas/hardening but lacks automatic crash restart and container readiness checking | Existing single-process deployment; actual kill/recovery, PostgreSQL failure, admission, integrity and consistent restore drills | Restart loops can hide faults; monitor `/ready` and restart count; revert two Compose settings | Adopted, [#170](https://github.com/shenyankm/PractiQ/pull/170); existing quotas, authentication and storage protections retained |
| 5. Grading array instruction | At `7920df8`, the image anchor in all three runs first fails `list_type`, requiring bounded correction | One prompt-format factor; unchanged five reference/rubric anchors, exact scores, complete context, bounded calls and durable failed-call usage | Untested models/questions may react differently; revert two prompt lines | Adopted, [#174](https://github.com/shenyankm/PractiQ/pull/174): 15/15 scores preserved, 18 → 15 calls; versioned offline failure corpus added |
| 6. PostgreSQL writer reuse | At `5b9210e`, the isolated 40-document benchmark opens 120 control connections; connection times overlap | Compare three uncontended runs with existing ASGI benchmark, real disposable PostgreSQL and 100 ms model substitutes; require gain beyond noise without queue/recovery regression | Serialization/transaction failure can delay admission or recovery; retain original connection boundaries | Rejected: full writer serialization is slower; admission-only reuse reduces connections to 80 but wall times overlap and queue wait increases |
| 7. Parser prompt/schema organization | Existing full Flash baseline fails extraction/structure/evidence gates; tree organization is a single-factor hypothesis | Fixed approved cases, unchanged scorer/thresholds/holdout, supplied-answer extraction only; require passing quality/non-regression evidence | Loss of choices, structure or cross-page associations; revert candidate patch | Rejected and reverted: scoped tree candidate passes only 1/9 quality trials; no parser optimization delivered |
| 8. Grading null-field omission | Complete question payload may contain optional null fields | Same five anchors, three repeats; require preserved scores with consistent total call/cost/latency benefit | Context changes can affect model output; restore original payload | Rejected and reverted: inputs shrink but correction calls remain, output grows and every elapsed observation is worse |
| 9. Service distribution integrity | Measured image/package lacks the project's MIT notice; a retained report symlink can yield a successful empty source package; build backend dependencies are unbounded | Separate license, archive-content and build-tool PRs; retain exact source/lock/license bytes, historical data, all platforms and audits | Packaging omissions or tool incompatibility; revert only scoped metadata/selection/pins, never delete retained reports | Adopted separately in [#175](https://github.com/shenyankm/PractiQ/pull/175), [#177](https://github.com/shenyankm/PractiQ/pull/177), and [#179](https://github.com/shenyankm/PractiQ/pull/179) after dependency [issue #178](https://github.com/shenyankm/PractiQ/issues/178); no package-size or build-speed gain claimed |

The [raw journal evidence](evidence/2026-10-09-engineering/README.md) includes rejected PostgreSQL samples, excluded contention, native/static/image inventories, hosted CI repetitions, complete final parser failure and the cumulative real-model ledger. Per-change reports provide accepted measurements and their focused regression evidence.

## Performance, size and build boundaries

| Measurement | Before → after, or unchanged inventory | Supported conclusion |
| --- | --- | --- |
| Web initial JS/CSS, including static imports | 332,043 bytes; gzip 102,754, unchanged | Complete asset reduction is separate from initial network load |
| Web full static resources | 2,059,410 → 1,240,096 bytes | WOFF/TTF duplicates removed; required WOFF2 faces and notices retained; [font evidence](performance-web-fonts-20261009.md) |
| Service Web clean-build command, paired median/range | 1.333 s (1.328–1.336) → 0.815 s (0.799–0.821) | One duplicate build removed; dependencies and OS caches warm |
| Service Web incremental command, paired median/range | 1.347 s (1.336–1.401) → 0.800 s (0.795–0.834) | Same output hashes; [build-once evidence](performance-build-once-20261009.md) |
| Hosted Service quality job, same head three attempts each | Baseline 624/607/584 s; candidate 599/594/437 s | Median 607 → 594 s, ranges overlap: no overall CI speed claim; caches/runners/network vary |
| 25 MiB Office-entry SHA-256 duration | Median 9.398 → 9.425 ms | No hashing speed gain |
| Maximum 1 ms heartbeat gap during that hash | Median 9.987 → 1.238 ms | Event-loop responsiveness in this probe; [payload evidence](performance-payload-check-20261009.md); no conversion-throughput or tail-latency claim |
| App initial JS/CSS, including static imports | 620,696 bytes; gzip 191,647 | Unchanged app source; inventory only |
| App full static resources | 1,638,348 bytes; 19 WOFF2 assets total 256,168 bytes | Six builds have identical asset hashes; no app size optimization claimed |
| App clean frontend build / incremental samples | 2.677/0.736/0.732 s; 0.715/0.885/0.703 s | Fresh output vs immediate reuse, OS/dependency caches warm; no improvement claim |
| Actual macOS package build, clean Cargo target / incremental | 121.765/121.392/117.493 s; 61.777/61.786/61.798 s | Every actual final DMG passed package validation; registry and OS caches warm; cache-state comparison only |
| Six actual local macOS DMGs | 12,022,039–12,022,063 bytes | Installer metadata varies; byte reproducibility is not claimed |
| Main CI installers at `7920df8` | macOS DMG 12,015,018; Windows NSIS EXE 7,819,610; Android arm64 debug APK 270,392,192 bytes | All supported platforms retained and package-checked; Android includes debug symbols; no signed-release APK or physical-device claim |
| Service image, three cold-layer and three immediate warm builds at `20b1f12` | 1,233,563,089–1,233,563,698 bytes; cold 183.684/165.275/101.638 s; warm 0.584/0.611/1.238 s | Base images/OS cache warm, network uncontrolled; all six build commands succeed and runtime/Web/license contents match; image byte reproducibility and speed improvement are not claimed |

The image inventory driver originally asserted equal byte sizes after all six successful commands. That assertion was wrong: the spread is 609 bytes. The original samples remain, and separate read-only checks establish identical Python modules, lockfile, Web assets, MIT notice and Debian package versions. Do not relabel the driver as wholly passing or use content equality as an image-ID equality claim.

The PostgreSQL baseline median is 3.073 s (3.007–3.349); full serialization is 3.468 s (3.380–3.519); admission-only reuse is 3.080 s (3.046–3.456). Baseline median queue-wait observations are 918–949 ms, versus admission-only 1,175–1,260 ms. A further untouched baseline gives median 3.272 s. Reduced connection count is insufficient evidence to accept either candidate. One contended admission run is retained as excluded evidence.

Runtime inspection also covers checkpoint/artifact fsync and threaded I/O, bounded extraction/normalization, parser scheduling and provider budgets. Web polling already pauses when hidden, aborts obsolete requests, uses 3 s active / 30 s settled intervals, and fetches large previews only when checkpoint/state identity changes. No localized polling or storage bottleneck justifies further change. The three existing native Rust/SQLite stress probes were each run three times with isolated 10,000-question/100,000-attempt databases; all nine probes pass. They cover data operations, not native GUI responsiveness or production tail latency.

## Real Agent evaluation and failure attribution

The user approved Beijing `qwen3.7-flash-2026-07-15`, thinking off, maximum 16,384 output tokens, 33 fixed parser cases and five existing grading anchors, three repetitions per comparison, cumulative CNY 10 / 1,200 calls. A more expensive model/budget was proposed and declined. No such model was called. A guarded transport records unknown cost before dispatch, reserves worst-case spend, and stops rather than treating missing usage as zero or retrying without bound. The [ledger](evidence/2026-10-09-engineering/live-budget.json) has 576 known calls, estimated CNY 0.9387102, zero unresolved unknown calls. List-price estimates are not invoices.

Two approved annotation corrections are historical dataset changes, not threshold adjustments: the original translation fixture says only “into English.” Its source-language gold changed from `zh-CN`, briefly to `zh`, then to `null` after Codex identified the current prompt's explicit-language requirement. The original fixture, other answers, scorer and holdout stay unchanged. [PR #171](https://github.com/shenyankm/PractiQ/pull/171) fixes only this annotation. Older reports cannot be substituted for the final dataset's baseline.

Final parser baseline source: `bb5981ae2c6ccccb01ec022d4471623b22a33967`; evaluator dataset hash `91f0ab04a760ed67a18fce2fedf5c5e07e307827fa252c4bb81af055acbf1b6e`; manifest hash `84dd2203df0da65dc02ab85dbdd2d6b50f363449f2a1b6cc1920f523fcdc0b7e`; scorer 6.0.0. Its [complete report](evidence/2026-10-09-engineering/final-parser-baseline.json.gz) is **FAILED**: 84 execution successes, 12 partial results and three expected errors; 69/96 normal trials pass quality (71.875%), and 62.5% of cases pass all repetitions. Structure accuracy is 35.211%, option accuracy 83.333%, and visual F1 66.667%. Zero invented answers in this batch does not erase 22 extra questions, 23 field mismatches and 31 unverified questions. Do not tune the holdout or lower these gates. Parse-quality readiness remains a known limitation.

Grading adoption is separate: unchanged human-defined reference/rubric anchors retain 15/15 exact scores, and the array instruction avoids three reproducible correction calls. Batch input/output tokens fall 18.8%/12.6%, estimated cost falls 16.3% (CNY 0.0067136 → 0.0056210), and observed five-anchor median elapsed falls 13.259 → 11.935 s. See the [grading report](performance-grading-arrays-20261009.md) for raw usage, variation, bounded recovery and the four-case reconstructed offline Badcase corpus. This small synthetic-anchor comparison does not establish teacher calibration or general score accuracy. Parsing continues extracting supplied evidence without solving questions; grading still requires explicit action and a reference answer or rubric.

## Handbook version and implementation correspondence

Reference: [aliyun/ai-agent-handbook at `6d12dd2dc006eefd0f89f213c4e0ca2edfe7e9a8`](https://github.com/aliyun/ai-agent-handbook/tree/6d12dd2dc006eefd0f89f213c4e0ca2edfe7e9a8), read October 9, 2026. Apply only the advice connected to observed failures:

| Chapter / advice | Existing implementation and bounded application |
| --- | --- |
| 4, orchestration and evidence-based completion | LangGraph prepare/chunk/vision/merge/gate stages, terminal status, finite retries and checkpoint continuation; failed parser quality is recorded independently of successful execution |
| 5, context/state/artifact lifecycle | Source fingerprints, ordered normalization manifests, checkpointed partial output and content-addressed local artifacts; retain full grading context after null-omission regression |
| 13, observability and attributable cost | Task/run/call-kind associations, validation issue paths, durable usage receipts, known/unknown spend and repeated latency samples; no new cloud platform |
| 14, untrusted inputs and data boundaries | Strict contracts, checksums/path/size limits, memory-only Web token, native credential stores, supplied-answer parsing and explicit evidence-backed grading; embedded-instruction anchors remain |
| 21, golden sets and fixed comparison criteria | Versioned 33 parser cases, retained holdout, five reference/rubric grading anchors; approved annotation changes rebuild the baseline and keep previous failures |
| 22, Badcase attribution and single-factor adoption | `list_type` failures motivate only array-format instructions; versioned reconstructed string/null regressions preserve failed-call usage and cached recovery; rejected tree/null-context experiments remain traceable |

No new Agent framework, multi-Agent workflow, RAG, vector store or cloud observation system is needed for these problems.

## Delivery and verification status

| PR | Verified main squash SHA |
| --- | --- |
| [#168 Web fonts](https://github.com/shenyankm/PractiQ/pull/168) | `5b9210ee5b53b048987d5fe4b87aee50450f0480` |
| [#170 restart/readiness](https://github.com/shenyankm/PractiQ/pull/170) | `7920df81f7dbf0096eff45c5ab5d61fd5952e8b4` |
| [#172 build once](https://github.com/shenyankm/PractiQ/pull/172) | `87d1c4055f13988ac22d81f12b7c12d4b8ff4105` |
| [#171 approved language gold](https://github.com/shenyankm/PractiQ/pull/171) | `e76dbcf1af4664bb46d56d3e83e7246d45680868` |
| [#173 shared payload check](https://github.com/shenyankm/PractiQ/pull/173) | `3bf252dd4f9e79bd44c08aa8c30d97bb26762b38` |
| [#174 grading arrays](https://github.com/shenyankm/PractiQ/pull/174) | `0b6d908ffe68fcf381e43a719fb5304214cbae60` |
| [#177 source package contents](https://github.com/shenyankm/PractiQ/pull/177) | `b95553b1cfe6ea468e3903c6bbf583fba73d2077` |
| [#175 distribution license](https://github.com/shenyankm/PractiQ/pull/175) | `e784ba4c83fe3d3a3b7e63a97da1fbb6d4bb4bc0` |
| [#179 build-tool constraints/audit](https://github.com/shenyankm/PractiQ/pull/179) | `100781ec56f607c8160ec5b78df5e461ee5ffb66` |

Each merged change required successful `Service CI`, `Desktop CI`, `Android CI`, Codex review of its latest head, resolved conversations, no conflict and the current protected base. Conventional Commits retain the user's primary author identity and Codex coauthor. Full service verification retains the 90% threshold; observed local combined coverage is 93%. Web checks use substitutes; hosted native package checks and Android API 35 instrumentation are actual builds/emulator execution. Native package inventories identify their source; app source did not change in this round.

The final code baseline is main `100781ec56f607c8160ec5b78df5e461ee5ffb66`, confirmed after #179 merged. All 32 installed Python modules and the complete bundled lock in the measured image match this main source. Final document changes stay outside `server/`, `web/` and `app/`. The service's last full local `make verify` passes 1,779 tests and 93% combined coverage. #179's initial Android emulator job failed while downloading/unpacking the NDK ZIP, before building or testing; the same head's failed-job rerun passes. This is not a test pass for the failed attempt.

PR #174 was already merged when the explicit merge command ran. Its existing GitHub default squash body retains individual commit messages/coauthor lines; main history was not rewritten. The user's primary author and Codex coauthor are present.

## Final single-machine profile and recovery

The [final raw deployment records](evidence/2026-10-09-engineering/README.md) extend the earlier [single-machine report](operations-single-machine-20261009.md), without replacing its source/time boundaries. Host: macOS 27.0.1 arm64, 16 GiB; Docker Desktop 29.8.2 runs a Linux aarch64 VM with 10 CPUs, 8,319,504,384 bytes RAM and kernel `7.0.14-linuxkit`. This validates a local Linux VM deployment, not an online ECS host or a minimum whole-machine specification.

| Profile element | Verified setting and evidence |
| --- | --- |
| AI service | One Uvicorn process; UID/GID 10001; 2 CPUs / 2 GiB / 128 PID; read-only root, bounded writable tmpfs, dropped capabilities and privilege escalation disabled |
| PostgreSQL | Dedicated PostgreSQL 16 database; 1 CPU / 1 GiB / 128 PID; `practiq` owner has no superuser/create-database/create-role privileges; direct loopback connection and session ownership lock |
| Persistent files | Existing absolute Linux VM path, UID 10001 and mode 0700; actual bind mount backed by Linux-local `ext2/ext3` (the `stat` label); original directories/databases/backups retained |
| Admission/model settings | `N_JOBS_PER_WORKER=4`, `AI_GRAPH_MAX_CONCURRENCY=2`, `AI_PROVIDER_CONCURRENCY=8`, `AI_MAX_BUSY_THREADS=8`, `AI_UPLOAD_CONCURRENCY=4`; synthetic provider RPM 100000 only to avoid artificial rate waits |
| Measured image | Source `2878ecad830b213010c4ca9d08853e01258a5a38`, Docker image ID `sha256:edf0a70198028c9df59290d9f94cec0d8b6ef0beebd069cd3a52e22b92360364`, 1,233,571,946 bytes; all source modules and lock match final code main |
| Model boundary | Existing `recovery_provider.py`, loopback-only, fixed 2-second delay; `gpt-4o-mini` is a stub identifier here. No paid provider is contacted for deployment/load/fault drills |

Three paced repetitions submit 200 fresh TXT tasks each, in 25 drained batches of eight with at most four simultaneous submissions. All **600/600** tasks succeed without rejection/error. Raw repetition elapsed values are 172.074/155.608/148.190 seconds; service/database/file caches are reused after startup. Each eight-task batch passes the existing driver's admission/liveness/concurrency checks. Batch percentiles are retained as raw observations and do not establish stable tail latency or real-provider capacity. Sampled running/provider peaks are four, within configured limits. Cgroup memory peak after this load is 306,814,976 bytes; after the additional format pipeline it is 609,161,216 bytes, with zero OOM/max-limit events. The raw drill's `resourcesAfter600Tasks` field was captured after the additional formats as well.

Actual default-format preprocessing/persistence/export completes all nine supported formats three times (27 tasks), with valid ZIP CRCs and hashes. The earlier image's execution code fingerprint/runtime equals the composed final image. The final Linux-local profile separately completes scanned PDF and Word/Excel text modes three times (15 tasks). Its twelve actual Office manifests pass strict ordering/source/type/byte/checksum validation; XLS and XLSX each retain two visible/hidden fixture sheets and 48 CSV cells per repetition. Text normalization loses layout/formula semantics as already documented; this proves the supplied fixture boundaries, not arbitrary Office fidelity or semantic AI accuracy.

Final fault/restore assertions pass:

- SIGKILL during a dispatched call triggers automatic restart, retaining the original run ID, one unknown-call record and subsequent known usage. Exactly-once provider execution is not claimed.
- Stopping PostgreSQL causes fail-closed ownership loss/restart. One observed recovery takes 5.956 seconds; the saved result/usage is unchanged and no new provider call is made. This single observation is not a recovery-time guarantee.
- Missing/corrupt saved artifacts return 404/409 without model work. A second offline owner is rejected. Maintenance retains reads (200) and rejects new tasks/grading (503).
- A verified local HTTPS CA/SAN edge serves `/ready`; metrics require Bearer authentication (401/200), and removed `/metrics` returns 404. Existing six alert rules pass syntax plus healthy/firing/recovered waveform tests using an ephemeral pinned promtool image. Rule simulation does not prove receiver delivery.
- Logs omit tested document markers and service/provider secrets; task/run/call correlation remains available. Graceful stop logs shutdown completion with exit 143 and no OOM.
- With the process stopped, a custom PostgreSQL dump and matching file archive restore into a **new** dedicated database/Linux-local directory. All twelve table digests, the grading sequence, all file hashes, run/result/usage/unknown records, bank bytes and cached grading receipt match. The snapshot contains 616 tasks/runs/receipts, 10,478 checkpoints, one grade and one grade call. Rollback to the retained original configuration also matches; restore/replay/rollback make zero additional provider calls. Private dumps/configurations/files remain local and are excluded from Git.

The initial eight-way submit burst correctly hits the four-slot upload gate (two 429 responses). More seriously, Docker Desktop's macOS shared bind (`fuseblk`) produces one `OBJECT_STORE_UNAVAILABLE` task in each of three paced/diagnostic profiles. A representative pass-through diagnostic records `_read` raising `FileNotFoundError` (errno 2), with the immutable path present immediately afterward. The root cause is not conclusively isolated. All three failed tasks retain their checkpoints and complete after explicit sequential resume; no hidden retry or validation bypass was added. **That shared filesystem fails this workload and is excluded from the accepted deployment profile.** Linux-local storage passes the complete 600-task profile. Preserve the failed samples; do not generalize this VM result to every filesystem or deployment.

The [package-source report](service-package-source-20261009.md), [license report](service-distribution-license-20261009.md) and [build-tool report](service-build-tools-20261009.md) record their separate correctness baselines. The final three constrained archives have identical hashes and exact source/lock/MIT metadata; runtime/dev and six build pins have no known vulnerabilities at capture. Full lock bytes affect execution fingerprints even when runtime package versions do not change: drain before upgrade and retain the original deployment for unfinished tasks. Native installers and OCI metadata are not claimed byte-reproducible.

## Conclusions for the six requirements

| Requirement | Delivered conclusion and remaining boundary |
| --- | --- |
| Runtime performance | Adopted measured event-loop improvement; rejected noisy/slower PostgreSQL candidates. Storage/checkpoint integrity, polling boundaries and nine native large-bank probes remain intact |
| Size and build cost | Web complete assets reduced 39.8%; one repeated Web build removed. Initial load, App/package/image inventories and total CI timings are reported separately without invented gains |
| Code reuse and compatibility | Storage and Office share the same size/checksum validator, with cancellation/rejection regressions; API/ZIP/practice/backup contracts and generated front-end type source remain unchanged |
| Single-machine production configuration | Restart/readiness delivered; explicit Linux-local resource profile, sustained substitute load, HTTPS/auth/alerts, faults and consistent restore/rollback verified. Shared-macOS storage and real-provider capacity remain outside acceptance |
| Agent optimization | Real reference/rubric grading anchors preserve exact scores with fewer corrections/calls/tokens/cost. Versioned Badcases and fixed approved gold retained; complete Flash parser quality still fails and no parser candidate was adopted |
| Documentation and open-source practice | English/Chinese indexes, operations/contribution guidance, dated reports and raw hashes synchronized; source/lock/license package gates and build audits delivered. No publication, HA, physical-device or general model-quality claim |
