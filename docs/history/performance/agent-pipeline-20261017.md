# Agent pipeline hardening, October 17, 2026

Baseline: `3d80763e03d8d595addc0bc52248c9c01bbf9c98` (merged PR #256).
Candidate: local `sheny/agent-pipeline-hardening`; source hashes are recorded in
the [raw measurements](../../../server/reports/agent-pipeline-20261017.json).

## Scope and decisions

The review followed document admission through transactional outbox delivery,
preparation, parallel extraction, optional review/repair, model attempts, artifact
persistence, checkpoints, result reads and recovery. Explicit synchronous grading
shares the model boundary. This is a focused correction of demonstrated problems,
not a claim that every possible Agent failure or workload has been eliminated.

| Boundary | Change or retained protection | Acceptance |
| --- | --- | --- |
| Authenticated admission | Keep account ownership, request receipts and atomic run/outbox commit | Existing HTTP, SaaS and runtime integration tests |
| Outbox and controls | Separate wake events; clear each before its database scan; drain full 100-row pages without idle sleeps | Notification isolation and backlog regressions; broker recovery suite |
| Preparation | Keep isolated extractor/Office workers, shared resource budgets and checksum manifests | Existing format, cancellation and preparation tests |
| Unit and review I/O | Move the shared ordered map from a graph-private helper to `capacity.bounded_map`; allocate only the configured number of workers | Empty/single/10000-item order, task-count, cancellation and sibling-failure tests |
| Model admission | Check budget before queueing; recheck pause before RPM consumption and dispatch using the committed run flag; reserve budget afresh | Budget exhaustion, real graph pause/resume and PostgreSQL paid-reservation regressions |
| Structured extraction and review | Keep bounded corrections, stalled/truncated-output handling, source-evidenced repair and immutable result receipts | Existing structured-output, review and billing tests |
| Unit persistence | Include unit-result serialization/write in the remaining stage deadline | Injected hung-write timeout and existing storage/recovery tests |
| Completion and recovery | Keep synchronous checkpoints, unknown-result blocking, exclusive ownership and explicit retry | Existing restart, ambiguous publish/ACK and billing probes |

No new dependency, parser, schema, public API, provider cache or automatic replay
was introduced. Shared batching now belongs to the capacity module used by both
the graph and passive task review. The runtime owns notification fan-out, while
each loop owns its event. This reduces the API's dependency on graph internals
without introducing a new framework or broad file reorganization.

## Reproductions

Before edits, the initial six-case regression run failed four cases:

- A publisher wait cleared a control notification on the shared event.
- A 10000-item storage batch allocated 10000 tasks despite concurrency three.
- A hung unit-result write exceeded the stage deadline and was stopped only by
  the test's outer timeout.
- A pause appearing during provider waiting still allowed a model request.

The full-page outbox regression also verifies that all 101 queued messages are
published before the first idle wait. Failure and cancellation paths still await
worker cleanup, return no partial successful list, and preserve output ordering
including legitimate `None` values.

Two additional regressions cover zero-allowance units and already-spent review
budgets. A read-only budget check rejects both before entering the provider
queue; the fresh reservation after the pause check still enforces the durable
limit. This avoids adding provider wait time to an already exhausted unit.

The paid admission test uses real disposable PostgreSQL/RabbitMQ with a fake
model. Pausing at provider admission produces an undispatched, rejected
reservation, zero model ledger charges and unchanged balance. Explicit resume
completes with one provider invocation and one settlement. A request already
dispatched remains subject to the existing conservative unknown-usage handling.

## PR review corrections

[PR #257](https://github.com/shenyankm/PractiQ/pull/257) identified two additional
pause boundaries. Provider admission previously consumed an RPM slot before
checking a queued pause, and the Store projection could lag an acknowledged
pause transaction. The rate gate now checks before taking a slot after
concurrency admission and on each rate-wait retry. Runtime guards also read the
current run's committed pause flag, scoped by run and thread IDs, using an ephemeral database
handle; persisted context and checkpoints retain no database handle.

Two regressions reproduce concurrency/rate waits and assert zero consumed RPM
slots, released concurrency, no model calls, and one call on explicit resume.
The paid regression also pauses through the normal authenticated task API while
the control coordinator is parked. Removing the durable check makes that task
complete despite the committed pause; the corrected code pauses with no model
call or ledger debit, then settles exactly once on explicit resume. The focused
admission/execution/review suite passes 242 tests. Initial fixture-authentication
and command-directory failures are retained separately from valid red/green
regressions.

## Measurements

Python 3.14.7 on local macOS. Storage batches use concurrency four and identical
synthetic yielding I/O. Three alternating pairs each contain one warmup and seven
timed runs, with GC enabled. Setup, output assertions and output hashing are
excluded; task-count observation is included in both variants. Tracemalloc runs
are separate from latency samples and measure Python allocations, not RSS or
whole-service memory. The 10000-item case is a stress workload.

| Storage items | Before median | After median | Reduction | Worker tasks | Traced peak, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 | 0.289 ms | 0.172 ms | 40.6% | 20 → 4 | 25311 → 15545 B |
| 1000 | 10.789 ms | 4.112 ms | 61.9% | 1000 → 4 | 1345571 → 23961 B |
| 10000 | 108.727 ms | 39.252 ms | 63.9% | 10000 → 4 | 13680843 → 96241 B |

The mocked outbox workload publishes 201 ordered messages in pages of 100, 100,
and one, retaining real one-second polling sleeps. Across three alternating pairs,
median drain time fell from 2035.225 ms to 19.753 ms by removing the two idle
waits with backlog. Publisher/DB operations are substituted in this measurement;
these numbers do not represent RabbitMQ throughput. Every paired output hash
matches.

The separate runtime probe uses real disposable PostgreSQL/RabbitMQ, a fake
100 ms model, fake verified object storage, 40 documents, eight jobs and graph
concurrency two. Health requests use an in-process ASGI transport. It measures
admission through completion, including checkpoints, but excludes setup and
process startup. The final three-pair alternating comparison uses an archived
baseline checkout and the review-fixed source, including durable pause checks and RPM admission.
Median elapsed time was 4.328 s before and 4.290 s after (0.9% faster), with
individual runs at 4.208–4.368 s before and 4.287–4.343 s after. Median per-run
queue wait was 1911 ms before and 1817 ms after; median per-run `/ok` p95 was
3.000 ms before and 2.694 ms after. All 240 documents completed with exactly
240 model calls. No overall throughput improvement is claimed.

The published pre-review source measured 4.279 s before / 4.290 s after
(0.3% slower); its samples and source snapshot remain available in the original
acceptance files and Git commit `c405ed4`. Review-fixed measurements use a fresh
`pr257/review-fixed/` directory and retain the earlier raw files.

Exploratory measurements of the first candidate varied in both directions:
nonalternating medians 3.205 s before / 3.332 s after, then alternating medians
3.411 s before / 3.247 s after. Their source snapshots and samples are retained
under `server/reports/checks/agent-pipeline-20261017/first-candidate/`. These
small, variable samples establish functional completion and responsiveness for
the fixture, not production p95/p99 or a reliable whole-service speedup.

## Verification and reproduction

Use the repository's existing Python 3.14+ interpreter, without a project venv:

```sh
PYTHONPATH=server/src:server "$AI_PYTHON" server/scripts/benchmark_agent_pipeline.py \
  --baseline 3d80763e03d8d595addc0bc52248c9c01bbf9c98 \
  --output /tmp/practiq-agent-pipeline.json
PYTHONPATH="$PWD/server/src" make verify AI_PYTHON="$AI_PYTHON"
```

The benchmark explicitly loads only the selected local Git baseline and retains
source hashes, individual samples, output hashes and allocation counts. The
[acceptance record](../../../server/reports/agent-pipeline-20261017-acceptance.json)
identifies final checks, corrected fixture/environment failures, repeat runtime
measurements and local raw evidence. Earlier performance reports and all original
screenshots are preserved; shared check outputs are archived during verification
and restored after the new outputs are retained in this run's directory.

Final `make verify` passed all 2758 tests (zero failures/errors/skips; 11 dependency
deprecation warnings), Ruff, Pyright, lock validation and 33 evaluation fixtures.
Line coverage was 6837/7207 (94.87%); branch coverage was 2413/2680 (90.04%). All
61 selected fault probes passed with the four reported rates at 100%; the separate
`durableCrashRecovery` aggregate remains `NOT_ASSESSED`. Wheel/sdist building and
the 40-file package source/lock integrity check passed. These are local results. One preceding full repeat passed 2757 tests but failed
the broker consumer-timeout observation at its unchanged 140-second bound.
An isolated fresh-broker repeat passed in 65.58 s, and this final complete repeat
passed all tests without changing that assertion or timeout. Both complete runs,
queue arguments and broker logs are retained under `pr257/`.

## Limits

This acceptance uses model substitutes; it does not establish live-model accuracy,
provider latency, deployed Office fidelity, production p95/p99, or distributed
high availability. Provider capacity and full filesystem cleanup remain bounded
cooperatively by their existing safeguards, rather than by a hard kill of file
writes. Existing execution fingerprints still reject resume across changed
deployments; retain the original deployment for its unfinished tasks or explicitly
start a new task. The subsequent shared-button sizing fix has its own
[App/Web screenshot acceptance](../../evidence/2026-10-17-button-sizing/README.md);
it does not change Agent behavior or establish native package acceptance.
