import type { DocumentTaskDetail, TaskProgress, UnitCounts } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { UnitMergeConflict, type AssemblyUnit } from "./assembly-finish.js";
import type { DocumentRecord } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { assembleOcrUnits } from "./ocr-assembly.js";
import { ocrUnitInput, readSavedOcrInputs, validateSavedOcrUnit } from "./ocr-inputs.js";
import { validateSourceFields } from "./source-fields.js";
import { assembleTextUnits } from "./text-assembly.js";
import { readRecognizedManifest, readSavedTextInputs, textUnitInput } from "./text-inputs.js";
import { UnitResults, type UnitIdentity } from "./unit-results.js";
import { AnswerResults } from "./answer-generation.js";
import { sourceIndexes } from "./source-selection.js";

/** Rebuild a stopped task's partial view without writing receipts, crops or checkpoints. */
export async function completedResult(storage: AiStorage, store: SqliteStore, task: DocumentRecord) {
  invariant(["PAUSED", "FAILED", "INTERRUPTED", "CANCELLED", "WAITING_REVIEW"].includes(task.state), "BANK_EXPORT_NOT_READY", "Pause document work before exporting completed units");
  const results = new UnitResults(store, storage, task.id, task.input.document.sha256, task.executionFingerprint!), units: AssemblyUnit[] = [];
  const load = async (identity: UnitIdentity) => {
    const saved = await results.get(identity);
    invariant(!saved || saved.record.round <= task.retry, "UNIT_RESULT_INVALID", "Saved unit belongs to a future retry round");
    return { index: identity.index, payload: saved?.record.status === "succeeded" ? saved.payload : null, failureCode: saved?.record.code ?? "UNIT_NOT_COMPLETED" };
  };
  const options = { answerSheet: task.input.documentRole === "answers", deduplicateQuestions: task.settings.deduplicateQuestions, retryCounts: task.retryCounts, sourceType: task.input.document.sourceType };
  let assemble: () => Promise<ReturnType<typeof assembleTextUnits>>;
  if (readRecognizedManifest(storage, task).recognized.textRef !== null) {
    const source = readSavedTextInputs(storage, task);
    for (const index of sourceIndexes(task, "document_parse", source.chunks.chunkRefs.length)) {
      const { identity, scope } = textUnitInput(storage, task, source.chunks, index), unit = await load(identity);
      if (unit.payload) unit.payload.parsed = validateSourceFields(unit.payload.parsed, scope);
      units.push(unit);
    }
    assemble = async () => assembleTextUnits(units, source.sourceText, source.chunks.spans, { ...options, headers: source.chunks.headers, warnings: source.recognized.warnings, truncated: source.recognized.truncated });
  } else {
    const source = readSavedOcrInputs(storage, task);
    for (const index of sourceIndexes(task, "vision_parse", source.pages.length, source.recognized.version === 2 ? source.recognized.inputParts : [])) {
      const unit = await load(ocrUnitInput(task, source, index).identity);
      if (unit.payload) validateSavedOcrUnit(unit.payload, source.pages[index], index);
      units.push(unit);
    }
    assemble = () => assembleOcrUnits(units.filter(unit => unit.payload), source.pages, { ...options, originalText: source.original, pageRefs: source.pageRefs, splitSource: Boolean(source.recognized.inputParts.length), visualTotal: units.length, failures: units.filter(unit => !unit.payload).map(unit => ({ stage: "vision_parse", index: unit.index, code: unit.failureCode!, retryable: false })), warnings: source.recognized.warnings, truncated: source.recognized.truncated }, async visuals => ({
      visuals: visuals.map(visual => {
        const reference = visual.page == null ? null : source.pageRefs[visual.page];
        return reference && ["image/png", "image/jpeg"].includes(reference.mediaType) ? { ...visual, sourceRef: reference } : visual;
      }), failures: [], truncated: false, limit: 0,
    }));
  }
  for (;;) {
    if (!units.some(unit => unit.payload)) return null;
    try {
      const assembled = await assemble();
      if (!assembled.result.questions.length) return null;
      assembled.result.warnings = ["This is a partial snapshot; unfinished units are not included.", ...assembled.result.warnings].slice(0, 1000);
      assembled.result.missingFields = [...new Set([...assembled.result.missingFields ?? [], "questions" as const])];
      assembled.processing.quality!.reviewRequired = true;
      return { ...assembled, status: "PARTIAL" as const };
    } catch (error) {
      if (!(error instanceof UnitMergeConflict)) throw error;
      invariant(error.indexes.length && error.indexes.every(index => units.some(unit => unit.index === index && unit.payload)), "UNIT_RESULT_INVALID", "Merge rejection has no successful source unit");
      for (const index of error.indexes) units[units.findIndex(unit => unit.index === index)] = { index, payload: null, failureCode: "OUTPUT_INVALID" };
    }
  }
}

export async function completedDetail(storage: AiStorage, store: SqliteStore, task: DocumentRecord, detail: DocumentTaskDetail): Promise<DocumentTaskDetail> {
  if (["PENDING", "RUNNING", "PAUSING", "EXPIRED"].includes(detail.state)) return { ...detail, canExportCompleted: false };
  if (task.input.generateAnswers && task.outputs.assemble?.result && !task.outputs.answers && detail.result && detail.processing) {
    const projected = new AnswerResults(store, task).project(detail.result, detail.processing);
    return { ...detail, result: projected.result, processing: projected.processing, status: "PARTIAL", canExportCompleted: Boolean(projected.result.questions.length) };
  }
  if (detail.result || !detail.checkpointId || !["PAUSED", "FAILED", "INTERRUPTED", "CANCELLED", "WAITING_REVIEW"].includes(detail.state) || !task.outputs.recognize?.manifest) return detail;
  const projected = await completedResult(storage, store, task); if (!projected) return detail;
  const failures = new Map(detail.failures.map(failure => [`${failure.stage}:${failure.index}`, failure]));
  for (const failure of projected.processing.failures) failures.set(`${failure.stage}:${failure.index}`, failure);
  const counts = (value: UnitCounts, stage: "document_parse" | "vision_parse") => {
    const failed = projected.processing.failures.filter(failure => failure.stage === stage && failure.code !== "UNIT_NOT_COMPLETED").length;
    return { total: value.total, succeeded: value.succeeded, failed, remaining: value.total - value.succeeded - failed };
  };
  const progress: TaskProgress = { chunks: counts(projected.processing.chunks, "document_parse"), visuals: counts(projected.processing.visuals, "vision_parse") };
  return { ...detail, ...projected, progress, failures: [...failures.values()], canExportCompleted: true };
}
