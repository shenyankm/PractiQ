# Changelog

## 0.2.2 — Unreleased

Prepared for macOS 14+ on Apple Silicon. Publication is pending final-candidate checks and the signing, clean-machine and live-model acceptance required by the [release policy](docs/maintainers/releases.md).

- Add a learning overview with daily review suggestions, 7- and 30-day statistics, personal notes, mistake causes and backup reminders.
- Grade submitted short answers during ordinary practice with individual scoring points and checked reference/answer quotations; preserve explicit grading and retry controls.
- Simplify the personal Web importer without an application access token; persist optional deduplication and AI answer/explanation generation defaults, both off by default.
- Compact Web import and task history layouts while retaining source review, partial export and explicit recovery.
- Preserve linked answer pages, table images and fixed Tencent figure associations; check question coverage, reading order and formulas against retained source evidence.
- Keep parsing diagnostics through bank import, sharing, merging and backup restoration, and clarify overlapping-import and export recovery.
- Harden interrupted writes, settings and backup restoration, verified file reads and RabbitMQ delivery; retain uncertain paid-call receipts without automatic replay.
- Reduce repeated file hashing, database reads, scoring and source-validation work while preserving checksums and immutable practice snapshots.
- Correct the three README translations for provider data flow, model API requirements, import options and backup compatibility.

Desktop data remains in `v4/` with SQLite schema 11; full backup version 4, bank ZIP version 2 and AI JSON schema 3 are unchanged. Full backups may include optional version-1 learning notes and grading connection settings, without credentials. The independent AI service source remains `0.3.0` and requires separate deployment.

## [0.2.2-rc.1](https://github.com/shenyankm/PractiQ/releases/tag/v0.2.2-rc.1) — 2026-11-02

Release candidate for macOS 14+ on Apple Silicon. This is a pre-release, unsigned and not notarized; final clean-machine and live-model acceptance remain incomplete. Review the release notes for candidate-specific automated checks, attachment hashes and Actions provenance.

- Preserve linked answer pages, native-table images and fixed Tencent figure associations; check question coverage, reading order and formulas against source evidence.
- Retain parsing diagnostics through bank import, sharing, merging and backup restoration, and clarify export recovery and overlapping snapshot imports.
- Harden interrupted import, retained-source repair and invalid Tencent-result recovery without automatically replaying uncertain paid submissions; retain uncertain Web reparse requests across reloads.
- Reduce repeated OCR, planning, scoring, question reads, resource hashing and backup-restoration work while retaining validation and immutable practice snapshots.
- Apply pagination, filter and refresh reads immediately while debouncing keyword edits, and reuse capabilities returned by the Web connection check.

Desktop data remains in `v4/` with SQLite schema 11; full backup version 4, bank ZIP version 2 and AI JSON schema 3 are unchanged. The independent AI service source version remains `0.3.0` and is not deployed by the desktop installer.

[Changes since v0.2.1](https://github.com/shenyankm/PractiQ/compare/v0.2.1...v0.2.2-rc.1).

## [0.2.1](https://github.com/shenyankm/PractiQ/releases/tag/v0.2.1) — 2026-10-30

First public release for macOS 14+ on Apple Silicon. The installer is unsigned and not notarized; final clean-machine and live-model acceptance remain incomplete. All four release attachments have verified Actions attestations. See the release notes for automated validation, checksums and provenance.

- Practise offline, take mock exams, review mistakes and bookmarks, and continue saved sessions without an account or service.
- Import and share question-bank ZIPs, retain practice and score snapshots, and back up local study data.
- Offer explicit subjective AI grading through a user-configured model or the independent service, with reference-answer or rubric requirements.
- Import documents through the separately deployed Web/Tencent parsing service and review source evidence before exporting a bank ZIP.
- Fix assembly of the single macOS release artifact without relaxing package or provenance checks.

- Reuse native media validation, consolidate choice layouts and import styles, and simplify contract export and storage test helpers without changing data formats.

- Add an explicit client version synchronization command and generated change summaries in draft release notes.
- Bind draft-asset Actions attestations to the candidate tag and source commit, and verify them before draft creation.
- Add reviewable release-tag creation and immutability policies.

The `v0.2.0` tag remains an unpublished candidate. [GitHub Releases](https://github.com/shenyankm/PractiQ/releases) carries the published installers, full notes and validation evidence. Future candidates use the [release template](.github/RELEASE_TEMPLATE.md).
