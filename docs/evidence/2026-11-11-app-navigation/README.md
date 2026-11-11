# App import and allowance navigation

These screenshots were captured in Chromium at 1440 px with synthetic accounts and a mocked native bridge, using `app/scripts/check-cloud-native.ts`. They show the desktop frontend, not an installed macOS release or production provider results.

- [Document import](import.png): one file-selection action, aligned file-purpose and page-range fields, and no account-portal navigation.
- [Allowance](allowance.png): the Settings allowance entry opens plans and remaining pages without mounting the import workspace. Purchase records return to allowance; the App sidebar independently opens Document import and returns through Settings.

The scenario asserts that opening allowance does not request import capabilities/settings or start model work. Native window automation timed out; native acceptance, real model calls and real payment processing are not established by this evidence.

The grading recovery follow-up uses `check-ux-recovery.mjs` at 1280 px and 360 px. It opens account login from a grading connection failure, signs in to the synthetic account, then returns to the same question without another grading request. [The returned grading draft](grading-return.png) retains its manual score and reason. It does not show a real model result.

Native loopback HTTP tests independently verify Cookie/CSRF grading without separate grading settings, credential redaction, explicit retry after login changes, and retaining an unknown receipt instead of applying a response after the account changes. The host suite passed 299 tests (27 intentionally ignored), with Clippy passing. Service account tests passed 30 cases, including cookie grading, CSRF rejection, account-specific request IDs and logout rejection, with a model substitute.
