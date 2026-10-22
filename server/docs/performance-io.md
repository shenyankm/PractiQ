# Service I/O work bounds

These optimizations remove repeated work without changing task authorization,
verified storage, explicit resume/retry, paid-call receipts, or database schemas.
They add no cache, connection pool, configuration, or dependency.

## Artifact authorization (recommendation 3)

`webapp.read_artifact` still authenticates the request, requires a task ID, and
reads the authoritative task record, including supported-format and expiry checks.
The namespace check is only an early rejection, not authorization. Membership
compares all four reference fields (`objectKey`, `sha256`, `sizeBytes`,
`mediaType`). An exact source match skips task detail and review; otherwise detail
is checked first and review is loaded only on a miss. Every accepted reference is
still read through `get_verified`; sources retain `DocumentReference` validation.

Deterministic regression evidence in `tests/test_artifact_performance.py` uses
saved structures with 1, 100, and 300 units. Each workload has these call counts:

| Reference found in | Previous detail / review calls | New detail / review calls | Verified payload reads |
| --- | --- | --- | --- |
| Source record | 1 / 1 | 0 / 0 | 1 |
| Task detail | 1 / 1 | 1 / 0 | 1 |
| Stage review | 1 / 1 | 1 / 1 | 1 |

The baseline unconditionally loaded both detail and review. Each such call reads
a snapshot; skipped review also skips any unit-result reads it would have needed.
The regression counts the public helper calls, not real checkpoint SQL or disk
latency. It also checks four-field source mismatches, cross-task rejection,
missing/expired/unsupported tasks, and actual missing/corrupt local source files.

## Resume preflight (recommendation 14)

`execution.preflight` verifies execution identity, then source, then optional
normalization before touching saved outputs. Saved unit results and deduplicated
artifact references are separate phases using the existing `capacity.bounded_map`
and `AI_STORAGE_CONCURRENCY`. The verifying workers return `None`: neither parsed
unit results nor artifact bytes accumulate in the map's results list. Reference
metadata and `None` slots remain O(N); concurrent payload work is bounded by the
configured worker count, not the total object count. Existing storage timeouts,
thread-capacity accounting, caller deadlines, and unknown-call checks are unchanged.

`tests/test_execution_preflight.py` verifies these deterministic work counts for
N = 10, 100, 300 and concurrency C = 1, 2, 4:

- One source read, then one normalization validation.
- Exactly N unit-result validations and N unique artifact validations, despite
  duplicate references across pages, OCR pages, chunks, input parts, original
  pages, and text.
- Peak in-flight verifier count equals C; no active workers remain on return.
- Both maps return exactly N `None` entries, despite verifiers producing 1 KiB
  payloads. No collected payload bytes or parsed results escape the workers.
- Corruption or cancellation in either phase drains workers and stops subsequent
  phases. Execution/source/normalization failures prevent saved-output work.

These are bounded, cooperative fake-I/O counts, not a real-filesystem throughput
or peak-RSS benchmark. Parallel reads may increase transient memory and disk
contention; storage concurrency remains the tuning bound.

## Outbox publishing (recommendation 11)

`messaging.Delivery.run` opens one existing autocommit database connection for a
nonempty outbox batch. It does not open a connection for an empty batch. Publishing
remains sequential: each positive publisher confirm is immediately followed by
the original `run_id`/`created_at` conditional UPDATE. There is no batch transaction,
delayed marking, or publication concurrency. Unknown confirms remain unmarked;
connection/update errors and cancellation exit through the existing recovery path.

`tests/test_messaging.py::test_outbox_reuses_batch_connection_and_commits_each_confirm`
records the exact connect/confirm/UPDATE/close sequence using a fake broker and
autocommit database:

| Batch size | Previous connect / close pairs | New connect / close pairs | Positive confirms / UPDATEs on success |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 0 / 0 |
| 1 | 1 | 1 | 1 / 1 |
| 10 | 10 | 1 | 10 / 10 |
| 100 | 100 | 1 | 100 / 100 |

Failure cases cover an unknown second confirm, a second UPDATE failure,
cancellation, and shutdown between messages. Already committed rows stay marked;
later rows are not marked or sent after the failure. The existing backoff test
also asserts publication is actually attempted on each failed connection cycle.
These counts concern marking connections only; the existing batch SELECT and
its reader connection are unchanged. No PostgreSQL handshake timings are claimed.

## Focused reproduction

Use an existing Python 3.14+ interpreter with the locked development dependencies;
no external models, Tencent, RabbitMQ, PostgreSQL, or Docker are needed:

```sh
cd server
"$AI_PYTHON" -m pytest -q \
  tests/test_artifact_performance.py tests/test_execution_preflight.py \
  tests/test_messaging.py \
  -k 'artifact or preflight or protocol or broker_configuration or remote_broker or broker_accepts or positive_publisher or delivery_poison or repeated_publication or outbox_reuses or notice_inventory'
"$AI_PYTHON" -m ruff check \
  src/practiq_ai/{webapp,execution,messaging}.py \
  tests/test_artifact_performance.py tests/test_execution_preflight.py tests/test_messaging.py
"$AI_PYTHON" -m pyright --pythonpath "$AI_PYTHON" -p pyrightconfig.json \
  src/practiq_ai/{webapp,execution,messaging}.py \
  tests/test_artifact_performance.py tests/test_execution_preflight.py tests/test_messaging.py
```

Full runtime recovery, broker integration, and combined verification remain
separate integration checks. No p50/p95 latency, cold-cache behavior, production
throughput, or RSS improvement is inferred from the deterministic work counts.
