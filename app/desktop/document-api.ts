import type { ArtifactReference, DesktopBankZipReceipt, DesktopCostPreferences, DesktopDocumentBankSelection, DesktopDocumentReply, DesktopDocumentRequest, DesktopSourceRepairRequest, DocumentTaskDetail, DocumentTaskReview, ReviewUnit } from "../src/contracts.generated.js";
import { completedDetail } from "./completed-result.js";
import { AiDatabase } from "./ai-database.js";
import { AiStorage } from "./ai-storage.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { validateContract } from "./contracts.js";
import { parseJson } from "./document-contract.js";
import { DocumentRuntime } from "./document-runtime.js";
import { DocumentTasks, type DocumentConfiguration, type DocumentRecord } from "./document-tasks.js";
import { unreadableEvidence } from "./document-diagnostics.js";
import { AppError, invariant } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { canonical } from "./questions.js";
import { TencentResults } from "./tencent-results.js";
import { TencentClient } from "./tencent.js";
import { TextAssembler } from "./text-assembler.js";
import { TextDocuments } from "./text-documents.js";
import { readRecognizedManifest } from "./text-inputs.js";
import { TextStructures } from "./text-structures.js";
import { documentBankSnapshot } from "./document-bank.js";
import { DocumentRevisions } from "./document-corrections.js";
import { UnitResults, type SavedUnit, type UnitPayload } from "./unit-results.js";
import { AnswerGenerator } from "./answer-generation.js";
import { sourceIndexes } from "./source-selection.js";
import { DocumentReparser } from "./document-reparse.js";
import { SourceRepairs } from "./source-repair.js";
import { modelSlots, ProviderSlots, tencentSlots } from "./provider-slots.js";
import { exportDocumentBank } from "./document-bank-export.js";
import { DocumentMaintenance } from "./document-maintenance.js";
import { CostBudget } from "./cost-budget.js";
import { preparationSlots } from "./preparation.js";

