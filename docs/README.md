# PractiQ documentation

PractiQ has an independent AI import service and Web frontend, plus an offline practice app for macOS, Windows and Android. Start with the current guides below; dated reports describe only their recorded source and evidence.

## Directory map

| Directory | Contents |
| --- | --- |
| `guides/` | Practice, import tasks, bank ZIPs and personal backups |
| `reference/` | Question data model, JSON fields, rendering and scoring |
| `product/` | Current visual specification and interaction rules |
| `acceptance/` | Import-quality, source-review, release-package and user-trial procedures |
| `maintainers/` | Contributor handover, release policy, roadmap and merge automation |
| `history/` | Dated implementation, performance, operations and UI reports; see [history index](history/README.md) |
| `evidence/` | Text records, measurements and original hash manifests tied to dated reports |
| `assets/` | Root README screenshots and source-document images used by guides and reports |

## Use the app and import documents

| Task | Guide |
| --- | --- |
| Install prerequisites and run from source | [English overview](../README.md), [简体中文概览](../README.zh-CN.md) |
| Practise, submit answers and review scores | [Practice guide](guides/practice-guide.md) |
| Start, control and review AI imports | [Import tasks](guides/import-tasks.md) |
| Import/share bank ZIPs or restore personal study data | [Question-bank packages and backups](guides/question-bank-package.md) |
| Develop or verify Android native flows | [Android guide](../app/docs/android.md) |
| Explore UI scenarios without native storage or model calls | [Development preview](../app/docs/development-preview.md) |

## Integrate and operate the service

| Task | Guide |
| --- | --- |
| Configure phone/account-token access, import points and operator reconciliation | [SaaS guide](../server/docs/saas.md) |
| Configure RabbitMQ delivery and explicitly upgrade service schemas | [Delivery and recovery](../server/docs/rabbitmq.md) |
| Configure/start the service and call subjective grading | [Service guide](../server/docs/service-guide.md) |
| Create/query/control tasks and read/export saved results | [Document-task API](../server/docs/document-tasks.md) |
| Back up service state, recover tasks and perform maintenance | [Operations](../server/docs/operations.md) |
| Configure service-side Word/Excel normalization | [Office guide](../server/docs/desktop-office.md) |
| Validate fixtures and measure extraction/grading quality | [Evaluation](../server/docs/evaluation.md) |
| Check checkpoint compatibility after a change | [Resume compatibility](../server/docs/resume-compatibility.md) |

The API guide owns task payloads and controls; the user import guide explains the corresponding actions. The question model owns data versions and relationships; the JSON/rendering reference owns detailed field and type mappings.

## Product, data and acceptance

| Topic | Guide |
| --- | --- |
| Shared App/Web theme and component styles | [Visual specification](product/design.md) |
| Workspace interaction rules | [Workspace UX decisions](product/ux-workspace.md) |
| Question versions and relationships | [Question model](reference/question-model.md) |
| Question fields, types, rendering and scoring | [JSON and rendering reference](reference/question-types-data-rendering.md) |
| Import quality and source annotations | [Quality worksheet](acceptance/import-quality-acceptance.md), [source map](acceptance/import-corpus-source-review.md) |
| Final package bytes, signing and target-system acceptance | [Final-package worksheet](acceptance/final-package-acceptance.md) |
| Voluntary user feedback | [Trial protocol](acceptance/desktop-user-trial.md) |

## Maintain and contribute

| Task | Guide |
| --- | --- |
| Prepare issues/PRs and choose checks | [Contributing](../CONTRIBUTING.md) |
| Report vulnerabilities and review dependencies | [Security policy](../SECURITY.md) |
| Review dependency risks and repository safeguards | [Dependency security](maintainers/dependency-security.md) |
| Review outstanding workstream status | [Roadmap evidence](maintainers/roadmap-evidence.md) |
| Reproduce contributor setup and hand over responsibilities | [Contributor handover](maintainers/contributor-handover.md) |
| Operate the trusted PR merge workflow | [PractiQ agent-bot](maintainers/maintainer-agent.md) |
| Select, tag and stage release assets | [Release policy](maintainers/releases.md) |

Fixture provenance and reproduction belong beside their inputs: [service-export](../app/fixtures/service-export/README.md), [AI-import corpus](../app/fixtures/ai-import/README.md), [Office fixtures](../app/fixtures/office/README.md), [SaaS-export](../app/fixtures/saas-export/README.md), and [rich-content fixtures](../app/fixtures/rich-content/README.md). Package notices are documented in [app licenses](../app/licenses/README.md).

Historical descriptions of desktop AI import, embedded Python/LibreOffice, Linux app builds, earlier schemas, Agent Server, Redis or cloud object storage refer to retired versions. The current service uses PostgreSQL and RabbitMQ; SQLite belongs to offline App storage. Model substitutes, successful CI and old installer builds do not establish live-model, clean-machine, participant or signing acceptance. Follow current guides for setup; old commands may refer to removed scripts.

Superseded review/fix journals and the duplicate theme-preview guide were removed; their source remains in Git history. On October 17, 2026, UI acceptance and local test screenshots were removed except for the three images used by the root English and Chinese README files. Application icons, test fixtures, source-document images, parsing artifacts and performance reports are retained. The [historical screenshot manifest](evidence/screenshots-removed-20261017.sha256) records all 88 removed tracked screenshot paths and SHA-256 values; recover those files from Git commit `6a0ea50`. Other historical manifests also retain original screenshot entries; those entries do not mean the images remain available in the checkout. Ignored `server/reports/checks/`, temporary files and expired Actions artifacts may be unavailable in a fresh checkout; recorded filenames and hashes identify prior evidence, not downloadable files or current passes.
