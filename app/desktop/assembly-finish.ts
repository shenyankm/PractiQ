import type { DocumentParseResult, DocumentProcessing, Question, UnitCounts, UnitFailure, VisualElement } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { findDuplicateTrees, findSourceDuplicateTrees, removeDuplicateTrees } from "./duplicate-trees.js";
import { AppError } from "./errors.js";
import { finalizeQuestions, SourceQuestionConflict } from "./finalize-questions.js";
import type { MergeResult } from "./merge-chunks.js";
import { composite, list, object } from "./question-contract.js";
import { canonical } from "./questions.js";
import { retryFailures } from "./retry-policy.js";
import { buildSourceEvidence } from "./source-evidence.js";
import type { ChunkSpan } from "./source-chunks.js";
import { SourceText } from "./source-text.js";
import type { UnitPayload } from "./unit-results.js";

export interface AssemblyUnit { index: number; payload: UnitPayload | null; failureCode?: string }
export class UnitMergeConflict extends AppError {
  constructor(readonly indexes: number[]) { super("OUTPUT_INVALID", "Merged source units require explicit retry", { indexes }); }
}
const first = (value: string, count: number): string => { const text = new SourceText(value); return text.slice(0, Math.min(text.length, count)); };
function confidenceScore(questions: Question[]): number {
  // Match the reference compensated sum and ties-to-even rounding of binary floats.
  let hi = 0, lo = 0; for (const question of questions) { const value = question.confidence, sum = hi + value; lo += Math.abs(hi) >= Math.abs(value) ? (hi - sum) + value : (value - sum) + hi; hi = sum; }
  const value = (hi + lo) / Math.max(1, questions.length) * 100, bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); const bits = bytes.readBigUInt64BE(), exponent = Number(bits >> 52n & 2047n), numerator = ((bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n)) * 10n, denominator = 1n << BigInt(52 - (exponent ? exponent - 1023 : -1022));
  let rounded = numerator / denominator; const remainder = numerator % denominator; if (remainder * 2n > denominator || remainder * 2n === denominator && rounded % 2n) rounded++; return Number(rounded) / 10;
}

