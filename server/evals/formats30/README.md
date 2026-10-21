# Frozen six-per-format evaluation matrix

This is the requested **30-case matrix**: six TXT, six DOCX, six PDF, six XLSX,
and six ordered image groups. Run three repetitions for 90 document observations.
The original `../cases.json` and its 30 regression cases remain unchanged.

Sources are synthetic maintenance material. The first five scenario families are
shared across formats: grouped arithmetic, Chinese questions, composite types,
missing answers and grammar fill. TXT/DOCX/PDF/XLSX scenario six is listening
without audio; image-group scenario six is the existing two-column diagram fixture
plus a final non-question page. These are not 30 independent teacher annotations
and do not establish generalization. The image scenario differs, so per-format
averages are not a fully paired model comparison.

`provenance.json` binds every case to the existing regression source and exact
question/answer gold, along with input hashes. All question fields, null answers,
aliases, critical flags and annotations are copied before model runs. XLSX adds
its literal worksheet section to expected groups; group/source route metadata
reflects the new container while question/answer gold stays identical.

Each image group contains **two continuous PNG pages** under `groups/`. The
existing service accepts a single source file: `sources/image/` holds the ordered,
losslessly concatenated PNG actually submitted, with member hashes and exact pixel
regions recorded in provenance. This evaluates image-group composition followed by
normal image import; it does not establish a native multi-file import API. No OCR
or model output is used to generate these images or their labels.

PDFs have a searchable text layer and were rendered for visual inspection. DOCX
and XLSX use standard OOXML, without adding python-docx/openpyxl/UNO or another
service parser. The source lines are preserved exactly in DOCX paragraphs and XLSX
inline-string cells, checked by tests. All small Office inputs go directly through
Tencent, with the normal native-table/figure limitations and quality gates.

Generate only into a new unfrozen copy using `generate.py` and the Codex bundled
artifact Python (ReportLab and Pillow). Its assertions reject overwriting the
frozen manifest, verify input counts and copied gold, and prove image composition
preserves every member pixel. Project evaluation/tests still use Python 3.14+.
The generator records the source manifest and font hashes. Do not regenerate in
place after inspecting evaluation outputs.

From the repository root, with the existing configured service environment:

```sh
PYTHONPATH=server/src:server "$AI_PYTHON" server/scripts/evaluate.py \
  --manifest server/evals/formats30/cases.json --validate-only
PYTHONPATH=server/src:server "$AI_PYTHON" server/scripts/evaluate.py \
  --manifest server/evals/formats30/cases.json --repetitions 3 \
  --output /absolute/new-report.json
```

The second command calls Tencent and the configured model and may incur charges.
Keep an independent absolute storage directory and new report path per campaign.
Thresholds, critical-case rules and artifact validation are unchanged; partial,
unsafe crop, missing answer and unknown-provider outcomes retain their failures.
