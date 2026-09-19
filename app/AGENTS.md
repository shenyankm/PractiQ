# Desktop application

- React + Vite + shadcn/ui + TypeScript, Tauri 2 and Rust/SQLite. macOS and desktop layouts only in this release.
- Reuse the bundled Python AI service for explicit document parsing; consume its existing JSON contracts for import. Never implement another parser or generate answers.
- Validate all native command inputs. File access begins with a native file picker. Imported content cannot request arbitrary SQL, file access or network access.
- Preserve nulls, quality warnings, source associations and practice snapshots. Unreviewed content may be practised. Incomplete/unavailable answers must not become automatically incorrect.
- Store API keys only in macOS Keychain, scoped to the configured Base URL; never return stored keys to the webview or include them in SQLite/backups. Text and vision models must both be configured before parsing; desktop artifacts stay local.
- Keep databases out of the repository. Use temporary directories in integration tests, including resource import and restore tests.
- Use the existing octopus brand asset, Lucide (`lucide-react`) for functional icons, existing shadcn components and standard CSS layout. No mobile layout or mobile platform scaffolding.
- `make app-check AI_PYTHON=/path/to/python3.14` and `make app-build` from the repository root are the acceptance commands.

Source-document import supports PDF, TXT, CSV and PNG/JPEG images. Word is unsupported; direct users to export PDF. Do not restore Word parsers or LibreOffice dependencies. The desktop sidebar has one unified import page for offline JSON import and AI parsing/task management.
