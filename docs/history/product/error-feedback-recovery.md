# Error feedback and recovery

App and import Web retain their existing explicit actions, request identifiers,
backup replacement warnings, unsaved-edit confirmations and immutable practice data.
No failure automatically starts or replays importing, grading, purchasing or restoration.

- App asynchronous action errors remain visible in the current dialog or workspace
  until dismissed or another explicit action starts. The service configuration view
  retains its existing field-level errors. Other error notifications stay dismissible
  instead of expiring after four seconds; success notifications remain brief.
- Human-readable summaries precede collapsed, selectable and copyable diagnostics.
  Diagnostic copy failures have a manual-selection fallback.
- Delete, restore and quit confirmations name their action, prevent duplicate pending
  submissions, stay open on failure and restore a surviving trigger or list heading.
- Web request feedback distinguishes reads, rejected writes and uncertain write
  outcomes. Error codes remain available; server free text is not rendered.
- Account validation feedback is associated with the preserved input fields.
  Task action failures appear in the task workspace and scroll into view without
  stealing keyboard focus.
- Catalog loading, failure and empty states are separate; catalog requests and body
  reception have a bounded timeout. Refreshing products never creates an order.
- Root rendering boundaries provide explicit reload recovery with an unsaved-input
  warning. Local lazy-view boundaries preserve the surrounding shell and controls.
  Closing a failed App setup/editor returns to the surrounding workspace.

## Validation

Run `npm --prefix app run check:ui`, `npm --prefix web run check`, both frontend
builds, and both Playwright suites. The new cases in `check-ux-recovery.mjs` and
`web/tests/browser.spec.ts` inject synthetic write failures and lazy-module load
failures, verify retained drafts, keyboard focus, persistent errors and absence of
implicit request replay, and capture desktop/narrow-screen evidence.

Browser fixtures do not establish native storage, OS credential/file-picker,
real payment/service or physical-device acceptance. No live model or payment calls
are needed for this frontend validation.
