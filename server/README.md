# Historical service records

The independent Python/LangGraph, PostgreSQL and RabbitMQ runtime is retired.
Current development, tests, CI, packaging and AI execution use the single
Electron/TypeScript application. Start with the [current installation guide](../docs/guides/installation.md)
and [migration evidence](../docs/maintainers/electron-migration.md).

This directory deliberately retains deployment files, upstream license notices,
evaluation inputs, historical reports and documentation. Existing ignored data,
backups, credentials, caches and deployment volumes remain untouched. Do not run
old deployment/upgrade/cleanup commands against existing state as part of the
desktop migration, and do not remove this directory wholesale.

The last complete dual-implementation reference is available at
[`a3bef2da8c818aaa889b1f27c72c4ce4f1617c7b`](https://github.com/shenyankm/PractiQ/tree/a3bef2da8c818aaa889b1f27c72c4ce4f1617c7b).
Old setup and reproduction commands describe that historical source, not this
checkout. Python checkpoints are not deserialized into LangGraph.js; previously
exported compatible results remain importable, with the old evidence preserved.

Current wire/model/grading/IPC baselines and provenance live in
[`app/fixtures/`](../app/fixtures/migration-reference.md). Current practice and AI
state use separate local SQLite databases; learning backups exclude current
credentials and AI task state.
