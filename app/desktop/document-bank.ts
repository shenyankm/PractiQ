import type { DesktopDocumentBankSelection, DocumentAnswerEvidence, DocumentBankImport, DocumentCorrections, DocumentParseResult, DocumentTaskDetail } from "../src/contracts.generated.js";
import { correctedResult } from "./document-corrections.js";
import type { DocumentRecord } from "./document-tasks.js";
import { bankResourcePlan } from "./bank-references.js";
import { validateContract } from "./contracts.js";
import { MAX_JSON_BYTES, validateParsedDocument, validateProcessing } from "./document-contract.js";
import { invariant } from "./errors.js";
import { composite } from "./question-contract.js";
import { canonical } from "./questions.js";
import { SourceText } from "./source-text.js";

function appendExportWarning(result: DocumentParseResult, warning: string): void {
  if (result.warnings.length >= 1000) result.warnings[result.warnings.length - 1] += `\n${warning}`; else result.warnings.push(warning);
}

export function selectBankQuestions(result: DocumentParseResult, indexes: number[]): DocumentParseResult {
  invariant(indexes.length > 0 && indexes.length <= 2000 && indexes.every(index => Number.isSafeInteger(index) && index >= 0 && index < result.questions.length), "SOURCE_SELECTION_INVALID", "Select valid questions from the reviewed result");
  const selected = new Set(indexes), byId = new Map(result.questions.flatMap((question, index) => question.id ? [[question.id, index] as const] : []));
  for (;;) {
    const required = new Set(selected);
    for (const [index, question] of result.questions.entries()) {
      const related = [question.parentId, question.optionSourceId].flatMap(id => id && byId.has(id) ? [byId.get(id)!] : []);
      if (selected.has(index)) related.forEach(index => required.add(index));
      if (related.some(index => selected.has(index))) required.add(index);
    }
    if (required.size === selected.size) break;
    required.forEach(index => selected.add(index));
  }
  const value = structuredClone(result); value.questions = value.questions.filter((_question, index) => selected.has(index));
  const ids = new Set(value.questions.flatMap(question => question.id ? [question.id] : []));
  const retain = <T extends { questionIds?: string[] }>(items: T[]): T[] => items.filter(item => !(item.questionIds ?? []).length || item.questionIds!.some(id => ids.has(id))).map(item => ({ ...item, questionIds: (item.questionIds ?? []).filter(id => ids.has(id)) }));
  value.groups = retain(value.groups); value.visualElements = retain(value.visualElements);
  appendExportWarning(value, "Selected-question export includes required material and shared-option groups.");
  return validateParsedDocument(value) as unknown as DocumentParseResult;
}

/** A portable saved snapshot: task state, usage, credentials and source paths stay out. */
export function documentBankSnapshot(record: DocumentRecord, detail: DocumentTaskDetail, selection: DesktopDocumentBankSelection, corrections?: DocumentCorrections): DocumentBankImport {
  validateContract("DesktopDocumentBankSelection", selection);
  invariant(selection.threadId.toLowerCase() === record.id && detail.checkpointId === selection.checkpointId, "STALE_CHECKPOINT", "The reviewed checkpoint changed");
  invariant(!["EXPIRED", "PENDING", "RUNNING", "PAUSING"].includes(detail.state) && detail.checkpointId && detail.result && detail.status && (detail.state === "COMPLETED" || selection.scope === "completed" && detail.canExportCompleted), "BANK_EXPORT_NOT_READY", "This checkpoint has no exportable saved result");
  let snapshot = structuredClone(detail.result); const answerSources = new Map<number, DocumentAnswerEvidence>();
  if (selection.revisionId != null) {
    invariant(detail.state === "COMPLETED" && corrections, "CORRECTION_NOT_READY", "Revisions require a completed result and its saved history");
    invariant(corrections.checkpointId === selection.checkpointId, "CORRECTION_CONFLICT", "Revisions belong to another checkpoint");
    snapshot = correctedResult(snapshot, corrections, selection.revisionId);
    appendExportWarning(snapshot, "Human-corrected revision; original source evidence and review flags are retained.");
    snapshot = validateParsedDocument(snapshot) as unknown as DocumentParseResult;
    const previousAnswers = new Map<number, unknown>();
    for (const edit of corrections.edits ?? []) {
      if (edit.answerEvidence) answerSources.set(edit.questionIndex, edit.answerEvidence);
      else if (canonical(previousAnswers.get(edit.questionIndex)) !== canonical(edit.question.answerPayload)) answerSources.delete(edit.questionIndex);
      previousAnswers.set(edit.questionIndex, edit.question.answerPayload);
      if (edit.requestId.toLowerCase() === selection.revisionId.toLowerCase()) break;
    }
  }
  const result = selection.questionIndexes == null ? snapshot : selectBankQuestions(snapshot, selection.questionIndexes), processing = structuredClone(detail.processing);
  if (processing && selection.questionIndexes != null) {
    const ids = new Set(result.questions.map(question => question.id!));
    processing.questionSources = (processing.questionSources ?? []).filter(source => ids.has(source.questionId));
    processing.quality ??= { reviewRequired: false, reviewQuestionCount: 0, issues: [] };
    processing.quality.issues = (processing.quality.issues ?? []).filter(issue => ids.has(issue.questionId));
    processing.quality.reviewQuestionCount = result.questions.filter(question => question.needsReview && !composite(question)).length;
  }
  const retained = new Set(result.questions.map(question => question.id));
  for (const [index, question] of snapshot.questions.entries()) if (retained.has(question.id)) {
    const evidence = answerSources.get(index); if (!evidence) continue; const excerpt = new SourceText(evidence.sourceText || "unavailable");
    appendExportWarning(result, `Supplied answer source for original question ${index + 1}: ${evidence.fileName || "answer document"}; SHA-256 ${evidence.sourceSha256}; source excerpt: ${excerpt.slice(0, Math.min(1200, excerpt.length))}`);
  }
  validateProcessing(processing, new Set(result.questions.map(question => question.id!)));
  const fileName = record.input.document.fileName ?? detail.fileName, title = fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) || fileName : fileName;
  const value: DocumentBankImport = { title, status: detail.status, result, processing };
  validateContract("DocumentBankImport", value); validateParsedDocument(value);
  invariant(Buffer.byteLength(canonical(value)) <= MAX_JSON_BYTES, "BANK_EXPORT_TOO_LARGE", "Bank JSON exceeds its size limit");
  for (const reference of bankResourcePlan(value).values()) invariant(reference.objectKey === record.input.document.objectKey || String(reference.objectKey).startsWith(`practiq-agent/artifacts/${record.input.document.sha256}/`), "BANK_EXPORT_INVALID", "Bank resource belongs to another source");
  return value;
}
