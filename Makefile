.PHONY: install test test-server verify server-dev backend-test backend-package backend-dev db-apply db-seed worker-imports taro-install taro-weapp taro-test

install: taro-install

test: taro-test

test-server:
	cd server && uv run --extra dev pytest tests

verify: test test-server backend-test

backend-test:
	mvn -f backend/pom.xml test

backend-package:
	mvn -f backend/pom.xml package

backend-dev:
	mvn -f backend/pom.xml spring-boot:run

server-dev:
	uv run --env-file .env.local --project server python -m server

db-apply:
	uv run --env-file .env.local --project server python -m server.admin db apply

db-seed:
	uv run --env-file .env.local --project server python -m server.admin db seed

worker-imports:
	uv run --env-file .env.local --project server python -m server.worker

taro-install:
	npm --prefix taro ci

taro-weapp:
	npm --prefix taro run dev:weapp

taro-test:
	npm --prefix taro run verify
