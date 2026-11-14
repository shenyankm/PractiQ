# Tencent regression inputs

Keep only small, reproducible inputs needed by permanent tests. One-time migration
callback snapshots and randomized comparison matrices are excluded from the PR.
Their original data remains in Git at `012843bf` and in ignored local migration
archives. Normal tests and packaged-app smoke checks do not read those archives
or invoke Python.

The desktop tests directly assert source identity, literal answer/analysis proof,
closed composite trees, source overlap, immutable figures, answer-bearing tables,
OCR fidelity, partial results, recovery and explicit deduplication. They construct
small inputs beside the behavior being checked instead of storing complete
normalized callbacks with repeated defaults. The five historical model schema
baselines use SHA-256 assertions in `model.test.ts`; the actual wire/model schema
sources remain in `shared/ai-contracts.json`.

The retained fixtures each exercise an external encoding or a specific boundary:

- `tencent-xlsx.json` and `.xml`: synthetic native worksheet cells, merged/blank
  cells, leading zeroes and content outside the print area.
- `zip-codecs.json`: the same tiny OCR page and two-pixel PNG encoded with ZIP
  methods 0, 8, 12, 14 and 93. These fixed bytes test the actual decoders.
- `image.jpg`, `multi-frame.png`, `default-frame.png`, `multi-picture.mpo`:
  tiny raster inputs for image format and animation/container rejection.
- `text-splits.json`: 27 UTF-8/BOM/CRLF/malformed-encoding/split-limit vectors.
- `source-scores.json`: scalar decimal-cent and float-tolerance boundary vectors.
- `source-numbers.json`: literal integer/float spelling, negative zero, unsafe
  integers and scientific-notation vectors for the source-only JSON reader.
- `ocr-associations.json`: small fixed figure-ownership and validation vectors.
- `ocr-evidence.json`: Tencent text/XML evidence ordering and table extraction.
- `vision-crops.json`: 35 deterministic raster calibration inputs for RGB/alpha
  thresholds, edge contact, faint marks and invalid bounds. Randomized migration
  samples are excluded; `visual-crops.test.ts` also uses the fixed edge image to
  verify source retention and crop limits.

The full extraction prompts, Unicode case folding and digit tables are runtime
resources under `app/desktop/`, with their original licenses and source links.
They are required application behavior, rather than migration test output.
