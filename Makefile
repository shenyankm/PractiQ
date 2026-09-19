PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
AI_PORT ?= 8090

.PHONY: install server-install test test-server server-dev init-db verify
install: server-install
server-install:
	uv pip install --break-system-packages --python "$(AI_PYTHON)" -e './server[dev]'
test: test-server
test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest
server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m uvicorn practiq_ai.webapp:app --host 127.0.0.1 --port $(AI_PORT) --workers 1 --env-file ../.env --timeout-graceful-shutdown 65
init-db:
	cd server && "$(AI_PYTHON)" -m practiq_ai.manage init-db
verify:
	cd server && "$(AI_PYTHON)" -m ruff check src tests scripts
	cd server && "$(AI_PYTHON)" -m pyright --pythonpath "$(AI_PYTHON)"
	cd server && "$(AI_PYTHON)" scripts/evaluate.py --validate-only
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m coverage run -m pytest --junitxml=reports/checks/probes.xml
	cd server && "$(AI_PYTHON)" scripts/evaluate.py --probes reports/checks/probes.xml
	cd server && "$(AI_PYTHON)" -m coverage report
	cd server && uv build
