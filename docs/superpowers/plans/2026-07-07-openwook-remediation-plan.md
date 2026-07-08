# OpenWook Remediation Plan Archive

> Historical note: this plan described the pre-migration Next.js/App Router codebase and is retained only as an archive of earlier remediation thinking. It is **not** the current implementation plan.

## Current architecture

OpenWook now uses a split-stack layout:

- `frontend/`: React + Vite + React Router + HeroUI browser app.
- `backend/`: Go 1.26 + Chi HTTP API, worker/admin binaries, internal services, and SQL schema.
- `ai/`: Python FastAPI internal AI/document-processing service.
- `Makefile`: repository-level command entry point.

Current authoritative paths:

- Frontend source: `frontend/src`
- Frontend tests: `frontend/tests`
- Frontend package and lockfile: `frontend/package.json`, `frontend/pnpm-lock.yaml`
- Go commands: `backend/cmd/openwook-api`, `backend/cmd/openwook-worker`, `backend/cmd/openwook-admin`
- Go internal packages: `backend/internal/*`
- Product SQL schema: `backend/db/*/*.sql`
- Current product design: `docs/system-design.md`

Current verification commands:

```bash
make lint
make test
make test-go
make test-ai
make build
```

Use this archive only to understand past risk areas. For new work, follow `README.md`, `AGENTS.md`, and `docs/system-design.md`.
