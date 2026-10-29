# Changelog

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
