# Button sizing and history toolbar acceptance, October 17, 2026

Screenshot files were removed on October 17, 2026 during repository cleanup. The results below describe the original acceptance. Logs, measurements and original hash manifests are retained as historical records; screenshot entries in those manifests no longer identify available files. Current product screenshots remain in the root README files. All 88 removed tracked screenshots are listed in the [historical checksum manifest](../screenshots-removed-20261017.sha256); recover their files from Git commit `6a0ea50`.

The complete original 14-entry checksum list is retained in [SHA256SUMS.original](SHA256SUMS.original) for verifying files recovered from Git history. [SHA256SUMS](SHA256SUMS) covers only the files still present in this directory.

The Settings backup actions used the same Button size, but Radix's composed
dropdown trigger replaced `data-slot="button"`. Shared theme selectors therefore
missed the restore action: the normal export button was 40 px high while the
restore trigger retained its 32 px component height.

Both App and import Web Button wrappers now emit a stable `data-button` marker.
Shared theme, English wrapping, reduced-motion and touch sizing rules use that
marker. Radix's slot names, menu semantics, existing size variants, callbacks and
focus handling are preserved. This covers composed dialog/menu buttons rather
than adding a one-off height override to the Settings page. No package dependency
changed. The installed components remain the authority; the repository does not
pin the shadcn CLI. [Official Button guidance](https://ui.shadcn.com/docs/components/radix/button)
documents variants and composition.

## Native macOS evidence

At acceptance, the existing isolated `PractiQ Native QA` host
(`com.practiq.native-errors-20261017`) loaded the development frontend
from loopback port 1420. Its title identified the original native host
build, `main a430f7e`; the original screenshots validated that frontend through live
reload in macOS WebKit, not a rebuilt installer or a new Rust binary.

- Before: mismatched backup action heights.
- After: matching heights and vertical alignment.
- Open restore menu: all three existing restore/import actions
  remain available.
- [Focus restoration](native-focus-restored.txt): Escape returns focus to the
  Restore backup trigger. No native backup/restore file mutation was performed.

## Browser coverage

The regression uses the real production components and styles with the existing
offline preview transport. It checks Chinese/light at 1280 and 390 px, plus
English/dark at 960 and 360 px. Desktop actions must be 40 px high; narrow actions
must be 48 px high. Icons must match in size. Actions share a vertical center when
they fit on one row; otherwise wrapping retains left alignment and the existing
12 px row gap. English 360 px deliberately wraps into two rows.

| Scenario | Original capture | Action height |
| --- | --- | --- |
| Chinese, light, 1280 px | Desktop | 40 px |
| English, dark, 960 px | Desktop | 40 px |
| Chinese, light, 390 px | Narrow | 48 px |
| English, dark, 360 px | Wrapped actions | 48 px |

The same scenarios open the restore menu, close it with Escape, check restored
focus, and invoke fake export exactly through the existing preview path. The
preview suite rejects unexpected native IPC and page errors. Original test
failures include two demonstrated desktop height mismatches, then corrected test
fixtures for translated labels/fake backup paths and valid narrow wrapping.

The final check totals, source/screenshot hashes and retained raw logs are listed
in the [acceptance record](../../../server/reports/agent-pipeline-20261017-acceptance.json).
App types/lint/coverage passed with 415 tests and one intentionally disabled
editor microbenchmark (`PRACTIQ_EDITOR_BENCH`). The complete final App browser
repeat passed 83 tests with two workers, zero skips/flaky/unexpected results.
Web types/lint/coverage passed 115 tests, its browser suite passed 36 tests, and
the Web production build passed. The mechanical design scan reported no findings.
Earlier performance records and screenshot hashes are retained. Browser Android
projects exercise touch layouts with mocked native commands; this change does
not establish Android-device or Windows-native package acceptance.

## History refresh placement

History refresh now sits beside the status filter at the top of the content
area. Only pagination remains below the list. Empty, loading and failed reads
retain the same refresh control; loading disables it, and refreshing retains
the selected status and page. No native command or read/retry behavior changes.

- Native macOS empty history: the existing isolated
  WebKit host showed the acceptance frontend after a successful passive refresh.
- Desktop empty history and
  populated history.
- Narrow empty history and
  populated history.

Two browser regressions assert geometry, absence of horizontal overflow, one
read per refresh, preserved status, loading disablement and recovery after a
synthetic read failure. Their fixture supplies empty results before refresh and
uses the existing preview records afterward. Final rerun totals and first
failure logs are retained in the acceptance record linked above.
