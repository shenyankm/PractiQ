# Roadmap evidence and completion boundaries

Tracks [#89](https://github.com/shenyankm/PractiQ/issues/89). GitHub status was checked on 2026-10-06 against main `f7fb2a496305332c34160c18c2b0176958e2898f`: #89–#93 remain open and no GitHub Release is published. This is a dated observation; the issue and native sub-issues remain authoritative for later status changes.

The product boundary is the [independent AI service/Web importer and offline practice app](../README.md). Implementation of [#130](https://github.com/shenyankm/PractiQ/issues/130) and [#131](https://github.com/shenyankm/PractiQ/issues/131) is integrated through [#132](https://github.com/shenyankm/PractiQ/pull/132) and [#133](https://github.com/shenyankm/PractiQ/pull/133). Those deliveries do not complete the separate acceptance workstreams below.

## Integrated evidence and remaining work

[PR #141](https://github.com/shenyankm/PractiQ/pull/141) merged on 2026-10-04 as `934b798fcd4f229f1e5e65259ff25c7173295bd4`; its package-reference evidence is integrated in [the final-package worksheet](final-package-acceptance.md#engineering-reference-recorded-on-2026-10-04). The older claim that it is open is superseded. [#147](https://github.com/shenyankm/PractiQ/pull/147) also merged on October 4. The fixture, chart/source-map, handover and engineering records linked below are integrated; their historical source identities remain unchanged.

| Priority / workstream | Integrated deliverable | Evidence still required |
| --- | --- | --- |
| Now / [#90 import quality](https://github.com/shenyankm/PractiQ/issues/90) | [Quality worksheet](import-quality-acceptance.md), [source map](import-corpus-source-review.md), [#138 no-model transport/native evidence](https://github.com/shenyankm/PractiQ/pull/138), [#142 source review](https://github.com/shenyankm/PractiQ/pull/142) and [#146 chart geometry](https://github.com/shenyankm/PractiQ/pull/146) | Independent source annotations, selected deployed Office fidelity and a source-aligned real-model run on a frozen candidate. Historical 0/10 complete recognition and partial results remain failures. |
| Now / [#91 final packages](https://github.com/shenyankm/PractiQ/issues/91) | [Release policy](releases.md), [final-byte staging and acceptance worksheet](final-package-acceptance.md), including the merged #141 reference inventory | One selected main candidate/tag, exact final installers/hashes, signing and target-system/native evidence under the release policy. Historical reports, development packages and emulator checks do not complete ordinary release gates. Test-version deferrals retain strict gates and disclosed limits. |
| Next / [#92 trials](https://github.com/shenyankm/PractiQ/issues/92) | [Consented trial protocol](desktop-user-trial.md), adapted to Android and Web → ZIP → app in [#137](https://github.com/shenyankm/PractiQ/pull/137) | Authorized recruitment, actual voluntary consent and participation, task outcomes, triage/retests and a reviewed sanitized summary. No participant results are recorded by these documents. |
| Later / [#93 contribution/continuity](https://github.com/shenyankm/PractiQ/issues/93) | [Contributor handover](contributor-handover.md); CSV/PDF/PNG fixtures in merged [#134](https://github.com/shenyankm/PractiQ/pull/134), [#135](https://github.com/shenyankm/PractiQ/pull/135) and [#136](https://github.com/shenyankm/PractiQ/pull/136); corrected rehearsal record in [#139](https://github.com/shenyankm/PractiQ/pull/139) and [#143](https://github.com/shenyankm/PractiQ/pull/143) | Original criterion 3: an actual new contributor executes setup/focused checks and records blockers/fixes. The maintainer rehearsal does not supply that evidence. A backup role may remain vacant; no extra APPROVED-review requirement is added. |

These are dependency priorities, not promised dates. Offline annotations, fixture checks and candidate inventories can proceed without model calls or contacting people. Real-model evaluation, signing, publication and recruitment need their own applicable authorization and evidence; historical task permissions do not authorize new actions. See each worksheet for its procedure and completion criteria rather than duplicating them here.

## Integrated repair batch

The ten issues #94–#102 and #110 received separate merged PRs. This ledger records implementation and validation scope; it does not supply model-quality, final-release or real-user acceptance.

| Issue | Independent implementation PR | Validation scope |
| --- | --- | --- |
| #94 | [#122](https://github.com/shenyankm/PractiQ/pull/122) | Interrupted grading call ledger; fake models and durable restart/failure regressions; service verification |
| #95 | [#127](https://github.com/shenyankm/PractiQ/pull/127) | Unsaved editor drafts, dismissal and child ordering; UI/browser checks |
| #96 | [#119](https://github.com/shenyankm/PractiQ/pull/119) | Persistent current-query read errors/retry; UI and mocked-browser checks |
| #97 | [#124](https://github.com/shenyankm/PractiQ/pull/124) | Obsolete mutation refresh guards; delayed-response UI/browser regressions |
| #98 | [#121](https://github.com/shenyankm/PractiQ/pull/121) | In-place study setup retry without selection/configuration loss; UI/browser checks |
| #99 | [#123](https://github.com/shenyankm/PractiQ/pull/123) | Preview filter/review parity, recursive descendants and imported warnings; offline UI/browser checks |
| #100 | [#120](https://github.com/shenyankm/PractiQ/pull/120) | Non-color answer markers; status matrix, both themes and keyboard/large-card browser checks |
| #101 | [#128](https://github.com/shenyankm/PractiQ/pull/128) | Reduced-motion open/closed overlay styles and focus; UI/native/browser checks and a historical local macOS development package/bundled-service smoke check from before #132; it does not validate the current independent-service architecture or final installers |
| #102 | [#125](https://github.com/shenyankm/PractiQ/pull/125) | Generated task detail contracts; service/UI/native/browser checks |
| #110 | [#126](https://github.com/shenyankm/PractiQ/pull/126) | Single self-assessment command; strict legacy field rejection, submit/result/snapshot regressions; UI/native/browser checks |

Later performance and UI work is recorded in [the October 3 record](performance-implementation-20261003.md), [the October 5 record](performance-implementation-20261005.md) and [PR #157](https://github.com/shenyankm/PractiQ/pull/157). Their checks belong to their recorded source; they cannot certify a later release candidate.

## Evidence rules

Record the source SHA, platform/architecture, date, artifact/corpus hashes, command or manual task, outcome and durable report link. Distinguish failed, unknown and not run from passed. Required CI must match the reviewed PR head; signing or repackaging requires new hashes and repeated final-byte gates.

Keep completed extraction separate from semantic quality, fake-model transport separate from live recognition, native engineering QA separate from voluntary trials, and implementation delivery separate from final-release acceptance. Preserve unknown usage and source omissions. Keep #89 open while required workstream acceptance remains pending.
