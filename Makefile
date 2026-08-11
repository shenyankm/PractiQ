.PHONY: install lint test test-server verify server-dev db-apply db-seed worker-imports mobile-install mobile-dev mobile-android mobile-ios mobile-lint mobile-test

install:
	npm --prefix mobile ci

lint:
	npm --prefix mobile run lint

test:
	npm --prefix mobile run typecheck
	npm --prefix mobile test

test-server:
	cd server && uv run pytest tests

verify: lint test test-server

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
