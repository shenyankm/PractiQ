# Import quality acceptance worksheet

Tracks [#90](https://github.com/shenyankm/PractiQ/issues/90). The original worksheet records main `2e9215f59920a7e2f7d9bf9b64ff61b6d1f6ccd7` and the historical DOC repair below. Fresh independent-service engineering checks on 2026-10-04 used `b10ad6c696e5594cc961d89e31e038673c44b85a`; their scope is recorded separately below. Real-model calls were explicitly declined for this work. Live extraction, independent annotation and actual host Office deployment remain pending; the fresh Android round-trip below is engineering evidence with fake model output, and this document does not close the issue.

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
(cd server && PYTHONPATH=src "$AI_PYTHON" scripts/evaluate.py --validate-only)
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_import_corpus.py tests/test_evaluation.py)
"$AI_PYTHON" app/scripts/check-fixtures.py
(cd server && PYTHONPATH=src "$AI_PYTHON" -m pytest tests/test_web_import.py tests/test_bank_export.py)
make web-install
(cd web && ./node_modules/.bin/playwright install chromium --only-shell)
make web-check
```

These checks inspect fixtures, scorer behavior, API/export contracts and the Web frontend with substitutes; they do not call a provider. The manifest and pytest commands run from `server/` because their fixture paths are relative to that directory. They reproduce repository regression gates, not the separate actual HTTP experiment below. For Office fidelity use the independent [service Office guide](../server/docs/desktop-office.md) and its [no-task conversion command](../app/fixtures/office/README.md); for app packages follow the [release policy](releases.md). Use fresh report paths and retain first failures.

## Offline DOC equation repair

The unchanged [Office regression DOC](../app/fixtures/office/README.md) loses its fraction's numerator and denominator during direct PDF export with bundled LibreOffice 26.8.0.3. Visual review confirms the loss; it is not just a PDF text-order mismatch. The source still contains the equation: the same engine's DOCX export retains its numerator and denominator. Regenerating DOC from the committed DOCX reproduces the exact committed DOC hash.

The private worker now converts only legacy DOC/PDF inputs through a temporary DOCX, then exports the PDF with the same pinned engine. Both stages share the original timeout, use fresh hardened profiles and retain output size, regular-file and package checks. The intermediate DOCX is never an artifact. Original input bytes, metadata and native source associations remain unchanged; DOC text, DOCX and Excel conversion keep their existing paths.

The local source-worker check first failed on the old path, then passed the unchanged fraction/image gate after this repair. The resulting PDF also retained all 70 table rows, 70 supplied answers, the final paragraph and three pages. These runs used the existing bundled macOS engine without model calls. They establish this fixture's source-worker behavior, not arbitrary Office fidelity, rebuilt-package acceptance or live recognition. This is historical desktop-worker evidence. The current architecture runs normalization in the independent service and ships no Office engine in the app. Retain fresh strict fidelity/conversion reports for the selected service deployment and separate practice-only desktop package reports before acceptance; keep the original failed report.

## Current engineering checks without a real model

The 2026-10-04 checks used the independent service at `b10ad6c696e5594cc961d89e31e038673c44b85a`, temporary storage and synthetic inputs. They do not replace the historical 0/10 complete-recognition failures or change live quality denominators.

| Layer | Observed result | Acceptance boundary |
| --- | --- | --- |
| Actual Office adapter | Ten PDF/text conversions produced twelve verified artifacts; Word fraction/icon/table and Excel print-area/visible/hidden-sheet observations are recorded in the [Office fixture evidence](../app/fixtures/office/README.md#retained-service-probe) | Temporary pinned engine only; TXT/CSV losses remain declared; no full fidelity or actual host deployment acceptance |
| Actual Web → HTTP → SQLite → ZIP | Passive file selection, explicit Start import, authenticated upload, RUNNING/COMPLETED progress, persistent run/checkpoint/Store and verified ZIP export worked with two shared fake-model calls; an unauthenticated request returned 401 | Engineering contract evidence, with zero real model calls; no extraction-quality, teacher or user-trial acceptance |
| Android native ZIP import/practice | Passed for this fresh ZIP on the actual `8cdc570` ARM debug APK: native SAF append, image display, supplied B auto-correct and submitted null-answer ungraded; full backup readback preserves both new images and existing data | Owned API 35 emulator/WebView 124 only; synthetic contract evidence, not real recognition, physical-device, minimum-version, signed-release or user-trial acceptance |

The Office engine was a read-only mount of the checksum-verified official macOS arm64 archive, with exact identity `LibreOffice 26.8.0.3 bce0998afefdbc355585ca324285661a2170ba77`. Only the probe's child configuration changed; both persistent host Office settings remained unconfigured. Its own mount was detached and other Office processes were unaffected. The retained Office review has SHA-256 `82f7269865dff6c0a1bc727ae28d10b8b4767bb5096725b2aa9afcb4289bf711`.

The HTTP experiment used a separate original synthetic PNG, not the ten-format corpus or its gold results. It downloaded a 32,034-byte question-bank ZIP with SHA-256 `cefd64ade3bfc5041431f69cbb7454440c12f4ecd753d9c1e1f277497023e19f`: two questions, one supplied reference answer, one explicit null answer and two review flags. Its verified source PNG is `fe8d301750a599861f7df002f9d5d34376d4d2b1263d0ea3135428fc11f4cae0`; the associated JPEG crop is `c47bde73f6070f8c475c89ee5a5630aed406867b90fb2609b0241e27c69d006d`. Provider settings and `.env` were not loaded; the browser token remained out of local/session storage and cleared on reload. The retained execution review has SHA-256 `e7a0d98b9c7846980f280464ad95a57c2581cf94fd8b6903a285bc18e7b49463`.

The actual Android source was `8cdc570e17657250a6a4e82f1049e359e3104e80`; the installed arm64 APK matched SHA-256 `f3c38bde99c7c53967581a7919ea5046295c4582e75d44c58d42acc40292183c`. On the owned API 35 emulator with WebView `124.0.6367.219`, the system file picker appended the exact exported ZIP above. Both questions retained review flags, B/null reference answers, null grading evidence and two source associations. Offline practice rendered the image, auto-graded selected B correctly, and left submitted A for the answerless question ungraded and excluded from accuracy. The service was stopped and the app connection unconfigured. A full native backup exported through the system picker has SHA-256 `79782570ec6fc949e691c85ca185735607bb7372b88650285c435f5304d9e751`: schema 11/v4, integrity OK, no foreign-key violations, all four resources matching their actual bytes, two new submitted attempts with preserved source snapshots, and original 26 questions/20 attempts preserved. The native database contains no AI imports or grading requests; the practice steps ran with the service stopped. This is a same-artifact Web/export/native practice engineering round-trip with model substitutes.

To repeat that HTTP layer, identify the selected service/Web source, use fresh temporary SQLite and artifact storage, inject the existing shared `FakeModel` before service startup, and allow only the selected loopback origin for the authenticated browser/API flow. Verify persisted state and rehash the downloaded ZIP and every packaged resource after stopping only the owned service. The archived experiment used a separate temporary harness; passing the repository Web/API tests above does not establish that socket-level flow. Its Python processes denied outbound IP/DNS attempts and its page requested no external origin; no OS-wide browser/native-child network attestation is claimed.

Keep both temporary-helper first failures: Office inspection initially used the invalid `utf8-sig` alias, then reread the same frozen outputs after correcting only that helper to `utf-8-sig`; no converter failure or reconversion occurred. The HTTP browser helper initially failed dynamic CommonJS named-export access before browser/API/model work, then used direct Playwright imports. Neither failure is presented as a product defect or erased by the corrected run. The owned HTTP service stopped before final verification; repository bytes and persistent configuration stayed unchanged.

## Live run and completion record

Do not run a provider until model/provider, authorized public corpus and a cost ceiling are explicitly agreed. Reuse the [evaluation runner](../server/docs/evaluation.md), freeze source SHA, corpus/manifest hashes, scorer version, settings/prompt hashes and model identity. Record run date, repetitions, retries, latency, known tokens and unknown calls. The ten-format combined corpus requires source-aligned manual review in addition to the existing individual-case runner; do not insert guessed gold structures to manufacture a passing manifest.

For each discrepancy record source location, expected supplied content, actual output, repeat/run identity, severity and linked regression/fix. Verify Web import/review/export and native ZIP import/offline practice on the same declared service and practice-app candidates. A final sanitized report must include per-format attempted/passed/failed/not-run counts, independent source-review provenance, retained failing artifacts and remaining blockers. No current live result or clean-machine acceptance is recorded here.
