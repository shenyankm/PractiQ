PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
AI_PORT ?= 8090

.PHONY: install server-install test test-server server-dev verify
install: server-install
server-install:
	uv pip install --python "$(AI_PYTHON)" -e './server[dev]'
test: test-server
test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest
server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m langgraph_cli dev --no-browser --host 127.0.0.1 --port $(AI_PORT)
verify:
	cd server && "$(AI_PYTHON)" -m ruff check src tests scripts
	cd server && "$(AI_PYTHON)" -m pyright --pythonpath "$(AI_PYTHON)"
	cd server && "$(AI_PYTHON)" scripts/evaluate.py --validate-only
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m coverage run -m pytest --junitxml=reports/checks/probes.xml
	cd server && "$(AI_PYTHON)" scripts/evaluate.py --probes reports/checks/probes.xml
	cd server && "$(AI_PYTHON)" -m coverage report
	cd server && "$(AI_PYTHON)" -m langgraph_cli validate
	cd server && uv build
