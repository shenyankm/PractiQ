# Large question-editor dirty snapshot measurement

Issue #191 compares source `628f776a382a7f157b283121ad7147059a557cf9` with cached per-node normalized snapshots in the existing `QuestionEditor`. Immutable node references reuse their JSON; shared-option children also depend on their owner's options reference. Changed nodes are normalized with the existing rules, and the resulting ordered snapshot still determines whether an edit/revert is clean.

## Workload and method

`QuestionEditor.performance.test.tsx` is opt-in and builds one synthetic reading group with 250 children, long material, nested JSON blocks and null metadata. The 930,164-byte input has SHA256 `5acf84415371c226f967dbe3562e685775347918d8df240630f183e73e08a505`. All 251 nodes were checked against the shared `DocumentParseResult` contract after converting the App root's empty parent ID to its API null representation.

Each report mounts the real component three times and changes the parent's stem 15 times per mount. Input-to-commit timing covers the Testing Library change event through the committed DOM update; React Profiler totals every commit triggered by that edit. Three alternating baseline/candidate pairs provide 135 edits per variant. [Raw reports, input hash and source hashes](evidence/2026-10-10-editor-snapshots/metadata.json) preserve all six paired runs.

Environment: Apple M4 arm64, macOS 27.0.1 (26A434), Node v22.23.2, jsdom and the locked App dependencies. This is component computation evidence, not browser-frame, keystroke or physical Android latency. An initial probe kept only the last Profiler commit and was rejected; the paired reports use the corrected sum and must not be compared to that preliminary number.

## Results

Pooled milliseconds, with the same workload and assertions:

| Metric | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 |
| --- | ---: | ---: | ---: | ---: |
| React committed render computation | 6.108 | 3.918 | 19.215 | 16.895 |
| Input event through DOM commit | 8.136 | 6.197 | 21.907 | 19.930 |

Median repeated-edit cost decreases locally; tail variation remains substantial. The optimization retains an O(n) ordered join and parent map, and still serializes changed nodes. It adds no form framework, native command, persistence format or dependency.

## Semantics and validation

Existing regressions cover parent/child edits and reverts, nested content/metadata, null/default normalization, array ordering, shared-answer fallback and pending audio. A new regression changes and reverts the external option owner while the child object remains unchanged, proving cache invalidation and clean dismissal. The full App UI check passes 373 tests with one opt-in benchmark skipped; the browser suite passes 61 desktop/touch cases using mocked native commands.

```sh
cd app
PRACTIQ_EDITOR_BENCH=/tmp/practiq-editor.json \
  npm exec -- vitest run src/QuestionEditor.performance.test.tsx
```

Compare the same probe on the recorded baseline/candidate component and verify input hashes first. In-place mutation of question or owner-option objects would invalidate the immutable-reference assumption; existing editor updates replace those objects. No actual Windows/Android hardware, native persistence or complete application frame budget was measured for this computation-only change.
