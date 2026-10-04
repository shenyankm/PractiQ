# Service integration and development guide

[Product overview](../../README.md) · [Simplified Chinese overview](../../README.zh-CN.md)

This guide covers configuration, document parsing, subjective grading APIs, and engineering checks for the independent AI service. For desktop instructions, see the [project overview](../../README.md). Commands run from the repository root unless stated otherwise. Historical reports describe only the versions they tested.

## Run locally

Use uv and an existing Python 3.14+ interpreter; do not create a project `.venv`. Copy the configuration template without overwriting an existing `.env`:

```bash
cp -n .env.example .env
```

Configure the service token, model, dedicated SQLite directory, and file storage in `.env`, then install locked dependencies and start the service:

```sh
make install-locked AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make web-install
make web-build
make server-dev AI_PYTHON=/path/to/python3.14
```

The default address is `127.0.0.1:8090`. `GET /ok` checks liveness; `GET /ready` checks readiness. Both local and production deployments require SQLite. Initialization accepts only an empty database and does not read or migrate old Agent Server data. A single service process holds an exclusive lock. Restarting resumes unfinished tasks automatically; manually paused tasks and tasks awaiting review remain waiting.

`LLM_MODEL` is required for model-enabled deployments and selects one model supporting text and image inputs. The old `LLM_TEXT_MODEL` / `LLM_VISION_MODEL` settings are no longer read. Set `LLM_MODEL` to the previous vision model ID, or the previous text model if no vision model was configured; the selected model must support both input types. TXT/CSV extraction uses text input; PDF/image extraction uses image input directly. PDFium renders PDFs. The deployment image includes Chinese fonts. Office uploads require the independently deployed LibreOffice configuration described in the [Office guide](desktop-office.md); they are normalized before entering these same extractors. Set `AI_READ_ONLY=1` to run without model configuration for reading saved results; unfinished tasks remain stopped and new model work is rejected.

Source images support PNG/JPEG only (`image/png`, `image/jpeg`). Declaring WebP/GIF at upload returns 422. Renaming those files to PNG/JPEG does not bypass actual-format validation during parsing. Existing question-bank images and backups are not deleted.

## Import workflow

Open the built Web frontend at the service root, or run `make web-dev` for its loopback development proxy. The Web token stays in memory; provider credentials and Office executable paths stay in the service environment. File selection is passive; Start import authorizes upload, normalization and parsing. The desktop uses the resulting ZIP offline and calls the service only for explicit grading.

`GET /api/import-capabilities` is authenticated and reports supported source types, the configured `sourceMaxBytes`, Office availability/modes and model configuration. When Office is available, `officeSourceMaxBytes` is the smaller of `sourceMaxBytes` and the converter's 25 MiB ceiling; otherwise it is null. Upload metadata, binary upload and task admission reject oversized sources before reading their content or queuing work. Non-Office formats retain the configured `sourceMaxBytes`. Read-only deployments can serve existing results without a configured model; new model work returns `MODEL_NOT_CONFIGURED`.

Upload the source, create a task, then read and download the result:

1. Send `Authorization: Bearer your_service_token_here`, replacing the placeholder with `AI_SERVICE_TOKEN`, to `POST /api/uploads` to request a file reference.
2. Send the raw bytes with an authenticated PUT to the returned address using its Content-Type. An existing file may return a reference without requiring upload.
3. Submit `document` and a UUID `requestId` to `POST /api/document-tasks`; poll `GET /api/document-tasks/{threadId}`. Official native Graph/SDK APIs are not exposed.
4. Submit an `ArtifactReference` to `POST /api/artifacts/read` to read asset bytes after authentication, size, and SHA-256 checks.
5. For a completed result, `GET /api/document-tasks/{threadId}/export?checkpoint_id=<currentCheckpoint>` downloads the existing desktop-compatible bank ZIP. A stale checkpoint returns `STALE_CHECKPOINT`; an unfinished or missing result returns `BANK_EXPORT_NOT_READY`. Export makes no model call.

