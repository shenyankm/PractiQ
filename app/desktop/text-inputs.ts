import type { ArtifactReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { hash } from "./assets.js";
import { ChunkInputs, type ChunkInputsManifest } from "./chunk-inputs.js";
import { parseJson } from "./document-contract.js";
import prompts from "./document-prompts.json" with { type: "json" };
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentRecord } from "./document-tasks.js";
import { invariant } from "./errors.js";
import type { StructuredInput } from "./model.js";
import { canonical } from "./questions.js";
import { validateSourceContext, type SourceFieldContext } from "./source-fields.js";
import type { RecognizedText } from "./text-documents.js";
import type { RecognizedRaster } from "./raster-documents.js";
import { officeSource, type RecognizedOffice } from "./office-documents.js";
import type { UnitIdentity } from "./unit-results.js";

export function readRecognizedText(storage: AiStorage, context: DocumentStageContext) {
  context.execution.guard();
  return readRecognizedManifest(storage, context.task);
}
export function readRecognizedManifest(storage: AiStorage, task: DocumentRecord) {
  const stage = task.outputs.recognize;
  invariant(["text", "markdown", "pdf", "image"].includes(task.input.document.sourceType) || officeSource(task.input.document.sourceType), "ACTION_UNAVAILABLE", "This model stage requires a verified source");
  const owns = (reference: ArtifactReference) => invariant(stage?.artifacts.some(item => canonical(item) === canonical(reference)), "INVALID_REFERENCE", "Model evidence must belong to the completed recognition stage");
  const manifest = stage?.manifest;
  invariant(manifest?.mediaType === "application/json" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/recognized-text/`), "CHUNK_INPUTS_INVALID", "Text structuring requires its completed recognition manifest"); owns(manifest);
  const recognized = parseJson(storage.artifact(manifest)) as RecognizedText | RecognizedRaster | RecognizedOffice;
  invariant(recognized !== null && typeof recognized === "object" && Object.keys(recognized).length === (recognized.version === 1 ? 8 : 10) && ["version", "source", "textRef", "ocrPageRefs", "inputParts", "warnings", "truncated", "chunkManifest"].every(key => Object.hasOwn(recognized, key)) && [1, 2, 3].includes(recognized.version) && canonical(recognized.source) === canonical(task.input.document) && typeof recognized.truncated === "boolean", "CHUNK_INPUTS_INVALID", "Invalid recognized source identity");
  if (recognized.version === 2) {
    invariant(["pdf", "image"].includes(task.input.document.sourceType) && Object.hasOwn(recognized, "pageRefs") && Object.hasOwn(recognized, "prepareManifest") && recognized.textRef === null && recognized.chunkManifest === null && Array.isArray(recognized.pageRefs) && canonical(recognized.prepareManifest) === canonical(task.outputs.prepare?.manifest), "CHUNK_INPUTS_INVALID", "Raster evidence requires its immutable preparation"); owns(recognized.prepareManifest);
    const prepared = parseJson(storage.artifact(recognized.prepareManifest)) as { source: unknown; pages: { reference: ArtifactReference }[]; parts: { reference: ArtifactReference }[] };
    invariant(canonical(prepared.source) === canonical(task.input.document) && Array.isArray(prepared.pages) && Array.isArray(prepared.parts) && canonical(recognized.inputParts) === canonical(prepared.parts) && canonical(recognized.pageRefs) === canonical(prepared.parts.length ? prepared.parts.map(part => part.reference) : prepared.pages.map(page => page.reference)), "CHUNK_INPUTS_INVALID", "Raster page evidence differs from its preparation");
  } else if (recognized.version === 3) {
    invariant(officeSource(task.input.document.sourceType) && recognized.textRef === null && recognized.chunkManifest === null && Array.isArray(recognized.pageRefs) && canonical(recognized.prepareManifest) === canonical(task.outputs.prepare?.manifest) && canonical(recognized.pageRefs) === canonical(recognized.ocrPageRefs), "CHUNK_INPUTS_INVALID", "Office evidence differs from its original preparation or OCR pages"); owns(recognized.prepareManifest);
    const prepared = parseJson(storage.artifact(recognized.prepareManifest)) as { source: unknown; submission: ArtifactReference; preparation: unknown };
    const preparation = task.input.document.sourceType === "xlsx" ? "visible_excel_sheets" : ["ppt", "pptx"].includes(task.input.document.sourceType) ? "visible_powerpoint_slides" : null;
    invariant((prepared.preparation === null || preparation !== null && prepared.preparation === preparation) && canonical(prepared.source) === canonical(task.input.document) && canonical(recognized.inputParts) === canonical(prepared.preparation ? [{ reference: prepared.submission, preparation: prepared.preparation }] : []), "CHUNK_INPUTS_INVALID", "Office evidence changed its derived visibility identity");
  } else invariant(["text", "markdown"].includes(task.input.document.sourceType), "CHUNK_INPUTS_INVALID", "Original-text evidence requires a UTF-8 source");
  invariant(Array.isArray(recognized.warnings) && recognized.warnings.length <= 1000 && recognized.warnings.every(value => typeof value === "string") && Array.isArray(recognized.ocrPageRefs) && Array.isArray(recognized.inputParts), "CHUNK_INPUTS_INVALID", "Invalid recognized text evidence metadata");
  return { recognized, owns, manifest };
}
export function readTextInputs(storage: AiStorage, context: DocumentStageContext) {
  return textInputs(storage, context.task, readRecognizedText(storage, context));
}
export function readSavedTextInputs(storage: AiStorage, task: DocumentRecord) {
  return textInputs(storage, task, readRecognizedManifest(storage, task));
}
function textInputs(storage: AiStorage, task: DocumentRecord, { recognized, owns }: ReturnType<typeof readRecognizedManifest>) {
  invariant(recognized.version === 1, "CHUNK_INPUTS_INVALID", "Original-text proofs require a text recognition manifest");
  invariant(task.retryUnits.every(unit => unit.stage === "document_parse"), "ACTION_UNAVAILABLE", "OCR parsing requires its page-specific stage");
  invariant(recognized.textRef !== null && recognized.chunkManifest !== null, "ACTION_UNAVAILABLE", "Differing OCR evidence requires its page model stage");
  invariant(!recognized.truncated && recognized.textRef.mediaType === "text/plain" && recognized.textRef.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/text/`), "CHUNK_INPUTS_INVALID", "Original-text field proofs require a complete verified text result");
  owns(recognized.textRef); owns(recognized.chunkManifest);
  const original = new TextDecoder("utf-8", { fatal: true }).decode(storage.source(task.input.document));
  invariant(storage.artifact(recognized.textRef).equals(Buffer.from(original)), "CHUNK_INPUTS_INVALID", "Recognized text no longer exactly proves the original source");
  const chunks = new ChunkInputs(storage).readSaved(task, recognized.chunkManifest, recognized.textRef, { complete: true });
  for (const reference of chunks.chunkRefs) owns(reference);
  return { recognized, chunks, sourceText: original, chunkManifest: recognized.chunkManifest };
}

