# Rich-content acceptance corpus

Synthetic, locally authored documents; this is a bounded regression corpus, not
an overall production recognition-accuracy benchmark. `expected.json` is the
hand-authored import expectation, not model output. The source PDF stays frozen.

- `source.pdf`: matrix/inverse, integral/series, piecewise function, four-column
  table with Chinese, literal pipes, signed numbers and inline math, plus a chart.
- `visual-regions.json`: visually reviewed normalized regions tied to the PDF
  SHA-256. Regenerating the PDF requires reviewing the regions again.
- `merged-cross-page.pdf`: two pages with merged headers and a continuing table;
  the question starts on page 1 and its supplied answer is on page 2.

## Implementation

The vision model returns simple tables as rectangular `tableRows`; the service
escapes pipes and constructs Markdown instead of trusting model-authored table
separators. Its extracted cells are retained in question content blocks and
source transcription. Irregular rows preserve text and require review instead
of inventing cells. Empty media placeholders and continuation-only pages are
normalized only at the model boundary; public JSON import contracts stay strict.

Figures carry validated page-local question indexes, remapped after page merging.
Crops include a 4% page margin bounded to the page edges. Every figure retains a
`sourceRef` for the original rendered page; even a failed page in a partial result
keeps an original-page fallback and marks neighboring questions for review.
This margin does not guarantee semantic completeness on arbitrary documents.

The desktop imports both references through the same checksum/path validation,
deduplicates shared page files, and includes them in backups. “查看原页” loads the
image only on demand. Unsubmitted exams remove original-page references from the
returned snapshot and hide the control because pages can contain printed answers.
Exact duplicate table transcriptions are not displayed twice.

The earlier KaTeX mismatch is fixed: CSS and rehype both use 0.16.47; a regression
check verifies version equality and actual fraction font scaling in the browser.

## Reproduce

- `make app-check AI_PYTHON=/path/to/python3.14`: shared contracts, frontend,
  database/reopen/practice/backup equality, original-page import and exam hiding,
  existing Rust tests and Clippy.
- `make verify AI_PYTHON=/path/to/python3.14`: service checks including PDF pixels,
  coordinate mapping, failed-page originals, question-index remapping, irregular
  tables, and rejection of deliberately corrupted fidelity examples.
- From `app`, start `npm run dev`; then
  `node scripts/check-rich-content.mjs /path/to/playwright/index.mjs` uses installed
  Chrome to check 960/1280px layout, fraction sizing, image decoding, zoom and focus.
  It saves a screenshot under `app/reports/rich-content/`.
- Explicit live calls (read `.env`, use temporary isolated local storage):
  `python3.14 app/scripts/check-rich-recognition.py`
  and `python3.14 app/scripts/check-rich-recognition.py --merged`.
  Normal CI never calls real models. `--check-report` rechecks the saved simple
  result offline. The live script retains outputs/resources and exits nonzero on
  a failed gate. The merged gate accepts safe PARTIAL/review outcomes, not a claim
  that every page was structurally recognized.
- Rebuilding the simple source intentionally: append `--generate-pdf` to the
  browser check, inspect the PDF and re-review its region hash/bounds.

## Acceptance on 2026-09-20

The original failures are retained in `app/reports/rich-content/before-fix/`.
Intermediate failed attempts also remain, including the malformed Markdown pipe
and stalled continuation-page responses. Successful outputs do not erase them.

The simple document passed three consecutive live runs. The strengthened gate
compares every header/data cell against the fixed expected table, checks key
formula structure and literal table text, and requires >=95% coverage of both
reviewed regions. Results: `app/reports/rich-content/final-run-{1,2,3}/`.
Reports retain source and implementation hashes. These checks are literal fixture
checks, not general symbolic equivalence or a perceptual sharpness metric.

The merged/continuation fixture passes the fallback checks: one question, both
periods' cell text, the next-page supplied answer, review required, and complete
original images for both pages. Its processing status remains PARTIAL: independent
recognition of the continuation page can stall. This is safe degradation, not
full merged-table reconstruction. See `app/reports/rich-content/merged/`.

Real macOS Tauri WebView acceptance also completed in a separate
`com.practiq.rich-acceptance` data directory: imported the real-model JSON and
three verified image files, inspected formulas and all table cells, opened the
full original page, and verified Escape restores focus to its trigger. The
production user's question bank and model settings were not used.

Final automated checks after rebasing onto the latest main passed: `make verify`
(448 tests, 94% coverage, Ruff,
Pyright, evaluation fixtures, recovery probes and package build), `make app-check`
(40 frontend tests, 25 Rust tests; one Keychain test ignored, contracts and Clippy),
Rust formatting, the macOS app/DMG build and packaged-service check. The Chrome
layout/interaction check also passed before the test-only upstream rebase.