Export verifies and writes one resource at a time into a private disk ZIP, then streams it in 64 KiB chunks. The single-process service allows one export build/download per event loop until that response finishes. A competing authenticated export receives HTTP 429 with `BANK_EXPORT_BUSY` and `Retry-After: 1`; retry explicitly after the current download finishes. Completion, failed builds, disconnects and cancellation close the temporary archive and release the slot. Existing JSON, individual resource, expanded-resource and ZIP limits still apply.

The service supports `text_csv_parser`, `pdf_parser`, and the all-format `document_parser`. Task input rejects URLs, Base64, and server paths. The former product `/api/v1/ai/*` endpoints have been removed.

Application errors return a structured `detail` containing a stable `code` and optional diagnostic `message` and interpolation `params`. Clients localize the code rather than display the diagnostic message as interface copy. Invalid authentication returns 401 / `INVALID_SERVICE_TOKEN`; oversized JSON bodies return 413 / `REQUEST_TOO_LARGE`. FastAPI field-validation errors retain their standard 422 validation details.

Pause, interrupt, resume, retry, and partial-result acceptance use `POST /api/document-tasks/{threadId}/control`. See [task controls](document-tasks.md) for requests, idempotency, and the 180-day retention period.

## Request subjective grading

Clients should call `POST /api/subjective-grades` only after an explicit grading or regrading action. The endpoint uses the same Bearer authentication and returns one question's result directly. It does not create a document task or offer document-task pause/resume controls.

Grading requires a complete short-answer question, a nonempty answer, and a reference answer or rubric. Parsed fields `sourceScore`, `scoringRubric`, and `scoreSourceText` preserve the source score, rubric, and score text; missing values remain `null`. New JSON may omit these optional fields. Parsing does not generate answers or grading evidence.

The request has three fields:

| Field | Content |
| --- | --- |
| `requestId` | Client-generated UUID; reuse it when querying the same grading request |
| `inputDigest` | Hexadecimal SHA-256 of the raw UTF-8 bytes of `payload` |
| `payload` | JSON string containing `question`, `answer`, `maxCents`, and optional `materials`, `images`, and `feedbackLocale` |

`question` follows the parsed-question contract. `maxCents` is an integer in hundredths of a point: `500` means 5 points. The inner `payload` must not contain `requestId` or `inputDigest`. Do not reserialize the string after calculating its digest.

Invalid inner payloads or mismatched digests return 422 / `GRADING_INPUT_INVALID` without starting a grading call.

Payload parsing and PNG/JPEG checksum, format, and dimension validation run in a worker thread. Each unchanged image is verified once per request and reused when constructing the model message; cancelling validation retains its upload slot until the worker finishes.

`feedbackLocale` accepts `zh-CN` or `en` and controls generated grading explanations; quoted evidence stays in its source language. Omitted values default to `zh-CN` for existing clients. The desktop includes its current language when preparing a new request and preserves that language and digest on replay. Switching the interface language does not translate saved feedback or trigger regrading.

This synthetic example constructs a request without calling a model. Its Chinese question and rubric are sample content:

```python
import hashlib
import json
import uuid

question = {
    "stem": "说明蒸发的含义",
    "answerMode": "short_answer",
    "answerPayload": {"text": "液体表面发生的汽化现象"},
    "scoringRubric": "汽化得3分，指出发生在液体表面得2分。",
}
payload = json.dumps({
    "question": question,
    "answer": "液体变成气体",
    "maxCents": 500,
}, ensure_ascii=False)
request_body = {
    "requestId": str(uuid.uuid4()),
    "inputDigest": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    "payload": payload,
}
```

Send `request_body` as JSON to the grading endpoint. This response illustrates the format; it is not a measured model result:

