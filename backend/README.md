# PractiQ product API

Python FastAPI + Pydantic + Psycopg, no ORM. The API and durable worker share this package; private model execution remains in `server/`.

Use `make backend-install`, `make backend-dev`, `make backend-worker`, and `make backend-test` from the repository root. Tests require disposable PostgreSQL and never use SQLite. Configure `DATABASE_URL`, `MEDIA_DIR`, `APP_ORIGIN`, `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`; no account or billing configuration exists.

`db/00_schema.sql` is for an empty database. No automatic migrations or destructive reset occur at application startup. `/api/health` is liveness; resource access requires a working database. API docs: `/docs` and `/openapi.json`.
