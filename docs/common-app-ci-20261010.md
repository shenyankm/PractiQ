# Common App CI execution evidence

Issue #194 now has one App scheduler rather than two independent quality jobs. `app.yml` selects the common Desktop/Android path scope, resolves its actual checkout to an immutable SHA, runs common quality once, and fans out to separate macOS/Windows package, Android arm64 APK and API35 emulator jobs. Both App final gates require that same run's quality result and source SHA. There is no cached result from another branch or earlier run.

## Identical work and independent work

Both former workflows installed the same App npm lock, checked frontend types/lint/coverage, exported the shared contracts, validated fixtures and ran overlapping workflow/package regressions. Desktop's full browser command includes the two Android touch projects; Android's separate browser command repeats those projects. The consolidated job uses the complete Desktop superset, including npm audit, Rust formatting/advisory and target-graph checks, the strict native build guard, all contract/fixture checks and the full browser suite. Its UI worker limit is explicitly two, matching the former Android setting.

Native Rust tests/Clippy on macOS and Windows, Windows credential roundtrip, actual desktop payload checks, Android runtime notices/APK verification, emulator Kotlin unit/instrumentation tests, artifact retention and release staging remain separate jobs. Release drafts call App once for the already checked candidate SHA. The required names remain `Service CI`, `Desktop CI` and `Android CI`.

## Actual hosted execution

The prior push on `628f776a382a7f157b283121ad7147059a557cf9` changed documentation and legitimately skipped heavy jobs. Those green skips are excluded. Two new full manual baseline runs use that fixed source; the candidate is PR #209 source `2bd710a5b0c8beff8a0e370400f17ed9811fbb71`.

| Successful quality execution | Run / job | Runner label | Started → completed (UTC) | Occupied seconds |
| --- | --- | --- | --- | ---: |
| Baseline Desktop | [38043258370 / 114187598758](https://github.com/shenyankm/PractiQ/actions/runs/38043258370/job/114187598758) | ubuntu-22.04 | 09:58:21 → 10:07:53 | 572 |
| Baseline Android | [38043284151 / 114187676612](https://github.com/shenyankm/PractiQ/actions/runs/38043284151/job/114187676612) | ubuntu-24.04 | 09:58:50 → 10:03:41 | 291 |
| Candidate App | [38043602816 / 114188616181](https://github.com/shenyankm/PractiQ/actions/runs/38043602816/job/114188616181) | ubuntu-22.04 | 10:04:15 → 10:12:46 | 511 |

The API step receipts show `npm ci`, UI checks and contract export actually succeeded twice before and once after. The candidate job log verifies its actual PR-merge checkout `c72e9f0ca46a741d86976d196f490c7c7f8e6a91`, 372 passing UI tests and 61 passing browser cases; workflow/package checks also succeeded. Quality-job occupancy totals 863 → 511 seconds (14m23s → 8m31s) in this observation. This is runner wall time, including setup/post steps, not CPU time, billed minutes or total pipeline latency. Android native work waits for the larger common superset, so no promise of a shorter Android critical path follows from this consolidation.

[Sanitized job/step receipts and metadata](evidence/2026-10-10-common-app-ci/metadata.json) retain source IDs, timestamps, runner configuration and all successful quality steps. The recorded App frontend, npm inputs, fixtures, generated contracts and exporter/checker files have identical Git blob manifests across the two sources. The complete source differs by CI changes and previously merged #197; baseline runner OS labels and Desktop's implicit worker configuration also differ. This single observation demonstrates removed duplicate execution, not a repeatable universal 41% speedup. Separate native jobs and complete PR gate outcomes are checked on the current PR head rather than inferred from these common-job records.

## Gate and rollout checks

The 703 local workflow/scope/release/package tests verify native jobs, pinned actions, full browser coverage and the single release caller, plus fail-closed behavior for missing dependencies, failure/cancellation, unexpected skips and absent/unresolved App source SHA. Every downstream App checkout uses the resolved SHA from the same run. Documentation-only skips remain deliberate; workflow changes, unknown push bases and manual/release invocation run all affected checks.

Maintainers now dispatch `app.yml` for App CI. Automation that names the removed `desktop.yml` or `android.yml` workflow must use it too. Historical dated evidence links remain unchanged. No production schema, credential, model action, release publication or physical-device acceptance is introduced by this orchestration change.
