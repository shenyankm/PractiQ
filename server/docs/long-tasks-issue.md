> 历史记录：当前版本已改用 SQLite，并已移除 Excel、Word 源文件解析与 LibreOffice 依赖；下文保留当时的范围与验证结果。

> 历史设计记录：其中 Agent Server / Redis / 原生 API 部分已被开源运行时替换。当前接口与部署以 [document-tasks.md](document-tasks.md) 和 [operations.md](operations.md) 为准。

# Add durable pause, resume and failed-unit retry for document tasks

Issue draft; not published.

## Problem

Document graphs resume unfinished nodes, but completed failed units are not retried.
Users cannot request a cooperative pause or distinguish recovery from reparsing.
Model attempts inside a node can repeat after storage errors or interruption.

## Proposed change

Reuse Agent Server threads, runs, checkpoints and Store for three authenticated
document-task endpoints. Add cooperative pause, immediate interruption, checkpoint
resume, selected failed-unit retry and optional human review. Preserve default
PARTIAL results, verified object references, bounded concurrency and model budgets.
Persist model attempts and usage independently from downstream artifact writes.
Reject incompatible execution snapshots and keep historical tasks on their old
deployment instead of migrating checkpoints.

TXT/CSV use the required text model; other formats use the required vision model. XLSX combines cells and visual views per worksheet. PDF/DOCX/image pages directly produce structured
questions and figures; remove OCR transcription and the second text-model pass.
Preserve successful pages during failed-page retry.

## Acceptance

Test parallel pause/resume, retained attempt budgets, storage failure after model
completion, partial/all-unit retry, direct visual extraction and failed-page retry, request conflicts,
snapshot/reference validation and complete usage accounting. Run make verify.
Production readiness additionally requires PostgreSQL/Redis process-crash drills
with both local persistent storage and a real OSS bucket; development-server tests
do not establish that guarantee. Do not publish or deploy as part of this draft.
