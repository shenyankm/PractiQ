# Import, export, and back up question-bank ZIP files

A single ZIP is enough to share a question bank. The app no longer offers separate JSON or image-directory pickers. The independent service's App import workspace parses documents and downloads this same ZIP format; app import remains offline on macOS.

## Import and share

On the empty question-bank page, choose **Add example bank** to add the [all-types sample](../../app/fixtures/all-types.zip) offline: 20 answerable questions and six material parent nodes covering all 11 answer modes and nine English question kinds, including images and listening tones. No model configuration is required.

1. In **Settings → Import and restore**, choose **Import bank ZIP**. Try the [basic sample](../../app/fixtures/sample.zip) or [composite sample](../../app/fixtures/composite.zip) without model configuration. The [nine English question kinds sample](../../app/fixtures/english.zip) also includes tones for player verification.
2. The app validates questions, packaged images, and audio, then displays a preview. Duplicate question references within a section or visual, and passage blanks referring to absent questions, are rejected before confirmation. A new bank defaults to the package title and description; the title is editable. Appending preserves the target bank's metadata.
3. Choose **Export bank** from a bank card's action menu, save the file, and distribute it. To share multiple banks together, copy-merge them before exporting.

Sparse question records, including options with only labels or unreadable content, remain importable with their missing-field and review warnings; they do not block other questions in the bank. Incomplete choices are not automatically graded. Truly empty questions are still rejected.

Sharing packages retain questions, answers, explanations, source content, shared materials, composite relationships, source scores, rubrics, images, listening audio, and review flags. They exclude bookmarks, mistake status, personal answers, practice history, grading records, connection settings, and credentials.

Choosing an existing bank checks for identical complete question trees before confirmation. The preview lists duplicate groups and their subquestion count. Choose **Keep duplicates** or **Skip identical groups** explicitly; the default keeps overlapping questions from different snapshots. Comparison includes normalized question content, supplied answers, quality flags, shared materials and associated visuals/resources, rather than matching only stems. Similar questions and changed answers or materials are retained. No existing question, note, favorite, review confirmation or practice snapshot is overwritten. Only the destination bank is compared; duplicates within the incoming package or other banks are not merged. An identical complete-result receipt is always skipped, including with **Keep duplicates**, while verified missing resources can still be added through the existing import path.

Skipping compares the bank again on confirmation. If its compared content changed, import is rejected and the preview refreshes for another explicit confirmation. Retained questions keep their source associations and parsing diagnostics; skipped trees keep their existing local content and provenance. Skipping every incoming question also discards that import's document-level images and groups, so a skipped import cannot add global visuals to existing questions. File selection and duplicate checks are passive and never start model calls. Import the final complete result into a new bank if you want to keep snapshots entirely separate.

New imports retain each snapshot's parsing status, processing counts, truncation flag, failed units, source associations and quality issues. Open **Question details → Import parsing diagnostics** to inspect them. The diagnostics survive restart, copy-merge, bank sharing and study-data backup/restore, using the existing schema-11 warning store with a reserved metadata position. Ordinary warnings remain literal text. Re-importing the original ZIP can recover diagnostics omitted by an older app when its question records and source associations still prove the original mapping; it does not add duplicate questions. Edited or reordered imports without a provable mapping retain their current data; import the original ZIP into a new bank to inspect its diagnostics. Diagnostics already lost without the original ZIP cannot be reconstructed.

Copy-merging also retains unlinked sections, unparsed source pages, and warnings from imports with no questions. Unparsed pages stay separate from practice questions, including after the original banks are deleted and the merged package is shared.

Missing or corrupt referenced images or audio prevent export. If a bank was initially imported without images, append a complete ZIP with the same content: questions are not duplicated, verified images are added, and historical snapshots remain unchanged. On macOS, bank export writes a temporary file and publishes it only after all steps succeed; existing filenames cannot be overwritten.

## Difference from study-data backups

**Export backup** in Settings still creates a ZIP containing personal banks, images, audio, answers, exams, and grading records for restoring your own data. It excludes credentials and AI task state. Backup creation validates image/audio formats before writing the ZIP. Unsupported legacy resources (including WebP/GIF) or damaged media cancel the backup before publication. A desktop destination is replaced only after the private ZIP is complete. Restore validates the backup and retains a pre-restore copy.

Study-data backups allow up to 512 MiB of database and expanded resources combined. Their manifest and repair-recovery inventory each have a separate 16 MiB cap; the ZIP file is capped at 544 MiB to accommodate metadata. These limits apply equally to explicit backups and pre-restore recovery copies. Large inventories do not change the version-4/schema-11 format; backups whose manifests exceed 1 MiB require an updated app to restore.

Restore checks SQLite storage classes against strict bank/session readers before replacement; BLOB values in text fields or non-integer bank timestamps are rejected without replacing live data. It also validates every stored visual record, including document-only and unlinked records, against the shared visual contract before projecting questions or replacing live data. Invalid JSON shapes, resource-reference types and question references reject the incoming backup; the existing database remains usable.

