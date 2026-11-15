# Snapshot association performance — November 15, 2026

Second optimization pass, following the [session/history work](performance-session-history.md).
The baseline is that pass's accepted compiled build, not unmodified `main`.
Its module hashes are retained in `app/.build/performance-20261115/accepted-electron.json`;
the second pass preserves a matching copy before modifying `thaw`.

## Change

`app/desktop/questions.ts:thaw` previously filtered every group and visual for
every restored question. It now builds an operation-local ID map and visits each
association's referenced rows directly. The existing single-question scan stays
in place: allocating a target array per association slowed a draft-save control
in the first candidate. There is no persistent cache or invalidation policy.

Question order and association order remain unchanged. Repeated reference IDs
attach an association once; repeated question IDs retain every row so later
validation cannot accidentally accept a repaired snapshot. Missing/foreign
references remain ignored, unscoped visuals still attach to every row, and
unscoped groups remain unattached. Schema, array/object checks, question-row
cloning and association-object sharing retain their existing behavior. No schema,
dependency, IPC, archive, paid-call or recovery-policy change is introduced.

The helper is shared by full session reads, submission, retry, grading preparation
and backup validation. Callers and frozen fixtures remain unchanged. Two added
regressions compare exact output with the old association rules and cover dense,
empty, duplicate, absent and non-string references, duplicate row IDs, original
ordering, source preservation, single/empty selections and corrupt snapshots.
The work-bound fixture reduces `questionIds` getter reads from 1,200 to at most
40 for 20 questions. The existing `list` guard reads a valid array property twice;
the first candidate test's bound was corrected to account for that, with its
original failure retained. The baseline still fails the final bound.

## Paired measurements

Apple M4, macOS arm64, 16 GiB RAM. The table uses Electron's embedded Node
24.22.2, preserved compiled modules, three isolated processes per variant in
AB/BA/AB order, one warmup and seven measured calls per process (21 samples).
Project tests/builds do not run during measurement.

| Workload | Before median ms | After median ms | Interpretation |
| --- | ---: | ---: | --- |
| Restore 1,000 questions with 500 two-question groups and 500 visuals | 42.843 | 2.167 | 94.9% less |
| Full 1,000-question associated session, database-worker round trip | 39.976 | 17.976 | 55.0% less |
| Restore twenty questions with associations | 0.063 | 0.045 | Small absolute change |
| Restore one question | 0.0072 | 0.0059 | Too small for a useful latency claim |
| Save one answer in the associated 1,000-question session | 4.437 | 4.529 | 0.093 ms slower (2.1%); no save-latency claim |
| Full 1,000-question response without associations | 13.334 | 12.054 | Control; no additional general-session claim |

Ordinary Node 22.23.2 independently reduces the large restore 26.333 → 2.990 ms
(88.6%) and associated full-session round trip 46.519 → 21.806 ms (53.1%).
The workloads use separate fixtures and warmup histories; their medians cannot
be added/subtracted to attribute components of the worker round trip.

The extended `app/scripts/benchmark-performance.ts` retains all prior workloads
and adds three restore probes plus associated-session save/full-response probes.
All 23 output hashes match across baseline/candidate in both runtimes. Restore
hashes cover complete ordered rows, and input documents must remain unchanged.
Worker full responses include snapshots; their hashes normalize random session
IDs, creation times and revision keys, with canonical revision hashes checked
separately. The worker path includes SQLite/validation/structured cloning and
messaging, excluding Electron renderer/preload, painting and startup. Visuals
have descriptions and references, without real media-byte decode/hash work.

## Acceptance and reproduction

`make verify` passes: 26 CI guards, contracts, maintainer/UI/worker types, lint,
76 release-tool tests, 916 frontend tests (seven existing opt-in probes skipped),
1,837 backend tests and production renderer build. Backend coverage: 91.14%
statements, 86.27% branches, 91.84% functions and 92.74% lines. Focused question,
session, grading, backup and native-IPC suites pass all 82 cases.

Actual `npm --prefix app run test:electron` also passes sandbox/IPC, embedded
worker/LangGraph flows, practice/grading, all-type ZIP round trips, protected test
credentials and confirmed backup restoration. Providers and native dialogs are
local substitutes. Renderer code is unchanged; this pass does not rerun the full
browser suite. Its earlier interruption and successful targeted rechecks remain
documented in the [first pass](performance-session-history.md).

Use the existing [benchmark instructions](performance-desktop.md#reproduction)
with fresh preserved builds/report destinations. Evidence is retained under
ignored `app/.build/performance-20261115-round2/`: `accepted-node.json`,
`accepted-electron.json`, `acceptance.json`, `source-identity.json`, `verify.log`,
`final-focused.log`, `electron-smoke.log`, baseline/initial candidate failures
and the first candidate's paired reports. `after-final/` is the accepted build;
its module hashes match the final native build.

No whole-application, cold-start, memory, energy, live-provider or installed-DMG
improvement is inferred. Remote CI, signing/notarization and real-media performance
are untested. Existing runtime build fingerprints remain enforced for unfinished
AI tasks; no state is automatically replayed or migrated.
