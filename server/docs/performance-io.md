# Service I/O work bounds

## OCR context and validated projections (October 30 follow-up)

`_vision` checks whether PRIMARY has questions with stable IDs before opening
neighbor OCR artifacts. Empty/answer-only pages and drafts without IDs cannot
use context enrichment, so they read only PRIMARY. Eligible context still uses
the same ordered, size/hash-verified reads and model calls.

Each `OcrPageParseResult` validates its fixed Tencent figure associations and
creates one private `PageParseResult` projection. `_vision` consumes that
projection without mutating the OCR response. Context enrichment validates a new
response and preserves PRIMARY independently. Oversized context marks the
validated PRIMARY questions for review. Explicit `page_result()` calls still
revalidate; this is not a cross-request cache or validation bypass.

See the [follow-up acceptance report](../../docs/history/performance/followup-20261030.md)
for output-equivalence checks, work counts and local timing limits. Parser-source
changes alter the conservative execution signature: drain unfinished imports on
their original deployment, or retain it for explicit recovery. Never rewrite
saved signatures; see [resume compatibility](resume-compatibility.md).

## Validated HTTP read models (October 30)

Detail and preview routes retain validated Pydantic models through the HTTP
response boundary. The existing dictionary helpers still serialize for internal
tools; export consumes the validated detail directly. Saved inputs remain
validated, model-supplied audio remains discarded, and default HTTP JSON stays
equivalent. The opt-in metadata preview avoids sending completed questions twice;
see the [API contract](document-tasks.md#read-only-review-preview).

The [read-path acceptance](../../docs/history/performance/read-paths-20261030.md)
records paired actual-ASGI timings, response sizes and output hashes. It also
retains the rejected concurrent OCR-read experiment: local small-file reads did
not improve, so merge retains sequential verified OCR reads.

These optimizations remove repeated work without changing task authorization,
verified storage, explicit resume/retry, paid-call receipts, or database schemas.
They add no cross-request cache, configuration, or dependency.

## Artifact authorization (recommendation 3)

`webapp.read_artifact` still authenticates the request, requires a task ID, and
reads the authoritative task record, including supported-format and expiry checks.
The namespace check is only an early rejection, not authorization. Membership
compares all four reference fields (`objectKey`, `sha256`, `sizeBytes`,
`mediaType`). An exact original-source match skips snapshots, task detail and
review. Other references first check the saved checkpoint's public `pageRefs`,
`chunkRefs`, and OCR evidence for vision units actually exposed by `review_task`.
OCR entries without a public vision unit are not authorized; once merged questions
exist, orphan parsed-unit indices no longer expose OCR evidence. Internal text,
input-part and unit-result references are not recursively authorized.

Result-only visual references now reuse that same snapshot. Final result visuals
are checked directly; before merge, saved successful units are loaded one at a
time in source order and authorization stops at the first matching visual. No
full task detail, usage diagnostics or review response is constructed. A merged
result supersedes old unit visuals. Arbitrary dictionaries embedded in question
content cannot grant access to internal files.

Every accepted reference still uses `get_verified`; original sources retain
`DocumentReference` validation. There is no cross-request cache, and source
namespace alone never authorizes a read.

`tests/test_artifact_performance.py` saves real in-memory LangGraph checkpoints
and local externalized unit JSON files for N = 1, 30, 100. It first verifies that
real review loads N units and exposes the requested references, then downloads
all N distinct page, chunk, or OCR evidence artifacts. The asserted work is:

| Work for N public checkpoint artifact downloads | Before this fix | After |
| --- | --- | --- |
| Detail / review calls | N / N | 0 / 0 |
| Snapshot reads | 2N | N |
| Unrelated unit-result loads | N² | 0 |
| Requested verified payload reads | N | N |

For example, the 30-unit case previously loaded 900 unit results; it now loads
none. This is deterministic work-count evidence, not a latency benchmark. The
snapshot path uses the real runtime reader with an in-memory checkpointer;
authoritative database rows are synthetic, not checkpoint SQL measurements.
For a result-only visual in the first of N saved units, the new regression checks
one snapshot, one verified unit-result read and one verified image read, for
N = 1, 30, 100. Later corrupt unrelated units are never opened. A reference in a
later unit, or an absent reference, may still require preceding units; no reverse
index or manifest was added.

Coverage retains four-field mismatches, cross-task and same-source nonmember
rejection, missing/expired/unsupported tasks, and missing/corrupt requested bytes.
An unrelated corrupt unit no longer prevents reading a valid public source page.
Merged/unmerged OCR exposure and internal-reference rejection are tested as well.
The October 25 runtime changes also touch hashed parser/Tencent sources, so the
normal conservative execution signature changes. Drain unfinished tasks on their
original deployment or retain that deployment for explicit recovery; do not
rewrite signatures. Passive reads and exports still do not start models. See
[resume compatibility](resume-compatibility.md).

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

## Tencent client and export lifetimes (October 25)

Each admitted `parse_job` owns one private RPC `AsyncClient`, shared by its submit,
queries and existing bounded read retries, then closed on success, failure or
cancellation. Task-local context prevents concurrent jobs from borrowing each
other's client. Direct standalone RPC requests still own a short-lived client;
result-download/COS clients remain separate, with their original URL policies.
Signed headers are built for every request. Timeout, response bounds, disabled
proxies/redirects and no automatic submit replay remain unchanged. After the known
task ID is persisted, the source bytes and Base64 submit dictionary are deleted
before polling. This is a frame-lifetime guarantee, not an RSS bound.

Task export constructs detail from its initial `(task, snapshot, run)` instead of
reading the full checkpoint again. The post-build checkpoint/state read remains
mandatory and closes the archive on conflict, failure or cancellation. Media
entries use Stored for JPEG/MPEG/MP4/AAC; JSON, PNG and WAV retain fast Deflate.
PNG can contain uncompressed image data, so it is not categorically treated as
already compressed. All content checks, permissions and package limits remain.

The [October 25 acceptance record](../../docs/history/performance/runtime-optimizations-20261025.md)
contains work counts, paired probes, commands and exclusions.

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
