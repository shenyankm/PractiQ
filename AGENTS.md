# Repository Guidelines

## Architecture

`server/src/practiq_ai/` is the sole Python 3.14+ LangGraph AI document import service. Keep its format extractors, shared parser graphs, structured contracts, local file storage and model usage accounting together. `webapp.py` exposes authenticated upload and artifact routes; Agent Server provides runs, checkpoints and `/ok` health checks.

There is no frontend, product backend, product database, login, billing, answer generation or learning report. Material-question groups are document content, not study groups. Do not restore removed product compatibility APIs.

## Commands

- Use an existing Python 3.14+ interpreter; no project `.venv`. Set `AI_PYTHON` when needed.
- `make install`: install AI and development dependencies into that interpreter.
- `make server-dev`: run the Agent Server on loopback, loading `server/.env`.
- `make test` / `make test-server`: AI tests without external model calls.
- `make verify`: Ruff, Pyright, evaluation fixture validation, tests with coverage, graph validation and package build.

## Boundaries

Preserve strict Pydantic inputs, token authentication, bounded uploads, path and checksum validation, partial-result details, checkpoint resumability and per-call usage on success and failure. Never inject raw document/model HTML. Do not add another parser or a product compatibility layer.

Bind services to loopback. Keep credentials server-side and never commit environment secrets. Preserve existing files, database volumes and unrelated worktree changes. Local AI storage resolves relative to `server/`; production must use a persistent absolute path.

Update relevant documentation and focused tests with behavior changes. Follow `CONTRIBUTING.md` for pull requests.
