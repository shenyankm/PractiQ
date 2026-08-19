.PHONY: install test test-server verify server-dev backend-test backend-package backend-dev schema-check

install: backend-install

test: backend-test

test-server:
	uv run --project server --extra dev pytest server/tests

verify: test test-server schema-check

backend-test:
	mvn -f backend/pom.xml test

backend-package:
	mvn -f backend/pom.xml package

backend-dev:
	uv run --no-project --env-file .env.local -- mvn -f backend/pom.xml spring-boot:run

server-dev:
	uv run --env-file .env.local --project server python -m server

schema-check:
	bash db/schema_check.sh


