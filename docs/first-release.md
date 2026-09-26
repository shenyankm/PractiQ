# First-release draft

This draft describes the current repository's first-release scope. It does not establish a published or accepted release. Confirm the version, date, download link, and signing/notarization status at publication; no release date is promised here.

## Scope

| Area | Included capabilities |
| --- | --- |
| Desktop | Apple Silicon macOS 14+; Simplified Chinese and English |
| Import | Offline bank ZIP with images; explicit parsing of PDF, TXT, CSV, and PNG/JPEG |
| Organization | Review, edit, search, bookmark, and copy-merge banks |
| Practice | Seven basic types and nine English question kinds: listening, reading, word bank, cloze, grammar fill, sentence selection, paragraph matching, translation, and writing; resume and history |
| Exams | Cross-bank tests, timed exams, point allocation, and local objective scoring |
| Short answers | Explicit AI grading with a reference answer or rubric; manual overrides |
| Data | Local storage and backups including images, audio, answers, and scores; keys excluded |

## Initial release notes

- Connect document import and review to offline practice, exams, and score review.
- Manage AI parsing tasks with pause, resume, and retry on the Import page; import bank ZIP through Settings → Restore backup.
- Preserve review flags and historical practice snapshots, with backup and restore for personal records.

These notes summarize the initial delivery, not changes between published versions.

## Walkthrough and use cases

Start with the [English walkthrough](../README.md#-try-it-without-a-model) or [Chinese walkthrough](../README.zh-CN.md#-先体验无需配置模型) to import repository samples and practise without model credentials.

Demonstrate two scenarios: students import revision material and retry missed questions; material organizers distribute bank ZIP files with images for recipients to practise independently offline. These are reproducible scenarios, not collected customer testimonials. File sharing does not include an online community or sharing links. Desktop export of individual banks as ZIP is supported. Full backups contain personal records and are unsuitable for distributing questions alone.

## Before publication

Keep these items unchecked until evidence exists for the final release candidate:

- [ ] Confirm version, date, download URL, and signing/notarization status.
- [ ] Run and record service, desktop, and package checks for the release candidate; see [Contributing](../CONTRIBUTING.md#check-the-affected-code).
- [ ] Verify installation, sample import, practice, submission, and backup restore on a clean target Mac.
- [ ] Capture an actual app walkthrough or screenshots of import, practice, and score review.
- [ ] Record live-model parsing and grading examples and failures, and collect user feedback with consent.

Engineering checks and hand-written samples do not establish live-model accuracy; historical checks do not replace release-candidate acceptance. AI grading is for personal practice and leaves answers ungraded without a reference answer or rubric. Export Word to PDF. Windows CI does not establish Windows runtime support. The linked guides record installation constraints and existing grading evidence.
