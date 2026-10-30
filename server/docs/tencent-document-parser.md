# Tencent asynchronous document parsing

The service submits document recognition to Tencent's
[SubmitMultimodalDocParseJob](https://cloud.tencent.com/document/api/866/139312)
and resumes polling through
[DescribeMultimodalDocParseJob](https://cloud.tencent.com/document/api/866/139313).
Question structuring, printed-answer extraction, validation, human review and
question-bank export remain in PractiQ. Parsing never solves unanswered questions.

Configure `AI_TENCENT_SECRET_ID` and `AI_TENCENT_SECRET_KEY` in the trusted service
environment. They do not enter graph state, execution signatures, Web responses,
practice data, or extractor worker environments. Requests use HTTPS and TC3
signatures through the existing HTTP dependency; no Tencent SDK is required.

## Source preparation

All supported inputs (TXT, Markdown, PDF, Word, PPT, Excel and PNG/JPEG) use
Tencent asynchronous parsing. CSV is rejected at upload and new-task creation;
historical source references, saved results and imported banks are retained.
File selection and passive reads never submit work. There is no local text/CSV
recognition branch or user-selectable Office conversion mode.

PDF and image sources use Tencent OCR evidence instead of sending full-page
images to the question-structuring model. The existing isolated renderer retains
full pages for authenticated review and deterministic crops. OCR coordinates
are normalized against each OCR page's own width and height before cropping the
stored source page. Models may associate and classify known figures, but cannot
invent or modify their bounds.

Model-facing figure previews are capped at 200 KiB before Base64 encoding.
Verified Tencent subimages at or below that limit are sent unchanged; larger
subimages use the bounded JPEG encoder over their full extent. These previews
never replace stored `imageRef` or source bytes, checksums, IDs or coordinates.
Generated crops and resized previews composite transparency (including palette
alpha) onto white before JPEG encoding and the diagram boundary check. A failed
preview is omitted from model images, while the complete OCR figure inventory,
authoritative artifacts and existing human-review requirements are retained.
Neighbor-context completion reuses the same preview messages.

PRIMARY and CONTEXT OCR JSON sent to the model omit only each figure's
`imageRef` storage metadata and `cropBbox` repair bounds, and use compact JSON
separators. Stored OCR artifacts retain both fields. The service still verifies
and loads the referenced images, labels previews with their fixed `elementIndex`,
and restores image references and crop bounds to the final visuals by that ID.
Element order, page dimensions, polygons, original bounds, figure IDs, table
fields/cells (including blanks), formulas and XML merged-cell layouts remain
unchanged in model evidence. No source strings are trimmed or deduplicated.

Model-facing OCR page numbers use the same one-based numbering as question IDs;
stored OCR indices remain unchanged. Context completion preserves ordinary
questions' existing material blocks as well as composite content. Associated
material from neighboring pages must be retained in displayable content blocks
or passages, not only in `sourceText` quotations. Composite continuations retain
later printed reuse permission, rubric, analysis and source-score metadata;
conflicting non-null metadata is rejected for review rather than silently lost.

Table copies added to question blocks/source quotations share a 1 MiB per-page
budget. When exhausted, the full table remains once in its linked visual with
all question associations and original bounds; questions using the linked-only
material remain flagged for review. This limits copy amplification without
raising the 32 MiB bank JSON limit or discarding source/model-provided blocks.

The import service creates no audio artifacts. Model-supplied `audioRef` values
are discarded from drafts and from read-only projections of saved task results;
listening content keeps its transcript and missing-media review flag. Saved
results and provider receipts are not rewritten or resubmitted. Portable bank
contracts still support verified audio supplied outside this import workflow.

An unassociated figure with a retained full source page is not published as a
verified crop: keep the full-page `sourceRef`, report `CROP_UNVERIFIED` and retain
partial-result/media review flags. Provider bounds can omit detached labels;
the service does not expand those immutable coordinates or invent associations.

Word and PPT originals within the per-job limit are submitted directly after
container validation. XLSX preparation exposes hidden and very-hidden sheets in
an immutable derived copy, preserving all other ZIP members and the original
source. Live recognition of the synthetic prepared workbook returned both sheets.
Legacy XLS always requires the existing isolated LibreOffice adapter; its
`SinglePageSheets` PDF export includes hidden sheets. A Docker LibreOffice 7.4.7
check exported both sheets, including hidden content, from the original fixture. Oversized Office inputs also use that adapter to produce
reviewable PDF pages before Tencent recognition. PPT/PPTX use Impress PDF export.
Without a configured converter, capabilities exclude XLS and cap other Office
uploads at their direct-submission limit. Excel output still requires original
workbook review for cell and merged-layout fidelity. Native table JSON retains cells and fields, with uniquely
matched XML table layouts preserving merged spans; no page coordinates are invented. Original source bytes and
checksums remain authoritative. TXT and Markdown are validated as UTF-8 before
submission, without performing local recognition. After Tencent returns, text-only evidence
that exactly matches the original UTF-8 text retains the existing chunking,
source-presence validation and explicitly opted-in deduplication path. Evidence
that differs stays in the OCR page workflow; it cannot authorize original-text
deduplication and remains flagged for review.

The existing XLSX metadata preparation retains the original sheet inventory.
If native table names do not cover that inventory, including when Tencent returns
only ordinary OCR pages and no native tables, the task remains partial with
missing-question markers, even when Tencent reports `Success` and zero failed
pages. Matching names are only a coverage check, not proof that all cells or
images were recognized. No missing content is synthesized or resubmitted
automatically.

## Input transport and output format

Local directories remain the default and authoritative source/artifact store.
`AI_TENCENT_COS_ENABLED=false` sends each input using Base64, capped at 8 MiB;
no bucket is needed and the service never switches to COS automatically.

COS is an advanced opt-in. Set `AI_TENCENT_COS_ENABLED=true` and fill
`AI_TENCENT_COS_BUCKET` (including the APPID suffix) and `AI_TENCENT_COS_REGION`
(for example `ap-guangzhou`). When enabled, **every** input uses private COS
staging and a signed HTTPS `FileUrl`; there is no Base64 fallback. The existing
Tencent key needs access to this dedicated staging prefix. Keep the bucket and
its policies private; uploads explicitly request private ACL and AES256 storage
encryption, and Content-MD5 plus the returned ETag verify the exact uploaded
bytes. No SDK or new package is required. Bucket creation and policy changes
remain explicit deployment administration.

The prefix is fixed to `practiq-import/`; object names contain task/unit and
content hashes, never source filenames. An upload intent is durable before PUT.
A lost PUT acknowledgement can retry the same bytes at the same key; the paid
submission intent is written separately before calling the parser. Signed source
URLs last one hour and are never stored, logged or returned to clients. After a
known terminal failure or a safely saved and validated result, the service deletes its staged
object. Cleanup failures preserve the local archive and fail the prepare stage with
`TENCENT_COS_CLEANUP_FAILED`. Explicit resume retries deletion before continuing,
reusing the saved archive without another upload or parser submission. Configure
a bucket lifecycle rule to expire only `practiq-import/` after one day for crash
orphans and submissions whose outcome remains unknown. Unknown submissions keep
the source available until that expiry and are never resubmitted automatically.
Use an unversioned staging bucket, or also expire noncurrent versions so retries
and delete markers cannot retain old source copies. The service does not modify
lifecycle rules or delete other prefixes. Local files are retained in either mode. Limit the key's COS permissions to PutObject,
GetObject, DeleteObject and the upload ACL operation on this staging prefix.

`AI_TENCENT_INPUT_MAX_BYTES` is the deployment ceiling per submission (default
and maximum 157286400, or 150 MiB). The active transport also applies its cap:
local Base64 8 MiB; COS URL PDF/Word/PPT 150 MiB, Excel/TXT/Markdown 10 MiB and
images 30 MiB. Original uploads still obey `AI_SOURCE_MAX_BYTES` (Office also
has its existing 25 MiB cap), page limits, character limits and scratch budgets.
The Web capability `parserInputMaxBytes` reports the active transport ceiling;
individual source types may have lower limits. Inputs exactly at their effective
limit are sent intact; larger inputs split before the first paid request.

TXT/Markdown split at UTF-8 boundaries, preferring newline boundaries; joining
the parts reproduces every original byte. PDF uses its retained rendered pages.
Large PNG/JPEG or rendered pages split into lossless PNG tiles without resizing,
removing pixels or changing transparency. CMYK JPEG tiles convert to RGB before
PNG encoding, using the embedded color profile when present. Oversized Office uses the trusted
isolated adapter to render PDF pages and follows the same visual split path.
Missing Office configuration fails before submission. Enabling COS avoids the
Base64-specific 8 MiB split while preserving the other limits. Image validation
also decodes scan data, so a truncated JPEG is rejected before submission;
tilers apply the same structured `IMAGE_FORMAT_UNSUPPORTED` error to saved inputs.
Malformed OOXML directories and excessive workbook XML nesting fail with
`OFFICE_INPUT_INVALID`. Corrupt archive member compression, including BZIP2, LZMA
and Zstandard result/subimage streams, fails with `TENCENT_RESULT_INVALID` without
altering the retained result bytes or resubmitting the paid job.

| Submitted source type | ResultType | Reason |
| --- | --- | --- |
| TXT, Markdown | 2 (Markdown) | Text evidence without an assumed OCR coordinate schema |
| PDF, PNG/JPEG | 9 (JSON + Markdown + XML) | JSON coordinates plus XML subimage associations |
| Word, PPT, Excel | 9 (JSON + Markdown + XML) | Structured evidence and linked resources for review |

The interface has no JSON-plus-XML-only option, so layout/resource inputs use 9.
This choice follows the actual submitted type: a rendered Office/PDF tile uses
the image rule. It is fixed service behavior, not a client-provided option. Each
job stores its selected result type so replay decodes the retained archive the
same way. Markdown output is bounded UTF-8 source evidence, never rendered HTML;
unsafe paths, ambiguous full-document files and malformed archives fail closed.

All parts pass individual size, part-count and total visual-byte checks before
the first job. The configured document-page limit cannot exceed Tencent's 300-page ceiling and also bounds the number of
parts and the combined returned pages. The isolated Office worker receives the
same page bound; task diagnostics retain every parser receipt in numeric part
order up to the shared 300-part ceiling. Direct Office requests set
`FileEndPageNumber` to that configured limit before paid submission. A live
XLSX check showed that Tencent can still return multiple sheets with an end-page
value of one, so XLSX metadata also rejects workbooks with too many sheets before
any paid submission; XLS uses the bounded PDF conversion path. Reaching the
ceiling retains partial evidence with a warning rather than claiming full coverage. Original source hashes, ordered part
hashes, text byte ranges and image pixel bounds/original-page references are
retained; visual review and crops use the exact submitted tile. Each part has
its own durable Tencent receipt and replay reuses completed jobs. Cross-part
questions and materials retain the adjacent-page context/review flow; split
boundaries add a review warning. Rendering fidelity and cross-part recognition
quality still require representative deployment acceptance.

## Recovery and billing boundaries

Before paid submission, the PostgreSQL LangGraph Store records the submission
intent. A returned TaskId is persisted before polling. Replays with a known TaskId
query the same job; locally stored result archives are checksum-verified and
reused. Download failures do not cause another paid submission.

Tencent does not document a client submission idempotency key. If submission
succeeds but its response or local receipt is lost, the saved intent remains
`SUBMITTING`. Recovery reports `TENCENT_SUBMISSION_UNKNOWN` and refuses automatic
resubmission. Check Tencent-side records before explicitly parsing again; another
submission may charge again. Local run cancellation cannot cancel cloud work
through these two APIs. Terminal rejection, unknown submission without a task ID,
and terminal job failure do not offer Resume; query rejections with a saved
task ID remain resumable without another paid submission; inspect the retained evidence before
explicitly parsing again.
An explicit provider rejection is saved as `REJECTED`, separate from an unknown
network outcome. Both require explicit recovery rather than automatic submission.

Result URLs are temporary capabilities. They are used only for bounded downloads
from validated Tencent COS HTTPS hosts without redirects, and are not saved in
task state. Archives are retained in local content-addressed storage. Archive
paths, expanded size, entry count, OCR schema, page indices and coordinates are
validated before interpretation. Unsupported result layouts fail explicitly.
Each job records downloaded and validated results separately. The existing
archive/subimage decoder confirms validation before COS source cleanup; it does
not decode images a second time. A malformed ZIP, JSON, XML or image keeps its
immutable bytes, failed-result reference and original Tencent receipt. Explicit
Resume queries the same saved task ID and downloads its result again, without
uploading the source or submitting another recognition job. Valid split-job
results remain reusable while only failed results are downloaded again. Older
saved result references pass through the same validation before reuse is
confirmed. Invalid content never triggers an automatic retry.
Cancellation waits for archive/subimage decoding threads to finish before
releasing their shared preparation slot and resource reservation. This bounds
overlapping work; it does not forcibly terminate a running decoding thread.

Tencent `Success` may include failed pages. Missing page evidence is retained as
a page failure and remains available for human partial-result review; the task
must not claim complete recognition. Semantic retries reuse stored OCR evidence.
Retrying Tencent recognition requires an explicit new parsing action. If optional
neighbor-context enrichment exceeds the model input limit, the valid primary
extraction is retained with review flags and a warning rather than discarded.
Correction feedback gives the actual question-array bounds for group indexes.
Local JSON punctuation repair may remove duplicated closing delimiters after a
complete root value; it still rejects mismatched nested brackets, multiple values,
unfinished strings and invalid business fields.

The authenticated preview includes the retained original document reference.
Visual review units expose separate rendered-source and OCR-evidence references;
both use authenticated, task-scoped, checksum-verified artifact downloads. The
Web review panel can download that checksum-verified original and explicitly
read saved OCR JSON/text as inert source evidence. These passive reads, including
after restart or in read-only mode, never submit Tencent or model work.

## Acceptance status

Local acceptance passed `make verify`: 2,877 tests, 92% coverage, Ruff, Pyright,
evaluation fixtures, recovery probes and wheel/source package checks. Provider
substitutes cover the durable job boundary, input splitting and complete local
graph execution with PostgreSQL, RabbitMQ and process restart recovery. The Web
checks passed 103 unit tests, 32 browser checks and its production build. Browser acceptance against an
isolated service verified retained source evidence and manual partial-result
acceptance enabling ZIP export while preserving review flags. Passive review
did not add Tencent submissions. These checks do not prove Tencent recognition
quality or billing.
Live synthetic TXT (Markdown output), PDF, DOCX and XLSX jobs completed and
their downloaded archives decoded successfully; the XLSX merged span was retained.
See [sanitized evidence](../../docs/evidence/2026-10-20-tencent-parser/README.md).
COS remains untested live because bucket and region are unset.
The subsequent [live import acceptance](../../docs/evidence/2026-10-20-tencent-import/live-acceptance.json)
uses real Tencent and configured question-structuring calls through an isolated
HTTP service, PostgreSQL, RabbitMQ and local storage. Eight admitted tasks reached
five concurrent Tencent workflows; a real query `RequestLimitExceeded` recovered
without a second submission. Separate injected query exhaustion and lost-submit
reply checks distinguish known-job resume from uncertain paid work. The latter
exposed and fixed an incorrect Resume action on the first transport failure.
Repeated create/control/reparse receipts and a service restart did not add
submissions. These small synthetic questions do not establish document accuracy
or account-wide remote page admission.
Deployment acceptance still requires enabled Tencent APIs and authorized real
samples: Chinese and English questions, shared and cross-page materials, answer
keys, formulas, tables, figures, Office sheets, partial pages and large sources.

Existing tasks keep their original deployment and files for recovery; do not
rewrite execution signatures or old checkpoints to adopt the new parser.

## Import engineering safeguards

Task diagnostics expose the submission and latest query request IDs, a bounded
provider error code and `statusUpdatedAt` (the last status transition). They never
save provider error messages or signed result URLs. Legacy records show null for
new diagnostic fields. `practiq_stage_seconds` includes `tencent_submit`,
`tencent_query` and `tencent_download`; outcome describes the HTTP operation, so a
successful query can still report a failed document job.

Only reads of an acknowledged task and its result retry transient transport
failures, HTTP 408/429/500/502/503/504, or query `RequestLimitExceeded` and
`InternalError` responses. By default each read has at most three attempts, with 1/2-second
backoff and 20% jitter, bounded by the saved run deadline and control checks.
The authenticated Web Settings page can persist 0–5 additional read retries
and a 0.5–10-second base backoff for subsequent read operations. Backoff checks
pause and execution guards at intervals of at most one second.
Authentication failures, malformed results, terminal job failures and paid
submission are never automatically retried. An exhausted read retains the job ID
for an explicit resume. An unacknowledged submission remains blocked from replay.

Web retains failed source submissions, including their original File, options and
request ID, when another selection succeeds or fails validation. Within the
connected page, identical verified content/filename/options reuse an uncertain
creation intent even if file timestamps change. This is still an explicit user
retry; selecting a file never creates a task. A failed start stops the batch,
leaving the remaining files unsubmitted until another explicit action. Mutation
receipts must affirm acceptance and include valid task/run IDs before the intent
is cleared. Failed files can be removed to free queue slots; removal does not
cancel server work, and uncertain content intents remain available in memory for
explicit reselection. Pending receipts exist only in memory: inspect the task
list before refreshing, disconnecting or closing the page.

The authenticated capabilities response reports the same per-unit reservations
used by dispatch. With a 400-call budget, ordinary/context units reserve 4/8 calls
without AI review (100/50 full reservations), or 16/20 with review (25/20).
Mixed units share the budget; units do not equal pages. Reservations are retained
on failure and retry, and a last unit may receive only the remaining allowance.
The pre-import Web hint describes full reservation capacity, not guaranteed output
or recognition quality. This change does not refund spent or uncertain calls.

A submission transport failure is reported as `TENCENT_SUBMISSION_UNKNOWN` on
the first failure, while retaining its `SUBMITTING` intent. It cannot offer a
normal Resume action: an unavailable response does not establish whether paid
recognition started. Inspect the provider task before explicitly parsing again.

Create, control and reparse all validate task receipts before clearing their
request IDs. A malformed successful response is still an uncertain outcome and
requires an explicit retry with the same ID. Deletion also requires an affirmative
receipt before the UI confirms removal. A rejected Tencent query saves its
safe request ID and error code before retry backoff, so pausing during that wait
retains the latest diagnostic receipt.


Tencent parsing has a separate shared admission ceiling of five concurrent
workflows in this service, independent of LLM concurrency. Web Settings can
lower this limit to 1–5; active workflows drain before new work is admitted. A slot covers submit,
known-task polling and local result saving. Waiting is bounded by the persisted
run deadline and happens before any new paid-submission intent is written;
cancellation while queued cannot leave a false `SUBMITTING` receipt. Pause is
checked at least once per second while queued. `tencent_admission` records slot
wait duration separately from provider requests. Slots are released on success, failure, pause and cancellation. Tencent may continue an
already submitted remote job after a pause or process exit; retained task IDs
still govern recovery and unknown submissions are never replayed. Other clients
using the same account also consume its quota; this local ceiling does not
reserve account-wide capacity. The official default is [five pages in parallel](https://cloud.tencent.com/document/api/866/139312), shared by synchronous and
asynchronous parsing; it is not a five-requests-per-second policy.
