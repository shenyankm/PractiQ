# Local simplification acceptance — 2026-10-17

Implemented audit items 1, 2 and 4, plus the requested Refresh placement, Web header cleanup and file-picker alignment. This record captures the local acceptance completed before publication.

## Changes and measurements

- Removed the obsolete Bearer-based Web design-preview entry and its notice. Current authenticated browser fixtures remain the Web preview/acceptance path.
- Reused duplicate-question location formatting and review-issue tracking in `_merge`, rebuilding indexes after removal. Warning text, order, source associations and review flags remain equivalent.
- Shared Card, Badge, Input and button variants in `shared/ui.tsx`. Both local Button implementations retain their behavior, including App WebKit focus handling. No dependency was added.
- Moved bank-home Refresh beside New bank and Import. It disables during reads, supports recovery after read failure and preserves the current page.
- Removed the import Web header connection badge and Disconnect action. Credentials still clear on reload; connection errors retain their recovery actions.
- Centered native file-selector and filename text by matching their inner height, line height and font size. The previous selector stayed at 24px inside 40/48px controls. The workspace contains one DOM file input; App file selection uses native dialogs. Other rendered buttons/badges were checked for centered alignment and symmetric padding.

Using the same cloc 2.06 inventory, excluding documentation, generated files, dependencies, lockfiles, blank lines and comments: **76,410 → 76,313 effective code lines**. Production code decreased by **190**, regression code increased by **93**, net **−97**. This is a code-size result, not a runtime-speed claim. Per-file counts are in [acceptance.json](acceptance.json).

The 110 focused parser tests passed before and after refactoring. All 82 captured `_merge` return values were byte-identical; both captures had SHA-256 `56becc7eb0b0e7c9d4372b134da36e80ea8709daece327f7cf8a4ab04908884f`. Twelve AST comparisons also confirmed the moved App component definitions and both Button implementations/variants were preserved.

## Regression results

| Check | Result |
| --- | --- |
| Server `make verify` | 2,758 tests passed; line coverage 94.86%, branch coverage 90.07%; lock, Ruff, Pyright, 33 fixtures, recovery probes and package build/check passed |
| App TypeScript / ESLint | Passed |
| App coverage suite | 415 passed, 1 existing skip; line coverage 93.31% |
| Host Rust tests / fmt / Clippy | 192 passed, 14 existing ignored subprocess/performance cases; fmt and Clippy passed |
| App browser suite | 86 passed, including desktop/touch layouts, Chinese/English refresh placement, pending reads, failure recovery and pagination |
| Web `make web-check` | 115 unit tests and 37 browser tests passed; line coverage 97.35%; TypeScript and ESLint passed |
| Final Web production build / built browser smoke | Build passed; 4 tests passed for desktop/mobile import flow, KaTeX fonts and file-picker alignment |
| macOS native QA build | Unsigned isolated QA app built and opened; Refresh works in the header; closing New bank with Escape returns focus to its trigger |

File-picker browser acceptance covers 1440, 390 and 360px, light/dark themes, empty/selected-file states, disabled geometry, keyboard focus and no overflow. Inner heights are 38px desktop and 46px touch; selecting a file makes no mutation/model request. Local screenshots preserve desktop light and narrow dark examples.

The server interpreter had an installed same-name package collision. The successful full run explicitly selected local source:

```sh
PYTHONPATH="$PWD/server/src" make verify \
  AI_PYTHON=/Users/sheny/.local/share/uv/python/cpython-3.14-macos-aarch64-none/bin/python3.14
```

An initial App coverage run had five timeout failures while the native release build was consuming CPU. The complete suite subsequently passed with `npm --prefix app run test:coverage -- --maxWorkers=2`; assertions and timeout limits were unchanged. An earlier App browser run was interrupted to incorporate the UI changes; the final complete 86-test run supersedes it.

## Evidence and limits

- [Native focus state](native-focus.txt), [recovery probes](server-probes.json) and [measurements](acceptance.json) are tracked.
- UI screenshots remain local in this directory: `native-refresh-header.png`, `file-picker-1440-light.png`, `file-picker-360-dark.png`, `bank-refresh-empty-1280.png`, `bank-refresh-paged-360.png`, `web-action-error-1440.png` and `web-result-failure-390.png`. Their [SHA-256 manifest](screenshots.sha256) identifies the inspected captures; the images are not part of the PR.
- Full logs remain local in this directory: `server-verify.log`, `app-coverage-final.log`, `app-browser-final.log`, `web-check-accepted.log` and `web-built-final.log`. They are ignored outputs and are not downloadable from a fresh checkout. The table above records the observed outcomes.

Native QA used the isolated identifier `com.practiq.simplify-qa-20261017-2e5c7b72` and synthetic example data. It did not use the user's practice database or make real model calls. Browser service fixtures do not establish live-service/provider acceptance. Windows, Android devices/emulators, signed distribution packages and remote CI were not run.

The initial base was `06df3cb`; the checkout was independently moved to `main` at `9ae2120` during this task. Those two commits have identical trees, so the measured source baseline is unchanged. At this acceptance snapshot, no checkout, reset, staging, commit or push had been performed for the simplification changes.
