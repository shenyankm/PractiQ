# Historical reports and evidence

These records preserve the result of a particular source revision, workload and toolchain. They are not current release, production-capacity or model-quality guarantees. Keep failures, source/artifact hashes, original denominators and excluded runs with their evidence.

## Import and extraction

| Record | Scope |
| --- | --- |
| [Extractor startup, October 16](../extractor-startup-20261016.md) | Reduced worker imports; original timeout remains unresolved |
| [Native import acceptance, 2026-09-29](import/ai-import-acceptance-20260929.md) | Former desktop import flow; small real-model sample and failures |
| [Ten-format acceptance](import/ai-import-all-formats-acceptance-20260929.zh-CN.md) and [repair/retest](import/ai-import-repairs-20260929.zh-CN.md) | Original live results; complete acceptance remained 0/10 |
| [Implementation review, 2026-09-29](import/review-implementation-20260929.md) | Historical implementation and validation scope |

## Performance

| Record | Scope |
| --- | --- |
| [Cross-component audit, October 29](../evidence/2026-10-29-performance-audit/README.md) | Source-presence ranges, native-table captions, answer-card drafts and manual paper selection; equivalent outputs, bounded measurements and local validation |
| [Answer-source validation, October 29](performance/answer-evidence-20261029.md) | Call-local candidate index, reused/skipped parsing, literal/ambiguity regressions, isolated paired measurements and sandbox validation limits |
| [Runtime optimizations, October 25](performance/runtime-optimizations-20261025.md) | Ten review items: buffer lifetimes, event-loop work, bounded artifact/export reads, Tencent client reuse and native SQL; paired probes and local acceptance |
| [Cross-component optimizations, October 22](performance/performance-optimizations-20261022.md) | All 16 recommendations, deterministic work counts, bounded native timings, recovery/browser/package acceptance and exclusions |
| [October 3](performance/performance-implementation-20261003.md) and [October 5](performance/performance-implementation-20261005.md) | Separate measured workloads and source baselines |
| [Web fonts, October 9](performance/performance-web-fonts-20261009.md) | Static assets and repeated build samples; no initial-load or image-size claim |
| [Web and service, October 15](performance/performance-web-server-20261015.md) | Shared-option search, duplicate-association indexing and artifact membership; synthetic measurements and limits |
| [App, October 15](performance/performance-app-20261015.md) | Snapshot and draft-context copies; paired output hashes and local timings |
| [Rust, October 17](performance/performance-rust-20261017.md) | Full native source review and measured immutable-snapshot copy removal |
| [Rust selected references](performance/rust-selected-reference-index.md) | Requested-row-only snapshot reference index; paired release samples and local App acceptance |
| [Python shared options](performance/python-shared-option-validation.md) | One option-pool serialization per validation call; equivalent outputs and paired CPU measurements |
| [Python, October 17](performance/performance-python-20261017.md) | Source-frame lookup and passive result projection; paired local measurements |
| [Agent pipeline, October 17](performance/agent-pipeline-20261017.md) | Independent dispatch notifications, bounded storage workers, pause admission and persistence deadlines |
| [Grading arrays, October 9](performance/performance-grading-arrays-20261009.md) | Fixed real-model anchors and avoided correction calls; no full parser-quality claim |
| [Payload checks, October 9](performance/performance-payload-check-20261009.md) | Shared storage/Office size-checksum validation and event-loop probes |
| [Web build-once, October 9](performance/performance-build-once-20261009.md) | One duplicate build removed; no overall CI-speed claim |
| [Store contention](performance/store-contention-20261010.md) and [editor snapshots](performance/editor-snapshots-20261010.md) | Synthetic fixed-source workloads; no hardware responsiveness guarantee |

## Engineering and packaging

| Record | Scope |
| --- | --- |
| [Engineering optimization, October 9](engineering/engineering-optimization-20261009.md) | Accepted/rejected candidates, build/package inventories and retained quality failures |
| [Service build tools](engineering/service-build-tools-20261009.md) | Locked backend build dependencies and recovery-fingerprint boundary |
| [Service packaging and licensing](engineering/service-packaging-20261009.md) | MIT notices in wheel/sdist/image and source-archive integrity guard |
| [Common App CI, October 10](engineering/common-app-ci-20261010.md) | Shared App quality job; one occupancy observation, not a universal speedup |

## Operations and stability

| Record | Scope |
| --- | --- |
| [Single-machine checks, October 9](operations/operations-single-machine-20261009.md) | Isolated quotas, synthetic overload, failure drills and backup restore |
| [Stability controls, October 16](operations/stability-controls-20261016.md) | Storage admission, monitoring, load authentication and Web deadlines |
| [Temporary resources and recovery, October 16](operations/stability-resource-recovery-20261016.md) | Scratch admission, backup sets and clean-target restore boundaries |

## Product and UI

| Record | Scope |
| --- | --- |
| [Component style audit](product/design-audit.md) | Dated control/component review and its browser-validation limits |
| [Responsive content verification](product/responsive-content-20261014.md) | App/Web question layout and rich-content checks |

## Preserved external evidence

[Service reports](../../server/reports/) retain dated runtime, capacity and performance records with their original JSON. [Saved evaluation reports](../../server/reports/evaluations/) retain historical scorer/model runs; generated report bodies stay unchanged. Old references to retired architecture remain useful only as descriptions of those source versions.

Some `server/reports/checks/` files, temporary outputs and expired Actions artifacts are ignored or unavailable in a fresh checkout. Their recorded filenames and hashes identify prior evidence; they do not imply that those files can be downloaded or that a check currently passes. Reproduce checks against the selected source using fresh output paths. Do not manufacture missing historical reports.
