# Desktop Office conversion

The desktop imports `.doc`, `.docx`, `.xls` and `.xlsx` using a local LibreOffice installation. The standalone service still accepts only PDF, TXT, CSV and PNG/JPEG. No Office parser, upload type, Python UNO bridge, `python-docx` or `openpyxl` was added.

## Using it

Install Writer and Calc from the [official LibreOffice download page](https://www.libreoffice.org/download/download-libreoffice/). On Import, use **Check LibreOffice**, **Select executable** or **Restore automatic discovery**. Discovery checks standard installation locations, PATH and Windows registry entries. Selecting a macOS `.app` resolves its `Contents/MacOS/soffice`; Windows uses the console `soffice.com` next to `soffice.exe`. Detection tests all four export capabilities with temporary documents and shows the executable, version and available capabilities. Missing Writer/Calc is reported separately.

| Input | Default | Text mode |
| --- | --- | --- |
| DOC / DOCX | PDF for the existing visual parser | UTF-8 TXT |
| XLS / XLSX | PDF for the existing visual parser | One UTF-8 CSV per sheet, including hidden sheets |

**Convert / extract files** works without model settings. It opens native input and save dialogs. Multiple CSVs are saved in a new `PractiQ-<UUID>` directory inside the chosen folder; existing source files cannot be overwritten. This operation starts neither the HTTP service nor model calls.

For AI import, choose the mode, select source files, then review the converted filenames in the native confirmation dialog. Only confirmation permits uploads and model work. Excel text mode creates one task per nonempty sheet, named after the source file and sheet. Empty sheets are exported locally but explicitly marked as skipped for AI; wholly empty extraction creates no tasks. Conversion never silently switches modes.

PDF uses the document's printing layout; print areas can omit cells or sheets. Text mode loses images, formulas and layout. CSV contains displayed cell values rather than formula expressions; dates and numeric display depend on the source formatting and LibreOffice locale. The mode warning explicitly includes hidden sheets. Fonts and compatibility with the installed Office version affect rendering: review output before relying on it.

## Local boundaries and recovery

- Rust owns file authorization, bounded source snapshots, output validation and atomic saves. Frontend requests cannot contain paths, executables or command arguments. The private Python `office` command uses the standard library to invoke a detected installation.
- Each conversion uses separate temporary input/output and LibreOffice profile directories. Macro execution, trusted macro locations, external-link updates and Writer field/chart updates are disabled in that profile. Parent-exit monitoring and Windows Job Objects clean up only the operation's processes; existing LibreOffice sessions use different profiles.
- External Office processes use system library search paths instead of the frozen Python bundle's libraries, following [PyInstaller's external-program guidance](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#launching-external-programs-from-the-frozen-application). The private worker restores its own Windows DLL search path after spawning; macOS uses the native font renderer.
- Conversions are serial. Each source/output is limited to 25 MiB; there are at most 100 outputs totaling 100 MiB. Conversion timeout is 180 seconds. PDF validation also enforces the desktop's 100-page limit. Outputs must be regular files of the expected type, valid PDF/UTF-8 text/CSV, within the authorized directory, and match the worker's size/hash manifest. Zero exit without valid output is failure.
- A selected executable is stored in SQLite and revalidated when used. Backup export removes it; restoration clears it even from a modified backup. The next use performs fresh discovery. Study backups continue to exclude AI task state and credentials.
- AI operation receipts record original filename/SHA-256, mode, LibreOffice version, artifact SHA-256 and task association. Duplicate Office imports use original hash plus mode. Sheet task requests are persisted before task submission; accepted receipts and remaining pending requests survive a later failure. Explicit recovery reuses request IDs, avoiding automatic duplicate model calls.
- Retry and reparse use retained uploaded PDF/TXT/CSV artifacts, subject to service retention. They need neither LibreOffice nor the original source. Historical removed `docx_parser` tasks remain readable but cannot resume; convert the original file for a new supported-format task.

The filters use LibreOffice's [conversion filter names](https://help.libreoffice.org/latest/en-US/text/shared/guide/convertfilters.html) and [CSV parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/csv_params.html): CSV token 9 enables displayed values, token 10 disables formula expressions, and token 12 is `-1` for all sheets.

## Reproducing conversion checks

Use the project's selected Python 3.14+ interpreter and an installed LibreOffice. No model credentials or external model calls are needed.

```sh
python3.14 app/scripts/check-office.py
python3.14 app/scripts/check-office.py --engine /path/to/soffice
python3.14 app/scripts/check-office.py --bundle app/src-tauri/bundled
```

The script tests four checked-in formats in both modes. Fixtures contain Chinese, a formula, an image, a multipage table, visible/hidden sheets, a date, leading zeros, merged cells and a print area. It checks text values, sheet count, source hashes and readable PDFs, then retains converted files and rendered page previews under `server/reports/checks/office-artifacts/`. These are conversion checks, not AI extraction accuracy scores. The DOC/XLS fixtures are LibreOffice conversions of synthetic OOXML and do not represent every Microsoft Office version.

Desktop CI installs LibreOffice only on test runners and exercises the **packaged** private worker on macOS, Windows and Linux. Product packages exclude LibreOffice. See [the evaluation and size report](desktop-office-evaluation.md) for local evidence and remaining manual acceptance boundaries.
