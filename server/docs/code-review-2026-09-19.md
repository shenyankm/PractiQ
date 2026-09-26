> Storage update: the current version uses local files only; the OSS backend has been removed. References to OSS below are preserved as historical audit or design records.

> Historical record: the current version uses SQLite and no longer parses Excel source files. The scope and validation results below describe the version reviewed at the time.

> Historical report: results, package sizes, hashes, and dependency descriptions apply to the version tested at the time. The current version has removed Word and LibreOffice. The Import page manages AI parsing tasks; bank ZIP import is under Settings → Restore backup. See the [project overview](../../README.md) and [service guide](service-guide.md) for current usage. Historical evidence does not establish acceptance of the current version.

# Detailed code review and improvement recommendations

- Review date: 2026-09-19
- Target: Python / LangGraph document import service
- Methods: static inspection, existing tests, isolated PostgreSQL fault injection, in-memory graphs, and offline model-protocol reproductions
- Implementation status: R01–R17 and O01–O04 were fixed in the local workspace. Section 8 records each fix and its validation. Sections 1–7 preserve the original findings and evidence.

## 1. Conclusion

The service already has authentication, strict input models, a durable queue, checkpoints, file validation, model-call budgets, and substantial tests. Combined fault scenarios nevertheless expose significant defects. The highest priorities are:

1. Concurrent control requests can starve the connection pool and trigger service exit.
2. Pause and human-review interrupts can conflict, preventing resume.
3. Incorrect XLSX dimensions can silently omit questions.
4. Correction messages are incomplete under the default tool-calling protocol.
5. Underlying work continues after timeout, and image pixel budgets are not enforced.

Fix correctness, recovery, and resource boundaries before broad style refactoring.

## 2. Scope and validation limits

### Review scope

- HTTP, authentication, uploads, and artifact reads.
- PostgreSQL queue, task controls, idempotency, pause, resume, and run deadlines.
- Extraction, parser graphs, structured model output, and result merging.
- Local/OSS storage interfaces and file cleanup scripts.
- Logs, metrics, evaluation, dependencies, and deployment configuration.

At the time, the project explicitly excluded a frontend, product backend, login, billing, answering, and learning reports; their absence was not a defect. A single process, shared Bearer authentication, and public health checks were not treated as findings by themselves.

### Completed checks

| Check | Result |
|---|---|
| Full pytest suite | 452 passed, 2 skipped |
| Skip reason | LibreOffice was not installed locally, so real Writer/Calc rendering tests did not run |
| Ruff | Passed |
| Pyright | 0 errors, 0 warnings |
| Dependency lock consistency | Passed |
| Evaluation manifest | 25 cases validated; this does not mean live-model quality evaluation passed |
| Locked dependency vulnerability audit | No known vulnerabilities found; this does not rule out unknown vulnerabilities |
| Critical findings | Reproduced with isolated databases, in-memory graphs/documents, and SDK MockTransport |

No real external models were called, real OSS acceptance was not performed, the production image was not rebuilt, and coverage was not remeasured. Some reproductions used controlled scheduling, shortened timeouts, or fault injection; they do not measure production throughput or failure probability.

Source locations below are relative to the repository root. Line numbers refer to the reviewed version and may shift after changes.

## 3. Priorities and findings

- **P1: fix first.** Potential service exit, failed recovery, silent content loss, or ineffective resource boundaries.
- **P2: fix next.** Error handling, data contracts, operational reliability, or trustworthiness of validation.
- **Improvements: planned work.** Not equivalent to confirmed exploitable vulnerabilities.

| ID | Priority | Finding | Evidence |
|---|---|---|---|
| R01 | P1 | Control requests exhaust the connection pool and trigger exit | Isolated PostgreSQL fault injection |
| R02 | P1 | Pause and review interrupt order conflicts | In-memory graph reproduction |
| R03 | P1 | Incorrect XLSX dimensions silently omit questions | In-memory workbook reproduction |
| R04 | P1 | Tool-call correction lacks matching responses | Captured actual SDK requests and strict protocol stub |
| R05 | P1 | Synchronous parsing/storage continues after timeout | Controlled blocking-thread reproduction |
| R06 | P1 | Image input bypasses configured pixel limits | In-memory image reproduction |
| R07 | P2 | Incomplete answers bypass type constraints | In-memory model validation |
| R08 | P2 | Late result validation causes repeated resume failures | Model validation and offline graph reproduction |
| R09 | P2 | Sibling coroutines continue after batch failure | In-memory concurrency reproduction |
| R10 | P2 | Recovery prechecks are outside run deadlines | Slow-precheck stub |
| R11 | P2 | Final GC rewrite can corrupt the recovery manifest | Temporary-directory write-failure injection |
| R12 | P2 | Default startup omits structured INFO logs | Default Uvicorn logging reproduction |
| R13 | P2 | Evaluator rejects a valid XLSX schema | Evaluation-function reproduction |
| R14 | P2 | Default storage path violates the documented contract | Actual configuration resolution |
| R15 | P2 | Slow uploads have no receive deadline | Stalled request-stream reproduction |
| R16 | P2 | Non-ASCII Bearer values cause an unhandled exception | Authentication and HTTP-boundary reproduction |
| R17 | P2 | Partially initialized databases cannot retry directly | Static control-flow analysis |

