.DEFAULT_GOAL := verify
APP_PACKAGE_DIRECTORY := $(CURDIR)/app/.build/packages/make-$(shell date +%s)

.PHONY: install install-locked dev test verify audit build app-install app-dev app-check app-build app-package-check test-e2e

install install-locked: app-install
dev: app-dev
build: app-build

app-install:
	cd app && npm ci
	cd app && npm run desktop:install

app-dev:
	cd app && npm run desktop

test:
	cd app && npm run test:coverage
	cd app && npm run test:desktop

verify app-check:
	node --test .github/scripts/*.test.ts
	cd app && npm run check
	cd app && npm run build

audit:
	cd app && npm audit --audit-level=high

app-build:
ifeq ($(shell uname -s),Darwin)
	cd app && npm run package:electron -- "$(APP_PACKAGE_DIRECTORY)"
else
	@echo "The practice app supports macOS only."; exit 1
endif

app-package-check: app-build
ifeq ($(shell uname -s),Darwin)
	cd app && npm run test:package -- "$(APP_PACKAGE_DIRECTORY)"
else
	@echo "The practice app supports macOS only."; exit 1
endif

test-e2e:
	cd app && npm run test:browser
	cd app && npm run test:electron
