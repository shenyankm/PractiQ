<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

An AI document import tool that turns text, CSV, PDF, images, Word, and Excel files into structured questions, passage-based question groups, source answers, and visual assets. It supports durable pause/resume, selected failed-unit retry, optional human review, and per-call model usage tracking.

The code lives in `server/` and runs through LangGraph Agent Server. It does not include a frontend, question bank management, practice grading, answer generation, or learning reports.

## Run locally

Use an existing Python 3.14+ interpreter without creating a project `.venv`. Set `AI_PYTHON` to the interpreter path.

```bash
# Copy only on first setup; do not overwrite existing model configuration
cp -n server/.env.example server/.env
# Edit server/.env to configure the service token and models
make install AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

The server listens on `127.0.0.1:8090` by default. Use `GET /ok` for health checks. Local development does not require a product database or Docker Compose; `langgraph dev` does not provide production-grade task persistence.

All formats use one required `LLM_VISION_MODEL`; `LLM_TEXT_MODEL` is removed. PDF, DOCX and images go directly to structured questions, with no intermediate OCR/transcription or text-model pass. Text/CSV/Excel send source text to that same model. DOCX also requires LibreOffice Writer and Chinese fonts. Use `AI_SOFFICE_PATH` to specify the converter executable.

## Import workflow

1. Call `POST /api/uploads` with `Authorization: Bearer <AI_SERVICE_TOKEN>` to request a file reference.
2. Upload the raw file with an authenticated PUT using the returned URL and Content-Type. Existing files may return a reference without requiring another upload.
3. Create a task with `POST /api/document-tasks` using the uploaded `document` and a UUID `requestId`; poll `GET /api/document-tasks/{threadId}`. Native graph APIs remain available.
4. Call `POST /api/artifacts/read` with authentication to retrieve derived assets.

Available graphs are `text_csv_parser`, `pdf_parser`, `docx_parser`, `excel_parser`, and `document_parser`, which supports all formats. Native inputs do not accept URLs, Base64 content, or server filesystem paths. The former product `/api/v1/ai/*` endpoints have been removed.

Pause, interrupt, resume, retry failed units or accept partial results through `POST /api/document-tasks/{threadId}/control`. See the [task API and recovery guide](server/docs/document-tasks.md) for request examples, idempotency and the 180-day recovery window.

See the [AI service guide](server/README.md) for complete API examples and capability limits.

## Validation and data

```bash
make test AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
```

Automated tests do not call real models. The [evaluation guide](server/docs/evaluation.md) and historical reports are retained; past failed runs do not establish a current quality baseline.

Storage supports two modes: `AI_STORAGE_BACKEND=local` (default) or `oss`. Both use the same authenticated upload and artifact APIs, with size and SHA-256 verification.

In local mode, AI files are stored in `server/.local/ai` by default. Relative `AI_STORAGE_DIR` paths resolve from `server/`. In production, use an absolute path on a persistent mount and back it up. The project simplification does not migrate or delete existing databases, volumes, files, or local configuration. See the [operations guide](server/docs/operations.md) and `Dockerfile.server` for production deployment.

In OSS mode, configure `AI_OSS_REGION`, `AI_OSS_BUCKET`, `AI_OSS_ACCESS_KEY_ID`, and `AI_OSS_ACCESS_KEY_SECRET` in `server/.env`. Optional `AI_OSS_SECURITY_TOKEN` supports temporary STS credentials. `AI_OSS_ENDPOINT` overrides the HTTPS endpoint; set `AI_OSS_USE_CNAME=true` for a bucket-bound custom domain. See `server/.env.example` for all settings.

Use an existing private bucket and grant access only to the required objects. Credentials stay on the server; files pass through the authenticated API. Switching modes does not copy data or fall back to the other backend. Copy and verify every referenced object before switching. New versioned tasks reject storage-location changes; finish them on the original deployment or create new tasks after migration. Old checkpoints are not upgraded. Renew temporary credentials and restart before they expire.
