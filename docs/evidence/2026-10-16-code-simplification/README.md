# Code simplification acceptance

Date: 2026-10-16. Baseline: the existing working tree, including its unrelated uncommitted changes.

## Scope

- Remove the unused App `finish` request from TypeScript, the preview and native dispatch. Existing native tests now use `submit_paper`; a regression accepts both explicit draft choices and review completion, and rejects `finish`.
- Delete 33 App translation entries without production references. Count-formatting tests use current bank-selection copy instead of removed document-import copy.
- Move the identical theme mappings and base rules into `shared/theme.css`.
- Consolidate Web shortcut and secondary-action styles while retaining their final computed values.
- Remove `sessionSnapshotKey`; test restore invalidation through the next request's snapshot-key argument.

The native error dictionary, including all 72 old error messages, is unchanged. No dependencies, schemas, stored data or model-call paths change. Production source and styles shrink by 111 lines; tests grow by 14 lines.

## Validation

| Check | Result |
| --- | --- |
| `VITEST_MAX_WORKERS=2 npm --prefix app run check:ui` | Types, lint and coverage pass; 392 tests pass, one existing benchmark skips; line coverage 93.37% |
| `npm --prefix web run check` | Types, lint and coverage pass; 93 tests pass; line coverage 97.46% |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --locked` with empty Tauri bundle resources | 190 pass, 13 existing tests ignored; binary and doc-test targets also pass |
| `cargo clippy --manifest-path app/src-tauri/Cargo.toml --locked --all-targets -- -D warnings` with empty Tauri bundle resources | Pass |
| `cargo fmt --manifest-path app/src-tauri/Cargo.toml --check` | Pass |
| Contract export check and fixture validation | Pass; 49 shared contract cases and the sample validated |
| App and Web production builds | Pass |
| `npm --prefix app run test:browser` | 67 pass, including desktop, built touch navigation, rich content and both touch viewport projects |
| `npm --prefix web run test:browser` | 27 pass |
| CSS comparison against the initial working-tree builds | App CSS and Web review CSS are byte-identical; Web main CSS produces identical computed styles and geometry in 24 Chromium combinations: three viewport widths, two themes, two root font sizes and two disclosure states |

The new native request regression failed before removing `finish` and passes afterward. An initial App coverage run at default concurrency failed three tests while native and browser checks also ran; the two affected files passed all 58 tests in isolation, then the complete suite passed with two workers. No timeout or coverage threshold was changed.

Local logs and before/after CSS evidence are retained in the ignored `app/.build/code-simplification-20261016/` directory. Hash comparison confirms that all pre-existing tracked and untracked files outside the 12 scoped files retain their original bytes or absent state.

## Boundaries

Native tests ran on macOS. Browser checks use synthetic HTTP and native substitutes; they do not establish Windows/Android native behavior, final-installer acceptance or live-model accuracy. The independent service was not changed or subjected to a full service test run.