export function textUnitInput(storage: AiStorage, task: DocumentRecord, chunks: ChunkInputsManifest, index: number) {
  const reference = chunks.chunkRefs[index], answerSheet = task.input.documentRole === "answers";
  const scope: SourceFieldContext = { index, expectedNodeCount: answerSheet ? null : chunks.nodeCounts[index], presence: answerSheet ? null : chunks.presence[index], requireTypeLabels: true }; validateSourceContext(scope);
  const presence = scope.presence === null ? null : Object.fromEntries(Object.entries(scope.presence).map(([id, hints]) => [`fragment:${index + 1}:${id}`, ["stem", "options", "analysis"].filter(field => hints[`need_${field}` as keyof typeof hints]).concat(hints.need_answer ? ["answerPayload"] : [])]));
  const header = chunks.headers[index], count = scope.expectedNodeCount;
  const input: StructuredInput = { schema: "UnitParseResult", promptVersion: prompts.version, system: prompts.system + (answerSheet ? prompts.answerSheet : ""), text: `File: ${task.input.document.fileName || "unknown"}\nSource type: ${task.input.document.sourceType}\nFragment ${index + 1} of ${chunks.chunkRefs.length}\n\n` + (header ? `Column header context for the original rows below: ${header}\nThis repeated header is context, not a question or a sourceText quote.\n\n` : "") + (count === null ? "" : `This fragment has exactly ${count} validated source records, including parent records. Return one question per record, preserving all parents and children; do not add or omit records.\n\n`) + (presence === null ? "" : `Use exactly these source record IDs and preserve each supplied field: ${JSON.stringify(presence)}\n\n`) + new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(storage.artifact(reference)) };
  const identity: UnitIdentity = { stage: "document_parse", index, round: task.retry, inputDigest: hash(canonical({ input, scope })) };
  return { scope, input, identity };
}
