import type { DocumentParseResult, DocumentProcessing } from "../src/contracts.generated.js";
import { retainSourceAnswers } from "./answer-evidence.js";
import { finishAssembly, type AssemblyUnit } from "./assembly-finish.js";
import { invariant } from "./errors.js";
import { mergeChunks } from "./merge-chunks.js";
import { parsedAnswerSourceConflict } from "./question-contract.js";
import type { ChunkSpan } from "./source-chunks.js";
import { SourceText } from "./source-text.js";
export { UnitMergeConflict as TextMergeConflict } from "./assembly-finish.js";
export type TextAssemblyUnit = AssemblyUnit;

/** Mutates only loaded unit copies; original unit artifacts and receipts stay immutable. */
export function assembleTextUnits(units: TextAssemblyUnit[], sourceText: string, spans: ChunkSpan[], options: { headers?: (string | null)[]; warnings?: string[]; truncated?: boolean; answerSheet?: boolean; deduplicateQuestions?: boolean; retryCounts?: Record<string, number>; sourceType?: string } = {}): { status: "SUCCEEDED" | "PARTIAL"; result: DocumentParseResult; processing: DocumentProcessing } {
  const ordered = structuredClone(units).sort((a, b) => a.index - b.index), warnings = [...options.warnings ?? []], source = new SourceText(sourceText), failed = ordered.filter(unit => !unit.payload);
  for (const unit of ordered) invariant(Number.isSafeInteger(unit.index) && unit.index >= 0 && spans[unit.index] && (!unit.payload || unit.payload.visuals.length === 0), "UNIT_RESULT_INVALID", "Text assembly requires verified text units");
  warnings.push(...failed.map(unit => `Fragment ${unit.index + 1} of ${ordered.length} failed and was skipped.`));
  const parsed = ordered.filter(unit => unit.payload !== null);
  for (const unit of parsed) for (const question of unit.payload!.parsed.questions ?? []) if (parsedAnswerSourceConflict(question)) warnings.push(`Answer/source conflict for ${question.id || question.stem}: verify the supplied answer before grading.`);
  for (const unit of parsed) {
    const span = spans[unit.index], header = options.headers?.[unit.index], primary = (header ? `${header}\n` : "") + source.slice(span.start, span.end);
    for (const [index, fields] of retainSourceAnswers(unit.payload!.parsed.questions ?? [], primary, [], options.answerSheet)) warnings.push(`Source evidence, fragment ${unit.index + 1}, question ${index + 1}: removed unverified ${fields.join(", ")}; retained the question for review.`);
  }
  const merged = mergeChunks(parsed.map(unit => ({ index: unit.index, questions: unit.payload!.parsed.questions ?? [], groups: unit.payload!.parsed.groups ?? [] })), { sourceText, spans });
  warnings.push(...merged.warnings);
  return finishAssembly(merged, ordered, warnings, { ...options, sourceText, spans, failures: failed.map(unit => ({ stage: "document_parse", index: unit.index, code: unit.failureCode || "OUTPUT_INVALID", retryable: false })), chunks: { total: ordered.length, succeeded: ordered.length - failed.length, skipped: 0 }, visualCounts: { total: 0, succeeded: 0, skipped: 0 } });
}
