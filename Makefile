.PHONY: install test test-server verify server-dev backend-test backend-package backend-dev taro-install taro-weapp taro-test

install: taro-install

test: taro-test

test-server:
	uv run --project server --extra dev pytest server/tests

verify: test test-server backend-test

backend-test:
	mvn -f backend/pom.xml test

backend-package:
	mvn -f backend/pom.xml package

backend-dev:
	uv run --no-project --env-file .env.local -- mvn -f backend/pom.xml spring-boot:run

server-dev:
	uv run --env-file .env.local --project server python -m server

taro-install:
	npm --prefix taro ci

taro-weapp:
	npm --prefix taro run dev:weapp

taro-test:
	npm --prefix taro run verify
