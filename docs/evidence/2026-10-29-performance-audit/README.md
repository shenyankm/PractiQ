# Cross-component performance audit — October 29, 2026

Baseline: `2099f77a17eda91a99ddc2c4ce916c46cb2c1ec8`. Four parallel reviewers
traced the main service, Web, practice UI and native storage flows; an independent
reviewer checked the resulting changes, with a second native reviewer. This is a
flow-based source audit and bounded local acceptance, not a claim that every line
or every production workload was profiled. The expected deployment remains one
personal service and one offline macOS user.

## Review coverage and decisions

| Area | Inspected paths and decision |
| --- | --- |
| Document planning | `document._assemble`, chunk/frame parsing, source presence and source evidence. Existing frame caches already avoid repeated parsing. Replace per-chunk full-frame scans with binary range selection. |
| Service I/O | Runtime/control/delivery, messaging confirmations, database heads, task list/detail/export, storage, bank export, Tencent RPC/ZIP decoding and deployment resource limits. Existing bounded reads, completed-task caches, connection/client reuse and transaction/checksum boundaries remain. Index native table captions during one ZIP decode. |
| Web and shared UI | Polling/wake lifecycles, source upload, ZIP download, result filtering/paging, quality JSON, Markdown and artifact loading. Recent optimizations already address these paths; no further change justified. |
| Practice UI | Practice input, answer card, saved-session updates, language changes, navigation and compact layout. Reuse saved answer-card states while only the current draft changes. |
| Native data | Question queries, paper selection, imports, sessions/snapshots, backup/restore and assets. Validate manual selection with a set of requested IDs and one candidate scan. Preserve the requested order and all rejection checks. |
| Build and deployment | Make targets, dependency manifests, CI path selection, image stages and Compose limits. Keep separate Python-version gates, package inspection and integrity checks. No build/configuration change justified. |

Deferred candidate: backup restoration scans the asset manifest for each database
asset in `backup.rs`. This may become quadratic for very large resource sets, but
we did not measure its contribution relative to mandatory file verification and
media decoding. It is not presented as a confirmed performance finding or changed
in this PR. Live query plans, real OCR/model latency and production memory profiles
were not measured.

## Accepted changes and measurements

All inputs are synthetic. No user database, credential or paid provider was used.
Inputs/outputs are checked for equivalence in each probe. Numbers are local
medians, not release thresholds or end-to-end latency predictions.

| Workload | Before | After | Scope |
| --- | ---: | ---: | --- |
| 1,000 typed source records, cold split plus source-presence planning | 11.315 ms | 9.786 ms | Python CPU, frame caches cleared |
| 100 native table pages | 3.096 ms | 1.715 ms | Complete local synthetic ZIP decode; default page limit |
| 300 native table pages | 17.978 ms | 5.145 ms | Same decode at the supported configurable page limit |
| 1,000 questions, typing with 999 retained partial matching drafts | 7.126 ms | 3.825 ms | React development/JSDOM input through synchronous commit; unrelated item reads 2,997 → 0 |
| 100,000 roots, manually choose final 1,000 | 491.033 ms | 211.086 ms | Complete release `Store::preview_paper`, temporary SQLite |
| 100,000 roots, manually choose first 1,000 | 205.590 ms | 200.607 ms | Small-change control, no substantial gain claimed |

The 20-question UI control was 1.934 → 1.865 ms; 20-record cold source planning
was 0.201 → 0.198 ms. These small differences are not significant claims.
Native random selection samples are noisier: one 100,000-root manual-last
aggregate was 329.577 → 313.760 ms. They and unchanged count/quota controls remain
in the report rather than being omitted. Native timings include an initial busy
pair and two coordinated quiet pairs; each variant has nine samples per workload.

Detailed methods, controls, hashes and reproduction:

- [Source planning](source-presence.md), [raw samples](source-presence.json).
- [Practice UI](frontend.md), [baseline samples](practice-before.json),
  [candidate samples](practice-after.json).
- [Native paper selection](../../../app/docs/performance-native.md),
  [all native samples](native.json).
- [Table decode samples](tencent-tables.json), reproduced from the repository root:

```sh
AI_READ_ONLY=1 AI_SERVICE_TOKEN=synthetic-benchmark-token \
PYTHONPATH="$PWD/server/src" "$AI_PYTHON" server/scripts/benchmark_tencent_tables.py \
  --baseline 2099f77a --output /tmp/practiq-tencent-tables.json
```

## Combined validation

Environment: macOS 27.0.1 ARM64, Python 3.14.7, Node 22.23.2 and Rust 1.98.1.
Use the existing interpreter; no project virtual environment was created.

```sh
export AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14
export PYTHONPATH="$PWD/server/src"
make verify AI_PYTHON="$AI_PYTHON"
VITEST_MAX_WORKERS=2 make app-check AI_PYTHON="$AI_PYTHON"
VITEST_MAX_WORKERS=2 npm --prefix app run check:ui
npm --prefix app run test:browser
VITEST_MAX_WORKERS=2 make web-check web-build
```

| Check | Result |
| --- | --- |
| Service `make verify` | Passed: lockfile, Ruff, Pyright, 30 evaluation fixtures, 3,482 tests, 93% aggregate coverage, all four recovery probe metrics 100%, source/wheel build and package integrity. |
| `make app-check` | Passed: generated contracts/fixtures, types/lint, 501 frontend tests (4 skipped), 247 native tests (22 ignored), formatting and Clippy. The manual-selection release probe ran separately. |
| App `check:ui` | Passed: 501 tests, 4 skipped; 93.74% line and 86.02% branch coverage. |
| App browser | Initial full run: 149 passed, one failed after a dev-page reload reset the sidebar. Unchanged candidate focused reruns passed three times, then the complete mocked project passed 8/8. All other projects passed in the full run; this is not a fresh all-150 run. See the [trace diagnosis](frontend.md#browser-acceptance-follow-up). |
| Web `web-check web-build` | Passed: 230 tests (one opt-in benchmark skipped), 56 browser checks, types/lint, coverage and static build. |
| Independent review | No blocking code findings. Verified baseline equivalence, boundary cases, source/probe hashes, raw native median calculations and evidence links. |

The initial dependency inventory found local Web KaTeX 0.19.0 while the unchanged
lock requires 0.19.1. `npm --prefix web ci` restored locked dependencies before
Web acceptance. Early table benchmark setup lacked synthetic configuration; it
was corrected before the retained measurements, without any external call.
Local full-check logs are `/tmp/practiq-perf-*.log`; service reports remain in
`server/reports/checks/`. These are local paths, not permanent downloadable CI
artifacts. Committed benchmark JSON above contains the retained raw evidence.

## Compatibility and rollout

No API, schema, dependency, configuration, resource format or backup changes.
The changes preserve source-evidence ambiguity, checksums, immutable snapshots,
explicit grading/import actions and failed/unknown provider outcomes. UI caches
use the existing immutable session-array updates; translations happen during
button rendering. The caption index is local to a single decode.

The service's source fingerprint changes even for this equivalent optimization.
Drain unfinished work on its original deployment or retain that exact deployment
for recovery before upgrading. Do not rewrite historical execution signatures;
explicitly creating a new import can incur provider costs. See
[resume compatibility](../../../server/docs/resume-compatibility.md).

No live-model accuracy, real Tencent throughput, production RSS, manual native UI,
clean-machine installation, signed package or service image acceptance is claimed.
Browser tests use mocked HTTP/native commands. Hosted CI and review statuses are
separate and belong to the PR; this change does not authorize merging or releasing.
