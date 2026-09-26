# Import, export, and back up question-bank ZIP files

A single ZIP is enough to share a question bank. The app no longer offers separate JSON or image-directory pickers. Document parsing and AI task import retain their existing workflow.

## Import and share

On the empty question-bank page, choose **Add example bank** to add the [all-types sample](../app/fixtures/all-types.zip) offline: 20 answerable questions and six material parent nodes covering all 11 answer modes and nine English question kinds, including images and listening tones. No model configuration is required.

1. In **Settings → Restore backup**, choose **Import bank ZIP**. Try the [basic sample](../app/fixtures/sample.zip) or [composite sample](../app/fixtures/composite.zip) without model configuration. The [nine English question kinds sample](../app/fixtures/english.zip) also includes tones for player verification.
2. The app validates questions, packaged images, and audio, then displays a preview. A new bank defaults to the package title and description; the title is editable. Appending preserves the target bank's metadata.
3. Choose **Export bank ZIP** from a bank card's action menu, save the file, and distribute it. To share multiple banks together, copy-merge them before exporting.

Sharing packages retain questions, answers, explanations, source content, shared materials, composite relationships, source scores, rubrics, images, listening audio, and review flags. They exclude bookmarks, mistake status, personal answers, practice history, grading records, connection settings, and credentials.

Missing or corrupt referenced images or audio prevent export. If a bank was initially imported without images, append a complete ZIP with the same content: questions are not duplicated, verified images are added, and historical snapshots remain unchanged. Export writes a temporary file and publishes it only after all steps succeed; existing filenames cannot be overwritten.

## Difference from study-data backups

**Export backup** in Settings still creates a ZIP containing personal banks, images, audio, answers, exams, and grading records for restoring your own data. It excludes credentials and AI task state. Restore validates the backup and retains a pre-restore copy.

Bank-sharing packages and study-data backups are different formats. Both operations are under **Restore backup** in Settings: **Import bank ZIP** appends content, while **Restore study-data backup** replaces personal data after confirmation. Selecting the wrong format returns an error.

## File format

The ZIP root contains `manifest.json`, `questions.json`, and image/audio files at `resources/<objectKey>`.

```json
{
  "format": "practiq-question-bank",
  "version": 2,
  "bank": {"title": "Example bank", "description": "Bank description"}
}
```

`questions.json` follows the AI result contract with `schemaVersion: 3`, including `questions`, `groups`, `visualElements`, `warnings`, and `confidenceScore`. See the [question model](question-model.md) for the JSON contract. Images retain the objectKey, SHA-256, size, and media type in `imageRef` and `sourceRef`. Packages contain question data, not the desktop database or practice snapshots.

Limits are 300 MiB per ZIP, 32 MiB per JSON file, 25 MiB per image or audio file, and 256 MiB for all expanded resources. The current result contract permits at most 1000 question nodes (including composite parents), 1000 material groups, 1000 visual elements, and 1000 warnings per package. Exceeding these limits rejects export rather than truncating the bank. All referenced images and audio must be present. Extra files, directory entries, duplicate entries, symlinks, and path traversal are forbidden.

Regenerate development samples with `python3 app/scripts/package-fixtures.py`. Their hand-written content does not establish live-model quality.

Listening parent questions store audio references in `audioRef`, supporting audio/mpeg, audio/mp4, audio/aac, and audio/wav. Images and audio share the package and expanded-size budgets. The current ZIP version is 2, backup version is 4, and desktop directory is v3. Older versions are explicitly rejected; old directories remain intact. Reparse source documents or generate new-format banks.

Initial listening-audio validation requires macOS `afinfo`. Windows and Linux currently do not support importing, exporting, or restoring banks with audio.
