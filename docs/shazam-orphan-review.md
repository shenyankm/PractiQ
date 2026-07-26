# Shazam Orphan Symbol Review

`shazam_verify --preCommit` reports repository-wide internal orphan symbols because pi-shazam's graph is conservative: it does not model every dynamic framework entrypoint, JSON/reflection shape, or Go/Python type usage. The warning has been reviewed and is not treated as a deletion list.

## Reviewed categories

### FastAPI dynamic entrypoints

Files such as `ai/main.py` and `ai/routes.py` define route functions registered by FastAPI decorators, for example health checks and internal AI endpoints. They are invoked by the ASGI router rather than by direct source-code calls. Route behavior is covered by `ai/tests/test_routes.py`.

### Pydantic schema models

`ai/schemas.py` contains request/response models consumed by FastAPI, fallback providers, and tests. Pydantic model use is partly dynamic and may not create symbol-level graph edges. Schema behavior is covered by `ai/tests/test_schemas.py`, `ai/tests/test_documents.py`, and route tests.

### Go HTTP/API DTOs and handler dependency structs

The Go backend contains many request/response DTO structs under `backend/internal/httpserver`, `backend/internal/services`, and related packages. These are used through `net/http` handlers, JSON encode/decode paths, pgx scanning, and service boundaries. Reflection, generic decoding, and struct literal usage are under-counted by the graph. HTTP behavior is covered by route tests in `backend/internal/httpserver/*_test.go`.

### Go CLI and worker internals

`backend/cmd/openwook-*` packages expose `main` entrypoints and internal runtime structs. CLI and worker wiring are verified by package tests and `make test-go`.

## Maintenance policy

- Do not delete symbols solely because they appear in the orphan list.
- Before deleting any reported symbol, confirm there is no framework registration, JSON/reflection use, SQL scan target, route test, CLI entrypoint, or external API contract.
- Treat new orphan warnings as actionable only when they correspond to newly added code without tests or route/service integration.
- Use the standard verification suite after changes:

```bash
make lint
make test
make test-go
make test-ai
make build
```
