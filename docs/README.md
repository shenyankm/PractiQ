# Find the right PractiQ guide

PractiQ has an independent AI import service and Web frontend, and an offline practice app for macOS, Windows and Android. Use the guides below for current behavior. Dated implementation and evaluation records describe only their recorded source, artifacts and runs; they do not establish current release or model-quality acceptance.

## Use the app and import documents

| Task | Guide |
| --- | --- |
| Install prerequisites and run from source | [English overview](../README.md), [Chinese overview](../README.zh-CN.md) |
| Choose questions, submit answers, review scores and keep drafts | [Practice guide](practice-guide.md) |
| Start, control and review AI imports | [Import tasks](import-tasks.md) |
| Import/share bank ZIPs or restore personal study data | [Question-bank packages and backups](question-bank-package.md) |
| Develop or verify Android native flows | [Android guide](../app/docs/android.md) |
| Explore UI scenarios without native storage or model calls | [Development preview](../app/docs/development-preview.md) |

## Integrate and operate the service

| Task | Guide |
| --- | --- |
| Configure/start the service and call subjective grading | [Service guide](../server/docs/service-guide.md) |
| Create/query/control tasks and read/export saved results | [Document-task API](../server/docs/document-tasks.md) |
| Back up service state, recover tasks and perform maintenance | [Operations](../server/docs/operations.md) |
| Configure service-side Word/Excel normalization | [Office guide](../server/docs/desktop-office.md) |
| Understand versions, storage relationships and immutable sessions | [Question model](question-model.md) |
| Look up question fields, type examples and rendering/scoring rules | [JSON and rendering reference](question-types-data-rendering.md) |
| Validate fixtures and measure extraction/grading quality | [Evaluation](../server/docs/evaluation.md) |

The question model owns data-version and relationship explanations; the JSON/rendering reference owns detailed field/type mappings. User guides link to these references instead of maintaining a second schema. The API guide owns task payloads and controls; the import guide explains the corresponding user actions.

## Contribute and record acceptance

These documents define procedures and outstanding evidence, rather than completed acceptance:

| Work | Guide or worksheet |
| --- | --- |
| Prepare issues/PRs and choose checks | [Contributing](../CONTRIBUTING.md) |
| Report vulnerabilities and review dependencies | [Security policy](../SECURITY.md) |
| Review outstanding workstream status | [Roadmap evidence](roadmap-evidence.md) |
| Review source annotations and import quality | [Quality worksheet](import-quality-acceptance.md), [ten-format source map](import-corpus-source-review.md) |
| Select/tag/stage release assets | [Release policy](releases.md) |
| Record final bytes, signing and target-system acceptance | [Final-package worksheet](final-package-acceptance.md) |
| Obtain voluntary feedback and record actual trials | [Trial protocol](desktop-user-trial.md) |
| Reproduce contributor setup and hand over responsibilities | [Contributor handover](contributor-handover.md) |

Fixture provenance and reproduction belong beside their inputs: [service-export](../app/fixtures/service-export/README.md), [AI-import corpus](../app/fixtures/ai-import/README.md), [Office fixtures](../app/fixtures/office/README.md), and [rich-content fixtures](../app/fixtures/rich-content/README.md). Package notices are documented in [app licenses](../app/licenses/README.md).

## Read historical evidence

Preserve failures, source hashes, artifact hashes and original denominators. Historical references to desktop AI import, embedded Python/LibreOffice, Linux app builds, earlier schemas, Agent Server, PostgreSQL, Redis or cloud object storage are descriptions of retired versions. Follow the current guides above for setup; old commands may refer to removed scripts. Model substitutes, successful CI and old installer builds do not establish live-model, clean-machine, participant or signing acceptance.

| Historical record | Scope |
| --- | --- |
| [Native import, 2026-09-29](ai-import-acceptance-20260929.md) | Former desktop import workflow; small real-model sample and failures |
| [Ten-format acceptance](ai-import-all-formats-acceptance-20260929.zh-CN.md), [repair/retest](ai-import-repairs-20260929.zh-CN.md) | Original 2026-09-29 live results; complete acceptance remained 0/10 |
| [Functional audit](functional-audit-20260922.md), [closed-PR follow-up](review-follow-up.md) | Earlier findings and scoped repairs |
| [September 28 repairs](review-fixes-20260928.md), [September 29 implementation](review-implementation-20260929.md), [PR 83 follow-up](pr83-review-fixes.md) | Successive repair records; later corrections do not rewrite original measurements |
| [October 3 performance](performance-implementation-20261003.md), [October 5 performance](performance-implementation-20261005.md) | Separate measured workloads and source baselines, not duplicate benchmarks |
| [Service code review](../server/docs/code-review-2026-09-19.md), [SQLite/macOS delivery](../server/docs/sqlite-desktop-delivery.md), [desktop Office evaluation](../server/docs/desktop-office-evaluation.md) | Earlier service/package architectures and their validation limits |
| [Service reports](../server/reports/) | Dated runtime, capacity and performance records with their original JSON evidence |
| [Saved evaluation reports](../server/reports/evaluations/) | Historical scorer/model runs; generated report bodies stay unchanged |

Ignored `server/reports/checks/`, temporary files and expired Actions artifacts may be unavailable in a fresh checkout. Their recorded filenames and hashes identify prior evidence, not downloadable files or current passes. Reproduce a check against the selected source with fresh output paths; do not manufacture missing historical reports.
