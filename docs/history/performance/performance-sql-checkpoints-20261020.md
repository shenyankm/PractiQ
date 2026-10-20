# Checkpoint head SQL performance, October 20, 2026

`Database.checkpoint_heads` read every checkpoint for the requested tasks and
used `DISTINCT ON` to select the latest ID. Replace it with a LATERAL top-one
lookup per requested thread, using the existing composite primary key
`(thread_id, checkpoint_ns, checkpoint_id)`. Preserve the empty namespace,
lexicographic ID order, missing-task omission, duplicate-input semantics,
checkpointer lock and metadata-only projection. No table, index, migration,
checkpoint payload, credential, API or persistence format changes.

Task detail and task listing call this method to validate their head-keyed
summaries. Returned order is immaterial because the method returns a dictionary.
The query is still parameterized; duplicate requested IDs may repeat a bounded
lookup but produce the same dictionary as before.

## Measurement and query plan

Baseline `c7635acb`. The new probe uses disposable PostgreSQL 16, the actual
LangGraph checkpoint table/primary key and synthetic metadata. It reads both SQL
statements directly from the selected runtime sources. Twenty requested threads
have either 20 or 1,000 historical checkpoints each, plus one absent requested
thread. VACUUM ANALYZE precedes timing; database/file caches are warm, not flushed.
Three alternating before/after pairs each run one warmup and seven timed samples
(21 per version/case). Output dictionaries match the expected heads and each other.
Final measurements run without another compiler or test suite. An earlier run
under concurrent build/test load is retained locally and excluded.

| History per thread | Checkpoint rows | Before median | After median | Reduction |
| --- | --- | ---: | ---: | ---: |
| 20 | 400 | 0.747 ms | 0.345 ms | 53.8% |
| 1000 | 20000 | 25.946 ms | 0.455 ms | 98.2% |

EXPLAIN ANALYZE shows the old large-case plan reads 20,000 primary-key entries
before sorting/deduplicating to 20 heads. The new plan performs 21 bounded index
lookups, returning one entry for each existing thread and none for the absent
one. Both queries read only metadata; the benchmark does not model checkpoint
payload size or establish whole-request/production throughput improvements.

[Raw timings, SQL and JSON query plans](../../../server/reports/sql-checkpoint-performance-20261020.json)
are retained. Setup, assertions and plans are outside the timing. Timing includes
local async database round trips and query execution, not task projection,
checkpoint payload deserialization, HTTP or model work.

## Validation and reproduction

- Passed: 75 focused PostgreSQL/runtime/task API/list tests.
- New regression covers empty input, duplicates, missing threads, nested namespace isolation and a newly inserted head observed by a subsequent call.
- Passed: Ruff and Pyright for service code, tests and scripts.
- Full hosted service CI and current-head Code/Security Review are tracked in the PR; no live model or production-load acceptance is claimed.

```sh
PYTHONPATH=server/src:server python3.14 server/scripts/benchmark_checkpoint_heads.py \
  --baseline c7635acb --output /absolute/report.json
PYTHONPATH=server/src python3.14 -m pytest server/tests/test_checkpoint_heads.py \
  server/tests/test_task_list_performance.py server/tests/test_task_api.py \
  server/tests/test_runtime.py -q
```

Use an existing Python 3.14+ interpreter with locked development dependencies.
The existing disposable database helpers create/remove only their temporary
PostgreSQL databases and RabbitMQ vhosts. No `.env`, service token or model call is
needed. Logs and the excluded preliminary report remain in ignored
`server/reports/checks/perf-20261020/`.
