# Selected imports and recoverable corrections

All new source imports still use Tencent recognition followed by the existing question structuring graph. File selection, source reads, answer matching, correction proposal reads and ZIP export are passive. Only explicit Start/reparse/retry actions authorize paid work. Original source bytes, parsed checkpoints and prior corrections remain unchanged.

## Page ranges

The Web Start form accepts one-based page numbers such as `1,3-5`; blank means all pages. `DocumentTaskCreate.pages` contains 1–2,000 positive page numbers, canonicalized to sorted unique values. TXT/Markdown have no pages and reject this option. Images use page 1; multi-page sources keep original page references, including split image tiles. The service checks known PDF/image bounds before Tencent submission and checks retained page evidence before structuring. Office page bounds are known only after recognition.

This option limits question structuring. Tencent can still recognize the entire source, and its charges may reflect the whole source. It does not add a local recognition fallback, crop Office documents before submission, or guarantee lower Tencent charges. Unknown creation recovery reuses the original range and document role.

## Reparse selected sources

Choose questions in a completed result, then use **重新解析所选题目的来源**. The Web derives their existing source-unit references and sends an explicit reparse request:

```json
{"requestId":"<new UUID>","selection":{"checkpointId":"<current checkpoint>","units":[{"stage":"vision_parse","index":1}]}}
```

Unit indexes are zero-based retained source indexes. Only completed `document_parse` or `vision_parse` units at the current completed checkpoint are accepted. A selected unit can contain multiple questions: the action reparses that whole unit, not an invented question crop. The associated new task retains the original pages, source hashes, prepared evidence and parent task ID. It starts its own structuring receipts/budget without resubmitting Tencent; the original result, corrections and usage are untouched. Historical tasks require compatible retained evidence; missing or incompatible evidence fails explicitly. Frozen request recovery also works after an accepted child's parent has been deleted. Replaying an ID with another selection is rejected.

## Supplied answer sheets

Choose **答案卷** in Start or upload through **关联答案卷**. `documentRole: "answers"` uses the same graph to extract supplied numbered answers, never solve them; `generateAnswers: true` is rejected for that role. Literal source quotes and answer-presence proofs remain required. A separate completed answer task is the source of truth; its original source hash, filename, checkpoint, question index and supplied quote are copied into each confirmed association receipt.

`GET /api/document-tasks/{id}/answer-matches` reads current corrected target questions and a completed answer task. Only unique printed numbers on both sides receive a unique suggestion. Duplicate/missing numbers remain ambiguous/unmatched; existing answers remain protected. Literal source numbering takes priority over wording; decimal prefixes are not question numbers. Suggestions never save edits. A user may choose another source record and explicitly allow replacement of an existing answer.

`GET /api/document-tasks/{id}/answer-proposal` validates the selected record against the target's current type and option/material relationships and returns the candidate plus current corrections. It converts only literal labels with a known representation, such as `B` to a supplied choice option or `True` to a boolean. Unsupported or conflicting formats require manual review. The user must still confirm **保存修订**. A source-backed correction must equal the validated candidate; unlink the source to make a separate manual edit. All associations remain marked for review. Receipt replay verifies the exact source selection before reading a source that may have since expired.

## Selected-question ZIP

Select result questions and download **下载所选题目 ZIP**. Repeated `question_index` query values select up to 2,000 original zero-based question positions. A saved `revision_id` exports that revision. The exporter includes required parents, shared option owners and their linked children, so material blanks and relationships never point outside the package. It retains referenced resources, review flags, relevant source/quality records and all original warnings. Later manual changes to other fields retain supplied-answer provenance while the answer itself is unchanged; a manual answer replacement clears that proof. The ZIP adds selection and supplied-answer provenance warnings; it uses the existing bank format and 300 MiB bound. The preview explains that a linked material group may add questions beyond the explicitly checked ones.

The desktop imports this ZIP through Settings → Import and restore → Import bank ZIP. This appends content; full backup restoration remains a separate confirmed replacement action. No practice database migration, credential, grading trigger or snapshot behavior changes.
