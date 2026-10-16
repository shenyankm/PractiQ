# Retired native error translations: compatibility audit

Date: 2026-10-16. Scope: the 72 unreferenced `LOCAL_*` entries identified before this follow-up. The initial working tree already contained unrelated changes and the earlier five simplifications.

## Decision

Remove all 72 candidates (288 dictionary lines). None has a producer on the supported historical grading-persistence path. Keep the other 212 translation pairs exactly, including local transport, model-provider and remote-service errors that saved grading responses can contain. No runtime formatter, database, schema, backup format, credential namespace or historical task file is changed.

| Candidate group | Count | Reason |
| --- | --- | --- |
| Retired import, parser startup and provider-settings paths | 57 | Removed in `42641a82`; failures return before the grading response is captured, or belong only to separate import-task files |
| Producers removed before schema 11 | 11 | Current startup and backup restore reject those older database versions; no migration is added |
| Dictionary-only entries | 3 | No literal producer exists in the reachable native Git history |
| Retired import-result validation | 1 | `LOCAL_RESULT_EMPTY` was removed in `bffe771a`; it validated document import, not a grading response |

## Historical evidence and persistence boundary

- `9e34a1c0` introduced schema 11 and strict rejection of older databases/backups. `app/src-tauri/src/schema.sql` is unchanged between that commit and the current HEAD. Existing schema-11 version-4 backups remain supported.
- All ten `ai.rs` revisions in reachable history from that boundary onward were checked. In the bundled-service versions, `active_endpoint(...)?` starts the parser and validates provider settings before entering `AiRequest::Grade`. Inside that arm, only `process.json(POST, "/api/subjective-grades", ...)` failures are wrapped as a stored `appError`. Parser startup, key/configuration and import-operation errors do not cross this capture boundary.
- Reproduce the key historical boundary with `git show 42641a82^:app/src-tauri/src/ai.rs` (startup at `active_endpoint`, grading arm at lines 805–840) and `git show 9e34a1c0:app/src-tauri/src/ai.rs` (same grading capture at lines 810–833). The candidate codes have no literal producers in the service source at these two endpoints either.
- The removed `ai_work.rs` stores operation and batch errors under the separate `ai/` directory. Full backups copy the practice SQLite database and assets; they exclude that task directory. Current App code does not read those old files. They remain untouched on disk.
- Current `ai.rs` still persists transport and service errors through `record_grade_with_key` into both `grade_requests.response` and `attempts.grading.lastRequest`. Backup removes only in-flight receipts with a null response. Completed error responses survive unchanged, and `ExamResults` passes them to `errorMessage` for the current locale.
- Unknown stored codes remain opaque data. The existing fallback still displays their original diagnostic and request metadata. This audit does not claim arbitrary third-party backup JSON can never contain a deleted code; it establishes that the shipped supported history did not persist these 72 translations' producers. No private user database was inspected or modified.

## Regression coverage

`app/fixtures/legacy-grading-errors.json` is shared by native and frontend tests. It covers an old HTTP error whose diagnostic exists only in `message`, a local transport error with explicit diagnostics and unknown metadata, an unknown external code, and a legacy string-only error code.

The native regression records those responses through the production grading-record path, closes and reopens SQLite, exports a real backup ZIP and restores into a fresh temporary store. It checks exact stored response and grading JSON, preserved null results and scores, and readable session history. The test passed before removing translations and is included in the post-cleanup suite.

Frontend regressions render the archived responses in `ExamResults`, switch from Chinese to English, retain the diagnostic, keep the input session unchanged, and reject any native/model call beyond language reads and the explicit language change.

## Acceptance