Bank-sharing packages and study-data backups are different formats. Both operations are under **Restore backup** in Settings: **Import bank ZIP** appends content, while **Restore study-data backup** replaces personal data after confirmation. Selecting the wrong format returns an error.

Restore rejects sessions with no attempts, missing or invalid attempt ordinals, a current position outside the attempt list, or saved answers that do not match their normalized frozen question structure before replacing local data. Each answerable frozen question must have exactly one attempt; composite parents cannot have attempts. Saved answers retain the normal 256 KiB serialized byte limit and cannot reuse exclusive word-bank options. Validation uses the saved question and shared options, so later bank edits do not invalidate historical answers. Null and incomplete draft answers remain supported. Valid schema-11 backups keep their saved position.

Schema-11 backups made before Traditional Chinese support remain supported. On startup or staged restoration, only the exact former two-language settings table is upgraded in a transaction after the complete schema is validated; practice data and legacy provider fields are preserved. The database version stays 11 and the backup container stays 4. Older app builds do not accept the expanded settings constraint, so retain a backup from before upgrading if rollback is needed.

If currently referenced images or audio are missing or damaged, choose **Repair resources and restore backup** under **Restore backup**. It requires the same full-data replacement confirmation. The app validates the complete incoming version-4/schema-11 backup before changing live resources, then durably preserves the previous database, grading connection settings, available original resource bytes and `inventory.json` in a private `recoveries/before-restore-.../` directory. The inventory records expected and actual hashes/sizes, missing or damaged resources, and whether each file was indexed in the old database. This directory is an inspection/recovery record, not a valid ordinary backup; keep it for manual diagnosis rather than selecting it for standard restore.

Only this explicit action atomically replaces damaged or missing same-hash files with verified backup bytes. Ordinary reads, bank imports and backup creation retain checksum/format rejection. A valid existing resource is reused. Database publication, the pending service-settings record and rollback keep their existing ordering. If later database publication fails or rolls back, repaired same-hash bytes may remain, while the original bytes stay in the recovery record; the error reports its location. Symlinks, unreadable files, resources beyond the existing byte limits and failed preservation/synchronization block repair. Back up the repaired state to a new ordinary backup after successful recovery. Verify the native macOS file-picker and directory-publication behavior against the final package.

## File format

The ZIP root contains `manifest.json`, `questions.json`, and image/audio files at `resources/<objectKey>`.

```json
{
  "format": "practiq-question-bank",
  "version": 2,
  "bank": {"title": "Example bank", "description": "Bank description"}
}
```

`questions.json` accepts the existing portable `{status,result,processing}` envelope or result object with `schemaVersion: 3`, including `questions`, `groups`, `visualElements`, `warnings`, and `confidenceScore`. See the [question model](../reference/question-model.md) for the JSON contract. Images retain the objectKey, SHA-256, size, and media type in `imageRef` and `sourceRef`. Packages contain question data, not the desktop database or practice snapshots.

An app export with saved diagnostics adds `importDiagnostics` to the envelope. Each entry follows the generated `BankImportDiagnostic` contract: `questionIds`, nullable `status` (`SUCCEEDED` or `PARTIAL`), and nullable `processing`. IDs and processing references are remapped with their question records. Multiple snapshots keep separate diagnostic entries; the envelope status is `PARTIAL` if any snapshot is partial, and top-level `processing` is null when there are multiple entries. Deleting questions removes their diagnostic references when sharing; import-time unit counts remain historical. References to existing questions in another bank are rejected during reads, sharing and backup validation. Task IDs, runtime checkpoints, usage receipts and credentials are excluded. Plain result packages and the original service envelope remain supported, without a format/database version change. Updated apps are needed to retain these diagnostics through subsequent sharing.

Limits are 300 MiB per ZIP, 2,002 entries including the two JSON files, 32 MiB per JSON file, 25 MiB per image or audio file, and 256 MiB for all expanded resources. The current result contract permits at most 1000 question nodes (including composite parents), 1000 material groups, 1000 visual elements, and 1000 warnings per package. Exceeding these limits rejects export rather than truncating the bank. The entry limit also applies to banks accumulated from multiple valid imports; an oversized bank is rejected before writing its destination, without automatic splitting. Images must be PNG/JPEG; WebP/GIF resources are rejected. All referenced images and audio must be present. Extra files, directory entries, duplicate entries, symlinks, and path traversal are forbidden.

Regenerate development samples with `python3 app/scripts/package-fixtures.py`. Their hand-written content does not establish live-model quality.

Listening parent questions store audio references in `audioRef`, supporting audio/mpeg, audio/mp4, audio/aac, and audio/wav. Images and audio share the package and expanded-size budgets. The current ZIP version is 2, backup container version is 4 with schemaVersion 11, and the desktop directory is v4. Older versions are explicitly rejected; old directories remain intact. Reparse source documents or generate new-format banks.

Listening audio is validated with Symphonia on all app platforms. URL/QR imports are downloaded and saved as ordinary local audio before export; recipients need no access to the original site. Playback depends on the platform WebView codecs; verify the intended macOS runtime separately. Bank import appends content; full study-data restoration requires replacement confirmation.
