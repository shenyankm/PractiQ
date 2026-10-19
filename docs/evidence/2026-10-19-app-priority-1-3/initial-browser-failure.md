# Initial browser regression and correction

The initial 99-test run completed with 98 passed and one failed:

- `check-ux-recovery.mjs:229`, complete study workspace at 1440px.
- The test timed out locating the desktop “查看答题卡” link after it had been hidden at wide widths.
- The link also serves keyboard focus navigation, so it was restored at every width.
- The unmodified complete-study-workspace cases subsequently passed at 375, 768 and 1440px. See browser-recheck.log.

The first-run trace was transient test-runner output; the subsequent run replaced the browser output directory. This file records the failure and correction rather than claiming that the first full run was green.