```json
{
  "status": "graded",
  "result": {
    "scoreCents": 300,
    "maxCents": 500,
    "reason": "说明了汽化，未指出发生在液体表面。",
    "evidence": ["汽化得3分，指出发生在液体表面得2分。"],
    "reviewReasons": []
  },
  "usage": [],
  "calls": []
}
```

`status` is `graded`, `ungraded`, or `unknown`. Missing evidence, invalid model output, and unknown request outcomes must not become zero scores. Inspect `result`, `error`, `usage`, optional `usageStatus`, and `calls`. Responses may omit `calls` when no model call occurred. Interrupted-request replays include persisted call records, already-known usage, and `usageStatus: unknown`; an unfinished attempt has unknown usage and null token counts rather than zero consumption.

Replaying the same ID and digest returns the saved result. If no result has been saved, it returns `unknown` with any persisted attempt evidence without another model call. Known usage from completed attempts survives cancellation or process restart, including when a later correction is interrupted. Historical interrupted requests without attempt records still have empty usage. Reusing an ID with a different digest returns 409 / `REQUEST_CONFLICT`. Regrading requires explicit confirmation and a new ID and may incur additional charges. The grading cache does not guarantee exactly-once provider calls or automatically resume interrupted grading.

Grading input limits:

| Content | Limit or requirement |
| --- | --- |
| Complete HTTP JSON body | 32 MiB; the desktop separately limits raw `payload` to 31 MiB |
| Answer | 120,000 characters |
| Materials | At most 100 entries and 120,000 characters in total |
| Images | At most 32, each at most 20 MiB and 40 million pixels |
| Image references | Inline image data with SHA-256; arbitrary URLs and file paths are rejected |
| Maximum score | 1–100,000,000 hundredths, or 0.01–1,000,000 points |

Grading uses `LLM_MODEL`, attaching images to that same model when present. It reuses model concurrency limits, rate limits, bounded correction, and usage accounting. Document-task budgets and run deadlines do not apply to this endpoint. When the source provides a rubric and score, the service grades against the original maximum and scales to the current maximum. Use beyond personal self-testing requires independent labeling and calibration.

## Verification and data

Run checks appropriate to the change:

```bash
make test AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
make audit AI_PYTHON=/path/to/python3.14
make image-check
```

Database tests explicitly request `disposable_databases` and use temporary SQLite directories; no Docker database is needed. Pure unit tests, such as `cd server && python -m pytest tests/test_schemas.py tests/test_auth.py`, require neither a database nor Docker. Shared fakes and data builders live in `tests/support.py`; database helpers live in `tests/db_support.py`. CI installs PDF fallback fonts and uses real PDFium rendering for digital, scanned, and mixed PDFs. Office adapter tests use bounded temporary conversions and retain separate deployed-engine acceptance boundaries.

`make verify` checks lockfile consistency, Ruff, Pyright, evaluation fixtures, one test run with at least 90% coverage, recovery probes, and package builds. `make audit` audits locked runtime/development dependencies, requires network access, and fails on vulnerabilities or audit errors. `make image-check` requires Docker and builds the service image without publishing it.

CI runs these Make targets on every PR, pushes to `main`, and manual dispatch. It uses Ubuntu 24.04, Python 3.14, and uv 0.12.13. `make install-locked AI_PYTHON=/path/to/python3.14` installs locked dependencies and the editable project into the selected interpreter without a project `.venv`; CI uses a dedicated interpreter. `make install` remains a development convenience. Jobs time out after 20 minutes; a newer run cancels an older run for the same workflow/ref. JUnit, coverage XML, and probe JSON/Markdown go to `server/reports/checks/`. Each verification replaces only those four generated reports. CI retains available reports for 14 days, including on test failure. Recovery probes provide regression evidence, not complete production crash-recovery acceptance.

Automated tests do not call real models. The [evaluation guide](evaluation.md) and historical reports remain available; historical failures do not establish a current quality baseline.

