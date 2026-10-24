PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
# Resolve executable names before uv searches for a virtual environment.
override AI_PYTHON := $(or $(shell command -v "$(AI_PYTHON)"),$(AI_PYTHON))
AI_PORT ?= 8090
INSTALL_EXTRAS ?= --extra dev
APP_PACKAGE_REPORT ?= server/reports/checks/desktop-bundle.json

.PHONY: install server-install install-locked test test-server server-dev init-db upgrade-db verify audit audit-rust image-check alerts-check
install: server-install
server-install:
	cd server && uv pip install --break-system-packages --python "$(AI_PYTHON)" -e '.[dev]'
install-locked:
	@set -eu; requirements=$$(mktemp); trap 'rm -f "$$requirements"' EXIT; \
	cd server; uv export --locked $(INSTALL_EXTRAS) --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" -r "$$requirements"; \
	uv pip install --break-system-packages --python "$(AI_PYTHON)" --no-deps -e .
test: test-server
test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest
server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m uvicorn practiq_ai.webapp:app --host 127.0.0.1 --port $(AI_PORT) --workers 1 --env-file ../.env --timeout-graceful-shutdown 65
init-db:
	cd server && "$(AI_PYTHON)" -m practiq_ai.manage init-db
upgrade-db:
	cd server && "$(AI_PYTHON)" -m practiq_ai.manage upgrade-db
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
	cd server && "$(AI_PYTHON)" scripts/check_package.py
audit:
	@set -eu; requirements=$$(mktemp); trap 'rm -f "$$requirements"' EXIT; \
	cd server; uv export --locked --extra dev --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	"$(AI_PYTHON)" -m pip_audit --strict --disable-pip --no-deps -r "$$requirements"; \
	"$(AI_PYTHON)" -c 'import pathlib, sys, tomllib; project = tomllib.loads(pathlib.Path("pyproject.toml").read_text()); print(*project["build-system"]["requires"], *project["tool"]["uv"]["build-constraint-dependencies"], sep="\n", file=open(sys.argv[1], "w"))' "$$requirements"; \
	"$(AI_PYTHON)" -m pip_audit --strict --disable-pip --no-deps -r "$$requirements"
audit-rust:
	cargo audit --file app/src-tauri/Cargo.lock
	"$(AI_PYTHON)" app/scripts/check-rust-targets.py
image-check: web-build
	docker build -f Dockerfile.server -t practiq-ai:ci .
	docker run --rm --network none --read-only --cpus 2 --memory 2g --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=536870912,mode=1777 --tmpfs /home/practiq:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=700 --tmpfs /var/lib/practiq:rw,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=700 -e AI_READ_ONLY=1 -e AI_SERVICE_TOKEN=container-check-only --mount type=bind,source="$(CURDIR)/app/fixtures",target=/fixtures,readonly --mount type=bind,source="$(CURDIR)/server/scripts/check_container.py",target=/checks/check_container.py,readonly --entrypoint python practiq-ai:ci /checks/check_container.py
alerts-check:
	docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=134217728,mode=1777 --cap-drop ALL --security-opt no-new-privileges --mount type=bind,source="$(CURDIR)/server/deploy",target=/rules,readonly --workdir /rules --entrypoint /bin/promtool prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e test rules alerts.test.yml
	docker run --rm --network none --read-only --mount type=bind,source="$(CURDIR)/server/deploy",target=/rules,readonly --workdir /rules --entrypoint /bin/promtool prom/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e check config --syntax-only prometheus.example.yml

.PHONY: app-install app-dev app-check app-build app-package-check
app-install:
	cd app && npm ci
app-dev: app-prepare-package
	cd app && npm run desktop
app-check:
	"$(AI_PYTHON)" app/scripts/export-contracts.py --check
	"$(AI_PYTHON)" app/scripts/check-fixtures.py
	cd app && TAURI_CONFIG='{"bundle":{"resources":[]}}' npm run check
app-build: app-prepare-package
ifeq ($(shell uname -s),Darwin)
	cd app && npm run tauri -- build
else
	@echo "The practice app supports macOS only."; exit 1
endif
app-package-check: app-build
ifeq ($(shell uname -s),Darwin)
	"$(AI_PYTHON)" app/scripts/check-installer.py --installer app/src-tauri/target/release/bundle/dmg/*.dmg --output "$(APP_PACKAGE_REPORT)"
else
	@echo "The practice app supports macOS only."; exit 1
endif

.PHONY: test-e2e
test-e2e:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" PYTHONPATH="$(CURDIR)/server/src" "$(AI_PYTHON)" -m pytest tests/test_e2e.py
	TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --manifest-path app/src-tauri/Cargo.toml e2e_

.PHONY: app-prepare-package app-license-check
app-prepare-package:
	"$(AI_PYTHON)" app/scripts/prepare-package.py

app-license-check:
	"$(AI_PYTHON)" app/scripts/check_licenses.py --bundle app/src-tauri/bundled --output server/reports/checks/licenses.json

.PHONY: web-install web-dev web-check web-build
web-install:
	npm --prefix web ci
web-dev:
	npm --prefix web run dev
web-check:
	npm --prefix web run check
	npm --prefix web run test:browser
web-build:
	npm --prefix web run build
