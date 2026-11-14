# Historical reports and evidence

These records preserve the result of a particular source revision, workload and toolchain. They are not current release, production-capacity or model-quality guarantees. Keep failures, source/artifact hashes, original denominators and excluded runs with their evidence.

## Import and extraction

| Record | Scope |
| --- | --- |
| [Import correction workbench, November 6](import/workbench-20261106.md) | Source comparison, human revision history, optimistic saves and explicit revised ZIP export |
| [PNG type labels, November 6](import/type-labels-20261106.md) | New-response correction for missing known type labels; saved null compatibility, call budgets and same-source live workflow acceptance |
| [Native import acceptance, 2026-09-29](import/ai-import-acceptance-20260929.md) | Former desktop import flow; small real-model sample and failures |
| [Ten-format acceptance](import/ai-import-all-formats-acceptance-20260929.zh-CN.md) and [repair/retest](import/ai-import-repairs-20260929.zh-CN.md) | Original live results; complete acceptance remained 0/10 |
| [Implementation review, 2026-09-29](import/review-implementation-20260929.md) | Historical implementation and validation scope |

## Performance

Retired Rust/Python performance narratives and their top-level reports were
removed on November 14, 2026. Git history retains those versions. Raw historical
evidence, live-quality records and frontend reports remain; none certifies the
current Electron runtime. See the [current audit](../../app/docs/performance-desktop.md).

| Record | Scope |
| --- | --- |
| [Unified workflow, November 2](performance/workflow-20261102.md) | Production Web, real Tencent/model and downloaded ZIP through native practice/restore; 3/3 functional chains, 2/3 strict content gates |
| [Cross-component audit, October 29](../evidence/2026-10-29-performance-audit/README.md) | Source-presence ranges, native-table captions, answer-card drafts and manual paper selection; equivalent outputs, bounded measurements and local validation |
| [Web fonts, October 9](performance/performance-web-fonts-20261009.md) | Static assets and repeated build samples; no initial-load or image-size claim |
| [Editor snapshots, October 10](performance/editor-snapshots-20261010.md) | Frontend normalized snapshot reuse and dirty-state correctness |
| [Answer display, October 20](performance/performance-typescript-20261020.md) | Frontend item lookup work and preserved answer rendering |
| [Word counting, October 20](performance/typescript-words-round2-20261020.md) | Frontend Unicode word-count traversal and bounded allocations |
| [Grading arrays, October 9](performance/performance-grading-arrays-20261009.md) | Fixed real-model anchors and avoided correction calls; no full parser-quality claim |

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