See the [performance record](../reports/performance-20260921.md) for synthetic storage, scheduling, and extractor-transport checks. Startup adds ordering indexes to schema 1 task databases. Business reads reuse a dedicated connection and close cursors serially; write transactions, checkpoints, and Store remain isolated. Submission, control, completion, and shutdown events wake the scheduler. It also checks the persistent queue after at most one idle second, covering cancellation between transaction commit and notification. Startup scans the recovery queue.

Storage is local and persistent. Upload and asset-read APIs enforce authentication, size, SHA-256, path, and reference validation.

AI files default to `server/.local/ai-oss`. This historical directory name does not imply cloud storage support. Relative `AI_STORAGE_DIR` paths resolve from `server/`; production must use and back up an absolute persistent mount. Sources use `practiq-agent/sources/`; derived text and images use `practiq-agent/artifacts/`. Storage I/O uses a bounded thread pool and `AI_STORAGE_TIMEOUT_SECONDS`, with shared storage errors.

Storage uses local files. Non-local `AI_STORAGE_BACKEND` values prevent startup; remove obsolete `AI_OSS_*` settings. Existing data is never automatically moved or deleted. See [storage configuration](operations.md#storage-configuration).

## Graphs and API examples

The repository registers two format-specific graphs and one general entry point:

| Graph ID | `document.sourceType` |
| --- | --- |
| `text_csv_parser` | `text`, `csv` |
| `pdf_parser` | `pdf` |
| `document_parser` | `text`, `csv`, `pdf`, `image`, plus `doc`, `docx`, `xls`, `xlsx` with configured Office support |

All entries share extraction, vision, chunking, and merge logic. Format-specific entries validate the format before reading files and raise `DOCUMENT_SOURCE_TYPE_MISMATCH` on a mismatch, including when resuming a read node from a checkpoint. They share deployment workers and concurrency settings; there is no separate resource isolation per graph.

After uploading a PDF, submit `requestId`, `graphId="pdf_parser"`, and the returned `document` reference to `POST /api/document-tasks`. The API returns a 202 receipt. Poll the task GET for progress and results. `/threads`, `/runs`, `/store`, and native SSE APIs are not available.

Graph results retain `{ "status": "SUCCEEDED", "result": {...}, "processing": {...}, "usage": [...] }`, with `PARTIAL` or execution failure also possible. See the [task API](document-tasks.md) for full control examples.

## Architecture

Document tasks run through a SQLite queue. Subjective grading handles a single request directly, outside that queue:

```mermaid
graph TD
    Client[Client] --> API[FastAPI authenticated upload and task APIs]
    API --> DB[(SQLite task queue)]
    DB --> Runner[Single-process bounded scheduler]
    Runner --> Graph[Open-source LangGraph document parser]
    Graph --> State[(SQLite checkpoint / Store)]
    Graph --> Model[Shared multimodal model]
    API --> Grading[Subjective grading]
    Grading --> Model
    Grading --> Grades[(SQLite grading request cache)]
    API --> Files[(Local persistent directory)]
    Graph --> Files
```

## Core boundaries

Document parsing follows these constraints:

- Sources enter storage through a service-token-authenticated PUT. Size and SHA-256 are checked before parsing.
- Every PDF page, including digital PDFs, is rendered at approximately 200 DPI. The model must support images. Page images directly produce structured questions, groups, and figures, without OCR transcription or a second text-chunk parsing pass. Each page includes adjacent pages as context and emits only questions starting on that page. Content beyond that window remains incomplete and flagged for review. Failed pages can be retried and merged again without rerunning successful pages. The model supplies figure bounding boxes; Pillow crops them. Descriptions use the `[page crop]` prefix. Page recognition may run concurrently; individual vision/text failures retain details and return `PARTIAL`.
- Graph state stores references and structured results, not file Base64.
- Pydantic validates model output. Failed calls remain subject to shared retry and concurrency limits.

Assets may contain both `imageRef` (a crop) and optional `sourceRef` (the complete source page), each an `ArtifactReference`. Both use the same authenticated read API with size/digest checks. New JSON may omit `sourceRef`; clients should retain it when present so readers can inspect crop edges and context. Full pages may contain answers; the desktop removes their references and hides their controls before self-test or mock-exam submission.

For simple tables, the model returns rectangular cell arrays. The service escapes pipes and creates Markdown while retaining cell content and source transcription. Merged cells, multilevel headers, or irregular rows that cannot be represented faithfully retain images and readable text with review flags; missing cells are not invented. Cross-page content remains limited by the adjacent-page window, so complete reconstruction is not guaranteed. Partial results retain failed-page source references for review.

## Full-page PDF vision requirements

PDFium renders in a terminable isolated process. Page images and crops enter asset storage; temporary files are removed after extraction. Page-count, pixel, aggregate vision-byte, and crop limits still apply. Full-page recognition increases model calls, cost, and latency.

The extractor delivers binary page images and a bounded manifest. The parent reads/writes temporary files in a thread and waits for active file operations before cleanup on cancellation. This internal protocol ships with the independent service; external task and artifact APIs remain authenticated and checksum-checked.

Returned `page` values are zero-based. Automated tests do not call real models; recognition quality requires separate acceptance.

Raw Word/Excel uploads use the independently configured [service Office adapter](desktop-office.md); their original references remain task identity. Unsupported historical graph identifiers still return `TASK_FORMAT_UNSUPPORTED` and are excluded from scheduling without deleting old data. Desktop ZIP import accepts AI JSON schema 3; full restore requires backup container 4 and database schema 11. See [task errors](document-tasks.md) for details.

## Long-running task controls

All three graphs share the [task API and recovery rules](document-tasks.md). The default still returns `PARTIAL`; `failurePolicy="review"` waits for retry or partial-result acceptance after a processing failure. Document input and final result structures remain compatible. Mutations use UUID `requestId` values; resume uses the latest `checkpointId`, and pause/interrupt use the target `runId`. Query separately to distinguish acceptance from actual stopping.

## Verify model quality

Engineering checks use model fakes and do not establish extraction or grading accuracy. See the [evaluation guide](evaluation.md) for real-call commands, datasets, comparisons, and historical failures, and the [operations guide](operations.md) for capacity/recovery drills. Historical Agent Server reports do not establish acceptance of the current SQLite runtime.

## Image validation and model correction

Images are checked against `AI_MAX_VISION_PAGE_PIXELS` before model input and crop decoding. Direct multiframe uploads are rejected with `IMAGE_MULTIFRAME_UNSUPPORTED`; split them into single-frame documents.

Incomplete answers may contain missing values, but containers, element types, lengths, and references remain validated. Image descriptions and labels meet final-result constraints at the model-correction boundary. Correction history for the default tool-calling protocol includes matching tool responses, and failed-call usage is retained. Text groups merge across chunks only when they share confirmed overlap questions, have identical titles/material instructions, and match uniquely. Same-named groups from different sources remain separate.

See [operations](operations.md) for storage paths, upload deadlines, process isolation, and upgrades.

## Question contract v3

Python extracts, associates, and exports `schemaVersion: 3` JSON. Rust validates it and writes schema 11 SQLite. Reading, word-bank, and cloze use composite questions; single/multiple-choice answers share the `answerPayload.correct` array. Each word-bank/cloze blank is a choice child. IDs reference shared materials and option banks; sections remain independent of composite groups. Sources and review issues also use question IDs at export. Execution state version 7 rejects old-structure checkpoints. See the [question model and ER diagram](../../docs/question-model.md).

English question kinds include listening, reading, word-bank, cloze, grammar fill, sentence selection, paragraph matching, translation, and writing. Parsing extracts only supplied content; the desktop attaches listening audio locally. See the [English question model](../../docs/question-model.md#english-question-types) for fields, passage dialogs, and playback rules.