| Check | Result |
| --- | --- |
| `VITEST_MAX_WORKERS=2 npm --prefix app run check:ui` | Types, lint and coverage pass; 396 tests pass, one existing benchmark skips; line coverage 93.37% |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --locked` with empty Tauri bundle resources | 191 pass, 13 existing tests ignored; binary and doc-test targets pass |
| Clippy with all targets and warnings denied; Rust formatting | Pass |
| Browser smoke for explicit grading and offline ZIP/settings, including built touch-navigation dependencies | 7 pass |
| App production build; shared contract export check; fixture validation | Pass; 49 contract cases and sample validation |
| Workspace preservation | All pre-existing files except the intended native dictionary and backup-test file retain their initial hashes or absent state; earlier uncommitted work is unchanged |

Local logs, historical classification and the acceptance summary are retained in the ignored `app/.build/legacy-errors-20261016/` directory. Native tests ran on macOS with temporary data. Browser tests use native substitutes. Windows/Android native execution, final installers and live model calls were not run; the service and Web source were unchanged.

## Per-code decisions

Every row below is removed. Historical paths are under `app/src-tauri/src/`; the origin for the pre-schema-11 group is the commit that removed its producer.

| Code | Historical origin | Group |
| --- | --- | --- |
| `LOCAL_SOURCE_COUNT_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_MODEL_URL_REQUIRED` | `ai.rs` | retired-runtime |
| `LOCAL_MODEL_ID_REQUIRED` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_MISSING` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_START_FAILED` | `ai.rs` | retired-runtime |
| `LOCAL_INPUT_PIPE_FAILED` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_INIT_FAILED` | `ai.rs` | retired-runtime |
| `LOCAL_STATUS_PIPE_FAILED` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_TIMEOUT` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_PORT_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_BUNDLE_NOT_READY` | `ai.rs` | retired-runtime |
| `LOCAL_OPERATION_BUSY` | `dictionary only` | never-emitted |
| `LOCAL_OPERATION_ID_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_WORK_DIRECTORY_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_WORK_FILENAME_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_RECEIPT_MISMATCH` | `ai_work.rs` | retired-runtime |
| `LOCAL_OPERATION_PATH_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_REQUEST_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_OPERATION_ID_MISMATCH` | `ai_work.rs` | retired-runtime |
| `LOCAL_RECEIPT_MISSING` | `ai_work.rs` | retired-runtime |
| `LOCAL_OPERATION_REJECTED` | `ai_work.rs` | retired-runtime |
| `LOCAL_RECEIPT_INCOMPLETE` | `dictionary only` | never-emitted |
| `LOCAL_BATCH_ID_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_SIZE_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_ITEM_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_SELECTION_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_TASK_SOURCE_MISSING` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_ID_MISMATCH` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_STARTED` | `ai_work.rs` | retired-runtime |
| `LOCAL_RESULT_VERSION_CHANGED` | `dictionary only` | never-emitted |
| `LOCAL_DATABASE_NEWER` | `8116674a` | unsupported-schema-era |
| `LOCAL_QUESTION_MISSING` | `8116674a` | unsupported-schema-era |
| `LOCAL_BACKUP_IMAGE_CHECKSUM` | `8116674a` | unsupported-schema-era |
| `LOCAL_BACKUP_QUESTION_SIZE` | `8116674a` | unsupported-schema-era |
| `LOCAL_BACKUP_CONTENT_INVALID` | `8116674a` | unsupported-schema-era |
| `LOCAL_LEGACY_IMAGE_INVALID` | `8116674a` | unsupported-schema-era |
| `LOCAL_API_KEY_REQUIRED` | `settings.rs` | retired-runtime |
| `LOCAL_API_KEY_INVALID` | `settings.rs` | retired-runtime |
| `LOCAL_API_KEY_URL_REQUIRED` | `settings.rs` | retired-runtime |
| `LOCAL_SELECTED_QUESTION_DELETED` | `8116674a` | unsupported-schema-era |
| `LOCAL_IMAGE_FORMAT_INVALID` | `2c3435ed` | unsupported-schema-era |
| `LOCAL_NO_MISTAKES` | `8116674a` | unsupported-schema-era |
| `LOCAL_TASK_ID_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_PARSER_STATE_UNAVAILABLE` | `ai.rs` | retired-runtime |
| `LOCAL_WORD_UNSUPPORTED` | `ai.rs` | retired-runtime |
| `LOCAL_DOCUMENT_UNSUPPORTED` | `ai.rs` | retired-runtime |
| `LOCAL_FILENAME_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_PARSER_UNAVAILABLE` | `ai.rs` | retired-runtime |
| `LOCAL_PAGE_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_TASK_LIST_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_ACTION_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_DOCUMENT_NOT_SELECTED` | `04803917` | unsupported-schema-era |
| `LOCAL_UPLOAD_URL_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_UPLOAD_URL_OUTSIDE` | `ai.rs` | retired-runtime |
| `LOCAL_UPLOAD_FAILED` | `ai.rs` | retired-runtime |
| `LOCAL_UPLOAD_RETRY` | `ai.rs` | retired-runtime |
| `LOCAL_PREVIEW_UNIT_MISSING` | `ai.rs` | retired-runtime |
| `LOCAL_IMAGE_MISSING` | `ai.rs` | retired-runtime |
| `LOCAL_SOURCE_ENCODING_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_RESULT_VERSION_MISSING` | `ai.rs` | retired-runtime |
| `LOCAL_RESULT_EMPTY` | `ai.rs` | retired-import-result |
| `LOCAL_IMAGE_SIZE_OUTSIDE` | `ai.rs` | retired-runtime |
| `LOCAL_DIRECTORY_NOT_SELECTED` | `87b93f57` | unsupported-schema-era |
| `LOCAL_CONNECTION_MODEL` | `settings.rs` | retired-runtime |
| `LOCAL_CONNECTION_FIELDS` | `settings.rs` | retired-runtime |
| `LOCAL_SETTINGS_ACTIVE_TASKS` | `ai.rs` | retired-runtime |
| `LOCAL_SOURCE_MISSING` | `ai_work.rs` | retired-runtime |
| `LOCAL_IMPORT_DETAILS_INVALID` | `ai_work.rs` | retired-runtime |
| `LOCAL_BATCH_RUNNING` | `ai_work.rs` | retired-runtime |
| `LOCAL_IMPORT_VERSION_CHANGED` | `ai_work.rs` | retired-runtime |
| `LOCAL_SOURCE_ARTIFACT_INVALID` | `ai.rs` | retired-runtime |
| `LOCAL_IMAGE_ARTIFACT_INVALID` | `ai.rs, ai_work.rs` | retired-runtime |
