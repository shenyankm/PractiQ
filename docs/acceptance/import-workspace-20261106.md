# Import workspace acceptance — November 6, 2026

This delivery covers local correction recovery, page selection, selective source-unit reparse, supplied answer-sheet matching and selected-question ZIP export. [Behavior and API guide](../../server/docs/import-selection.md) documents the boundaries. The original feature-acceptance [machine evidence](evidence/import-workspace-20261106/acceptance.json) retains the service execution hash, native binary/ZIP hashes, provider counters and native phase results. All sources are synthetic fixtures committed in the acceptance runner. No real Tencent or LLM calls were made.

## Production Web → HTTP → native SQLite

On macOS arm64, `server/scripts/accept_corrections.py --suite` serves the built Web assets through the real loopback service, with disposable PostgreSQL/RabbitMQ and local artifact storage. Tencent and the model are bounded substitutes; HTTP handlers, checkpoints, receipts, exports and the native SQLite store are real.

| Flow | Observed result |
| --- | --- |
| Correction recovery | A typed analysis survives reload. A successful PUT whose response is deliberately dropped retains the exact request ID through a complete Chromium process restart with the same disk profile. Explicit receipt read confirms it, without a second PUT. |
| Separate answer sheet | Three supplied numbered answers are extracted as an answer-role task. Matching reads do not call a model. The user adopts one candidate, then explicitly saves; the receipt retains the original source hash and quote, and preserves the earlier manual analysis. |
| Selected export | One selected corrected question exports with its supplied-answer provenance. The original full ZIP still has three questions with missing answers. Original checkpoints and usage stay unchanged. |
| Page selection | A rendered three-page PDF with `pages: [2]` produces only page 2's question. Source navigation displays the immutable original page 2; the retained unit index remains 1. |
| Selective reparse | The selected page's associated new task uses unit 1. Tencent submissions stay at 3; model calls move from 3 to 4. The child has no new Tencent jobs and the parent result remains unchanged. |
| Native round trip | The exact one-question ZIP hash is imported into a fresh release-mode Rust SQLite store, practised and scored, closed/reopened, backed up and restored. One correct answer earns 100 cents. |

Reproduce after `make web-build` and a fresh release test build:

```sh
cd server
PYTHONPATH=src:. /path/to/python3.14 scripts/accept_corrections.py --suite \
  --output reports/checks/import-suite-fresh \
  --native-binary ../app/src-tauri/target/release/deps/practiq_desktop-<hash>
```

Use a new output directory every time. `PRACTIQ_CAPTURE=1` retains screenshots with transitions completed; it never enables live providers. The native binary is produced with `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --manifest-path app/src-tauri/Cargo.toml --no-run`.

## Interface inspection

The bounded visual check covered Start, restored drafts, matching and original-page comparison at 1440 × 1040/light and 390 × 844/dark. All eight layout samples had no horizontal overflow. The first inspection found adjacent answer-upload/task labels crowded together; the final inspection confirmed separate labeled rows. The existing first-screen Start constraint at 390 px also passes after reducing the range disclosure while retaining the cost warning.

[Start / narrow dark](evidence/import-workspace-20261106/start-narrow.png), [restored correction / desktop](evidence/import-workspace-20261106/draft-desktop.png), [matching / desktop](evidence/import-workspace-20261106/matching-desktop.png), [original page 2 / desktop](evidence/import-workspace-20261106/range-desktop.png).

## Checks and review

- Web: types, lint and coverage; 301 tests passed, one existing opt-in test skipped. Coverage: 88.53% statements, 84.80% branches, 86.66% functions, 95.11% lines. The complete fake-HTTP Playwright suite passed 65 tests.
- Desktop: contract/fixture parity, types, lint, 542 frontend tests and 277 Rust tests passed; six frontend cases and 27 native benchmarks/platform probes remain intentionally skipped. Rust formatting and Clippy passed. An initial concurrent frontend run timed out in an unchanged search interaction; the complete rerun passed.
- Focused service regressions: 27 passed, covering selection/relationships/warning retention, supplied proof and target validation, immutable originals, and replay after parent deletion. Historical create-payload expectations were updated to exclude new default-only fields; old receipt fingerprints remain compatible.
- Service full initial run: 3,821 passed / 10 failed, with 93% coverage. Nine failures were old default-field expectations (one fingerprint assertion and eight Office resume variants); those fixtures are updated. The remaining RabbitMQ consumer-timeout probe timed out under the initial load, then passed in isolation. The complete affected regression reruns passed 36 tests, including all ten original failures and five additional literal-conversion cases. Lock consistency, Ruff, Pyright, 30 evaluation fixtures, package build and archive integrity passed. A clean remote full CI rerun is required before merge.
- Connected-code self-review traced admission, source selection, source proofs, correction concurrency, browser ledgers, generated consumers and ZIP dependency closure. Single-user self-hosted use is the intended load. No unresolved implementation finding remains at this stage; remote CI and review still gate merging.

PR #514 subsequently identified two answer-association issues: unrelated manual edits dropped export provenance, and numeric wording could take precedence over printed source numbering. The fixes retain proof while the supplied answer is unchanged, clear it on a manual answer replacement, prefer original-source numbering and reject decimal prefixes. The 115 focused selection/correction/export regressions, Ruff, Pyright and rebuilt archive integrity checks passed. This follow-up changes no Web layout; the retained browser/native snapshot above remains the original feature-acceptance run.

The initial failures and successful reruns remain under ignored `server/reports/checks/import-suite-*`; they were not deleted or relabeled. The first full `make verify` remains recorded as failed; the focused repairs are separate successful runs. Remote CI and review are checked against the final PR head before merging.

## Limits

These checks establish engineering behavior, not independent real-provider recognition or answer-matching accuracy. They do not establish Tauri IPC, installed/signed/notarized package behavior, real user trials, or production deployment. Page selection can still incur Tencent recognition of the whole file. Reparse operates on complete source units and may include other questions in those units. Selected export can include a full linked material group. Browser drafts are origin-local, bounded, and not collaborative editing; browser-data deletion removes them. Existing saved source hashes, evidence, review flags, unknown receipts and original results are preserved.
