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
