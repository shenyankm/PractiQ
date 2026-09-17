PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
AI_PORT ?= 8090

.PHONY: install backend-install server-install web-install test web-test web-dev web-build web-typecheck backend-test backend-dev backend-worker test-server server-dev schema-check api-schema-smoke verify
install: backend-install web-install
backend-install:
	uv pip install --python "$(PYTHON)" -e './backend[dev]'
server-install:
	uv pip install --python "$(AI_PYTHON)" -e './server[dev]'
web-install:
	npm --prefix web ci
web-dev:
	npm --prefix web run dev
web-build:
	npm --prefix web run build
web-typecheck:
	npm --prefix web run typecheck
web-test:
	npm --prefix web run verify
test: web-test
backend-dev:
	"$(PYTHON)" -m dotenv -f .env.local run --no-override -- "$(PYTHON)" -m uvicorn practiq_backend.app:app --host 127.0.0.1 --port 8080 --reload
backend-worker:
	"$(PYTHON)" -m dotenv -f .env.local run --no-override -- "$(PYTHON)" -m practiq_backend.worker
backend-test:
	PYTHON="$(PYTHON)" bash db/api_schema_smoke.sh
test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest
server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m dotenv -f ../.env.local run --no-override -- langgraph dev --no-browser --host 127.0.0.1 --port $(AI_PORT)
schema-check:
	PYTHON="$(PYTHON)" bash db/schema_check.sh
api-schema-smoke: backend-test
verify: web-test backend-test test-server schema-check
	"$(PYTHON)" -m ruff check --config backend/pyproject.toml backend/src/practiq_backend