## 4. P1 findings

### R01: Concurrent control requests can trigger service exit

**Locations**

- `server/src/practiq_ai/database.py:69`
- `server/src/practiq_ai/task_api.py:185`
- `server/src/practiq_ai/runtime.py:125`

**Mechanism and impact**

Control transactions acquire a database connection before waiting for a global advisory lock. The lock holder then needs another connection for `_read_task`, checkpoint, or Store reads. Waiting requests can occupy all 16 connections, blocking both the holder and the scheduler.

An isolated PostgreSQL reproduction used 16 concurrent control requests, controlled scheduling, and a shortened pool timeout. It observed `PoolTimeout` and a `fatal(70)` call. The reproduction intercepted the exit function; the production default exits the process.

**Recommendations**

- Serialize control transactions requiring the global lock before acquiring connections.
- Reuse transaction connections where possible and shorten control transactions.
- Move long artifact reads outside the global critical section while retaining necessary consistency rechecks.
- Do not hide the wait chain by merely enlarging the pool.

**Regression acceptance**: at or above pool-capacity control concurrency, the scheduler remains functional; requests complete or fail within bounds without triggering exit.

### R02: Pause and human-review interrupt order conflicts

**Locations**

- `server/src/practiq_ai/execution.py:176`
- `server/src/practiq_ai/graphs/document.py:860`

**Mechanism and impact**

A review node first reaches the guard's pause interrupt, then the business review interrupt. Resume creates a new `runId`, so the old pause marker no longer matches. Replay skips the first interrupt, and the business review consumes the `resume` value intended for pause, returning `INVALID_CONTROL`.

An in-memory graph reproduced this ordering conflict. Ordinary pause tests did not cover both interrupt kinds in one node.

**Recommendation**: keep interrupt order stable during replay, or separate pause and review into independent checkpoint nodes.

**Regression acceptance**: cover both failure review and result-quality review. Resume after pause must enter the correct review state and still allow retry or acceptance of partial results.

### R03: Incorrect XLSX dimensions silently omit questions

**Location**: `server/src/practiq_ai/extractors/xlsx.py:204`

**Mechanism and impact**

`read_only` worksheet iteration trusts declared dimensions. An in-memory workbook contained questions in A1 and B2. Changing its declared range to A1:A1 caused only A1 to be extracted, with no warning, no failure marker, and `truncated=False`.

Existing row-count checks inspect only rows reached by iteration, so they cannot detect content hidden by incorrect dimensions.

**Recommendation**: correct or reset dimensions from actual cells, while limiting actual rows, columns, and total cells to avoid introducing resource exhaustion.

**Regression acceptance**: undersized, missing, and excessively large declared dimensions must not silently omit real cells. Limit breaches must explicitly reject the input or report partial failure.

### R04: Default tool-call correction lacks matching responses

**Locations**

- `server/src/practiq_ai/llm.py:338`
- `server/src/practiq_ai/llm.py:489`

**Mechanism and impact**

After validation failure in the default `function_calling` path, an assistant message with `tool_calls` is followed directly by a user correction message, without a `ToolMessage` for the corresponding `tool_call_id`.

The actual SDK's second request was captured and contained unanswered tool calls. A strict protocol stub returned 400, which became `AI_PROVIDER_ERROR` and stopped correction early. Real-provider rejection was not verified online.

Existing generic model fakes mostly return plain text. Native JSON Schema tests also do not cover the default tool-calling path.

**Recommendation**: build correction history with properly paired tool messages and add request-level regression coverage for the default protocol.

**Regression acceptance**: invalid first-call arguments followed by valid second-call arguments complete correction and retain both usage records. The second request contains no unmatched tool calls.

