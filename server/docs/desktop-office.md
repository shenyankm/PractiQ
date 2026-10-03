# Desktop Office conversion

The desktop imports `.doc`, `.docx`, `.xls` and `.xlsx` using the bundled LibreOffice 26.8.0 runtime. The standalone service still accepts only PDF, TXT, CSV and PNG/JPEG. No Office parser, upload type, Python UNO bridge, `python-docx` or `openpyxl` was added.

## Using it

All desktop packages include LibreOffice. On Import, **Check conversion component** checks the bundled version and all four export capabilities using temporary documents. The app never searches PATH, system installations or the Windows registry, and offers no executable picker or download action. A missing or damaged component requires reinstalling PractiQ. There is no runtime download or independent LibreOffice updater.

| Input | Default | Text mode |
| --- | --- | --- |
| DOC / DOCX | PDF for the existing visual parser | UTF-8 TXT |
| XLS / XLSX | PDF for the existing visual parser | One UTF-8 CSV per sheet, including hidden sheets |

The private **Convert / extract files** command works without model settings; its standalone panel is no longer shown on the import page. It opens native input and save dialogs. Multiple CSVs are saved in a new `PractiQ-<UUID>` directory inside the chosen folder; existing source files cannot be overwritten. This operation starts neither the HTTP service nor model calls.

Generated filenames fit a 255-byte UTF-8 component limit, shortening long source names with a digest while retaining the worksheet suffix. The save dialog filters by the converted format and restores a missing or changed PDF/TXT/CSV extension before checking the destination.

For AI import, fill in the bank name and description in the Import tab, select up to 10 source files at once, and click Start import. The form uses PDF mode. Start import explicitly authorizes conversion, upload and model work without a second confirmation dialog. Matching content opens existing tasks; the explicit Parse again action starts a new task without an additional prompt. Excel text mode creates one task per nonempty sheet, named after the source file and sheet. Empty sheets are exported locally but explicitly marked as skipped for AI; wholly empty extraction creates no tasks. Conversion never silently switches modes.

The native `select_document` command authorizes the selected paths and returns a selection token. `pick_document` requires that token and the bank name/description; it never opens a second file picker as a fallback. Missing fields, invalid metadata and unknown or replaced tokens are rejected before processing.

In a multi-file selection, an empty Office result or a source with pending operations is reported and skipped individually. Previously accepted tasks remain in the returned selection, and subsequent files still run.

PDF uses the document's printing layout; print areas can omit cells or sheets. Text mode loses images, formulas and layout. CSV contains displayed cell values rather than formula expressions; dates and numeric display depend on the source formatting and LibreOffice locale. The mode warning explicitly includes hidden sheets. Fonts and compatibility with the installed Office version affect rendering: review output before relying on it.

## Local boundaries and recovery

