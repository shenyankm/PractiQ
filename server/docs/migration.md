# Monorepo AI migration and Java compatibility

## Ownership and execution

The standalone current working tree was migrated into `server/`, not copied from its older HEAD. The package, native tests, fixtures/evals, historical reports, logo assets, scripts, engineering/interview docs, `uv.lock`, and `langgraph.json` are self-contained here. There is no nested Git repository. The original repository is not required by imports, editable installation, tests, builds or runtime.

`src/practiq_ai/graphs/document.py` is the **only document parser**. The old `server/agents/parser.py`, `server/agents/vision.py`, `server/chunking.py` and old format readers were removed. Existing answer/report generators, DTOs, envelopes, transport safeguards and their tests moved into `src/practiq_ai/product/` and `product_tests/`. Native contract/extraction/workflow tests replace tests of the removed parser; generator and HTTP tests were preserved, not discarded.

Java's existing `InternalAiClient`, `AiTaskWorker`, `ImportService` and `AiTaskService` remain the product authority. No product SQL, authentication, billing, queue or retry rules moved to Python. A Java worker/client regression test exercises the unchanged real HTTP client against synthetic facade success/failure responses. Its isolated PostgreSQL case also runs the real worker, persists all four answer modes, reads the owner-filtered task result (including image bytes and PARTIAL failure details), rejects another owner's read, and verifies usage replay is idempotent. `make api-schema-smoke` includes this regression.

That end-to-end regression exposed an existing Java blocker: PostgreSQL `ResultSet.getObject()` returns `Timestamp` for `deadline_at`, while `AiTaskService.claim()` expected `OffsetDateTime`. With supervisor approval, only the AI service's row mapper now converts JDBC `Timestamp` to UTC `OffsetDateTime`, preserving already-correct values and nulls. No deadline, queue or billing business rule changed.

## Compatibility contract

All AI routes require the shared bearer token (the existing `GET /api/health/live` liveness probe remains public):

- `POST /api/v1/ai/parse-document`: retains `{sourceType,fileName?,text?,fileBase64?,mimeType?}`. Text is UTF-8; binary Base64 is strictly decoded and bounded. File MIME is normalized by source type because Java uses `application/octet-stream` for some imports. Files are written into the native content-addressed OSS namespace and then verified by the same graph as native requests.
- `POST /api/v1/ai/generate-answer`: existing answer request/result and usage envelope.
- `POST /api/v1/ai/learning-report`: existing strict scope/statistics request/result and usage envelope.

A Java parse request still looks like:

```json
{"sourceType":"text","fileName":"quiz.txt","text":"1. Is two even? Answer: true"}
```

Success retains `{data,meta}`. `data` contains `questions`, `groups`, `visualElements`, `warnings`, `qualityScore`, plus additive `status` and `processing`. `meta.usage` contains per-call UUID, model ID, input/output token counts and call kind. Error responses retain `{error:{code,message,...},meta:{usage:[...]}}` with the appropriate HTTP status.

| Native result | Java facade result |
| --- | --- |
| `confidenceScore` | `qualityScore` |
| choice `{correctOption:"A"}` | unchanged (Java persists `{correct:["A"]}`) |
| true/false `{value:false}` | `{answer:false}` |
| fill-blank `{answers:["x"]}` | unchanged |
| short-answer `{text:"x"}` | `{answer:"x"}` |
| `status`, `processing` | retained in persisted task result |
| visual `imageRef` | retained plus bounded `imageBase64` preview |

`PARTIAL` preserves successfully parsed questions and all unit failure/truncation/skipping metadata; returned questions are marked `needsReview=true`. Java continues to persist imports as draft bank links and stores the complete result on the owner-authorized AI task. Its task/job status remains succeeded/completed for a usable partial result; `result.status=PARTIAL` is not hidden or promoted to full graph success. No new database status was invented.

All-fragment failure, empty output, storage/checksum failure and deadline expiry remain failures. The facade enforces the existing 180-second total deadline, while Java retains its independent task deadline and 185-second read timeout. Request-local usage is captured immediately after each provider response, including validation-repair calls, and is returned even if a subsequent graph/storage operation fails or times out. Concurrent requests cannot share usage. Java's existing settlement, refund, cancellation, source-cleanup and retry rules are unchanged.

## Native APIs and image access

The same Agent Server still registers `document_parser`, `text_csv_parser`, `pdf_parser`, `docx_parser`, and `excel_parser` with native OSS references, state/checkpoint/resumption and `SUCCEEDED`/`PARTIAL` outputs. `POST /api/uploads` retains its typed signed-PUT metadata contract. The graph never stores Base64 sources in state.

`POST /api/artifacts/read` accepts an `ArtifactReference` and returns size/SHA-256 verified bytes with `Cache-Control: no-store`, under service-token authentication. It rejects arbitrary object namespaces. This route is backend-only: do not disclose service credentials to the Mini Program. Java owner-authorized task results include non-expiring inline previews; larger originals remain available to trusted integrations using `imageRef`. Embedded document visuals now also retain their source artifact reference. No public bucket ACL, permanent public URL or product persistence was added to Python.

The native formats and page/character limits are the migrated source's limits. DashScope/DeepSeek behavior is retained, and existing Moonshot configuration remains supported rather than silently removing that provider. The answer/report generators only construct a text model, so native DeepSeek vision configuration does not disable those unrelated operations.

## Files and local configuration

The complete byte-preserving pre-migration backups (including both `.git` directories, ignored configuration, untracked files and caches) remain outside this repository at `/home/sheny/practiq-migration-backups/20260908-133554/`.

Not carried from the source working tree:

- `.git/`: repository metadata/history; the parent repository is authoritative, full history remains in the backup.
- `.codex/`, `.qoder/`, `.vscode/`: agent/editor-local metadata, not application source.
- `.langgraph_api/`: local run/checkpoint runtime state; not a product database or portable source fixture. Backed up, not reused as fresh runtime state.
- `.coverage`, `.pytest_cache/`, `.ruff_cache/`, `__pycache__/`, `*.pyc` (including under scripts/source/tests): generated caches and coverage results; regenerated by validation.
- `dist/`: stale standalone wheels/sdists; rebuilt from the migrated path.
- Source `.github/workflows/ci.yml`: relocated/adapted to root `.github/workflows/server.yml`, including lock, lint, typing, audit, coverage, graph validation, package and root Docker build checks.

The ignored source `.env` is copied byte-for-byte to `server/.env` with mode 0600. Root `.env.local` retains all existing bytes; only a missing shared `AI_SERVICE_TOKEN` was appended from local source configuration. Secret values are never included in this document, versioned source, or image. Neither environment file is overwritten by setup commands. Keep shared root/server token/model values consistent when editing them.

The pre-existing ignored `server/.venv` is not used or recreated. `make server-install`, `make server-dev`, and `make test-server` use `/home/sheny/miniconda3/envs/langgragh/bin/python` (override `AI_PYTHON` if necessary). CI/container environments use the lockfile independently. Run local native and Java APIs on port 8090; `AI_SERVICE_URL` must match.

## Validation boundary

Tests and migration smoke checks use fake LLM/OSS/payment integrations only. Historical evaluation reports remain preserved failed/historical evidence; they are not a claim of improved model quality. Production Agent Server startup/licensing, real model quality, real OSS permissions/lifecycle, and combined native/Java load must be validated separately in an authorized deployment. See [operations](operations.md) for those requirements.
