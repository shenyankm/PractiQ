# Changelog

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