- Rust owns file authorization, bounded source snapshots, output validation and atomic saves. Frontend requests cannot contain paths, executables or command arguments. The private Python `office` command uses the standard library to invoke the native-authorized bundled executable.
- Each conversion uses separate temporary input/output and LibreOffice profile directories. Macro execution, trusted macro locations, external-link updates and Writer field/chart updates are disabled in that profile. Parent-exit monitoring and Windows Job Objects clean up only the operation's processes; existing LibreOffice sessions use different profiles.
- The isolated profile disables LibreOffice's embedded Python runtime with `DisablePythonRuntime=true`. Native Writer/Calc exports need no Python extensions; disabling their loader also avoids LibreOffice 26.8's Writer startup failure under Unicode Linux installation paths. The [upstream loader](https://github.com/LibreOffice/core/blob/libreoffice-26.8.0.3/pyuno/source/loader/pyuno_loader.cxx) checks this setting before Python initialization. Bytecode writes remain disabled as a fallback. Package checks verify unchanged files after conversion in a writable relocated directory containing Unicode and spaces, then repeat with read-only POSIX resources.
- External Office processes use system library search paths instead of the frozen Python bundle's libraries, following [PyInstaller's external-program guidance](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#launching-external-programs-from-the-frozen-application). The private worker restores its own Windows DLL search path after spawning; macOS uses the native font renderer.
- Conversions are serial. Each source/output is limited to 25 MiB; there are at most 100 outputs totaling 100 MiB. Conversion timeout is 180 seconds. PDF validation also enforces the desktop's 100-page limit. Outputs must be regular files of the expected type, valid PDF/UTF-8 text/CSV, within the authorized directory, and match the worker's size/hash manifest. Zero exit without valid output is failure.
- Executable paths come only from application resources and are checked against the platform, architecture and pinned version. SQLite stores no executable preferences; backup restoration rejects schemas containing an executable-path column. Study backups continue to exclude AI task state and credentials.
- AI operation receipts record original filename/SHA-256, mode, LibreOffice version, artifact SHA-256 and task association. Duplicate Office imports use original hash plus mode. A request containing the prepared artifact reference is persisted before uploading its bytes; all sheet requests are durable before task submission. A later upload failure therefore leaves earlier uploaded content discoverable through pending operations. Explicit recovery reuses request IDs, avoiding automatic duplicate model calls. If an interrupted upload never reached storage, recovery reports the missing artifact rather than creating a task.
- Retry and reparse use retained uploaded PDF/TXT/CSV artifacts, subject to service retention. They need neither LibreOffice nor the original source. Historical removed `docx_parser` tasks remain readable but cannot resume; convert the original file for a new supported-format task.

The filters use LibreOffice's [conversion filter names](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html) and [CSV parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/csv_params.html): CSV token 9 enables displayed values, token 10 disables formula expressions, and token 12 is `-1` for all sheets.

Legacy DOC/XLS input checks walk the bounded [Compound File Binary allocation and directory structures](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/05060311-bfce-4b12-874d-71fd4ce63aea) and require root-level Word or workbook streams. A generic OLE signature or an embedded Office object does not establish the selected document's family. Malformed directories, unrelated containers and encrypted OOXML renamed as DOC/XLS are rejected before launching the converter.

## Reproducing conversion checks

Use the project's selected Python 3.14+ interpreter and build bundled resources with `make app-bundle AI_PYTHON=...` first. No model credentials or external model calls are needed.

```sh
python3.14 app/scripts/check-office.py
python3.14 app/scripts/check-office.py --bundle app/src-tauri/bundled
```

The script tests four checked-in formats in both modes. Fixtures contain Chinese, a formula, an image, a multipage table, visible/hidden sheets, a date, leading zeros, merged cells and a print area. It checks text values, sheet count, source hashes and readable PDFs, then retains converted files and rendered page previews under `server/reports/checks/office-artifacts/`. These are conversion checks, not AI extraction accuracy scores. The DOC/XLS fixtures are LibreOffice conversions of synthetic OOXML and do not represent every Microsoft Office version.

Desktop CI does not install system LibreOffice. It exercises the **packaged** private worker and bundled LibreOffice on macOS, Windows and Linux. See [the evaluation and size report](desktop-office-evaluation.md) for local evidence and remaining manual acceptance boundaries.

## Building and distributing

`app/scripts/bundle_office.py` reads `libreoffice.lock.json`, downloads at build time into `app/.build/office-downloads`, verifies SHA-256 (also on cache hits), and stages the complete runtime in `app/src-tauri/bundled/office`. macOS copies the official DMG application; Windows administratively extracts the official MSI; Linux extracts the official DEBs and retains the full `/opt/libreoffice26.8` runtime. Unsupported architectures fail the build. Current targets are macOS arm64/x86_64 and Windows/Linux x86_64.

The locked download URLs use the official Document Foundation archive host, as linked by the [LibreOffice download page](https://www.libreoffice.org/download/) during its October 2026 download-service outage. The version, filenames and SHA-256 pins remain unchanged.

Linux builds also seed `.uuid` files in the two bundled font directories, deriving distinct, stable identifiers from the archive checksum and relative directory. [Fontconfig 2.13.1](https://github.com/fontconfig/fontconfig/blob/2.13.1/src/fccache.c) otherwise creates these files during the first conversion on Ubuntu 22.04. Seeding them before packaging preserves resource immutability after relocation without changing the fonts. Package checks still compare every resource and report the paths of any additions, removals or content changes.

The office manifest records version, platform, architecture, upstream URL, checksum, source location and executable relative path; the top-level build manifest includes it. Development uses the same staged resources. macOS `files` and Linux DEB `files` copy the office directory intact, retaining framework/directory symlinks that generic resource enumeration would lose. Linux DEB dependencies include the system libraries needed by the bundled runtime, not a system LibreOffice package. macOS release signing covers nested Mach-O files and the LibreOffice app before signing PractiQ; signing/notarization remain explicit release operations requiring credentials.

Keep all upstream license/notice files and the top-level `THIRD-PARTY.txt` source link. LibreOffice is distributed under its [upstream licenses](https://www.libreoffice.org/licenses/); the corresponding source archive directory is recorded in the lock and manifests. Updates require changing the lock, verifying every platform checksum and rerunning package conversion checks. Do not trim components independently of those checks.

A bundled engine stabilizes the conversion version, not document fidelity: installed fonts and legacy Office objects still affect output. In particular, the historical DOC equation limitation in the evaluation report remains unresolved.

The table-ending DOCX text-export regression is now preserved under `app/fixtures/office/regressions/`. Before text conversion, the private worker uses a temporary source snapshot with one empty paragraph after a terminal body table. It inspects XML boundaries only and preserves the original ZIP and source bytes; extraction still belongs to LibreOffice. `make app-fidelity-check` additionally checks this regression and formula/image preservation from the final package. The strict check still fails for the legacy DOC fraction loss; see [the local acceptance record](../../docs/review-implementation-20260929.md).
