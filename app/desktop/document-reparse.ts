import { randomUUID } from "node:crypto";
import type { ArtifactReference, DocumentTaskReparse } from "../src/contracts.generated.js";
import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { parseJson } from "./document-contract.js";
import { executionFingerprint, DOCUMENT_TTL_MS } from "./document-execution.js";
import { DocumentTasks, type DocumentConfiguration, type DocumentRecord, type ReparseAdmission } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { executionJson, SqliteStore } from "./graph-store.js";
import { readSavedOcrInputs, ocrUnitInput, validateSavedOcrUnit } from "./ocr-inputs.js";
import { canonical } from "./questions.js";
import { REPARSE_WARNING, sourceIndexes } from "./source-selection.js";
import { readRecognizedManifest, readSavedTextInputs, textUnitInput } from "./text-inputs.js";
import { UnitResults, type SavedUnit, type UnitIdentity, type UnitPayload } from "./unit-results.js";
import { validateSourceFields } from "./source-fields.js";

/** Fork verified recognition evidence into an independently admitted JS task. */
export class DocumentReparser {
  constructor(readonly tasks: DocumentTasks, readonly store: SqliteStore) {}
  async create(id: string, input: unknown, config: DocumentConfiguration) {
    validateContract("DocumentTaskReparse", input); const request = structuredClone(input) as DocumentTaskReparse; id = id.toLowerCase(); request.requestId = request.requestId.toLowerCase(); request.selection ??= null;
    if (request.selection) {
      invariant(request.selection.units.every(unit => ["document_parse", "vision_parse"].includes(unit.stage) && Number.isSafeInteger(unit.index)), "SOURCE_SELECTION_INVALID", "Selective reparse requires valid parsing units");
      request.selection.units = [...new Map(request.selection.units.map(unit => [`${unit.stage}:${unit.index}`, unit])).values()];
    }
    const originDigest = hash(canonical({ kind: "reparse", parentThreadId: id, request })), previous = this.tasks.replay(request.requestId, originDigest);
    if (previous) { invariant(Date.now() < this.tasks.record(previous.threadId).createdAt + DOCUMENT_TTL_MS, "TASK_EXPIRED", "Reparse task expired; saved results remain available"); return previous; }
    invariant("secrets" in config, "MODEL_NOT_CONFIGURED", "New reparse work requires its credential snapshot");
    invariant(config.secrets.modelApiKey && config.preferences.model.baseUrl && config.preferences.model.modelId, "MODEL_NOT_CONFIGURED", "Configure a model before starting reparse work");
    const parent = this.tasks.record(id); invariant(Date.now() < parent.createdAt + DOCUMENT_TTL_MS, "TASK_EXPIRED", "Source task expired; saved results remain available"); this.tasks.storage.source(parent.input.document);
    const admission: ReparseAdmission = { id: randomUUID(), parentId: id, parentVersion: parent.updatedAt, originDigest };
    if (request.selection) {
      invariant(request.selection.checkpointId === parent.checkpointId, "STALE_CHECKPOINT", "The reviewed source checkpoint changed");
      invariant(parent.state === "COMPLETED", "SOURCE_SELECTION_INVALID", "Selective reparse requires a completed source task");
      admission.outputs = await this.seed(parent, request, admission.id, executionFingerprint(config));
    }
    const { document, graphId, failurePolicy, pages, documentRole, deduplicateQuestions, generateAnswers } = parent.input;
    return this.tasks.create({ requestId: request.requestId, document, graphId, failurePolicy, pages, documentRole, deduplicateQuestions, generateAnswers, parentThreadId: parent.id, reparseSelection: request.selection }, config, admission);
  }
  private async seed(parent: DocumentRecord, request: DocumentTaskReparse, childId: string, fingerprint: string): Promise<NonNullable<ReparseAdmission["outputs"]>> {
    const { storage } = this.tasks, { recognized } = readRecognizedManifest(storage, parent), selected = request.selection!.units, originalChunkManifest = recognized.chunkManifest, units: SavedUnit[] = [];
    const results = new UnitResults(this.store, storage, parent.id, parent.input.document.sha256, parent.executionFingerprint!); let identities: UnitIdentity[], validate: (payload: UnitPayload, identity: UnitIdentity) => void;
    if (recognized.textRef) {
      const source = readSavedTextInputs(storage, parent), available = sourceIndexes(parent, "document_parse", source.chunks.chunkRefs.length);
      invariant(selected.every(unit => unit.stage === "document_parse" && available.includes(unit.index)), "SOURCE_SELECTION_INVALID", "Selected text unit is unavailable");
      identities = selected.map(unit => textUnitInput(storage, parent, source.chunks, unit.index).identity);
      validate = (payload, identity) => { validateSourceFields(payload.parsed, textUnitInput(storage, parent, source.chunks, identity.index).scope); };
    } else {
      const source = readSavedOcrInputs(storage, parent), available = sourceIndexes(parent, "vision_parse", source.pages.length, recognized.version === 2 ? recognized.inputParts : []);
      invariant(selected.every(unit => unit.stage === "vision_parse" && available.includes(unit.index)), "SOURCE_SELECTION_INVALID", "Selected OCR unit is unavailable");
      identities = selected.map(unit => ocrUnitInput(parent, source, unit.index).identity);
      validate = (payload, identity) => validateSavedOcrUnit(payload, source.pages[identity.index], identity.index);
    }
    for (const identity of identities) { const saved = await results.get(identity); invariant(saved?.payload && ["succeeded", "rejected"].includes(saved.record.status) && saved.record.round <= parent.retry, "SOURCE_SELECTION_INVALID", "Selected source unit is not complete"); validate(saved.payload, identity); this.tasks.readArtifact(parent.id, saved.record.resultRef!); units.push(saved.record); }
    invariant(parent.outputs.prepare && parent.outputs.recognize, "SOURCE_SELECTION_INVALID", "Source task has no saved preparation and recognition");
    for (const output of [parent.outputs.prepare, parent.outputs.recognize]) for (const reference of output.artifacts) this.tasks.readArtifact(parent.id, reference);
    const replacements = new Map<string, ArtifactReference>();
    const rewrite = async (reference: ArtifactReference, value: unknown, kind: string) => {
      this.tasks.readArtifact(parent.id, reference); const written = await storage.putArtifact(Buffer.from(executionJson(value)), parent.input.document.sha256, kind, 0, "application/json"); replacements.set(canonical(reference), written); return written;
    };
    const prepareRef = parent.outputs.prepare.manifest;
    invariant(prepareRef, "SOURCE_SELECTION_INVALID", "Source task has no preparation manifest");
    const plan = parseJson(this.tasks.readArtifact(parent.id, prepareRef)) as Record<string, unknown>;
    invariant(plan.taskId === parent.id && canonical(plan.source) === canonical(parent.input.document), "SOURCE_SELECTION_INVALID", "Source preparation belongs to another task");
    const prepare = await rewrite(prepareRef, { ...plan, taskId: childId, ...(Object.hasOwn(plan, "executionFingerprint") ? { executionFingerprint: fingerprint } : {}) }, "tencent-inputs");
    if (recognized.chunkManifest) {
      const chunks = parseJson(this.tasks.readArtifact(parent.id, recognized.chunkManifest)) as Record<string, unknown>;
      recognized.chunkManifest = await rewrite(recognized.chunkManifest, { ...chunks, taskId: childId }, "chunk-inputs");
    }
    if (recognized.version !== 1) recognized.prepareManifest = prepare;
    const warnings = recognized.warnings; recognized.warnings = warnings.length < 1000 ? [...warnings, REPARSE_WARNING] : [...warnings.slice(0, -1), `${warnings.at(-1)} ${REPARSE_WARNING}`];
    const recognitionRef = parent.outputs.recognize.manifest!; await rewrite(recognitionRef, recognized, "recognized-text");
    const evidence = await storage.putArtifact(Buffer.from(executionJson({ version: 1, taskId: childId, parentThreadId: parent.id, parentCheckpointId: parent.checkpointId, sourceSha256: parent.input.document.sha256, executionFingerprint: parent.executionFingerprint!, selection: request.selection!, prepare: prepareRef, recognize: recognitionRef, chunkManifest: originalChunkManifest, units })), parent.input.document.sha256, "reparse-evidence", 0, "application/json");
    const remap = (reference: ArtifactReference) => replacements.get(canonical(reference)) ?? reference;
    const text = selected[0].stage === "document_parse", counts = (total: number) => ({ total, succeeded: 0, failed: 0, remaining: total });
    const retained = [evidence, prepareRef, recognitionRef, ...(originalChunkManifest ? [originalChunkManifest] : []), ...units.map(unit => unit.resultRef!)];
    return { prepare: { ...parent.outputs.prepare, manifest: prepare, artifacts: [...parent.outputs.prepare.artifacts.map(remap), ...retained] }, recognize: { ...parent.outputs.recognize, manifest: remap(recognitionRef), artifacts: parent.outputs.recognize.artifacts.map(remap), progress: { chunks: counts(text ? selected.length : 0), visuals: counts(text ? 0 : selected.length) } } };
  }
}
