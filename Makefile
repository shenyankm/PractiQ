.PHONY: install dev build start preview lint test test-go test-ai test-e2e verify api-dev ai-dev db-apply db-ensure db-seed worker-imports

install:
	pnpm --dir frontend install
	git rev-parse --git-dir >/dev/null 2>&1 && git config core.hooksPath .githooks || true

dev:
	pnpm --dir frontend dev

build:
	pnpm --dir frontend build

start:
	pnpm --dir frontend start

preview:
	pnpm --dir frontend preview

lint:
	pnpm --dir frontend lint

test:
	pnpm --dir frontend test

test-go:
	cd backend && go test ./internal/... ./cmd/openwook-admin ./cmd/openwook-api ./cmd/openwook-worker

test-ai:
	python -m pytest ai/tests

test-e2e:
	pnpm --dir frontend test:e2e

verify: lint test test-go test-ai build

api-dev:
	cd backend && go run ./cmd/openwook-api

ai-dev:
	python -m uvicorn openwook_ai.main:app --app-dir ai --host 127.0.0.1 --port 8001

db-apply:
	cd backend && go run ./cmd/openwook-admin db apply

db-ensure:
	cd backend && go run ./cmd/openwook-admin db ensure

db-seed:
	cd backend && go run ./cmd/openwook-admin db seed

worker-imports:
	cd backend && go run ./cmd/openwook-worker