### R05: Underlying synchronous work continues after timeout

**Locations**

- `server/src/practiq_ai/graphs/document.py:301`
- `server/src/practiq_ai/storage.py:199`

**Mechanism and impact**

Timing out `wait_for(to_thread(...))` cancels only the wait, not an already running thread. The reproduction returned a timeout from the endpoint or graph node while the underlying operation remained alive.

Slow disks, slow OSS, or expensive parsing can accumulate leftover work. Task/upload slots may be released while work still consumes the shared thread pool, CPU, memory, or rendering lock. Continued thread execution was reproduced; the extent of production resource exhaustion remains an inferred risk.

**Recommendations**

- Run extraction that cannot cancel cooperatively in terminable, reapable subprocesses.
- Give storage separate bounded execution resources, releasing capacity only when underlying operations actually finish.
- Distinguish request-wait timeout, underlying I/O timeout, and completed resource cleanup; checking error codes alone is insufficient.

**Regression acceptance**: repeated timeouts do not continually accumulate work, and later normal tasks can still obtain execution resources.

### R06: Image input does not enforce the configured pixel limit

**Location**: `server/src/practiq_ai/extractors/image.py:10`

**Mechanism and impact**

Direct image uploads run only `image.verify()` without checking `AI_MAX_VISION_PAGE_PIXELS`. With the pixel limit set to 1, a 200×200 image was still accepted.

Compressed-byte limits do not bound decoded memory, and Pillow's own threshold is not the service's configured limit. Later cropping decodes the full image.

**Recommendation**: validate dimensions and pixel budgets before acceptance, define a multi-frame policy, and align relevant image, PDF, and XLSX boundaries.

**Regression acceptance**: over-budget images are rejected before model calls and full decoding; images exactly at the limit pass.

## 5. P2 findings

### R07: Incomplete answers bypass type constraints

- **Location**: `server/src/practiq_ai/contracts.py:205`
- **Problem**: the partial branch returns a dictionary directly, bypassing some complete-schema constraints. It accepts `true_false.value=["x", null]`; `correctOption=["A", null]` raises `AttributeError` during reference checks.
- **Recommendation**: allow missing values while always validating containers, element types, lengths, and references. Invalid structures must produce validation errors that can enter correction.
- **Acceptance**: cover missing-value/wrong-type combinations for every type. Arbitrary containers must not count as valid drafts, and no unhandled type exceptions should occur.

### R08: Late model-result validation can repeatedly break resume

- **Locations**: `server/src/practiq_ai/graphs/vision.py:27`, `server/src/practiq_ai/graphs/document.py:449`
- **Problem**: `PageFigure` accepts whitespace-only descriptions and labels longer than 1000 characters; conversion to `VisualElement` rejects them outside the model-correction boundary. Accepted output may already be checkpointed, so resume fails again without another model call.
- **Recommendation**: share field constraints between model-output schemas and final public models so structural acceptance guarantees safe conversion.
- **Acceptance**: handle blank descriptions and oversized labels during model correction, without caching results that retry cannot recover.

### R09: Sibling coroutines continue after batch failure

- **Location**: `server/src/practiq_ai/graphs/document.py:208`
- **Problem**: when one `asyncio.gather` child fails, the exception propagates without automatically canceling and awaiting siblings. Artifact writes or cropping may continue and overlap a new batch after resume.
- **Recommendation**: cancel and await every child on error, or use `TaskGroup`. Canceling a coroutine still cannot terminate the synchronous threads described in R05.
- **Acceptance**: test a batch with one immediate failure and one blocked child. No sibling coroutine may remain running when the batch returns.

### R10: Recovery prechecks are outside run deadlines

- **Location**: `server/src/practiq_ai/runtime.py:150`
- **Problem**: source/artifact validation runs before establishing/checking the deadline and entering the timeout scope. An expired run may still spend a long time in prechecks while occupying a task slot.
- **Recommendation**: establish the deadline first and apply the remaining time to both prechecks and graph execution.
- **Acceptance**: expired runs skip lengthy prechecks, and slow prechecks cannot exceed the total run deadline.

### R11: Final GC update can corrupt the recovery manifest

- **Location**: `server/scripts/storage_gc.py:139`
- **Problem**: a recovery manifest is persisted before moving objects, but completion rewrites it non-atomically with `write_text`. Truncation followed by disk failure or process interruption can leave an empty or incomplete manifest.
- **Recommendation**: preserve the original manifest or update completion status through a temporary file, fsync, and atomic replacement.
- **Acceptance**: inject failure during the final update; the original manifest for moved objects remains fully readable.

