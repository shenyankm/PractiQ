# Cloud engineering repair evidence — 2026-11-09

Source: working tree on `fix/complete-cloud-engineering`, based on `3f80e0a3`.
The final PR head identifies the submitted source; this is engineering evidence,
not production, independent human quality or signed release acceptance.
See the [completion matrix](../../acceptance/engineering-completion-20261109.md).

## Connected current workflow

[Workflow report](workflow.json) and [24 Rust persistence records](native.json)
passed on macOS arm64, Python 3.14.7, disposable PostgreSQL/RabbitMQ and temporary
local storage. Each of TXT, Markdown and PNG passed these observed actions:

1. Open the built App in Chromium and register an ordinary user. A separate
   administrator was explicitly bootstrapped in the fresh disposable database.
2. Select a source without uploading or starting recognition, then explicitly
   start one upload/task through the native-IPC substitute and real HTTP APIs.
3. Complete the actual queue/checkpoint/storage workflow with one substituted
   structuring call and a substituted Tencent provider.
4. Edit analysis manually, retain the supplied answer/source, save revisions in
   PostgreSQL and download the revised ZIP. The strict content gate includes
   `questionTypeId`; revised-result equality retains the standard export warning.
5. Reopen the browser context, read the same account and saved revisions, and
   verify original parse/usage records are unchanged. Logout returns to sign-in
   and local banks remain accessible.
6. Run the actual release Rust/SQLite bank import/practice/reopen/backup-restore
   harness, then repeat it eight times per source: 24 matched records.

The HTTP cookie/CSRF stays in the Node-side isolated request context, outside the
WebView. Native file dialogs, IPC and Keychain are **not** accepted by this run.
Reopening proves the substituted credential bridge plus real server session, not
native credential persistence. Providers are substitutes; no live recognition or
accuracy claim follows. Neither source normalization nor another parser was added
to the App.

Reproduce with a fresh output directory, the existing Python interpreter and the
current release test executable:

```sh
make app-build AI_PYTHON=/path/to/python3.14
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --release --lib --no-run --manifest-path app/src-tauri/Cargo.toml
PYTHONPATH=server/src:server /path/to/python3.14 server/scripts/accept_workflow.py \
  --output /absolute/new/evidence-directory \
  --native-binary /absolute/path/to/the/release/practiq_desktop-test-executable
```

The command uses its own disposable database/storage and bootstraps only a test
administrator. The App assets are served only inside this isolated harness; never
deploy customer App assets as the administrator Web. Payment is forced off.
`--live` is a separate paid action and was not used. Legacy customer-Web correction
scripts remain historical source and are not current acceptance commands.

## Local checks

- App types/lint/coverage: 595 passed, 6 skipped (including live language changes in memoized content).
- Web types/lint/coverage: 332 passed, 1 skipped, including persisted refund identity and another-window protection.
- `make app-check`: shared contracts/fixtures, App tests, 294 Rust tests (27 ignored), formatting and all-target Clippy passed.
- App cloud browser suites: 68 passed, including English/Traditional Chinese plans and light/dark screenshots.
- Administrator Web browser suite: 4 passed, including explicit refund and reload without another write.
- Capacity/authentication focused regressions: 25 passed after updating old personal-mode test adapters.
- Current App and DMG built; [final installer inspection](installer.json) passed for the recorded DMG SHA-256 with no embedded AI engines. Signing and installation are separate.
- `make verify`: 3953 tests passed, 92% coverage; Ruff, Pyright, locked dependencies, evaluation fixtures, recovery probes and service package checks passed. No interrupted run is counted as passing.

PR review additionally exposed a retained successful refund that could remain locked after provider closure and an overly strict canonical type-label gate. Retries rejected for password/CSRF errors retain the original uncertain request; two additional regressions cover the lost-first-response path. The original-receipt query now stays available for its retained request, with a regression proving cleanup without a new refund. The quality gate accepts the fixture’s literal source label while rejecting missing/unrelated labels (34 focused workflow tests passed). The localization guard continues scanning existing App components as well as shared cloud code.

Remote Python 3.15 CI exposed an existing broker-capacity probe waiting for a particular quorum-queue overshoot count. It now fills the dead-letter target until explicit publish rejection, restarts while that target remains full, then removes the limit and requires every confirmed source and prefilled message to survive. The focused probe and the full 27-test broker group passed locally. No production broker policy or runtime behavior was relaxed.

Initial failures were retained in the ignored
`server/reports/checks/completion-20261109/` tree: missing browser/runtime caches,
legacy load-test adapters, the harness's missing server import path, native-window
metadata in the browser substitute, expecting upload 200 instead of the actual
201, and revised-export equality omitting the required correction warning. The
first full service run was superseded after exposing eight old load-adapter
failures; it is not a delivery gate. None caused a real paid request. A mistaken
root-directory formatter pass was reverted for unrelated files before checks
were rerun with the service configuration.

## Visible UI checks

Screenshots contain only synthetic users, orders and grants. Browser inspection
covered English/Traditional Chinese cloud pages and the new administrator refund
surface in light/dark themes. User content is intentionally not translated.

- [English plans, light](plans-en-light.png), [dark](plans-en-dark.png)
- [Traditional Chinese plans](plans-zh-TW-light.png)
- [Administrator refund, light](admin-refund-light.png), [dark](admin-refund-dark.png)

## Deferred external acceptance

No production service was configured or deployed. No real buyer paid or refunded.
No provider, merchant or Apple credential was read for this work. No publisher
signature/notarization, clean-machine installation, off-host disaster drill,
independently annotated extraction/grading quality, volunteer trial or external
contributor setup is claimed. These require the separately supplied resources
listed in the completion matrix. Current conservative checkpoint compatibility
and historical ownership isolation remain in force.
