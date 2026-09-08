AI_PYTHON ?= /home/sheny/miniconda3/envs/langgragh/bin/python
AI_PORT ?= 8090

.PHONY: server-install install test test-server verify server-dev backend-test backend-package backend-dev schema-check api-schema-smoke taro-install taro-dev taro-build taro-test taro-typecheck

install: taro-install

test: taro-test

taro-install:
	npm --prefix taro ci

taro-dev:
	npm --prefix taro run dev:weapp

taro-build:
	npm --prefix taro run build:weapp

taro-test:
	npm --prefix taro run verify

taro-typecheck:
	npm --prefix taro run typecheck

server-install:
	uv pip install --python "$(AI_PYTHON)" -e "./server[dev]"

test-server:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" "$(AI_PYTHON)" -m pytest

verify: test backend-test test-server schema-check api-schema-smoke

backend-test:
	mvn -f backend/pom.xml test

backend-package:
	mvn -f backend/pom.xml package

backend-dev:
	uv run --no-project --env-file .env.local -- mvn -f backend/pom.xml spring-boot:run

server-dev:
	cd server && PATH="$(dir $(AI_PYTHON)):$$PATH" "$(AI_PYTHON)" -m dotenv -f ../.env.local run --no-override -- langgraph dev --no-browser --host 127.0.0.1 --port $(AI_PORT)

schema-check:
	bash db/schema_check.sh

api-schema-smoke:
	bash db/api_schema_smoke.sh

