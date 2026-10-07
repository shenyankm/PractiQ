# Workspace UX decisions

PractiQ has two workflows: import and inspect documents in the independent Web frontend, then practise offline in the app. This review covers navigation, bank management, question lists and editors, session setup, answering, score review, history, connection settings, backups, Web uploads, task controls and parsed-result review. It does not establish usability results from real participants or live models.

## Visual and interaction rules

Keep the octopus identity, purple primary actions, system fonts, Lucide icons and existing shadcn components. Use quiet page backgrounds with distinct cards, bounded content widths and visible field labels. Keep the purple action identity in dark mode. Normal text targets a contrast ratio of at least 4.5:1, and input boundaries target 3:1 against their surface. Do not import remote fonts, add a UI library or animate routine list updates.

Separate the primary action from supporting and destructive operations. Make the next step apparent in empty, filtered, loading and failed states. Keep errors until an explicit retry or relevant edit. Preserve keyboard focus after local filter resets, and provide links between the current question and the answer card. Keep editor and import actions outside their scrolling content, while retaining dirty-draft confirmation.

The same workflows must fit narrow touch windows and desktop windows. Touch controls retain the existing 48px targets, dynamic viewport limits and safe-area handling. Native Android Back, storage recovery and credentials remain governed by the existing platform implementation.

## Decisions by workflow

| Workflow | Resulting interaction |
| --- | --- |
| Bank management | Create a bank with the existing native editor command, or import through Settings > Restore backup. An empty bank leads to question management rather than presenting a ZIP action that creates a different bank. Cards have headings and useful fallback descriptions. |
| Question lists | Search/type controls have visible labels. Clear filters keeps the current bank/list and restores search focus. No-match copy is distinct from no mistakes or favorites. |
| Question editor | Content scrolls inside the dialog; Save and Discard stay reachable. Existing nullable-field handling, nested-editor staging and unsaved-change confirmation are retained. |
| Session setup | Each mode explains answer visibility, scoring and timing. Quick counts appear only when complete question groups can form that count. An empty scope leads to advanced selection settings. |
| Answering | The answer card is directly reachable and links back to the current question. Progress counts submissions for practice and drafts with content for exams. The action bar remains reachable while reading long questions. |
| Results | Show confirmed scores, skipped questions and unassessed counts separately. Keep rate calculations and pending-score details available under judgement details. Show scoring controls after the question/reference context, with visible score and reason labels. |
| History | An empty filtered history can return to all records; a genuinely empty history leads to banks. Existing totals, resumable drafts and provisional-score labels are preserved. |
| Settings | Explain whether a token is already saved without exposing it. Retain connection-test errors and success in the form until another test or relevant edit. Backup restoration and bank append remain distinct operations. |
| Web upload | Derive file-picker extensions from current service capabilities. Files can be removed only before submission. Selecting/removing files never starts model work. |
| Web tasks | Provide navigation between upload, list and detail. Keep allowed controls and ZIP export prominent; disclose reparse and delete separately. Keep stale-checkpoint and uncertain-mutation handling. |
| Web result review | Search stems, supplied/shared option text and source text across loaded records; filter explicit review flags. Filtering resets local pagination and preserves the complete unit-scoped material/option lookup. It does not change export contents, DTOs, review flags or model usage. |

## Verification

Run the project UI checks and browser suites:

```sh
npm --prefix app run check:ui
npm --prefix app run test:browser
make web-check web-build
```

Focused checks cover bank creation through the existing command, local filtering, feasible quick counts, persistent connection feedback, untitled ZIP append with a valid bank-title fallback, unchanged checkpoint data, and passive file removal. Browser checks include 375px, 768px and 1440px workflow captures, answer-card focus, light/dark token contrast, 200% root text sizing, and the existing Android-size, reduced-motion, bilingual and dirty-editor suites.

Screenshots and browser diagnostics are generated under `app/test-results/browser/` and `web/test-results/browser/`. These are browser/model-substitute checks; they do not establish native package acceptance, physical-device behavior, extraction accuracy or user preference. Actual system Dynamic Type remains a separate device check.

## Source guidance

The requested [UI/UX Pro Max skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) supplied accessibility, touch, layout, feedback and style-selection guidance. Its flat-design recommendation fits a cross-platform productivity tool; its generated marketing-page/demo structure does not describe PractiQ's task workspace. The existing brand and offline font requirements take precedence over suggested replacement palettes and remote fonts. The progressive-disclosure lookup did not return a relevant match; task action grouping here follows the observed workspace hierarchy rather than a claimed database recommendation.