export interface AssemblyOptions {
  sourceText?: string | null; spans?: ChunkSpan[] | null; sourceType?: string; truncated?: boolean; deduplicateQuestions?: boolean; retryCounts?: Record<string, number>;
  failures: UnitFailure[]; chunks: UnitCounts; visualCounts: UnitCounts; visuals?: VisualElement[]; cropFailures?: UnitFailure[]; cropTruncated?: boolean;
}
/** Shared finalization remaps every association and never mutates immutable source units. */
export function finishAssembly(merged: MergeResult, ordered: AssemblyUnit[], warnings: string[], options: AssemblyOptions): { status: "SUCCEEDED" | "PARTIAL"; result: DocumentParseResult; processing: DocumentProcessing } {
  const reviews = ordered.flatMap(unit => unit.payload?.agentReview ? [object(unit.payload.agentReview)] : []);
  for (const unit of ordered) if (unit.payload?.agentReview) {
    const audit = object(unit.payload.agentReview), reports = list(audit, "reports"), findings = reports.length ? list(reports[audit.status === "repaired" ? 0 : reports.length - 1], "issues") : [];
    const detail = findings.slice(0, 5).map(value => { const item = object(value); return `${item.code}: ${first(String(item.instruction ?? ""), 200)} (source: ${first(String(item.evidence ?? ""), 200)})`; }).join("; ");
    warnings.push(`AI source review, unit ${unit.index + 1}: ${audit.status} (${audit.failureCode || "no call failure"}). ${detail} Not a guarantee of extraction accuracy; retain human review.`);
  }
  let { questions } = merged; const { groups, sources, quality } = merged, visuals = options.visuals ?? [], cropFailures = options.cropFailures ?? [], truncated = Boolean(options.truncated || merged.truncated || options.cropTruncated);
  try {
    questions = finalizeQuestions(questions, groups, visuals, sources, quality);
    const evidence = buildSourceEvidence(options.sourceText ?? null, questions, sources, options.spans ?? null, { sourceType: options.sourceType ?? "text", complete: !truncated }), duplicates = findDuplicateTrees(questions, groups, visuals, evidence), repeats = Object.keys(evidence).length ? findSourceDuplicateTrees(questions, evidence) : [];
    const removable = options.deduplicateQuestions ? duplicates.filter(trees => trees.every(tree => tree.every(id => evidence[id]))) : [], removedKeys = new Set(removable.map(canonical));
    let byId = new Map(questions.map((question, index) => [question.id!, { index, question }])), issues = new Set(quality.issues.filter(issue => issue.code === "NEEDS_REVIEW").map(issue => issue.questionIndex));
    const locations = (trees: string[][]): string => trees.map(tree => { const { index } = byId.get(tree[0])!, units = [...new Set(sources.filter(item => item.questionIndex === index).map(item => `${item.stage === "vision_parse" ? "page" : "fragment"} ${item.unitIndex + 1}`))].sort(); return tree.join(", ") + (units.length ? ` (${units.join(", ")})` : ""); }).join("; ");
    const mark = (id: string) => { const { index, question } = byId.get(id)!; question.needsReview = true; if (!issues.has(index)) { quality.issues.push({ questionIndex: index, code: "NEEDS_REVIEW" }); issues.add(index); } };
    for (const trees of duplicates) if (!removedKeys.has(canonical(trees))) { warnings.push(`Possible repeated questions: ${first(byId.get(trees[0][0])!.question.stem ?? "", 80)} — ${locations(trees)}. All copies were retained; you decide whether to remove any.`); [...new Set(trees.flat())].sort((a, b) => byId.get(a)!.index - byId.get(b)!.index).forEach(mark); }
    if (options.deduplicateQuestions) { const result = removeDuplicateTrees(questions, groups, visuals, sources, quality, removable); questions = result[0]; warnings.push(...result[1]); }
    byId = new Map(questions.map((question, index) => [question.id!, { index, question }])); issues = new Set(quality.issues.filter(issue => issue.code === "NEEDS_REVIEW").map(issue => issue.questionIndex));
    for (const trees of repeats) { const surviving = trees.filter(tree => tree.every(id => byId.has(id))); if (surviving.length < 2 || duplicates.some(strict => surviving.every(tree => strict.some(copy => canonical(copy) === canonical(tree))))) continue; surviving.flat().forEach(mark); warnings.push(`Repeated source question groups: ${locations(surviving)}. Parsed versions are not strictly identical; the remaining copies were retained for review.`); }
  } catch (error) {
    if (error instanceof SourceQuestionConflict) { const indexes = [...new Set(sources.filter(item => item.questionIndex === error.questionIndex).map(item => item.unitIndex))].sort((a, b) => a - b); if (indexes.length) throw new UnitMergeConflict(indexes); }
    throw error;
  }
  const failures = retryFailures([...options.failures.filter(failure => failure.stage !== "visual_crop"), ...cropFailures], options.retryCounts ?? {}), missing: ("questions" | "media")[] = !questions.length || options.truncated || merged.truncated || failures.some(failure => ["document_parse", "vision_parse"].includes(failure.stage)) || reviews.some(review => review.missingQuestions) ? ["questions"] : [];
  if (cropFailures.length || options.cropTruncated) missing.push("media");
  const processing: DocumentProcessing = { chunks: options.chunks, visuals: options.visualCounts, truncated, failures, questionSources: sources.map(item => ({ questionId: questions[item.questionIndex].id!, stage: item.stage, unitIndex: item.unitIndex })), quality: { reviewRequired: Boolean(failures.length || truncated || !questions.length) || questions.some(question => question.needsReview) || reviews.some(review => review.status !== "no_discrepancy"), reviewQuestionCount: questions.filter(question => question.needsReview && !composite(question)).length, issues: quality.issues.map(issue => ({ questionId: questions[issue.questionIndex].id!, code: issue.code })) } };
  if (!questions.length) warnings.push("No questions were extracted; source units require review.");
  if (visuals.some(visual => !visual.questionIndexes?.length)) { warnings.push("Some source figures are not associated with questions. Review the full source: OCR figure bounds may omit detached labels or material."); processing.quality!.reviewRequired = true; }
  const result: DocumentParseResult = { schemaVersion: 3, questions, groups: groups.map(group => ({ title: group.title, instructions: group.instructions ?? null, questionIds: group.questionIndexes.map(index => questions[index].id!) })), visualElements: visuals.map(({ questionIndexes, ...visual }) => ({ ...visual, documentOnly: !questions.length, questionIds: (questionIndexes ?? []).map(index => questions[index].id!) })), warnings: warnings.slice(0, 1000), confidenceScore: confidenceScore(questions), missingFields: missing };
  validateContract("DocumentParseResult", result); validateContract("DocumentProcessing", processing);
  return { status: failures.length || truncated || missing.length ? "PARTIAL" : "SUCCEEDED", result, processing };
}
