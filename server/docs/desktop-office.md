# Office import in the independent AI service

Office import runs in the independent service and its Web frontend. The desktop app ships no Python or LibreOffice runtime and accepts downloaded question-bank ZIP files for offline practice. This guide retains its historical filename so existing links remain valid.

## Deployment

PDF, TXT, CSV and PNG/JPEG work without Office software. For Word (`.doc`/`.docx`) and Excel (`.xls`/`.xlsx`), deploy LibreOffice on the service host and configure both environment variables:

```dotenv
AI_OFFICE_EXECUTABLE=/absolute/path/to/soffice
AI_OFFICE_VERSION=LibreOffice <exact deployed version and build identity>
```

Use the exact output of the selected executable's `--version`, rather than the placeholder above. The executable path must be absolute and point to the trusted deployed program. Missing or mismatched configuration prevents Office processing. Neither HTTP inputs nor desktop settings can choose an executable or command arguments. The authenticated `GET /api/import-capabilities` describes supported formats, modes, upload limits and model availability. A deployment without Office configuration does not advertise Office support.

Use a fixed deployment image/version and retain upstream licenses, source links and artifact checksums. Engine changes require fresh fidelity checks and affect checkpoint compatibility. The [LibreOffice license page](https://www.libreoffice.org/licenses/) describes its upstream licensing; a successful dependency audit does not replace deployment license review.

## Modes and source identity

Choose the mode before explicitly starting import:

- **PDF** is the default and uses document printing layout.
- **Text** exports Word as UTF-8 TXT and Excel as ordered CSV sheets, including hidden sheets. Empty sheets remain represented in the normalization manifest and are not fabricated into questions. Sheet outputs use the converter's stable filename order; original workbook tab order is not guaranteed.

Printing areas may omit cells or sheets. Text export loses images, layout and native formula structure; CSV contains displayed values rather than formula expressions. Source formatting and deployment fonts affect rendering. Inspect output before relying on it; successful conversion is not proof of fidelity or AI accuracy. Conversion never silently switches modes.

One task retains the original uploaded Office reference, filename and SHA-256. Normalized outputs have an ordered, checksum-verified manifest bound to the original source, mode and exact engine identity. They feed the existing TXT/CSV/PDF extractors inside the shared parser graph's prepare stage. Excel sheets share one task's limits, deadline, usage and model budget. No Office parser graph, `python-docx`, `openpyxl` or UNO bridge is introduced.

## Isolation and recovery

Each operation uses temporary source/output directories and a separate hardened LibreOffice profile. Macros, trusted macro locations, external-link updates and Writer field/chart updates are disabled. Conversion children are terminated and reaped on timeout, cancellation or worker exit; existing Office sessions use separate profiles. Outputs must be regular bounded files within the operation directory and match the manifest's type, size and hash. The original source remains unchanged.

The private standard-library Office worker keeps its legacy DOC-to-temporary-DOCX PDF path and table-ending DOCX text regression repair. The intermediate DOCX is never a public artifact or replacement source. The same timeout and validation boundaries cover both DOC stages. These are conversion compatibility fixes, not another source parser.

Resume verifies retained original and derived bytes, ordering, mode and execution identity before model work. An incompatible signature fails rather than silently mixing engines or recomputing a checkpoint. Parse again is explicit new work from the retained original source and mode. Reads, capability checks and ZIP downloads make no model calls.

## Verification

Use an existing Python 3.14+ interpreter, without a project virtual environment. Focused worker and service tests use temporary data and model substitutes:

```sh
cd server
PYTHONPATH=src python3.14 -m pytest tests/test_office.py tests/test_office_service.py tests/test_service_import_contracts.py
```

Run `make verify AI_PYTHON=/path/to/python3.14` from the repository root for the complete service gate. Verify the actual deployed engine separately with the unchanged [Office fixtures](../../app/fixtures/office/README.md), original/derived hashes, mode and engine version. Keep first failures and use fresh report paths; do not rewrite fixtures or expected equations to obtain a passing result.

The [historical evaluation](desktop-office-evaluation.md) and [import quality worksheet](../../docs/import-quality-acceptance.md) describe their original candidates. They are not acceptance of this independent deployment. Real-model quality, deployment fidelity and practice-only desktop packages require separate evidence.
