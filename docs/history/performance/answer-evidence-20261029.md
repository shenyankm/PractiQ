# Answer-source validation — October 29, 2026

## Change

Baseline: `125dae03a9594bd8892818819982df578412e87c` (PR #461).
`retain_source_answers` previously matched each question's literal stem against
every source record and counted its source number by rescanning a list. A
1,000-question profile observed approximately one million regex matches.

The validator now sorts record references once, locates literal prefixes by binary
search, and checks identical normalized bodies as a group. A `Counter` retains
source-number multiplicity. The index is local to one validation call and stores
references to existing strings; it introduces no persistent cache or dependency.

When no question has an answer or analysis, the validator returns without parsing
source text and leaves all review metadata intact. Otherwise, source-number
counts reuse the primary records already parsed for candidate lookup. Each
context still contributes its own counts, including text identical to the primary;
repeated numbers continue to block ambiguous answer-key links. The upstream
source/checksum and question-contract validations remain unchanged.

Literal Unicode word/hyphen boundaries, duplicate-stem ID disambiguation, grouped
items, source-number ambiguity, answer-key conflicts and composite proofs retain
their checks. Composite continuation still uses source order. Question order,
review flags and the independent answer/analysis decisions are preserved.

## Measurement

The [raw report](../../../server/reports/answer-evidence-performance-20261029.json)
contains all samples and matching before/after input and output hashes for seven
synthetic workloads. The validation output hash covers both the ordered removal
list and every complete resulting question, including review metadata. The
records-only control hashes the raw parser output and unchanged questions.

Three alternating pairs use separate Python processes, with one warmup and five
timed samples per workload/process. Fixture construction, question copies and
hashes are outside timing; garbage collection remains enabled. Processes run
serially, separately from tests and builds. Small input checks overhead and the
unchanged records-only parser is a control. Answerless input now exercises the
new no-fields return. This measures local answer-source validation, without
storage, database, HTTP, Tencent, model or end-to-end import latency claims.

| Questions / layout | Before median ms | After median ms |
| --- | ---: | ---: |
| 20 / local | 0.541 | 0.467 |
| 1000 / local | 121.743 | 23.089 |
| 1000 / key | 126.610 | 27.534 |
| 1000 / saved-table | 121.628 | 22.318 |
| 1000 / ambiguous | 182.442 | 112.493 |
| 1000 / no-fields | 8.023 | 0.046 |
| 1000 / records-only | 1.656 | 1.649 |

The first per-record prefix prototype regressed the repeated-stem workload.
Grouping equal bodies removed those repeated boundary checks; that workload
remains in the committed probe. Ambiguous candidates still require examination;
the change does not make every source layout linear.

## Verification and limits

- Focused source/answer, workflow and preflight selection: **640 passed,
  27 deselected**. The temporary selection omitted `disposable_databases` tests
  and three native process-reaping/error test cases unavailable in this sandbox.
- Four added work-bound regressions failed before the final refinement and passed
  afterward: empty/fieldless questions preserve their metadata with zero record
  parses; ordinary primary records are parsed once, and repeated context numbers
  still reject an otherwise unique supplied key.
- Lock consistency, repository-wide Ruff, Pyright and all 30 evaluation-fixture
  validations passed. Fixtures and fake providers do not establish model accuracy.
- Wheel/sdist build and `scripts/check_package.py` passed, checking 43 source
  files, licenses and lock bytes. Build dependencies came from the existing local
  uv cache; no project virtual environment was created.
- `make verify` with `PYTEST_ADDOPTS=--maxfail=1` stopped at the first Docker-backed
  test (12 passed, one failed). This session cannot access the Docker socket, so
  full coverage and PostgreSQL/RabbitMQ recovery acceptance remain incomplete.
  This attempt predates the final parsing refinement; it was not repeated after
  the same permission boundary remained unavailable. Final focused checks, lint,
  types, fixture validation, benchmarks and package checks were rerun.
- A wider non-database attempt stopped after 1,206 passing tests and two failures
  requiring macOS worker sandbox creation. Both failures also reproduce on the
  unchanged baseline. The wider focused attempt had 636 passes and 27 Docker or
  native-process failures before the explicit selection above.
- No App/Web UI, package installation, live provider, user-data or credential
  checks were needed for this service-only algorithm change. Hosted CI is unrun
  while publication is blocked; require current-head CI and reviews before merge.

Run with the existing Python 3.14+ interpreter from the repository root:

```sh
PYTHONPATH=server/src "$AI_PYTHON" server/scripts/benchmark_answer_evidence.py \
  --baseline 125dae03 --output /tmp/practiq-answer-evidence.json
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest -q \
  tests/test_answer_evidence_index.py tests/test_answer_evidence.py \
  tests/test_answer_consistency.py tests/test_source_evidence.py \
  tests/test_source_exercises.py tests/test_source_stem_answer.py \
  tests/test_source_duplicates.py tests/test_parsing_review_fixes.py \
  tests/test_review_regressions.py tests/test_workflows.py \
  tests/test_execution_preflight.py)
make verify
```

The commands intentionally do not disable native isolation or required recovery
checks. They require a host where those facilities are available.

## Upgrade boundary

Parser source bytes participate in the execution signature. Drain unfinished
tasks before upgrading or retain their original deployment for explicit recovery;
never rewrite stored signatures. Creating a new parse remains an explicit paid
action. No schema, public contract, source checksum, receipt, backup format,
credential handling, model prompt or paid-work trigger changes.
