# Import quality acceptance worksheet

Tracks [#90](https://github.com/shenyankm/PractiQ/issues/90). Prepared on 2026-10-04 against main commit `2e9215f59920a7e2f7d9bf9b64ff61b6d1f6ccd7`, with the offline DOC repair described below. Select a new clean candidate after the pending repairs merge. Real-model calls were explicitly declined for this work. Live extraction, independent annotation and native round-trip acceptance remain pending; this document does not close the issue.

## Corpus and provenance

Use the existing synthetic [ten-format corpus](../app/fixtures/ai-import/README.md) and [expected content](../app/fixtures/ai-import/formats-expected.json). Its 25 structured rows comprise six material parents and 19 answerable rows across 16 product types. Record count is not recall: match each source question, including legitimate duplicates, to an output item before counting omissions or extras. TXT/CSV references do not authorize local-image reads. Source figures in Office are embedded raster content, not proof of native equation fidelity.

The snapshot file hashes below were verified against the checked-in bytes. Existing labels are maintenance fixtures; no independent teacher/source review is claimed. Before live acceptance, a reviewer must record consent/license provenance, reviewer identity or approved pseudonym, review date, per-source question mapping and discrepancies. Do not change expected labels to agree with model output.

| Source | SHA-256 |
| --- | --- |
| `all-types-scanned.pdf` | `c43131387eb3ef9bad8078c5b24f8ebf95ed2962d8deb4a6728adf40d69c5059` |
| `all-types.csv` | `24d1adc6707b576dd40530c8562a550dc8cae5ae2f7170d33aebba31ce1e35d5` |
| `all-types.doc` | `7ffa3dc99d73125d706e4b19679816774d9033a668a4ee6526246bb6007e87b0` |
| `all-types.docx` | `1100f11e173716d116ec140645f6bc9958738725875898461f1e18c933799fd5` |
| `all-types.jpg` | `0b4289ab911e2457ef07029627595d6214c1c82d3ff6a26aa30a2b75be6537a0` |
| `all-types.pdf` | `15f8a86a4399d9b5f53af0552f1c534f0d2d4bd5a23c4b35b70490a5871afae8` |
| `all-types.png` | `8d680f5c66490b066147d9b8c074caabeaad976e537bdfed197de50eef2fad13` |
| `all-types.txt` | `8c7a08b79de0e40c560a1d98048dc8e203a49f932edd2787cbfbac564d65e3e5` |
| `all-types.xls` | `3ceab6db85bc2ded17cfb94393764f8bab036f4688680d1105ad71c593759d14` |
| `all-types.xlsx` | `2607d65f5e7e2d2e214b4c146e4b5226b401686eed001f1577ac00c419945f02` |

## Declare acceptance before running

For every format, report omitted, extra and duplicate questions separately. Compare supplied answers, explicit nulls, scores, rubrics, parent-child links, source pages, formula structure, table rows/cells and image/material-versus-answer roles. Keep execution status, content fidelity and cost as separate columns. The historical 0/10 complete acceptances remain historical failures; PARTIAL or an exportable result does not satisfy complete recognition.

Use the existing [scorer and quality gates](../server/docs/evaluation.md#scoring-and-gates), without lowering thresholds. All critical annotated fields and structures must pass. For the ten-format manual corpus, require every source-mapped question and supplied field to survive, no fabricated absent answer, no unintended duplicate and complete associated figures. Explicit failures block complete-recognition acceptance. Preserve current supported partial-result behavior and link follow-up defects.

| Coverage | Source checks before running | Acceptance evidence still required |
| --- | --- | --- |
| PDF / scanned PDF / PNG / JPEG | Four pages, original figure/crop bounds, supplied answer roles | Source-to-output mappings, omission/extra/duplicate and image checks |
| TXT / CSV | Original wording, quoted multiline fields, no implicit local-image access | Supplied answers/nulls, composite links and source associations |
| DOC / DOCX / XLS / XLSX | Independently deployed Office; original/derived hashes, ordered manifest, mode and exact engine version | Converted content fidelity plus separate model result; hidden-sheet text checks use Office fixtures |
| All formats | Provided scores/rubrics, missing listening audio, unanswered writing tasks | Review, ZIP export/reimport and offline practice preserve nulls, warnings and available content |

## Offline preparation commands

Run from repository root with an existing Python 3.14+ interpreter, without a project virtual environment:

```sh
AI_PYTHON=/absolute/path/to/python3.14
"$AI_PYTHON" server/scripts/evaluate.py --validate-only
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_import_corpus.py tests/test_evaluation.py)
"$AI_PYTHON" app/scripts/check-fixtures.py
```

These checks inspect fixture integrity and scorer behavior with substitutes; they do not call a provider. For Office fidelity use the independent [service Office guide](../server/docs/desktop-office.md); for desktop package checks follow the [release policy](releases.md); choose fresh report paths and retain failures.

## Offline DOC equation repair

The unchanged [Office regression DOC](../app/fixtures/office/README.md) loses its fraction's numerator and denominator during direct PDF export with bundled LibreOffice 26.8.0.3. Visual review confirms the loss; it is not just a PDF text-order mismatch. The source still contains the equation: the same engine's DOCX export retains its numerator and denominator. Regenerating DOC from the committed DOCX reproduces the exact committed DOC hash.

The private worker now converts only legacy DOC/PDF inputs through a temporary DOCX, then exports the PDF with the same pinned engine. Both stages share the original timeout, use fresh hardened profiles and retain output size, regular-file and package checks. The intermediate DOCX is never an artifact. Original input bytes, metadata and native source associations remain unchanged; DOC text, DOCX and Excel conversion keep their existing paths.

The local source-worker check first failed on the old path, then passed the unchanged fraction/image gate after this repair. The resulting PDF also retained all 70 table rows, 70 supplied answers, the final paragraph and three pages. These runs used the existing bundled macOS engine without model calls. They establish this fixture's source-worker behavior, not arbitrary Office fidelity, rebuilt-package acceptance or live recognition. This is historical desktop-worker evidence. The current architecture runs normalization in the independent service and ships no Office engine in the app. Retain fresh strict fidelity/conversion reports for the selected service deployment and separate practice-only desktop package reports before acceptance; keep the original failed report.

## Live run and completion record

Do not run a provider until model/provider, authorized public corpus and a cost ceiling are explicitly agreed. Reuse the [evaluation runner](../server/docs/evaluation.md), freeze source SHA, corpus/manifest hashes, scorer version, settings/prompt hashes and model identity. Record run date, repetitions, retries, latency, known tokens and unknown calls. The ten-format combined corpus requires source-aligned manual review in addition to the existing individual-case runner; do not insert guessed gold structures to manufacture a passing manifest.

For each discrepancy record source location, expected supplied content, actual output, repeat/run identity, severity and linked regression/fix. Verify Web import/review/export and native ZIP import/offline practice on the same declared service and desktop candidates. A final sanitized report must include per-format attempted/passed/failed/not-run counts, independent source-review provenance, retained failing artifacts and remaining blockers. No current live result or clean-machine acceptance is recorded here.
