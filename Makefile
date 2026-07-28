.PHONY: install dev build start lint test test-go test-ai test-e2e verify api-dev ai-dev db-apply db-seed worker-imports mobile-install mobile-dev mobile-android mobile-ios mobile-lint mobile-test

install:
	pnpm --dir frontend install
	npm --prefix mobile ci

dev:
	pnpm --dir frontend dev

build:
	pnpm --dir frontend build

start:
	pnpm --dir frontend start

lint:
	pnpm --dir frontend lint
	npm --prefix mobile run lint

test:
	pnpm --dir frontend test
	npm --prefix mobile run typecheck
	npm --prefix mobile test

test-go:
	cd backend && go test ./internal/... ./cmd/practiq-admin ./cmd/practiq-api ./cmd/practiq-worker

test-ai:
	python -m pytest ai/tests

test-e2e:
	pnpm --dir frontend test:e2e

verify: lint test test-go test-ai build

api-dev:
	cd backend && go run ./cmd/practiq-api

ai-dev:
	set -a; [ ! -f .env.local ] || . ./.env.local; set +a; python -m uvicorn main:app --app-dir ai --host 127.0.0.1 --port 8001

db-apply:
	cd backend && go run ./cmd/practiq-admin db apply

db-seed:
	cd backend && go run ./cmd/practiq-admin db seed

worker-imports:
	cd backend && go run ./cmd/practiq-worker

mobile-install:
	npm --prefix mobile ci

mobile-dev:
	npm --prefix mobile start

mobile-android:
	npm --prefix mobile run android

mobile-ios:
	npm --prefix mobile run ios

mobile-lint:
	npm --prefix mobile run lint

mobile-test:
	npm --prefix mobile run typecheck
	npm --prefix mobile test
