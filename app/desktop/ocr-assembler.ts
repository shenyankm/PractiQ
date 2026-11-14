import type { ArtifactReference, UnitFailure } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { UnitMergeConflict, type AssemblyUnit } from "./assembly-finish.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { assembleOcrUnits } from "./ocr-assembly.js";
import { ocrUnitInput, readOcrInputs, validateSavedOcrUnit } from "./ocr-inputs.js";
import type { StructuredOcr } from "./ocr-structures.js";
import { canonical } from "./questions.js";
import { UnitResults, type SavedUnit } from "./unit-results.js";
import { cropVisuals } from "./visual-crops.js";
import { sourceIndexes } from "./source-selection.js";

/** Revalidate immutable page identities and resource associations before final publication. */
export class OcrAssembler {
  constructor(readonly storage: AiStorage) {}
  async assemble(context: DocumentStageContext): Promise<DocumentStageOutput> {
    const { task } = context, source = readOcrInputs(this.storage, context), stage = task.outputs.structure, manifest = stage?.manifest;
    invariant(stage && manifest?.mediaType === "application/json" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/structured-ocr/`) && stage.artifacts.some(item => canonical(item) === canonical(manifest)), "UNIT_RESULT_INVALID", "OCR assembly requires its completed structure manifest");
    const structured = parseJson(this.storage.artifact(manifest)) as StructuredOcr, indexes = sourceIndexes(task, "vision_parse", source.pages.length, source.recognized.version === 2 ? source.recognized.inputParts : []);
    invariant(structured !== null && typeof structured === "object" && Object.keys(structured).length === 6 && ["version", "taskId", "sourceSha256", "executionFingerprint", "recognitionManifest", "units"].every(key => Object.hasOwn(structured, key)) && structured.version === 1 && structured.taskId === task.id && structured.sourceSha256 === task.input.document.sha256 && structured.executionFingerprint === task.executionFingerprint && canonical(structured.recognitionManifest) === canonical(source.manifest) && Array.isArray(structured.units) && structured.units.length === indexes.length, "UNIT_RESULT_INVALID", "OCR structure manifest belongs to another source or execution");
    const results = new UnitResults(context.store, this.storage, task.id, task.input.document.sha256, task.executionFingerprint!), records: SavedUnit[] = [], units: AssemblyUnit[] = [];
    for (const [position, declared] of structured.units.entries()) {
      const index = indexes[position];
      context.execution.guard(); const { identity, page } = ocrUnitInput(task, source, index);
      invariant(declared?.stage === identity.stage && declared.index === index && declared.inputDigest === identity.inputDigest && Number.isSafeInteger(declared.round) && declared.round >= 0 && declared.round <= task.retry, "UNIT_RESULT_INVALID", "Saved OCR unit differs from its immutable page input");
      const loaded = await results.get(identity); invariant(loaded, "UNIT_RESULT_INVALID", "OCR page has no durable unit receipt"); const saved = loaded.record;
      invariant(canonical(saved) === canonical(declared) || saved.status === "rejected" && declared.status === "succeeded" && canonical({ ...saved, status: "succeeded", code: null }) === canonical(declared), "UNIT_RESULT_INVALID", "Saved OCR unit changed after its manifest committed");
      invariant(saved.status !== "unknown", "AI_RESULT_UNKNOWN", "OCR page has an unresolved outcome");
      if (saved.resultRef) invariant(stage.artifacts.some(item => canonical(item) === canonical(saved.resultRef)), "INVALID_REFERENCE", "OCR unit artifact does not belong to its completed structure stage");
      if (saved.status === "succeeded") validateSavedOcrUnit(loaded.payload, page, index);
      records.push(saved); units.push({ index, payload: saved.status === "succeeded" ? loaded.payload : null, failureCode: saved.code ?? undefined });
    }
    let assembled: Awaited<ReturnType<typeof assembleOcrUnits>>, cropArtifacts: ArtifactReference[] = [];
    for (;;) {
      const retained = units.filter(unit => unit.payload), failures: UnitFailure[] = units.filter(unit => !unit.payload).map(unit => ({ stage: "vision_parse", index: unit.index, code: unit.failureCode || "OUTPUT_INVALID", retryable: false }));
      try {
        assembled = await assembleOcrUnits(retained, source.pages, { originalText: source.original, pageRefs: source.pageRefs, sourceType: task.input.document.sourceType, splitSource: Boolean(source.recognized.inputParts.length), visualTotal: units.length, failures, warnings: source.recognized.warnings, truncated: source.recognized.truncated, answerSheet: task.input.documentRole === "answers", deduplicateQuestions: task.settings.deduplicateQuestions, retryCounts: task.retryCounts }, async visuals => {
          context.execution.guard(false); const cropped = await cropVisuals(this.storage, task.input.document.sha256, visuals, source.recognized.version === 2 ? new Map(source.pageRefs.map((reference, index) => [index, reference])) : new Map(), task.input.document.sourceType, context.signal);
          cropArtifacts = cropped.visuals.flatMap(visual => visual.imageRef?.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/crop-`) ? [visual.imageRef] : []); return cropped;
        }); break;
      } catch (error) {
        if (!(error instanceof UnitMergeConflict)) throw error;
        invariant(error.indexes.length, "UNIT_RESULT_INVALID", "OCR merge rejection has no source page");
        for (const index of error.indexes) { context.execution.guard(false); const position = units.findIndex(unit => unit.index === index); invariant(units[position]?.payload && records[position]?.status === "succeeded", "UNIT_RESULT_INVALID", "OCR merge rejection does not identify a successful page"); await results.reject(records[position]); units[position] = { index, payload: null, failureCode: "OUTPUT_INVALID" }; }
      }
    }
    context.execution.guard(false); const result = await this.storage.putArtifact(Buffer.from(executionJson(assembled.result)), task.input.document.sha256, "result", task.retry, "application/json"), processing = await this.storage.putArtifact(Buffer.from(executionJson(assembled.processing)), task.input.document.sha256, "processing", task.retry, "application/json");
    context.execution.guard(false); const failed = assembled.processing.failures.filter(failure => failure.stage === "vision_parse").length;
    return { artifacts: [result, processing, ...cropArtifacts], result, processing, status: assembled.status, failures: assembled.processing.failures, progress: { chunks: { total: 0, succeeded: 0, failed: 0, remaining: 0 }, visuals: { total: units.length, succeeded: units.length - failed, failed, remaining: 0 } } };
  }
}
