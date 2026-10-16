# Extractor startup dependency reduction — 2026-10-16

TXT/CSV workers previously loaded public Pydantic contract models through
annotation imports, and SaaS/LangGraph through an unconditional billing-helper
import in `config.load()`. Fresh workers paid this cost before decoding even a
small text source. Annotation imports now run only during type checking, and
billing conversion imports the existing helper only when both rates are set.
Configured rate validation and integer conversion remain unchanged.

Two regression cases launch the real isolated worker entry point with TXT and
CSV sources, verify decoded output and inspect Python import traces. They fail
against the clean parent revision because service dependencies are imported.
They replace no extractor, make no external model call and impose no timing
performance threshold. Parser limits, subprocess isolation, cancellation and
business test deadlines are unchanged.

## Submitted-tree validation

Validation ran on an isolated worktree based on
`846829ed38fa78bc211ec721a1af2d588df2af5b`, excluding unrelated resource-recovery
and backup work. `make verify` passed with **2679 tests**, 11 warnings, no
failures/errors/skips, line coverage **94.83%** and branch coverage **90.08%**.
Lockfile consistency, Ruff, Pyright, 33 evaluation fixtures, recovery probes,
build and package integrity passed; command exit was 0. The complete test run
took 429.38 seconds on macOS arm64 with Python 3.14.7 and disposable
PostgreSQL/RabbitMQ instances. External model calls were substituted as usual.

After verification ended, 40 fresh workers ran sequentially against clean
parent/candidate source snapshots: 10 TXT and 10 CSV workers per version, with
version order alternating between trials. Bytecode caches were absent; OS
caches were warm. Every output manifest matched exactly within its format.

| Real worker startup and extraction | Parent median | Candidate median |
| --- | ---: | ---: |
| TXT, 10 workers per version | 347.00 ms | 50.50 ms |
| CSV, 10 workers per version | 343.34 ms | 51.39 ms |

Source hashes confirm that only the four intended runtime modules changed;
public contracts and the original deduplication/deadline tests remain identical
to the parent. [Measurements and validation](evidence/2026-10-16-extractor-startup/)
retain all samples and source hashes without packages, credentials or local
database files. These are local startup measurements, not production throughput.

## Original timeout remains open

This optimization is **not a root-cause resolution** of the original 15-second
`test_retry_preserves_admitted_dedup_flag` failure. It happened on the first
`wait_idle()`, before the explicit retry. The cancelled PostgreSQL cursor only
locates the observer; no contemporaneous worker-stage, query-duration or
scheduler trace exists to identify its cause.

Follow-up diagnostics used the pre-optimization runtime and real extraction,
PostgreSQL, RabbitMQ and persistent graph execution. Corrected load replays
verified actual native-test/release-build overlap: 24 of 30 target initial waits
finished within native execution, with a longest wait of 3.989 seconds. The
historical 15-second failure was not reproduced. Earlier concurrent checks that
aborted before native tests, or whose native tests finished before admission,
do not establish that overlap.

A later full diagnostic run of that pre-optimization workspace recorded 2701
passes and a different failure: a 140-second wait for consumer disconnection in
`test_consumer_timeout_does_not_overlap_or_repeat_old_execution`. The two new
startup assertions were deliberately deselected against the old runtime. That
case passed alone, and all 51 messaging cases then passed in their existing
order; neither rerun explains the failed full suite. Both timeout investigations
remain open. These historical results are separate from submitted-tree checks.

No release, deployment, live-model accuracy, production capacity or timeout
root-cause acceptance is implied by this change. Native Windows/Android and
production model-provider validation are outside this service-import change.
