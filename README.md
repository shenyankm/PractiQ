<p align="center">
  <img src="server/assets/logo/practiq-octopus-a5.png" width="160" alt="PractiQ logo">
</p>

# PractiQ

English | [简体中文](README.zh-CN.md)

An AI document import tool that turns text, CSV, PDF, images, Word, and Excel files into structured questions, passage-based question groups, source answers, and visual assets. It supports durable pause/resume, selected failed-unit retry, optional human review, and per-call model usage tracking.

The code lives in `server/` and runs on FastAPI, open-source LangGraph and PostgreSQL, without the commercial Agent Server runtime. It does not include a frontend, question bank management, practice grading, answer generation, or learning reports.

## Run locally

Use an existing Python 3.14+ interpreter without creating a project `.venv`. Set `AI_PYTHON` to the interpreter path.

```bash
# Copy only on first setup; do not overwrite existing model configuration
cp -n .env.example .env
# Configure token, models, a NEW PostgreSQL database and separate file storage
make install AI_PYTHON=/path/to/python3.14
make init-db AI_PYTHON=/path/to/python3.14
make server-dev AI_PYTHON=/path/to/python3.14
```

The server listens on `127.0.0.1:8090` by default. Use `GET /ok` for liveness and `/ready` for database/runtime readiness. Local and production runs require PostgreSQL. Initialization refuses non-empty databases; keep old Agent Server tasks in their original environment. Only one service process may own the new database.

Both `LLM_TEXT_MODEL` and `LLM_VISION_MODEL` are required, sharing the provider and API key. TXT/CSV use the text model. PDF/DOCX/images use direct visual extraction; XLSX combines worksheet cells, anchored images and rendered charts/shapes in one joint vision unit per worksheet. DOCX needs LibreOffice Writer; XLSX charts/shapes need Calc. Chinese fonts are included in the deployment image. `AI_SOFFICE_PATH` selects the converter.

## Import workflow

1. Call `POST /api/uploads` with `Authorization: Bearer <AI_SERVICE_TOKEN>` to request a file reference.
2. Upload the raw file with an authenticated PUT using the returned URL and Content-Type. Existing files may return a reference without requiring another upload.
3. Create a task with `POST /api/document-tasks` using the uploaded `document` and a UUID `requestId`; poll `GET /api/document-tasks/{threadId}`. Official native graph/SDK APIs are no longer exposed.
4. Call `POST /api/artifacts/read` with authentication to retrieve derived assets.

Available graphs are `text_csv_parser`, `pdf_parser`, `docx_parser`, `excel_parser`, and `document_parser`, which supports all formats. Task inputs do not accept URLs, Base64 content, or server filesystem paths. The former product `/api/v1/ai/*` endpoints have been removed.

Pause, interrupt, resume, retry failed units or accept partial results through `POST /api/document-tasks/{threadId}/control`. See the [task API and recovery guide](server/docs/document-tasks.md) for request examples, idempotency and the 180-day recovery window.

See the [AI service guide](README.zh-CN.md#graph-与接口示例) for complete API examples and capability limits.

## Validation and data

```bash
make test AI_PYTHON=/path/to/python3.14
make verify AI_PYTHON=/path/to/python3.14
```

Database tests explicitly request the `disposable_databases` fixture: they use `TEST_DATABASE_URI` or start a disposable PostgreSQL Docker container. Pure tests (for example, `cd server && python -m pytest tests/test_schemas.py tests/test_auth.py`) need neither. Shared fakes and sample builders live in `tests/support.py`; database helpers live in `tests/db_support.py`. CI installs LibreOffice Writer/Calc and Chinese fonts and sets `REQUIRE_LIBREOFFICE_TESTS=1`, so real rendering checks fail instead of skipping when LibreOffice is missing. Set the same variable locally to require those checks.

Automated tests do not call real models. The [evaluation guide](server/docs/evaluation.md) and historical reports are retained; past failed runs do not establish a current quality baseline.

Storage supports two modes: `AI_STORAGE_BACKEND=local` (default) or `oss`. Both use the same authenticated upload and artifact APIs, with size and SHA-256 verification.

In local mode, AI files are stored in `server/.local/ai-oss` by default. Relative `AI_STORAGE_DIR` paths resolve from `server/`. In production, use an absolute path on a persistent mount and back it up. The project simplification does not migrate or delete existing databases, volumes, files, or local configuration. See the [operations guide](server/docs/operations.md) and `Dockerfile.server` for production deployment.

In OSS mode, configure `AI_OSS_REGION`, `AI_OSS_BUCKET`, `AI_OSS_ACCESS_KEY_ID`, and `AI_OSS_ACCESS_KEY_SECRET` in `.env`. Optional `AI_OSS_SECURITY_TOKEN` supports temporary STS credentials. `AI_OSS_ENDPOINT` overrides the HTTPS endpoint; set `AI_OSS_USE_CNAME=true` for a bucket-bound custom domain. See `.env.example` for all settings.

Use an existing private bucket and grant access only to the required objects. Credentials stay on the server; files pass through the authenticated API. Switching modes does not copy data or fall back to the other backend. Copy and verify every referenced object before switching. New versioned tasks reject storage-location changes; finish them on the original deployment or create new tasks after migration. Old checkpoints are not upgraded. Renew temporary credentials and restart before they expire.
