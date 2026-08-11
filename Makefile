.PHONY: install dev build start lint test test-server test-e2e verify server-dev db-apply db-seed worker-imports mobile-install mobile-dev mobile-android mobile-ios mobile-lint mobile-test

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

test-server:
	cd server && uv run pytest tests

test-e2e:
	pnpm --dir frontend test:e2e

verify: lint test test-server build

server-dev:
	uv run --project server python -m server

db-apply:
	uv run --project server python -m server.admin db apply

db-seed:
	uv run --project server python -m server.admin db seed

worker-imports:
	uv run --project server python -m server.worker

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
