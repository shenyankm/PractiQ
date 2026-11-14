import { OcrAssembler } from "./ocr-assembler.js";
import { AiStorage } from "./ai-storage.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { canonical } from "./questions.js";
import { validateSourceFields } from "./source-fields.js";
import { assembleTextUnits, TextMergeConflict, type TextAssemblyUnit } from "./text-assembly.js";
import { readRecognizedText, readTextInputs, textUnitInput } from "./text-inputs.js";
import type { StructuredText } from "./text-structures.js";
import { UnitResults, type SavedUnit } from "./unit-results.js";
import { sourceIndexes } from "./source-selection.js";

export class TextAssembler {
  constructor(readonly storage: AiStorage) {}
  async assemble(context: DocumentStageContext): Promise<DocumentStageOutput> {
    if (readRecognizedText(this.storage, context).recognized.textRef === null) return new OcrAssembler(this.storage).assemble(context);
    const { task } = context, { recognized, chunks, chunkManifest, sourceText } = readTextInputs(this.storage, context), stage = task.outputs.structure, manifest = stage?.manifest;
    invariant(stage && manifest?.mediaType === "application/json" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/structured-text/`) && stage.artifacts.some(item => canonical(item) === canonical(manifest)), "UNIT_RESULT_INVALID", "Assembly requires its completed structured-text manifest");
    const structured = parseJson(this.storage.artifact(manifest)) as StructuredText, indexes = sourceIndexes(task, "document_parse", chunks.chunkRefs.length);
    invariant(structured !== null && typeof structured === "object" && Object.keys(structured).length === 6 && ["version", "taskId", "sourceSha256", "executionFingerprint", "chunkManifest", "units"].every(key => Object.hasOwn(structured, key)) && structured.version === 1 && structured.taskId === task.id && structured.sourceSha256 === task.input.document.sha256 && structured.executionFingerprint === task.executionFingerprint && canonical(structured.chunkManifest) === canonical(chunkManifest) && Array.isArray(structured.units) && structured.units.length === indexes.length, "UNIT_RESULT_INVALID", "Structured-text manifest belongs to another source or execution");
    const results = new UnitResults(context.store, this.storage, task.id, task.input.document.sha256, task.executionFingerprint!), units: TextAssemblyUnit[] = [], savedUnits: SavedUnit[] = [];
    for (const [position, declared] of structured.units.entries()) {
      const index = indexes[position];
      context.execution.guard(); const { identity, scope } = textUnitInput(this.storage, task, chunks, index);
      invariant(declared?.stage === identity.stage && declared.index === index && declared.inputDigest === identity.inputDigest && Number.isSafeInteger(declared.round) && declared.round >= 0 && declared.round <= task.retry, "UNIT_RESULT_INVALID", "Saved unit differs from its immutable fragment input");
      const loaded = await results.get(identity); invariant(loaded, "UNIT_RESULT_INVALID", "Structured unit has no durable receipt"); const saved = loaded.record;
      invariant(canonical(saved) === canonical(declared) || saved.status === "rejected" && declared.status === "succeeded" && canonical({ ...saved, status: "succeeded", code: null }) === canonical(declared), "UNIT_RESULT_INVALID", "Saved unit changed after its manifest committed");
      invariant(saved.status !== "unknown", "AI_RESULT_UNKNOWN", "A model unit has an unresolved outcome");
      if (saved.resultRef) invariant(stage.artifacts.some(item => canonical(item) === canonical(saved.resultRef)), "INVALID_REFERENCE", "Unit artifact does not belong to the completed structure stage");
      if (loaded.payload && saved.status === "succeeded") loaded.payload.parsed = validateSourceFields(loaded.payload.parsed, scope);
      savedUnits.push(saved); units.push({ index, payload: saved.status === "succeeded" ? loaded.payload : null, failureCode: saved.code ?? undefined });
    }
    let assembled: ReturnType<typeof assembleTextUnits>;
    for (;;) {
      try { assembled = assembleTextUnits(units, sourceText, chunks.spans, { headers: chunks.headers, warnings: recognized.warnings, truncated: recognized.truncated, answerSheet: task.input.documentRole === "answers", deduplicateQuestions: task.settings.deduplicateQuestions, retryCounts: task.retryCounts, sourceType: task.input.document.sourceType }); break; }
      catch (error) {
        if (!(error instanceof TextMergeConflict)) throw error;
        invariant(error.indexes.length, "UNIT_RESULT_INVALID", "Merge rejection has no source unit");
        for (const index of error.indexes) { context.execution.guard(false); const position = units.findIndex(unit => unit.index === index); invariant(units[position]?.payload && savedUnits[position]?.status === "succeeded", "UNIT_RESULT_INVALID", "Merge rejection does not identify a successful source unit"); await results.reject(savedUnits[position]); units[position] = { index, payload: null, failureCode: "OUTPUT_INVALID" }; }
      }
    }
    context.execution.guard(false);
    const result = await this.storage.putArtifact(Buffer.from(executionJson(assembled.result)), task.input.document.sha256, "result", task.retry, "application/json"), processing = await this.storage.putArtifact(Buffer.from(executionJson(assembled.processing)), task.input.document.sha256, "processing", task.retry, "application/json");
    context.execution.guard(false); const failed = assembled.processing.failures.length;
    return { artifacts: [result, processing], result, processing, status: assembled.status, failures: assembled.processing.failures, progress: { chunks: { total: units.length, succeeded: units.length - failed, failed, remaining: 0 }, visuals: { total: 0, succeeded: 0, failed: 0, remaining: 0 } } };
  }
}
