# Tencent result fixtures

Keep committed fixtures limited to reproducible regression inputs. One-time
migration callback snapshots are not permanent test dependencies. The large
model-compaction, page-results, OCR-page-results and source-context corpora were
replaced with focused tests for defaults, literal evidence, immutable PRIMARY
identity/material, bounded context links and failure barriers. Their original
data remains available in Git at `012843bf` and in ignored local migration
archives; normal tests never read those archives. Original-corpus verification
and the focused suite both passed before removing the snapshots.

`tencent-xlsx.json` and `tencent-xlsx.xml` retain the existing synthetic native
table regression from `server/tests/fixtures/`, including merged cells, blank
cells, leading zeroes and content outside the print area.

`zip-codecs.json` contains the same small synthetic OCR page and a two-pixel PNG
encoded by Python 3.14's `zipfile` with methods 0, 8, 12, 14 and 93. They are fixed
test inputs; desktop runtime and tests do not require Python or a command-line
archive utility. Decoder dependencies retain their upstream license notices.

`multi-frame.png` and `default-frame.png` are two-frame, two-pixel synthetic APNGs
used to preserve the source extractor's rejection of animation, including a
separate default image.

`image.jpg` is a static two-pixel JPEG; `multi-picture.mpo` contains two such
images and preserves the original source decoder's rejection of MPO containers.

`text-splits.json` fixes 27 byte-for-byte outputs/rejections from the historical
`tencent_inputs.split_text`: UTF-8 boundaries, initial/embedded BOMs, CRLF,
newline preference, malformed encoding and split-part limits. The corpus was
exported once with Python 3.14; TypeScript tests consume only the saved JSON.

`source-chunks.json` fixes 169 historical `graphs.chunking` planning/presence
outcomes, including randomized sources. They cover closed parent trees, density
and character limits, tabular provenance, literal stems and supplied fields,
Unicode offsets/whitespace, partial/reordered spans and malformed answer values.
The corpus is synthetic and generated once; desktop tests do not load Python.

`source-fields.json` fixes 35 historical `ChunkParseResult` outcomes for supplied
field/count/ID gates, literal stems, type labels and closed composite subtrees.
The following corpora cover the separate exercise-title and OCR field gates.

`source-scores.json` fixes 213 historical `UnitParseResult` score decisions around
decimal cents, the original absolute float tolerance and range boundaries.

`source-fidelity.json` fixes 88 historical text-fragment decisions for literal
exercise titles, unique passage suffixes, type-prefix removal, numbered gaps,
ambiguous evidence and Unicode whitespace/case. Inputs include original parsed
question defaults; this corpus isolates text fidelity from the base normalizer.

`ocr-fidelity.json` fixes 144 historical `ChunkParseResult` OCR field decisions:
trusted and flattened titles, matching policy, native worksheet/section groups,
required composite parents, PRIMARY page anchors, exact passage punctuation,
equation prefixes, repeated options, child markers and grammar hints. These are
field-level fixtures; immutable figure association/enrichment and full page graph
assembly still need their own acceptance evidence.

`model-schemas.json` fixes the historical model-facing UnitParseResult, GradeResult
and DocumentCorrections schemas. Tests compare required fields, descriptions and
the restricted model-authored review labels, independently of strict local wire
validation. Required-array order is semantically irrelevant and normalized only
for that comparison; wire schemas remain owned by `shared/ai-contracts.json`.

`model-json.json` fixes 331 historical punctuation-only repair decisions, including
cut-off values/strings, trailing commas, duplicate fields/closers, quoted punctuation,
fences, Unicode whitespace and BOM rejection. Model-argument parsing retains strict
duplicate-key, depth and safe-number checks. HTTP envelopes and saved payloads do
not use this repair path.

The complete historical document and answer-sheet prompts live in
`app/desktop/document-prompts.json`; fixed reference SHA-256 checks accompany the
actual text-structure integration tests. They run without Python.

`merge-chunks.json` fixes 37 outputs captured while running the historical
`test_chunking.py` suite: adjacent proven overlap, ambiguous/conflicting extracts,
independent page results and group/source-index associations. Large node/group
caps are exercised separately without duplicating thousands of fixture records.

`finalize-questions.json` fixes 25 successful results/source conflicts captured
from the composite/English-question suites, including the offending question index.
They cover adjacent compound continuations, shared options, scoring/audio metadata,
missing relatives, cross-tree blanks and remapped provenance.

`source-models.json` fixes 29 source-validation outcomes for Unicode folding,
partial shared-option answers, retained material warnings and whitespace/source
conflicts. The frozen Unicode 16 table in `app/desktop/source-casefold.json` matches
all 1,557 default full mappings in the official Unicode data; its license and
source links are retained under `app/desktop/licenses/`.

`answer-evidence.json` fixes 271 calls captured from the passing 313-test historical
answer-evidence/index suites. Question-scoped proofs retain supplied answers and
analysis independently, including answer-only context, printed numbering, typed
tables, item labels and complete word-bank/cloze material. Guesses, ambiguous
matches and neighboring ordinary questions cannot supply missing evidence.
`answer-evidence-edges.json` adds 162 Python-reference scalar/JSON type cases;
`source-numbers.json` fixes scalar string spellings, including integral floats,
large integers, negative zero and scientific notation. The source-only JSON reader
preserves token types for proofs; model and wire JSON remain strict. A separate
ignored differential run checked 2,500 Unicode/layout variants and 20,012 numeric
spellings without mismatches. Neither desktop runtime nor these tests call Python.

`source-evidence.json` fixes 151 calls captured from the passing 126-test historical
source-evidence/scope/duplicates/validation suites: 65 complete source/model tree
bijections, 70 exact-copy decisions, 15 original-source repeat decisions and one
explicit removal with source/group/visual/quality remapping. Nonfinite JSON and
large association-index regressions are checked separately without serializing
nonfinite values to null or flattening observation fixtures. The proof separates
identity slots from literal source text and retains unknown/incomplete trees.

`app/desktop/source-digits.json` freezes the reference Unicode 16 `str.isdigit`
characters outside the decimal-digit category, used only to reject decimal-looking
source numbering. It shares the retained Unicode data license.

`text-assembly.json` fixes 293 final text merge/quality/processing outputs. Eleven
were captured from the passing 52-test historical duplicate/parse-review/source-scope
run (24 database-backed cases were excluded from that capture); another 271 compose
the existing answer-proof inputs through the original passive `_merge`, with eight
confidence rounding and three historical-review warning cases. These include
section-only units, composite continuations, explicit deduplication, source-answer
removal, exact warning order, review counts, provenance and partial-result details.
Fixture generation used only in-memory files and the read-only reference path;
desktop tests and runtime consume the saved data without Python.
