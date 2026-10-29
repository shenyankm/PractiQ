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

Composite proofs normalize and compile their parent-title prefix once per child,
then reuse it while scanning source records and checking the matched passage.
The compiled regex keeps the original literal Unicode word/hyphen boundary.

Literal Unicode word/hyphen boundaries, duplicate-stem ID disambiguation, grouped
items, source-number ambiguity, answer-key conflicts and composite proofs retain
their checks. Composite continuation still uses source order. Question order,
review flags and the independent answer/analysis decisions are preserved.

## Measurement

The [raw report](../../../server/reports/answer-evidence-performance-20261029.json)
contains all samples and matching before/after input and output hashes for nine
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
The composite cases combine five existing evaluation parent/child questions
with answerless ordinary questions to reach 20 or 1,000 questions. Their complete
supplied fields must survive unchanged. Both the entry point and composite helper
are loaded from the baseline, so the comparison includes the title-loop change.

| Questions / layout | Before median ms | After median ms |
| --- | ---: | ---: |
| 20 / local | 0.499 | 0.451 |
| 1000 / local | 115.007 | 22.073 |
| 1000 / key | 118.881 | 26.728 |
| 1000 / saved-table | 114.250 | 21.846 |
| 1000 / ambiguous | 174.348 | 109.115 |
| 1000 / no-fields | 7.527 | 0.039 |
| 1000 / records-only | 1.569 | 1.602 |
| 20 / composite | 0.472 | 0.396 |
| 1000 / composite | 11.119 | 6.992 |

The first per-record prefix prototype regressed the repeated-stem workload.
Grouping equal bodies removed those repeated boundary checks; that workload
remains in the committed probe. Ambiguous candidates still require examination;
the change does not make every source layout linear.

## Verification and limits

- Final unrestricted `make verify`: **3,477 passed**, **93% coverage**, all four
  recovery/stop/routing/unknown-usage probe metrics **100%**, report status PASSED.
  It uses disposable PostgreSQL/RabbitMQ and fake providers, never paid models.
- The initial restricted source/answer, workflow and preflight selection had
  640 passes and 27 explicit Docker/native-process deselections. Host access was
  subsequently enabled and the complete suite passed, including the final
  composite refinement above.
- Four added work-bound regressions failed before the final refinement and passed
  afterward: empty/fieldless questions preserve their metadata with zero record
  parses; ordinary primary records are parsed once, and repeated context numbers
  still reject an otherwise unique supplied key.
- Four composite work-bound regressions failed before the title-loop refinement
  and passed afterward. Word-bank/cloze children keep their complete fields;
  title normalization is bounded by children rather than 20/1,000 unrelated
  records. The broader composite/evaluation selection passed 128 tests.
- Lock consistency, repository-wide Ruff, Pyright and all 30 evaluation-fixture
  validations passed. Fixtures and fake providers do not establish model accuracy.
- Wheel/sdist build and `scripts/check_package.py` passed, checking 43 source
  files, licenses and lock bytes. No project virtual environment was created.
- `make verify` with `PYTEST_ADDOPTS=--maxfail=1` stopped at the first Docker-backed
  test (12 passed, one failed). This session cannot access the Docker socket, so
  that initial attempt did not establish full coverage or recovery acceptance.
  The final unrestricted run above supersedes this environmental failure.
- A wider non-database attempt stopped after 1,206 passing tests and two failures
  requiring macOS worker sandbox creation. Both failures also reproduce on the
  unchanged baseline. The wider focused attempt had 636 passes and 27 Docker or
  native-process failures before the explicit selection above.
- No App/Web UI, package installation, live provider, user-data or credential
  checks were needed for this service-only algorithm change. PR #462's original
  published head passed hosted Python 3.14/3.15 service quality, Web checks, image
  and CodeQL. The composite follow-up must pass its own current-head CI and review
  before merge.

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