/** The embedded task boundary owns one JS runtime and never starts work from a read or recovery. */
export class DocumentApi {
  readonly storage: AiStorage;
  readonly store: SqliteStore;
  readonly tasks: DocumentTasks;
  readonly runtime: DocumentRuntime;
  readonly revisions: DocumentRevisions;
  readonly repairs: SourceRepairs;
  readonly maintenance: DocumentMaintenance;
  readonly costs: CostBudget;
  private readonly requests = new Set<Promise<DesktopDocumentReply>>();
  private closing = false;
  private readonly ready: Promise<void>;
  private readonly exportSlots = new ProviderSlots();
  private readonly exporting = new Set<Promise<DesktopBankZipReceipt>>();
  constructor(directory: string, calls: AiDatabase, checkpoints: SqliteCheckpoints, model: ModelClient, tencent: TencentClient, costPolicy?: (required: boolean) => DesktopCostPreferences | undefined) {
    this.storage = new AiStorage(directory); this.store = new SqliteStore(directory); this.tasks = new DocumentTasks(directory, this.storage, calls);
    this.costs = new CostBudget(this.store, costPolicy); model.bindCosts(this.costs); tencent.bindCosts(this.costs);
    this.revisions = new DocumentRevisions(this.tasks, this.store);
    const documents = new TextDocuments(this.storage, new TencentResults(tencent, this.storage)), structures = new TextStructures(this.storage, model), assembler = new TextAssembler(this.storage), answers = new AnswerGenerator(this.storage, model);
    this.runtime = new DocumentRuntime(this.tasks, checkpoints, { prepare: context => documents.prepare(context), recognize: context => documents.recognize(context), structure: context => structures.structure(context), assemble: context => assembler.assemble(context), answers: context => answers.generate(context) }, this.store);
    this.repairs = new SourceRepairs(this.tasks, this.store, () => this.runtime.active() > 0);
    this.maintenance = new DocumentMaintenance(this.runtime, preview => this.requests.size === (preview ? 1 : 0) && !this.runtime.busy() && !this.repairs.busy() && this.exporting.size === 0 && !modelSlots.busy() && !tencentSlots.busy() && !preparationSlots.busy());
    this.ready = this.runtime.recover(); void this.ready.catch(() => {});
  }
  async request(input: unknown, config: DocumentConfiguration): Promise<DesktopDocumentReply> {
    validateContract("DesktopDocumentRequest", input); await this.ready; const command = input as DesktopDocumentRequest;
    invariant(!this.closing, "AI_RUNTIME_UNAVAILABLE", "AI runtime is closing");
    if (command.type === "cleanup_state") { const reply = { type: "cleanup_state" as const, value: await this.maintenance.run(command.value) }; validateContract("DesktopDocumentReply", reply); return reply; }
    invariant(!this.maintenance.busy(), "MAINTENANCE_BUSY", "Wait for task-state cleanup to finish");
    const work = this.dispatch(command, config).finally(() => this.requests.delete(work)); this.requests.add(work); return work;
  }
  private async dispatch(command: DesktopDocumentRequest, config: DocumentConfiguration): Promise<DesktopDocumentReply> {
    let reply: DesktopDocumentReply;
    if ("secrets" in config && (command.type === "create" || command.type === "reparse" || command.type === "control" && ["resume", "retry_failed"].includes(command.value.action))) invariant(command.revision === config.revision, "LOCAL_SETTINGS_CHANGED", "AI settings changed before document work was authorized");
    switch (command.type) {
      case "cost_report": reply = { type: "cost_report", value: await this.costs.report(config.preferences.cost, command.threadId?.toLowerCase()) }; break;
      case "maintenance_preview": reply = { type: "maintenance_preview", value: await this.maintenance.preview() }; break;
      case "cleanup_state": throw new AppError("ACTION_UNAVAILABLE", "Cleanup requires exclusive task ownership");
      case "export_bank_zip": throw new AppError("ACTION_UNAVAILABLE", "Bank ZIP export requires a native save dialog");
      case "delete": reply = { type: "delete", value: await this.runtime.delete(command.threadId) }; break;
      case "source_status": reply = { type: "source_status", value: this.repairs.status(command.threadId) }; break;
      case "repair_source": throw new AppError("ACTION_UNAVAILABLE", "Source repair requires a native file picker");
      case "bank": {
        const record = this.tasks.record(command.value.threadId), detail = await this.detail(record.id, config);
        const value = documentBankSnapshot(record, detail, command.value, command.value.revisionId ? this.revisions.read(record) : undefined); this.storage.source(record.input.document); reply = { type: "bank", value }; break;
      }
      case "import_bank": throw new AppError("ACTION_UNAVAILABLE", "Practice imports belong to the main process");
      case "corrections": reply = { type: "corrections", value: this.revisions.read(this.tasks.record(command.threadId)) }; break;
      case "save_correction": reply = { type: "save_correction", value: this.revisions.save(command.threadId, command.value) }; break;
      case "answer_matches": reply = { type: "answer_matches", value: this.revisions.matches(command.threadId, command.checkpointId, command.answerTaskId) }; break;
      case "answer_proposal": reply = { type: "answer_proposal", value: this.revisions.proposal(command.threadId, command.checkpointId, command.questionIndex, command.answerSource) }; break;
      case "capabilities": {
        const configured = "secrets" in config ? Object.fromEntries(Object.entries(config.secrets).map(([key, value]) => [key, Boolean(value)])) : config.configured;
        reply = { type: "capabilities", value: { sourceTypes: ["image", "text", "markdown", "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"], sourceMaxBytes: 150 * 1024 * 1024, officeSourceMaxBytes: (config.preferences.tencentCos.enabled ? 25 : 8) * 1024 * 1024, officeAvailable: true, officeModes: [], modelConfigured: Boolean(configured.modelApiKey && config.preferences.model.baseUrl && config.preferences.model.modelId), parserConfigured: Boolean(configured.tencentSecretId && configured.tencentSecretKey), parserInputMaxBytes: (config.preferences.tencentCos.enabled ? 150 : 8) * 1024 * 1024, modelBudget: { limit: config.preferences.maxCalls, unitCalls: 4, contextUnitCalls: 8 } } }; break;
      }
      case "import_settings": reply = { type: "import_settings", value: { revision: config.revision, settings: config.preferences.import } }; break;
      case "save_import_settings": throw new AppError("ACTION_UNAVAILABLE", "AI settings belong to the main process");
      case "create": reply = { type: "create", value: await this.runtime.create(command.value, config) }; break;
      case "reparse": reply = { type: "reparse", value: await this.runtime.start(await new DocumentReparser(this.tasks, this.store).create(command.threadId, command.value, config), config) }; break;
      case "control": reply = { type: "control", value: await this.runtime.control(command.threadId, command.value, config) }; break;
      case "list": reply = { type: "list", value: this.tasks.list(command.offset, command.limit, command.state, command.cursor) }; break;
      case "detail": reply = { type: "detail", value: await this.detail(command.threadId, config) }; break;
      case "head": reply = { type: "head", value: this.tasks.head(command.threadId.toLowerCase(), config) }; break;
      case "preview": reply = { type: "preview", value: await this.preview(command.threadId, command.includeResult, config) }; break;
      case "artifact": {
        invariant(command.reference.sizeBytes <= 150 * 1024 * 1024, "DOCUMENT_TOO_LARGE", "Artifact exceeds the desktop read limit");
        const bytes = this.tasks.readArtifact(command.threadId, command.reference); reply = { type: "artifact", value: { reference: command.reference, bytes: bytes.toString("base64") } }; break;
      }
    }
    validateContract("DesktopDocumentReply", reply); return reply;
  }
  async repairSource(id: string, request: DesktopSourceRepairRequest, path: string | null) { await this.ready; invariant(!this.closing && !this.maintenance.busy(), "MAINTENANCE_BUSY", "Wait for task-state cleanup to finish"); return this.repairs.repair(id, request, path); }
  exportBankZip(selection: DesktopDocumentBankSelection, config: DocumentConfiguration, destination: string): Promise<DesktopBankZipReceipt> {
    invariant(!this.closing && !this.maintenance.busy(), "MAINTENANCE_BUSY", "Wait for task-state cleanup to finish");
    validateContract("DesktopDocumentBankSelection", selection); selection = structuredClone(selection);
    const job = this.exportSlots.run(1, undefined, async () => {
      await this.ready; const record = this.tasks.record(selection.threadId), detail = await this.detail(record.id, config);
      const snapshot = documentBankSnapshot(record, detail, selection, selection.revisionId ? this.revisions.read(record) : undefined);
      await exportDocumentBank(this.tasks, selection, snapshot, record.updatedAt, destination);
      return { threadId: record.id, checkpointId: selection.checkpointId, saved: true };
    }).finally(() => this.exporting.delete(job)); this.exporting.add(job); return job;
  }
  private async detail(id: string, config: DocumentConfiguration) {
    const record = this.tasks.record(id); let detail = this.tasks.detail(record.id, config);
    if (!detail.blocking.some(value => value !== null && typeof value === "object" && "code" in value && value.code === "TASK_CHECKPOINT_UNREADABLE")) {
      try { await this.runtime.validateCheckpoint(record); detail = await completedDetail(this.storage, this.store, record, detail); await this.review(record, detail, false); }
      catch (error) { if (!unreadableEvidence(error)) throw error; detail = this.tasks.diagnostic(record, detail); }
    }
    invariant(this.tasks.record(record.id).updatedAt === record.updatedAt, "STALE_CHECKPOINT", "Task changed while its completed units were being read"); return detail;
  }
  private async preview(id: string, includeResult: boolean, config: DocumentConfiguration): Promise<DocumentTaskReview> {
    const detail = await this.detail(id, config), record = this.tasks.record(id);
    invariant(record.updatedAt === Date.parse(detail.updatedAt) && record.checkpointId === detail.checkpointId, "STALE_CHECKPOINT", "Task changed before its review was read");
    if (!detail.resumeCompatible && detail.blocking.some(value => value !== null && typeof value === "object" && "code" in value && value.code === "TASK_CHECKPOINT_UNREADABLE")) return { document: record.input.document, threadId: record.id, checkpointId: record.checkpointId, state: detail.state, phase: record.phase, units: [], failures: detail.failures, quality: { reviewRequired: true, reviewQuestionCount: 0, issues: [] }, questionSources: [], corrections: null };
    return this.review(record, detail, includeResult);
  }
  private async review(record: DocumentRecord, detail: DocumentTaskDetail, includeResult: boolean): Promise<DocumentTaskReview> {
    const units: ReviewUnit[] = [], seen = new Map<string, string>(); let bytes = 0;
    const reference = (value: ArtifactReference | null | undefined) => { if (!value) return null; const serialized = canonical(value), previous = seen.get(value.objectKey); invariant(previous === undefined || previous === serialized, "INVALID_REFERENCE", "Source aliases disagree"); if (!previous) { this.tasks.readArtifact(record.id, value); seen.set(value.objectKey, serialized); } return value; };
    const append = (unit: ReviewUnit) => { bytes += Buffer.byteLength(JSON.stringify(unit)); invariant(bytes <= 60 * 1024 * 1024, "REVIEW_TOO_LARGE", "Task review exceeds its read limit"); units.push(unit); };
    if (includeResult && detail.result) { const { objectKey, sha256, sizeBytes, mediaType } = record.input.document; append({ stage: "result", index: 0, questions: detail.result.questions, groups: detail.result.groups, visualElements: detail.result.visualElements, sourceRef: { objectKey, sha256, sizeBytes, mediaType } }); }
    if (record.outputs.recognize?.manifest) {
      const { recognized, owns } = readRecognizedManifest(this.storage, record);
      let chunks: ArtifactReference[] = [];
      if (recognized.chunkManifest) { owns(recognized.chunkManifest); const manifest = parseJson(this.storage.artifact(recognized.chunkManifest)) as { chunkRefs?: ArtifactReference[] }; invariant(Array.isArray(manifest.chunkRefs) && manifest.chunkRefs.length <= 1000, "CHUNK_INPUTS_INVALID", "Invalid text evidence inventory"); chunks = manifest.chunkRefs; }
      const appendUnit = (stage: SavedUnit["stage"], index: number, payload?: UnitPayload) => {
        const raster = recognized.version === 2 && stage === "vision_parse", page = raster ? recognized.pageRefs[index] : null, evidence = stage === "document_parse" ? chunks[index] : recognized.ocrPageRefs[index];
        invariant(evidence, "UNIT_RESULT_INVALID", "Review unit has no owned source evidence"); owns(evidence); if (page) owns(page);
        const part = recognized.version === 2 && recognized.inputParts.length ? recognized.inputParts[index] : null; if (part) owns(part.originalPageRef);
        for (const visual of payload?.visuals ?? []) { reference(visual.imageRef); reference(visual.sourceRef); }
        append({ stage, index, questions: payload?.parsed.questions ?? [], groups: payload?.parsed.groups ?? [], visualElements: payload?.visuals ?? [], sourceRef: reference(page ?? (stage === "document_parse" ? evidence : null)), evidenceRef: reference(evidence), originalPageRef: reference(part?.originalPageRef), sourcePage: part?.sourcePage ?? (raster ? index : null) });
      };
      if ((record.outputs.assemble ?? record.retryBase?.assemble)?.result && detail.result?.questions.length) {
        if (recognized.textRef !== null) for (const index of sourceIndexes(record, "document_parse", chunks.length)) appendUnit("document_parse", index);
        else for (const index of sourceIndexes(record, "vision_parse", recognized.ocrPageRefs.length, recognized.version === 2 ? recognized.inputParts : [])) appendUnit("vision_parse", index);
      } else {
        const results = new UnitResults(this.store, this.storage, record.id, record.input.document.sha256, record.executionFingerprint!), saved = await this.store.search(results.namespace, { limit: 1000 }); invariant(saved.length < 1000, "REVIEW_TOO_LARGE", "Task review has too many units");
        for (const item of saved.sort((left, right) => String(left.value.stage).localeCompare(String(right.value.stage)) || Number(left.value.index) - Number(right.value.index))) {
          const declared = item.value as unknown as SavedUnit; invariant(item.key === `${declared.stage}-${declared.index}` && declared.round <= record.retry, "UNIT_RESULT_INVALID", "Review unit identity changed");
          const unit = await results.get(declared); invariant(unit, "UNIT_RESULT_INVALID", "Review unit disappeared"); if (unit.payload) appendUnit(declared.stage, declared.index, unit.payload);
        }
      }
    }
    invariant(this.tasks.record(record.id).updatedAt === record.updatedAt, "STALE_CHECKPOINT", "Task changed while its review was being read");
    const review: DocumentTaskReview = { document: record.input.document, threadId: record.id, checkpointId: record.checkpointId, state: detail.state, phase: record.phase, units, failures: detail.failures, quality: detail.processing?.quality ?? { reviewRequired: false, reviewQuestionCount: 0, issues: [] }, questionSources: detail.processing?.questionSources ?? [], corrections: record.checkpointId && detail.state !== "EXPIRED" ? this.revisions.read(record) : null }; validateContract("DocumentTaskReview", review); return review;
  }
  async close(pending: readonly Promise<unknown>[] = []): Promise<void> {
    this.closing = true; await this.ready.catch(() => {}); await Promise.allSettled(this.requests); this.runtime.abortAll(); await this.runtime.settle(); await this.maintenance.settle(); await this.repairs.settle(); await Promise.allSettled([...this.exporting, ...pending]); this.store.stop(); this.tasks.close();
  }
}
