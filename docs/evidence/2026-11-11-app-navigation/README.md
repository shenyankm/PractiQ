# App import and allowance navigation

These screenshots were captured in Chromium at 1440 px with synthetic accounts and a mocked native bridge, using `app/scripts/check-cloud-native.ts`. They show the desktop frontend, not an installed macOS release or production provider results.

- [Document import](import.png): one file-selection action, aligned file-purpose and page-range fields, and no account-portal navigation.
- [Allowance](allowance.png): the Settings allowance entry opens plans and remaining pages without mounting the import workspace. Purchase records return to allowance; the App sidebar independently opens Document import and returns through Settings.

The scenario asserts that opening allowance does not request import capabilities/settings or start model work. Native window automation timed out; native acceptance, real model calls and real payment processing are not established by this evidence.