### R12: Default startup omits structured INFO logs

- **Location**: `server/src/practiq_ai/telemetry.py:62`
- **Problem**: events use INFO, while default Uvicorn configuration leaves `practiq.events` at effective WARNING without an output handler. Expected events are absent during normal startup, impairing diagnostics, call traces, and human review. Tests mask this by explicitly enabling INFO.
- **Recommendation**: configure the logger, level, handler, and JSON message format at startup, independently of test logging settings.
- **Acceptance**: verify events with actual startup configuration and ensure logs exclude content, credentials, and raw exceptions.

### R13: Evaluator rejects the valid XLSX schema

- **Locations**: `server/scripts/evaluate.py:344`, `server/src/practiq_ai/graphs/excel.py:102`
- **Problem**: XLSX uses `GroundedSheetResult`, but the evaluator requires `ChunkParseResult` for `document_parse`, producing `WRONG_ROUTE_OR_SCHEMA` for valid calls.
- **Recommendation**: validate allowed call-kind/schema combinations by source format, not a single mapping keyed only by `callKind`.
- **Acceptance**: valid XLSX trajectories pass while incorrect model routes and schemas still fail.

### R14: Default storage path violates the documented contract

- **Locations**: `server/src/practiq_ai/config.py:12`, `server/src/practiq_ai/config.py:160`
- **Problem**: documentation resolves relative paths from `server/`, but `parents[3]` points to the repository root. The default therefore resolves to root-level `.local/ai-oss`; wheel installation changes the base again with installation layout.
- **Recommendation**: define a stable path contract and test source and wheel installations. Production should use persistent absolute paths.
- **Caution**: account for existing file locations before changing behavior. Do not silently switch data roots or automatically move/delete data.
- **Acceptance**: behavior matches documentation across working directories and installation modes, with explicit, reversible handling of existing data.

### R15: Slow uploads have no receive deadline

- **Location**: `server/src/practiq_ai/webapp.py:150`
- **Problem**: request bodies have a byte limit but no idle or total receive deadline. A stalled authenticated upload can occupy a slot indefinitely; storage timeouts do not cover body reception.
- **Boundary**: default Nginx request buffering mitigates proxied deployment, but direct service access remains affected.
- **Recommendation**: bound reception time and release upload slots on timeout.
- **Acceptance**: stalled streams end within bounds; slow but continuously progressing valid requests follow the documented policy.

### R16: Malformed Bearer input causes an unhandled exception

- **Location**: `server/src/practiq_ai/auth.py:12`
- **Problem**: string `secrets.compare_digest` rejects non-ASCII content with `TypeError`, producing 500 instead of 401.
- **Boundary**: no authentication bypass was found; this is an input/error-handling defect.
- **Recommendation**: reject input outside the token encoding contract before constant-time comparison and return 401 consistently.
- **Acceptance**: missing, incorrect, and non-ASCII tokens produce no unhandled exceptions; valid-token behavior remains unchanged.

### R17: Partially initialized databases cannot retry directly

- **Location**: `server/src/practiq_ai/database.py:75`
- **Problem**: checkpoint setup, Store setup, and business DDL run separately. If a later step fails, the nonempty database rejects reinitialization but cannot pass complete-schema checks.
- **Validation status**: confirmed by static control flow; initialization-stage fault injection had not yet run.
- **Recommendation**: record or recognize initialization phases and allow only verified partial states owned by this service to continue. Still reject unknown nonempty databases.
- **Acceptance**: injected failures at each phase recover safely on retry without changing existing data in unknown databases.

## 6. Further improvements

### O01: Align queue alerts with admission capacity

- **Locations**: `server/deploy/alerts.rules.yml:22`, `server/src/practiq_ai/task_api.py:49`
- **Current behavior**: admission counts pending plus running, while the alert requires at least 300 pending. With all eight default running slots occupied, 292 pending tasks can already reject new work without triggering the alert.
- **Recommendation**: use the same count and configured capacity as admission; test normal saturation and capacity changes.

### O02: Complete cross-chunk material-group merging

- **Location**: `server/src/practiq_ai/graphs/chunking.py:155`
- **Current behavior**: overlapping questions are source-deduplicated, but groups are appended directly, potentially duplicating the same cross-chunk group and its overlapping memberships.
- **Recommendation**: merge only groups sharing confirmed overlapping questions and matching titles/materials, never merely matching names.
- **Acceptance**: one cross-chunk material group merges correctly; same-named groups from different sources remain separate.

