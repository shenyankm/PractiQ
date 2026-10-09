PYTHON ?= $(shell command -v python)
AI_PYTHON ?= $(PYTHON)
# Resolve executable names before uv searches for a virtual environment.
override AI_PYTHON := $(or $(shell command -v "$(AI_PYTHON)"),$(AI_PYTHON))
AI_PORT ?= 8090
APP_PACKAGE_REPORT ?= server/reports/checks/desktop-bundle.json

.PHONY: install server-install install-locked test test-server server-dev init-db verify audit audit-rust image-check
install: server-install
server-install:
	cd server && uv pip install --break-system-packages --python "$(AI_PYTHON)" -e '.[dev]'
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
	cd server; uv export --locked --extra dev --no-emit-project --python "$(AI_PYTHON)" -o "$$requirements" >/dev/null; \
	"$(AI_PYTHON)" -m pip_audit --strict --disable-pip --no-deps -r "$$requirements"; \
	"$(AI_PYTHON)" -c 'import pathlib, sys, tomllib; project = tomllib.loads(pathlib.Path("pyproject.toml").read_text()); print(*project["build-system"]["requires"], *project["tool"]["uv"]["build-constraint-dependencies"], sep="\n", file=open(sys.argv[1], "w"))' "$$requirements"; \
	"$(AI_PYTHON)" -m pip_audit --strict --disable-pip --no-deps -r "$$requirements"
audit-rust:
	cargo audit --file app/src-tauri/Cargo.lock
	"$(AI_PYTHON)" app/scripts/check-rust-targets.py
image-check: web-build
	docker build -f Dockerfile.server -t practiq-ai:ci .

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
	@echo "Use Windows PowerShell build commands or make android-build; Linux applications are not supported."; exit 1
endif
app-package-check: app-build
ifeq ($(shell uname -s),Darwin)
	"$(AI_PYTHON)" app/scripts/check-installer.py --installer app/src-tauri/target/release/bundle/dmg/*.dmg --output "$(APP_PACKAGE_REPORT)"
else
	@echo "Use Windows PowerShell package checks or make android-package-check."; exit 1
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

ANDROID_RUNTIME_INVENTORY ?= $(CURDIR)/app/.build/android-runtime.json
ANDROID_APK ?= app/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
ANDROID_AAPT2 ?= $(ANDROID_HOME)/build-tools/36.0.0/aapt2
ANDROID_PACKAGE_REPORT ?= server/reports/checks/android-package.json
.PHONY: android-dev android-build android-prepare-package android-package-check
android-dev:
	cd app && npm run tauri -- android dev
android-prepare-package:
	"$(AI_PYTHON)" app/scripts/prepare-package.py --platform android --architecture arm64 --android-runtime-inventory "$(ANDROID_RUNTIME_INVENTORY)"
android-build: android-prepare-package
	cd app && npm run tauri -- android build --debug --apk --split-per-abi --target aarch64 --ci
android-package-check: android-build
	"$(AI_PYTHON)" app/scripts/check-apk.py --installer "$(ANDROID_APK)" --abi arm64-v8a --aapt2 "$(ANDROID_AAPT2)" --expected-notices app/src-tauri/bundled/THIRD-PARTY.txt --output "$(ANDROID_PACKAGE_REPORT)"
