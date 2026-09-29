PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
# Resolve executable names before uv searches for a virtual environment.
override AI_PYTHON := $(or $(shell command -v "$(AI_PYTHON)"),$(AI_PYTHON))
AI_PORT ?= 8090

.PHONY: install server-install install-locked test test-server server-dev init-db verify audit audit-rust image-check
install: server-install
server-install:
	uv pip install --break-system-packages --python "$(AI_PYTHON)" -e './server[dev]'
install-locked:
	@set -eu; requirements=$$(mktemp); trap 'rm -f "$$requirements"' EXIT; \
	cd server; uv export --locked --extra dev --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" -r "$$requirements"; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" --no-deps -e .
test: test-server
test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest
server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m uvicorn practiq_ai.webapp:app --host 127.0.0.1 --port $(AI_PORT) --workers 1 --env-file ../.env --timeout-graceful-shutdown 65
init-db:
	cd server && "$(AI_PYTHON)" -m practiq_ai.manage init-db
verify:
	rm -f server/reports/checks/probes.xml server/reports/checks/probes.json server/reports/checks/probes.md server/reports/checks/coverage.xml
	cd server && uv lock --check --python "$(AI_PYTHON)"
	cd server && "$(AI_PYTHON)" -m ruff check src tests scripts
	cd server && "$(AI_PYTHON)" -m pyright --pythonpath "$(AI_PYTHON)"
	cd server && "$(AI_PYTHON)" scripts/evaluate.py --validate-only
	@cd server; test_status=0; report_status=0; \
	"$(AI_PYTHON)" -m coverage erase || exit $$?; \
	PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m coverage run -m pytest --junitxml=reports/checks/probes.xml || test_status=$$?; \
	"$(AI_PYTHON)" -m coverage combine || report_status=$$?; \
	"$(AI_PYTHON)" -m coverage report || report_status=$$?; \
	"$(AI_PYTHON)" -m coverage xml --fail-under=0 -o reports/checks/coverage.xml || report_status=$$?; \
	"$(AI_PYTHON)" scripts/evaluate.py --probes reports/checks/probes.xml --output reports/checks/probes.json || report_status=$$?; \
	if [ "$$test_status" -ne 0 ]; then exit "$$test_status"; fi; exit "$$report_status"
	cd server && uv build --python "$(AI_PYTHON)"
audit:
	@set -eu; requirements=$$(mktemp); trap 'rm -f "$$requirements"' EXIT; \
	cd server; uv export --locked --extra dev --extra desktop --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	"$(AI_PYTHON)" -m pip_audit --strict --disable-pip --no-deps -r "$$requirements"
audit-rust:
	cargo audit --file app/src-tauri/Cargo.lock
image-check:
	docker build -f Dockerfile.server -t practiq-ai:ci .

.PHONY: app-install app-dev app-check app-build app-package-check
app-install:
	cd app && npm ci
app-dev:
	cd app && npm run desktop
app-check:
	"$(AI_PYTHON)" app/scripts/export-contracts.py --check
	"$(AI_PYTHON)" app/scripts/check-fixtures.py
	cd app && TAURI_CONFIG='{"bundle":{"resources":[]}}' npm run check
app-build: app-bundle
	cd app && npm run tauri -- build
app-package-check: app-build
ifeq ($(shell uname -s),Darwin)
	"$(AI_PYTHON)" app/scripts/check-bundle.py --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
	"$(AI_PYTHON)" app/scripts/check-office.py --isolated --bundle app/src-tauri/target/release/bundle/macos/PractiQ.app/Contents/Resources/bundled
else
	@set -eu; package_dir=$$(mktemp -d); trap 'rm -rf "$$package_dir"' EXIT; \
	dpkg-deb -x app/src-tauri/target/release/bundle/deb/*.deb "$$package_dir"; \
	"$(AI_PYTHON)" app/scripts/check-bundle.py --bundle "$$package_dir/usr/lib/PractiQ/bundled"; \
	"$(AI_PYTHON)" app/scripts/check-office.py --isolated --bundle "$$package_dir/usr/lib/PractiQ/bundled"
endif

.PHONY: test-e2e
test-e2e:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest tests/test_e2e.py
	TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --manifest-path app/src-tauri/Cargo.toml e2e_

.PHONY: app-bundle app-install-python
app-install-python:
	@set -eu; requirements=$$(mktemp); trap 'rm -f "$$requirements"' EXIT; \
	cd server; uv export --locked --extra desktop --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" -r "$$requirements"; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" --no-deps -e .
app-bundle:
	"$(AI_PYTHON)" app/scripts/bundle-python.py

.PHONY: app-fidelity-check app-license-check
app-fidelity-check:
	"$(AI_PYTHON)" app/scripts/check-office.py --fidelity-only --output server/reports/checks/office-fidelity.json
app-license-check:
	"$(AI_PYTHON)" app/scripts/check_licenses.py --bundle app/src-tauri/bundled --output server/reports/checks/licenses.json