### O03: Prioritize combined-fault tests

Before adding more happy-path tests, cover:

- Pause and human-review interrupts together.
- Concurrent control, a full connection pool, and scheduler connection acquisition.
- One failed artifact task with another still blocked.
- Output correction under the default tool-calling protocol.
- Model output valid under an intermediate schema but invalid for the final result.
- Underlying work continuing after timeout while recovery or a new task starts.
- Successful GC moves followed by a failed completion-manifest write.

Check actual consequences—resource release, recoverable state, correct request protocol, and data integrity—not just exception types or error codes.

### O04: Strengthen converter isolation

- **Location**: `Dockerfile.server:6`
- **Current behavior**: the image declares no non-root user while processing untrusted documents, leaving room to strengthen isolation.
- **Recommendation**: use an unprivileged user with CPU, memory, filesystem, and conversion-process isolation, and define writable temporary/persistent paths.
- **Boundary**: this is defensive hardening, not a confirmed exploitable converter vulnerability. Evaluate permission/deployment changes separately and verify existing mounts and conversion behavior.

## 7. Recommended implementation order

| Phase | Scope | Completion criteria |
|---|---|---|
| 1: Core correctness and recovery | R01, R02, R03, R04 | Focused regressions for pool starvation, pause/review, XLSX omission, and default-protocol correction |
| 2: Resource and result boundaries | R05, R06, R07, R08, R09, R10, R15 | Timeouts/failures leave no uncontrolled work; input and final-output constraints agree |
| 3: Data and operational reliability | R11, R12, R13, R14, R16, R17 | Trustworthy recovery manifests, logs, evaluation, storage paths, and initialization |
| 4: Continuous improvement | O01, O02, O03, O04 | Capacity-aligned alerts, correct cross-chunk structure, combined-fault coverage, and deployment isolation |

Update relevant docs and focused tests with each behavior change, then run project verification. Real-provider protocols, real LibreOffice rendering, and real OSS behavior still require acceptance in appropriately authorized environments; offline fakes cannot replace it.

## 8. Repair record (2026-09-19)

Repairs followed section 7. Nothing was committed, pushed, or deployed, and existing storage files and business databases were neither moved nor deleted. New tests mainly reside in `tests/test_review_regressions.py`; database fault injection used a separate temporary PostgreSQL database.

