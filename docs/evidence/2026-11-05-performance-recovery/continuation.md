# Completed phase and continuation

Baseline: `5973846cfdd2d5ec6948562e443642deb5042a02`; initial `main` was clean.
Branch: `fix/performance-recovery-20261105`. No production data, deployment,
publication or paid provider call was used.

Retained changes:

- Read, open-file size check and SHA-256 share one bounded storage job; cancellation
  and timeout retain capacity until a running worker exits.
- New publication temporary files have reserved names. Existing offline GC can
  quarantine old recognized remnants individually under a retained source hash.
  It preserves valid files, legacy ambiguous names and quarantine bytes.
- App Vitest discovery includes exactly source tests and excludes local artifacts.
- Connected workflow acceptance matches personal access and records browser work.
- Native repair probe includes 2,000 damaged resources and inventory hashes.
  The speculative membership implementation was withdrawn; its patch is evidence only.

Already verified: 93 latest focused checks, focused types/lint, current paired I/O,
30,000-read resource controls, discovery canary, full App/Web checks, current
production Web/HTTP → ZIP → release native practice/reopen/backup workflow with
three fixtures and 24 repeated native cases, plus the existing large-result probe.

The first full service run passed 3,721 tests / 93% coverage, probes and packages,
before the publication-marker change. Preserve it as first-round evidence only.

Final `make verify` passed on the frozen source: 3,736 tests, 93% coverage,
matching current probe fingerprint, all four probe metrics at 100%, and source/
wheel checks. `make-verify-final.txt` and `service-probes.json` are authoritative;
the initial round is historical evidence. The process is terminal, not a wait.

No measured high-value candidate remains open. Before another optimization round,
compare the code/probe hashes and retained diff in `verification.json`, inspect
current workspace changes, then measure the next demonstrated bottleneck. Do not
rerun unchanged checks merely to extend the phase. The implementation and curated
evidence travel together on this branch; disposable runtime storage stays local.

Primary report: `docs/history/performance/resource-recovery-20261105.md`.
Final connected results: `workflow-final/report.json`. Native executable metadata:
`native-binaries.json`, field `accepted`. Compiler diagnostics were moved to the
ignored checks directory named in `environment.json`; they are not required for
the curated evidence.

Limits: no real provider/quality, installer/WebView, long production soak,
physical disk exhaustion, host/disk/power-loss or multi-host disaster claim.
Quarantine does not free disk; cleanup remains an explicit operator procedure.
The service execution signature changed, so retain original deployments for
unfinished imports and never rewrite signatures or replay uncertain paid work.
