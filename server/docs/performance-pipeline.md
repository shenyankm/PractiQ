# Document pipeline performance boundaries

This change addresses recommendations **2, 9, 15 and 16** from the performance
review of `5b673a6e`. It changes document preparation and Tencent result handling,
not upload APIs, schemas, model prompts, or explicit-action requirements.

## Work avoided

- **2 — Reuse fixed Tencent subimages.** PRIMARY figure previews crop only figures
  without an `imageRef`. All-subimage pages do not read the full-page artifact.
  Mixed pages retain figure order, `elementIndex`, coordinates, original subimage
  bytes and media types. Final diagram cropping and cut-boundary checks are unchanged.
- **9 — Reuse the validated ZIP.** One ZIP is opened per result bundle. The existing
  whole-archive path, duplicate-member, entry-count and expanded-size checks run
  before image reads. XML associations reuse that validated member-name set.
  Images are read, validated and persisted sequentially, not expanded as a batch.
  CRC, actual-format, size and pixel checks remain in force. Invalid ZIP headers,
  unsupported extraction versions and malformed filename encodings retain the
  structured `TENCENT_RESULT_INVALID` error. Opening, decoding and
  image reads use the cancellation-draining thread helper: neither the ZIP nor the
  preparation lease closes before a running worker finishes, even after repeated
  cancellation.
- **15 — Shorten rendered-buffer lifetime.** After all split and visual-byte
  preflight passes, final `page` artifacts are persisted before the first paid job.
  Preparation then drops extracted-document objects, original/split image lists,
  last-iteration split buffers and non-text source bytes. Subsequent preparation
  retains page references, source-page references and ordered input receipts, not
  rendered images. Source hashes, pixel bounds, original-page associations and
  deterministic artifact naming are unchanged. Text bytes remain available for
  exact source-evidence comparison. A failed page write prevents paid submission.
- **16 — Overlap bounded Tencent waits.** A worker pool invokes `parse_job` for
  preflighted parts. Its size is bounded by the current existing Tencent concurrency
  setting at pool creation; every job still uses the service-wide admission gate.
  Decreasing that setting is respected by admission; increasing it does not expand
  an already-created pool. Each part keeps its existing indexed durable intent,
  task ID and result reference. Only small receipts accumulate concurrently.
  Once jobs settle, bundles are verified and decoded one at a time in source order,
  with the existing cumulative page, character and subimage-byte limits.

## Paid work and recovery risks

Concurrency intentionally changes **when charges can occur**. Later parts can be
submitted before an earlier result is known to be valid. A document-level decode
or resource-limit failure can therefore occur after more parts have incurred
charges than with serial processing. No result bundles are decoded concurrently.

On the first observed worker error, queued work stops and unfinished workers are
cancelled and drained before returning. Already-sent provider work cannot be
recalled: cancellation can leave several confirmed tasks or unknown submissions.
Durable per-part `SUBMITTING` records still precede sending; an unacknowledged
submission is never replayed automatically. A known task resumes by polling; a
stored result is checksum-verified and reused without another submission. On an
explicit resume, another worker can advance a previously queued part before a
different worker discovers an existing unknown receipt. That unknown part itself
is never resubmitted. Inspect unknown provider outcomes before explicitly parsing
again; a new parse can incur new charges.

Writing pages earlier can leave additional content-addressed artifacts after a
failed run. It does not overwrite source data, authorize model work, or change
cleanup/recovery ownership. Existing temporary-budget and worker-draining
boundaries remain intact.

## Deterministic evidence (substitutes only)

These are work-count and object-lifetime assertions, **not measured speedups or
RSS improvements**. Tests use in-memory storage and fake provider/model calls;
there are no real Tencent or model requests.

| Scenario | Previously implied work | Regression assertion |
| --- | --- | --- |
| Three PRIMARY figures, all have subimages | Three discarded crops plus a page read | Zero crop calls and zero page reads; same ordered image messages |
| Three figures, two have subimages | Three crops, two discarded | One crop with only the missing bbox; exact ordered image bytes and identities |
| Thirty images in a 32-member ZIP | 31 ZIP opens and 30 `namelist()` calls | One ZIP open, zero `namelist()` calls, 30 ordered image reads and identical image hashes |
| Four split jobs, admission limit two | One provider wait at a time | Two admitted overlapping waits; controlled completion `[1, 2, 3, 0]`, output pages/receipts `[0, 1, 2, 3]` |
| Replay of those four completed jobs | Existing receipts should prevent work | Four original submits/queries; zero additional provider requests on replay |
| Split/unsplit image at paid submission | Rendered lists and source bytes remain in preparation | No nonempty bytes in preparation's container locals; extracted-document and original-image-list weak references are dead; all page artifacts already exist |
| Repeated cancellation while opening/decoding/reading ZIP | Cleanup must await threads | ZIP remains open and preparation budget stays held until worker finishes; then both release |
| Error/cancellation during two admitted jobs | Unsent work must stop | Two initial intents only; blocked cleanup drains; unknown submission remains `SUBMITTING` and is never resent |
| Two individually valid bundles exceed a shared cap | Aggregate limits must still apply | Page, character and subimage-byte failures remain enforced after concurrent job completion |

The lifetime assertion checks preparation-owned references, not all process memory:
the fake store deliberately retains artifact bytes, and Tencent's existing request,
Base64 and download buffers have independent lifetimes. Rendering/splitting peak
memory is not reduced by this change. No process RSS or hardware timings were
measured, and no total-memory reduction is claimed.

Focused regressions live in `tests/test_document_performance.py` and
`tests/test_tencent_bundle_performance.py`, with thread/lease cancellation coverage
in `tests/test_import_engineering.py`. Existing split reconstruction and receipt
replay tests now associate HTTP submissions with their immutable source hashes;
HTTP submission order is deliberately no longer an ordering contract.

Run from `server/`, using the existing Python 3.14+ interpreter:

```sh
PYTHONPATH=src "$AI_PYTHON" -m pytest -q \
  tests/test_document_performance.py tests/test_tencent_bundle_performance.py \
  tests/test_tencent_inputs.py tests/test_tencent.py tests/test_tencent_staging.py \
  tests/test_import_engineering.py tests/test_diagram_crop_pipeline.py \
  tests/test_diagram_crop_boundary.py tests/test_ocr_label_crops.py \
  tests/test_vision_context.py tests/test_ocr_review_regressions.py \
  tests/test_page_rendering.py tests/test_pipeline_performance.py \
  -k 'not checkpoint_benchmark'
```

The database-backed checkpoint benchmark and full repository verification belong
to combined verification; this focused command neither starts databases nor calls
providers.