| ID | Implementation | Regression evidence |
|---|---|---|
| R01 | Queue control transactions before acquiring connections; move artifact prechecks outside the global transaction and recheck run/checkpoint before enqueueing | Database queries, scheduler, and readiness remained available during 24 concurrent control requests, with no fatal call |
| R02 | Separate pause checkpoints for visual, text, and result review; review nodes no longer mix pause interrupts | All three review kinds resumed with a new runId; failure review still allowed partial-result acceptance or retry |
| R03 | Reset declared dimensions, precheck actual coordinates, and bound actual cell iteration | Undersized, missing, and oversized dimensions retained A1/B2; excessive rows/columns produced explicit partial failure |
| R04 | Add every matching ToolMessage during correction; convert malformed envelopes without valid call IDs into plain-text history | Actual SDK MockTransport checked second-request pairing; invalid arguments/JSON corrected on the second call with both usage records retained |
| R05 | Terminate and reap extraction process groups, inherited by converters; transfer results as JSON/base64. Give storage a separate bounded pool and slots released only after actual I/O completion | Real blocked subprocesses and descendants stopped on timeout/cancel; repeated storage timeouts left only one underlying operation, and normal requests resumed after completion |
| R06 | Check pixels before verify/model calls/full decode at direct image input; explicitly reject multiple frames | Over-limit images rejected, exact-limit images accepted, multi-frame GIF rejected |
| R07 | Validate field shape, strict element types, lengths, list capacity, and references even with missing answers | Missing values preserved across types; wrong booleans/arrays/integers/matching pairs and oversized fields consistently raised ValidationError |
| R08 | Share description constraints across PageFigure, ImageDescription, SheetVisual, and VisualElement, and share label limits | Blank descriptions/oversized labels corrected within structured_call; valid results directly constructed public output |
| R09 | Cancel and await all sibling coroutines on batch failure/cancellation | With one failed and one blocked child, blocked-child cleanup completed before return |
| R10 | Include recovery prechecks in the persisted run's remaining deadline | Expired runs skipped prechecks; slow prechecks canceled at the deadline and released the task slot |
| R11 | Final GC manifest update uses a temporary file, fsync, and atomic replacement | Injected replacement failure after quarantine preserved the original manifest and object recovery by runId |
| R12 | Startup installs an idempotent independent INFO JSON handler without relying on the root logger | A subprocess using default Uvicorn configuration emitted an event exactly once, excluding content/credentials/raw exceptions |
| R13 | Use GroundedSheetResult for XLSX and validate the actual preparation sequence | Valid XLSX trajectories passed; wrong schemas and missing preparation still failed |
| R14 | Resolve source-relative paths from server/; require absolute paths for wheels; reject implicit switching when old relative locations contain data | Working-directory independence, source/wheel paths, and old-data preservation tested; container wheels use absolute persistent paths |
| R15 | AI_UPLOAD_TIMEOUT_SECONDS bounds total reception time; 408 releases the upload slot | Stalled streams ended within bounds; subsequent valid uploads succeeded |
| R16 | Reject non-ASCII input before comparing Bearer tokens | Non-ASCII HTTP headers returned 401; valid/incorrect/missing-token tests still passed |
| R17 | Mark empty databases before initialization, retry known partial states, and atomically commit business DDL with marker removal | Retry succeeded after faults in checkpoint, Store, and business-DDL phases; unknown database contents remained intact |
| O01 | Compare same-instance pending + running with actual queue_capacity | promtool covered 292+8/300 saturation, custom 2+8/10 capacity, and unsaturated instances |
| O02 | Merge only unique matches with matching title/material and shared confirmed overlapping questions | Cross-chunk material groups merged; same-name/different-material and different-source groups remained separate |
| O03 | Add pool, pause/review, concurrent-failure, protocol-correction, process/thread-timeout, and GC-write fault combinations | Checked real resources, recovery outcomes, request messages, and manifests, not only error codes |
| O04 | Image UID/GID 10001; Compose CPU/memory/PID limits, read-only root, and no privilege escalation | Real Writer/Calc, process extraction, and temporary-directory cleanup passed as non-root with a read-only root; temporary host bind-mount reads/writes passed while preserving existing files |

### Upgrade and validation limits

- See [operations.md](operations.md) for storage-path upgrades, retaining the old location, and manual migration/rollback. When old-location data exists, explicitly set `AI_STORAGE_DIR` to its original absolute path or migrate manually first. User configuration and permissions are not changed automatically.
- Runtime semantics and code signatures changed. Resume old tasks on their original deployment or create new tasks. Old signatures were not forged to bypass checkpoint compatibility protection.
- The new total upload deadline defaults to 120 seconds, so continuous but excessively slow uploads also time out; operators can adjust it. Threads cannot cancel storage I/O itself, but background work has a strict capacity limit. If all slots remain occupied by underlying I/O, later requests fail within bounds.
- Container checks used temporary directories and offline documents, without production mounts or deployment. `scripts/check_container.py` can rerun inside an image with the same restrictions. Real-provider protocols and real OSS were still unverified online; offline SDK tests do not replace provider acceptance. Live-model quality evaluation was not rerun.

### Final verification

| Check | Result at the time |
|---|---|
| `make verify AI_PYTHON=<existing Python 3.14.7>` | Passed: all 504 tests, none skipped; 94% coverage; Ruff, Pyright, lockfile, 25-case evaluation manifest, fault probes, and sdist/wheel builds |
| `make audit AI_PYTHON=<existing Python 3.14.7>` | No known vulnerabilities in locked runtime/development dependencies |
| `make image-check` | New non-root image built successfully; not published |
| `promtool test rules /rules/alerts.test.yml` | All rule cases passed |
| `docker compose -f server/deploy/service.compose.yml config --quiet` | Configuration validated with a temporary absolute storage path; deployment was not started |
| `python /check.py` in a restricted container | With UID 10001, read-only root, 2 CPU / 2 GiB / 128 PID limits: real Writer/Calc, process extraction, temporary cleanup, and host bind-mount object reads/writes passed; preexisting mounted files retained their contents |
| `git diff --check` | Passed |

This run's `make verify` artifacts were saved in `server/reports/checks/`. The full suite included real local LibreOffice tests, isolated PostgreSQL, and process-restart tests. The probe summary's fixed test set still does not establish production durability/capacity or live-model quality acceptance.
