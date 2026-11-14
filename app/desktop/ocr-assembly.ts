import type { ArtifactReference, UnitFailure, VisualElement } from "../src/contracts.generated.js";
import { retainSourceAnswers } from "./answer-evidence.js";
import { finishAssembly, type AssemblyOptions, type AssemblyUnit } from "./assembly-finish.js";
import { invariant } from "./errors.js";
import { mergeChunks } from "./merge-chunks.js";
import { modelDefaults } from "./model-defaults.js";
import { ocrAnswerText } from "./ocr-evidence.js";
import type { StoredOcrPage } from "./ocr-inputs.js";
import { parsedAnswerSourceConflict } from "./question-contract.js";
import { sourceContext } from "./source-context.js";

export interface CropResult { visuals: VisualElement[]; failures: UnitFailure[]; truncated: boolean; limit: number }
export interface OcrAssemblyOptions {
  warnings?: string[]; truncated?: boolean; answerSheet?: boolean; deduplicateQuestions?: boolean; retryCounts?: Record<string, number>; sourceType?: string;
  originalText?: string | null; splitSource?: boolean; pageRefs: ArtifactReference[]; failures: UnitFailure[]; visualTotal: number;
}
/** OCR never claims original-text overlap/dedup proofs, even with an original UTF-8 comparison. */
export async function assembleOcrUnits(units: AssemblyUnit[], pages: StoredOcrPage[], options: OcrAssemblyOptions, crop: (visuals: VisualElement[]) => Promise<CropResult>): Promise<ReturnType<typeof finishAssembly>> {
  const ordered = structuredClone(units).sort((a, b) => a.index - b.index), warnings = [...options.warnings ?? []], parsed = ordered.filter(unit => unit.payload !== null);
  for (const unit of ordered) invariant(Number.isSafeInteger(unit.index) && unit.index >= 0 && unit.index < pages.length, "UNIT_RESULT_INVALID", "OCR unit has no immutable source page");
  warnings.push(...ordered.filter(unit => !unit.payload).map(unit => `Fragment ${unit.index + 1} of ${ordered.length} failed and was skipped.`));
  warnings.push(...ordered.filter(unit => unit.payload?.contextSkipped).map(unit => `Page ${unit.index + 1}: oversized optional context was skipped; primary extraction was retained for review.`));
  const texts = pages.map(ocrAnswerText), [neighbors] = sourceContext(pages, !options.splitSource && options.sourceType === "pdf");
  for (const unit of parsed) for (const question of unit.payload!.parsed.questions ?? []) if (parsedAnswerSourceConflict(question)) warnings.push(`Answer/source conflict for ${question.id || question.stem}: verify the supplied answer before grading.`);
  for (const unit of parsed) {
    const primary = options.originalText ?? texts[unit.index], contexts = options.originalText == null ? neighbors[unit.index].filter(index => index !== unit.index && !("failed" in pages[index])).map(index => texts[index]) : [];
    for (const [index, fields] of retainSourceAnswers(unit.payload!.parsed.questions ?? [], primary, contexts, options.answerSheet)) warnings.push(`Source evidence, page ${unit.index + 1}, question ${index + 1}: removed unverified ${fields.join(", ")}; retained the question for review.`);
  }
  const merged = mergeChunks(parsed.map(unit => ({ index: unit.index, questions: unit.payload!.parsed.questions ?? [], groups: unit.payload!.parsed.groups ?? [] })), { overlapping: false }); warnings.push(...merged.warnings);
  const visuals: VisualElement[] = [], unverified: number[] = []; let offset = 0;
  for (const unit of ordered) {
    for (const original of unit.payload?.visuals ?? []) {
      const indexes = (original.questionIndexes ?? []).map(index => offset + index).filter(index => index < merged.questions.length); if (original.questionIndexes?.length && !indexes.length) continue;
      if (original.bbox == null && original.imageRef == null) unverified.push(visuals.length);
      visuals.push({ ...original, questionIndexes: indexes });
    }
    if (unit.payload) offset += unit.payload.parsed.questions?.length ?? 0;
  }
  for (const failure of options.failures) if (failure.stage === "vision_parse" && failure.index < options.pageRefs.length) {
    const reference = options.pageRefs[failure.index]; visuals.push(modelDefaults("VisualElement", { kind: "image", page: failure.index, questionIndexes: merged.sources.filter(source => source.unitIndex === failure.index).map(source => source.questionIndex), label: "未完成识别的原页", description: "此页识别未完成，关联未确定，请核对原始文档与来源证据。", sourceRef: ["image/png", "image/jpeg"].includes(reference.mediaType) ? reference : null }) as unknown as VisualElement);
  }
  const cropped = await crop(visuals), cropFailures: UnitFailure[] = [...cropped.failures, ...unverified.map(index => ({ stage: "visual_crop" as const, index, code: "CROP_UNVERIFIED", retryable: false }))];
  if (cropped.truncated) warnings.push(`Figure crop limit of ${cropped.limit} reached; remaining figures include descriptions only.`);
  for (const visual of cropped.visuals) if (visual.sourceRef && !visual.imageRef) {
    const affected = visual.questionIndexes?.length ? visual.questionIndexes : merged.sources.filter(source => source.unitIndex === visual.page).map(source => source.questionIndex);
    for (const index of affected) { merged.questions[index].needsReview = true; merged.questions[index].missingFields = [...new Set([...merged.questions[index].missingFields, "media" as const])]; if (!merged.quality.issues.some(issue => issue.questionIndex === index && issue.code === "MISSING_FIELDS")) merged.quality.issues.push({ questionIndex: index, code: "MISSING_FIELDS" }); }
  }
  const settings: AssemblyOptions = { ...options, visuals: cropped.visuals, cropFailures, cropTruncated: cropped.truncated, chunks: { total: 0, succeeded: 0, skipped: 0 }, visualCounts: { total: options.visualTotal, succeeded: ordered.length, skipped: 0 } };
  return finishAssembly(merged, ordered, warnings, settings);
}
