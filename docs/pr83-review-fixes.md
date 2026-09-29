# PR 83 review follow-up

This follow-up addresses the twelve inline review findings and the question-tree
index nit. It supersedes the writing-language fallback and license-completeness
claims in the historical September acceptance reports; those reports remain
unchanged as evidence of their original runs.

- Figure-review provider failures retain retryable page attribution and usage.
- Zero-question source images are retained as `documentOnly` across append,
  ZIP round-trips and backups, without attaching them to existing questions.
- Malformed missing-field metadata is rejected before normalization; valid
  incomplete content remains exportable.
- Missing target language remains null instead of interpreting quoted or
  ambiguous prose. Existing explicit model language tags remain unchanged.
- Evaluation requires exact expected missing fields. Invalid grading anchors
  exit through argparse with code 2 before calls or report creation.
- DOCX ZIP member errors map to `OFFICE_INPUT_INVALID`; corpus reads use UTF-8.
- Unattributable question-tree errors are re-raised rather than blaming unit 0.
- License inventory requires Python manifest/metadata agreement, filters Cargo
  packages by the target resolve graph, and marks ten link-only notices
  unresolved. No license terms or provenance were invented.
- Windows CI's audio allowance test now uses the existing controllable session
  clock. Slow scheduling no longer masquerades as elapsed audio playback; no
  production playback limit was relaxed.

The bot's generic docstring percentage warning is not a repository quality gate;
no bulk boilerplate docstrings were added. Real-model extraction accuracy and
unresolved release attribution/fidelity remain separate acceptance limits.

## Follow-up review and Windows packaging

Figure verification keeps the existing four-call unit budget. If transient
provider failures consume its remaining allowance, exhaustion preserves the
underlying retryable provider error; no calls or retries are added. A regression
uses the real shared allowance and three provider timeouts after page parsing.
Existing answer roles cannot be downgraded by a second model, and stringified
arrays are rejected through the normal structured-output correction path.

Expired matching tasks no longer prevent a fresh import. Office receipt matches
are refreshed against the service before reuse, with deleted tasks skipped.

After the audio regression passed on Windows, packaging exposed checkout newline
conversion in checksum-pinned license texts. Git attributes now preserve exact
notice and multi-format fixture bytes. A test checks out representative LF text
and CRLF CSV with `core.autocrlf=true` and verifies identical bytes.

## September 30 review

Crop-only truncation now marks missing media without claiming missing questions.
The formula-preservation check includes all renderable question fields (including
options, items, passage, instructions and supplied answers), while excluding raw
source evidence. Focused tests cover both distinctions.

Office reuse requires a live task for every recorded converted artifact, including
hidden-sheet CSVs. A missing or expired sheet triggers full conversion/submission;
historical expired receipts are harmless when that artifact has a live replacement.
Matching is by conversion artifact name within the selected source hash and mode.

The request to restore post-conversion confirmation is not adopted: the user
explicitly requested that clicking Start import execute without another modal.
The repository guidance is updated to match that explicit product decision.
Conversion-only actions remain credential-free and do not submit model requests.

Windows packaging now decodes Cargo/rustc output explicitly as UTF-8, matching
the Cargo JSON encoding rather than the runner's legacy locale codec.
