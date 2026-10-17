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
| Model admission | Check budget before queueing; recheck execution/pause after provider waiting; then reserve budget and record dispatch | Budget exhaustion, real graph pause/resume and PostgreSQL paid-reservation regressions |
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

## Measurements

Python 3.14.7 on local macOS. Storage batches use concurrency four and identical
synthetic yielding I/O. Three alternating pairs each contain one warmup and seven
timed runs, with GC enabled. Setup, output assertions and output hashing are
excluded; task-count observation is included in both variants. Tracemalloc runs
are separate from latency samples and measure Python allocations, not RSS or
whole-service memory. The 10000-item case is a stress workload.

| Storage items | Before median | After median | Reduction | Worker tasks | Traced peak, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 | 0.306 ms | 0.185 ms | 39.5% | 20 → 4 | 25311 → 15473 B |
| 1000 | 10.697 ms | 4.065 ms | 62.0% | 1000 → 4 | 1345571 → 23889 B |
| 10000 | 108.312 ms | 39.195 ms | 63.8% | 10000 → 4 | 13680843 → 96169 B |

The mocked outbox workload publishes 201 ordered messages in pages of 100, 100,
and one, retaining real one-second polling sleeps. Across three alternating pairs,
median drain time fell from 2035.152 ms to 28.670 ms by removing the two idle
waits with backlog. Publisher/DB operations are substituted in this measurement;
these numbers do not represent RabbitMQ throughput. Every paired output hash
matches.

The separate runtime probe uses real disposable PostgreSQL/RabbitMQ, a fake
100 ms model, fake verified object storage, 40 documents, eight jobs and graph
concurrency two. Health requests use an in-process ASGI transport. It measures
admission through completion, including checkpoints, but excludes setup and
process startup. The final three-pair alternating comparison uses an archived
baseline checkout and the final source with the read-only budget preflight.
Median elapsed time was 4.279 s before and 4.290 s after (0.3% slower), with
individual runs at 4.251–4.411 s before and 4.260–5.160 s after. Median per-run
queue wait was 1852 ms before and 1847 ms after; median per-run `/ok` p95 was
2.744 ms before and 2.901 ms after. All 240 documents completed with exactly
240 model calls. No overall throughput improvement is claimed.

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

Final `make verify` passed all 2755 tests (zero failures/errors/skips; 11 dependency
deprecation warnings), Ruff, Pyright, lock validation and 33 evaluation fixtures.
Line coverage was 6832/7202 (94.86%); branch coverage was 2410/2676 (90.06%). All
61 selected fault probes passed with the four reported rates at 100%; the separate
`durableCrashRecovery` aggregate remains `NOT_ASSESSED`. Wheel/sdist building and
the 40-file package source/lock integrity check passed. These are local results.

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
