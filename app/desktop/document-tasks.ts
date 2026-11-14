import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactReference, DocumentParseResult, DocumentProcessing, DocumentTaskControl, DocumentTaskCreate, DocumentTaskDetail, DocumentTaskHead, DocumentTaskList, DocumentTaskReceipt, FailedUnit, ImportSettings, TaskProgress, UnitFailure } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSettingsView, AiSnapshot } from "./ai-settings.js";
import { AiStorage, validateSourceReference } from "./ai-storage.js";
import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { transaction } from "./database.js";
import { parseJson, validateParsedDocument, validateProcessing } from "./document-contract.js";
import { AppError, invariant } from "./errors.js";
import { unreadableDetail, unreadableEvidence } from "./document-diagnostics.js";
import { regularFileExists, syncDirectory } from "./filesystem.js";
import { object } from "./question-contract.js";
import { canonical } from "./questions.js";
import type { SqliteStore } from "./graph-store.js";
import { MAX_UNIT_RETRIES, retryFailures, retryKey, selectRetryUnits } from "./retry-policy.js";

import { callAllocations, DOCUMENT_TTL_MS, executionBuildFingerprint, executionFingerprint } from "./document-execution.js";
export { DOCUMENT_TTL_MS } from "./document-execution.js";
export const DOCUMENT_VERSION = "typescript-document-v1";
export const DOCUMENT_STAGES = ["prepare", "recognize", "structure", "assemble", "answers"] as const;
export type DocumentStage = typeof DOCUMENT_STAGES[number];
type State = DocumentTaskDetail["state"];
export interface DocumentStageOutput { artifacts: ArtifactReference[]; manifest?: ArtifactReference; result?: ArtifactReference; processing?: ArtifactReference; failures?: UnitFailure[]; progress?: TaskProgress; status?: "SUCCEEDED" | "PARTIAL" }
interface Target { provider: string; baseUrl: string; modelId: string; version: string }
export interface DocumentRecord {
  id: string; inputDigest: string; input: DocumentTaskCreate; settings: ImportSettings; target: Target; maxCalls: number;
  version: string; executionBuild?: string; executionFingerprint?: string; state: State; phase: DocumentTaskDetail["phase"]; runId: string; checkpointId: string | null;
  desired: "pause" | "interrupt" | null; errorCode: string | null; failedStage: DocumentStage | null; retry: number; retryCounts?: Record<string, number>;
  outputs: Partial<Record<DocumentStage, DocumentStageOutput>>; retryBase: Partial<Record<DocumentStage, DocumentStageOutput>> | null; retryUnits: FailedUnit[]; createdAt: number; updatedAt: number; deleting?: true;
}
export interface ReparseAdmission { id: string; parentId: string; parentVersion: number; originDigest: string; outputs?: Pick<Record<DocumentStage, DocumentStageOutput>, "prepare" | "recognize"> }
const schema = `CREATE TABLE document_tasks(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE document_operations(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES document_tasks(id),digest TEXT NOT NULL,receipt TEXT NOT NULL CHECK(json_valid(receipt)),created_at INTEGER NOT NULL);
CREATE TABLE document_artifacts(task_id TEXT NOT NULL REFERENCES document_tasks(id),object_key TEXT NOT NULL,reference TEXT NOT NULL CHECK(json_valid(reference)),PRIMARY KEY(task_id,object_key));
CREATE INDEX document_tasks_created ON document_tasks(created_at DESC,id DESC);
PRAGMA user_version=1;`;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const active = (state: State) => ["PENDING", "RUNNING", "PAUSING"].includes(state);
export type DocumentConfiguration = AiSnapshot | AiSettingsView;
const targetOf = (config: DocumentConfiguration): Target => ({ provider: config.preferences.model.provider, baseUrl: config.preferences.model.baseUrl, modelId: config.preferences.model.modelId, version: DOCUMENT_VERSION });
const configured = (config: DocumentConfiguration): boolean => Boolean(config.preferences.model.baseUrl && config.preferences.model.modelId && ("secrets" in config ? config.secrets.modelApiKey : config.configured.modelApiKey));
const emptyProgress = (): TaskProgress => ({ chunks: { total: 0, succeeded: 0, failed: 0, remaining: 0 }, visuals: { total: 0, succeeded: 0, failed: 0, remaining: 0 } });
const expired = (record: DocumentRecord): boolean => Date.now() >= record.createdAt + DOCUMENT_TTL_MS;
const expiresAt = (record: DocumentRecord): string => new Date(record.createdAt + DOCUMENT_TTL_MS).toISOString();
function requireLive(record: DocumentRecord): void { invariant(!expired(record), "TASK_EXPIRED", "Document task expired; saved evidence remains available"); }
const phases: Record<DocumentStage, DocumentTaskDetail["phase"]> = { prepare: "prepare", recognize: "vision", structure: "chunk", assemble: "result", answers: "answer_generation" };
const states: State[] = ["PENDING", "RUNNING", "PAUSING", "PAUSED", "INTERRUPTED", "CANCELLED", "FAILED", "WAITING_REVIEW", "COMPLETED", "EXPIRED"];
const MAX_TASK_TIMESTAMP = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
function recordOutputs(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([stage, output]) => DOCUMENT_STAGES.includes(stage as DocumentStage) && output !== null && typeof output === "object" && !Array.isArray(output) && Array.isArray(object(output).artifacts) && (object(output).artifacts as unknown[]).length <= 2000);
}
const finalOutput = (record: DocumentRecord) => record.outputs.answers ?? record.outputs.assemble ?? record.retryBase?.answers ?? record.retryBase?.assemble;

function controlRequest(input: unknown) {
  validateContract("DocumentTaskControl", input); const request = structuredClone(input) as DocumentTaskControl;
  request.requestId = request.requestId.toLowerCase(); request.runId ??= null; request.checkpointId ??= null; request.units ??= [];
  return { request, digest: hash(canonical(request)) };
}

/** Task admissions and operation receipts commit together; provider receipts remain independent. */
export class DocumentTasks {
  readonly db: DatabaseSync;
  private executionStore?: SqliteStore;
  private readonly unreadable = new Map<string, number>();
  private markUnreadable(record: DocumentRecord): void {
    this.unreadable.delete(record.id); this.unreadable.set(record.id, record.updatedAt);
    if (this.unreadable.size > 256) this.unreadable.delete(this.unreadable.keys().next().value!);
  }
  diagnostic(record: DocumentRecord, detail: DocumentTaskDetail): DocumentTaskDetail { this.markUnreadable(record); return unreadableDetail(detail); }
  private diagnosticState(record: DocumentRecord): State {
    if (record.deleting || expired(record)) return "EXPIRED";
    return this.unreadable.get(record.id) === record.updatedAt && !active(record.state) ? "FAILED" : record.state;
  }
  bindStore(store: SqliteStore): void { invariant(!this.executionStore || this.executionStore === store, "EXECUTION_STORE_REQUIRED", "Document runtime must retain its execution Store"); this.executionStore = store; }
  constructor(readonly directory: string, readonly storage: AiStorage, readonly calls: AiDatabase) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); const path = join(directory, "document-tasks-v1.sqlite"), expected = new DatabaseSync(":memory:"); expected.exec(schema);
    const definitions = (db: DatabaseSync) => canonical(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all());
    const validate = (db: DatabaseSync) => invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 && definitions(db) === definitions(expected), "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported document task database; existing data remains unchanged");
    try {
      if (regularFileExists(path)) { const candidate = new DatabaseSync(path, { readOnly: true }); try { candidate.exec("PRAGMA trusted_schema=OFF"); if (candidate.prepare("PRAGMA user_version").get()?.user_version !== 0 || candidate.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.n !== 0) validate(candidate); } finally { candidate.close(); } }
      this.db = new DatabaseSync(path);
      try {
        this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
        if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) { invariant(this.db.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0, "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Cannot initialize a nonempty task database"); transaction(this.db, () => this.db.exec(schema)); }
        validate(this.db); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); syncDirectory(directory);
      } catch (error) { this.db.close(); throw error; }
    } finally { expected.close(); }
  }
  close(): void { this.db.close(); }
  private readRecord(id: string): DocumentRecord {
    invariant(uuid(id), "TASK_NOT_FOUND", "Document task does not exist"); const row = this.db.prepare("SELECT record FROM document_tasks WHERE id=?").get(id.toLowerCase()); invariant(row, "TASK_NOT_FOUND", "Document task does not exist");
    try {
      invariant(typeof row.record === "string" && Buffer.byteLength(row.record) <= 16 * 1024 * 1024, "TASK_CHECKPOINT_UNREADABLE", "Saved task metadata exceeds its limit");
      const value = JSON.parse(row.record) as DocumentRecord;
      invariant(value !== null && typeof value === "object" && !Array.isArray(value), "TASK_CHECKPOINT_UNREADABLE", "Saved task metadata is invalid");
      invariant(value.deleting === undefined || value.deleting === true, "TASK_CHECKPOINT_UNREADABLE", "Saved deletion fence is invalid");
      invariant([value.executionBuild, value.executionFingerprint].every(value => value === undefined || typeof value === "string" && /^[a-f0-9]{64}$/.test(value)), "TASK_CHECKPOINT_UNREADABLE", "Saved execution fingerprint is invalid");
      invariant(value.id === id.toLowerCase() && /^[a-f0-9]{64}$/.test(value.inputDigest) && value.version === DOCUMENT_VERSION && Number.isSafeInteger(value.maxCalls) && value.maxCalls >= 1 && value.maxCalls <= 10000 && uuid(value.runId) && Number.isSafeInteger(value.retry) && value.retry >= 0 && value.retry < Number.MAX_SAFE_INTEGER && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && value.createdAt <= MAX_TASK_TIMESTAMP - DOCUMENT_TTL_MS && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt && value.updatedAt <= MAX_TASK_TIMESTAMP, "TASK_CHECKPOINT_UNREADABLE", "Saved document task metadata is invalid or incompatible");
      invariant(states.includes(value.state) && [...Object.values(phases), "pending", "vision_review", "chunk_review", "result_review", "completed"].includes(value.phase) && (value.desired === null || ["pause", "interrupt"].includes(value.desired)) && (value.errorCode === null || typeof value.errorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(value.errorCode)) && (value.failedStage === null || DOCUMENT_STAGES.includes(value.failedStage)) && (value.checkpointId === null || typeof value.checkpointId === "string" && value.checkpointId.length > 0 && value.checkpointId.length <= 128), "TASK_CHECKPOINT_UNREADABLE", "Saved task lifecycle is invalid");
      invariant(recordOutputs(value.outputs) && (value.retryBase === null || recordOutputs(value.retryBase)) && Array.isArray(value.retryUnits) && value.retryUnits.length <= 2000, "TASK_CHECKPOINT_UNREADABLE", "Saved task stage metadata is invalid");
      invariant(["provider", "baseUrl", "modelId", "version"].every(key => typeof object(value.target)[key] === "string" && String(object(value.target)[key]).length <= 2048), "TASK_CHECKPOINT_UNREADABLE", "Saved task target is invalid");
      for (const unit of value.retryUnits) { validateContract("FailedUnit", unit); invariant(Number.isSafeInteger(unit.index), "TASK_CHECKPOINT_UNREADABLE", "Saved retry index is invalid"); }
      invariant(value.retryCounts === undefined || value.retryCounts !== null && typeof value.retryCounts === "object" && !Array.isArray(value.retryCounts) && Object.keys(value.retryCounts).length <= 10000 && Object.entries(value.retryCounts).every(([key, count]) => /^(?:(?:document_parse|vision_parse|vision_describe|visual_crop):(?:0|[1-9]\d{0,15})|stage:(?:prepare|recognize|structure|assemble|answers))$/.test(key) && Number.isSafeInteger(count) && count >= 0 && count <= MAX_UNIT_RETRIES), "TASK_CHECKPOINT_UNREADABLE", "Saved unit retry counts are invalid");
      validateContract("DocumentTaskCreate", value.input); validateSourceReference(value.input.document); validateContract("ImportSettings", value.settings);
      invariant(hash(canonical(value.input)) === value.inputDigest, "TASK_CHECKPOINT_UNREADABLE", "Saved document admission input changed"); return value;
    } catch (error) { if (!unreadableEvidence(error)) throw error; throw new AppError("TASK_CHECKPOINT_UNREADABLE", "Saved task metadata is unreadable; restore its original records before resuming"); }
  }
  record(id: string): DocumentRecord { const value = this.readRecord(id); invariant(!value.deleting, "TASK_DELETING", "Task deletion is incomplete; explicitly retry deletion"); return value; }
  cleanupCandidate(id: string, now: number) {
    const record = this.readRecord(id);
    invariant(["PENDING", "RUNNING", "PAUSING", "PAUSED", "INTERRUPTED", "CANCELLED", "FAILED", "WAITING_REVIEW", "COMPLETED", "EXPIRED"].includes(record.state), "TASK_CHECKPOINT_UNREADABLE", "Saved task lifecycle is invalid");
    if (active(record.state) || !record.deleting && now < record.createdAt + DOCUMENT_TTL_MS) return null;
    const { updatedAt: _updatedAt, deleting: _deleting, ...stable } = record;
    return { threadId: record.id, kind: record.deleting ? "deletion" as const : "expired" as const, fileName: record.input.document.fileName!, fingerprint: hash(canonical(stable)) };
  }
  beginDelete(id: string): void {
    invariant(uuid(id), "TASK_NOT_FOUND", "Document task does not exist");
    transaction(this.db, () => {
      if (!this.db.prepare("SELECT 1 FROM document_tasks WHERE id=?").get(id.toLowerCase())) return;
      const task = this.readRecord(id); invariant(!active(task.state), "TASK_BUSY", "Stop the task before deleting it");
      if (!task.deleting) { task.deleting = true; this.write(task); }
    });
  }
  finishDelete(id: string): void {
    invariant(uuid(id), "TASK_NOT_FOUND", "Document task does not exist"); id = id.toLowerCase();
    transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM document_tasks WHERE id=?").get(id)) invariant(this.readRecord(id).deleting, "INVALID_CONTROL", "Task deletion has no durable fence");
      this.db.prepare("DELETE FROM document_operations WHERE task_id=?").run(id); this.db.prepare("DELETE FROM document_artifacts WHERE task_id=?").run(id); this.db.prepare("DELETE FROM document_tasks WHERE id=?").run(id);
    });
  }
  private write(record: DocumentRecord): void {
    record.updatedAt = Math.max(Date.now(), record.updatedAt + 1); const bytes = canonical(record);
    invariant(Buffer.byteLength(bytes) <= 16 * 1024 * 1024, "LOCAL_FILE_TOO_LARGE", "Document task metadata exceeds its limit");
    invariant(this.db.prepare("UPDATE document_tasks SET updated_at=?,record=? WHERE id=?").run(record.updatedAt, bytes, record.id).changes === 1, "TASK_NOT_FOUND", "Document task does not exist");
  }
  replay(requestId: string, digest: string, taskId?: string): DocumentTaskReceipt | null {
    const row = this.db.prepare("SELECT task_id,digest,receipt FROM document_operations WHERE request_id=?").get(requestId);
    if (!row) return null;
    invariant(row.digest === digest && (!taskId || row.task_id === taskId), "REQUEST_CONFLICT", "This request ID was already used for another task or operation"); const receipt = JSON.parse(String(row.receipt)); validateContract("DocumentTaskReceipt", receipt); return receipt as DocumentTaskReceipt;
  }
  private receipt(task: DocumentRecord, requestId: string, digest: string): DocumentTaskReceipt {
    const receipt: DocumentTaskReceipt = { threadId: task.id, requestId, runId: task.runId, accepted: true };
    this.db.prepare("INSERT INTO document_operations VALUES(?,?,?,?,?)").run(requestId, task.id, digest, canonical(receipt), Date.now()); return receipt;
  }
  create(input: unknown, config: DocumentConfiguration, admission?: ReparseAdmission): DocumentTaskReceipt {
    validateContract("DocumentTaskCreate", input); const request = structuredClone(input) as DocumentTaskCreate; validateSourceReference(request.document);
    request.requestId = request.requestId.toLowerCase(); request.graphId ??= "document_parser"; request.failurePolicy ??= "return_partial"; request.documentRole ??= "questions"; request.pages = request.pages == null ? null : [...new Set(request.pages)].sort((a, b) => a - b); request.deduplicateQuestions ??= false; request.generateAnswers ??= false; request.officeMode ??= null; request.parentThreadId ??= null; request.reparseSelection ??= null;
    invariant(request.pages === null || request.pages.every(page => Number.isSafeInteger(page)), "SOURCE_SELECTION_INVALID", "Page numbers must be safe integers");
    invariant(request.officeMode === null && !(request.pages && ["text", "markdown"].includes(request.document.sourceType)) && !(request.documentRole === "answers" && request.generateAnswers) && (!["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(request.document.sourceType) || request.graphId === "document_parser"), "INVALID_REFERENCE", "Invalid document routing or import options");
    invariant(admission ? uuid(admission.id) && uuid(admission.parentId) && /^[a-f0-9]{64}$/.test(admission.originDigest) && request.parentThreadId === admission.parentId && Boolean(request.reparseSelection) === Boolean(admission.outputs) : request.parentThreadId === null && request.reparseSelection === null, "ACTION_UNAVAILABLE", "Selective reparse requires a verified source checkpoint");
    const digest = hash(canonical(request)), operationDigest = admission?.originDigest ?? digest, saved = this.replay(request.requestId, operationDigest); if (saved) return saved;
    invariant("secrets" in config, "MODEL_NOT_CONFIGURED", "New document work requires its credential snapshot");
    invariant(configured(config), "MODEL_NOT_CONFIGURED", "Configure the model and Tencent parser before starting document work");
    invariant(admission?.outputs || config.secrets.tencentSecretId && config.secrets.tencentSecretKey, "TENCENT_NOT_CONFIGURED", "Configure Tencent credentials before starting document work");
    this.storage.source(request.document);
    return transaction(this.db, () => {
      const saved = this.replay(request.requestId, operationDigest); if (saved) return saved;
      if (admission) {
        const parent = this.record(admission.parentId); requireLive(parent);
        invariant(parent.updatedAt === admission.parentVersion, "STALE_CHECKPOINT", "Source task changed while its reparse was prepared");
        invariant(canonical(request.document) === canonical(parent.input.document) && ["graphId", "failurePolicy", "pages", "documentRole", "deduplicateQuestions", "generateAnswers"].every(key => canonical(object(request)[key]) === canonical(object(parent.input)[key])), "SOURCE_SELECTION_INVALID", "Reparse must preserve its source and import options");
        if (request.reparseSelection) invariant(parent.state === "COMPLETED" && request.reparseSelection.checkpointId === parent.checkpointId, "STALE_CHECKPOINT", "Selective reparse requires the reviewed completed checkpoint");
      }
      invariant(this.unfinished().filter(record => record.createdAt > Date.now() - DOCUMENT_TTL_MS && record.executionBuild === executionBuildFingerprint()).length < 4, "QUEUE_FULL", "Document queue is full");
      const id = admission?.id ?? randomUUID(), now = Date.now(), record: DocumentRecord = { id, inputDigest: digest, input: request, settings: { ...config.preferences.import, deduplicateQuestions: request.deduplicateQuestions, generateAnswers: request.generateAnswers }, target: targetOf(config), maxCalls: config.preferences.maxCalls, version: DOCUMENT_VERSION, executionBuild: executionBuildFingerprint(), executionFingerprint: executionFingerprint(config), state: "PENDING", phase: "pending", runId: randomUUID(), checkpointId: null, desired: null, errorCode: null, failedStage: null, retry: 0, retryCounts: {}, outputs: structuredClone(admission?.outputs ?? {}), retryBase: null, retryUnits: [], createdAt: now, updatedAt: now };
      const references = Object.values(record.outputs).flatMap(output => [...this.verifyOutput(record, output).values()]);
      invariant(Buffer.byteLength(canonical(record)) <= 16 * 1024 * 1024, "LOCAL_FILE_TOO_LARGE", "Document task metadata exceeds its limit");
      this.db.prepare("INSERT INTO document_tasks VALUES(?,?,?,?)").run(id, now, now, canonical(record));
      for (const reference of references) this.db.prepare("INSERT OR IGNORE INTO document_artifacts VALUES(?,?,?)").run(id, reference.objectKey, canonical(reference));
      return this.receipt(record, request.requestId, operationDigest);
    });
  }
  compatible(record: DocumentRecord, config: DocumentConfiguration): boolean { try { return record.version === DOCUMENT_VERSION && record.executionBuild === executionBuildFingerprint() && record.executionFingerprint === executionFingerprint(config) && canonical(record.target) === canonical(targetOf(config)); } catch { return false; } }
  private failures(record: DocumentRecord): UnitFailure[] { const failures = DOCUMENT_STAGES.flatMap(stage => record.outputs[stage]?.failures ?? []); return retryFailures(failures, record.retryCounts ?? Object.fromEntries(failures.map(failure => [retryKey(failure), record.retry]))); }
  actions(record: DocumentRecord, config: DocumentConfiguration): DocumentTaskDetail["allowedActions"] {
    if (expired(record)) return [];
    if (active(record.state)) return record.desired ? ["interrupt"] : ["pause", "interrupt"];
    if (!record.checkpointId || !configured(config) || !this.compatible(record, config)) return [];
    const actions: DocumentTaskDetail["allowedActions"] = [];
    if (["PAUSED", "INTERRUPTED", "CANCELLED"].includes(record.state) || record.state === "FAILED" && !["TENCENT_SUBMISSION_UNKNOWN", "TENCENT_REQUEST_REJECTED", "MODEL_BUDGET_EXCEEDED", "NO_QUESTIONS_FOUND"].includes(record.errorCode ?? "")) actions.push("resume");
    if (this.failures(record).some(failure => failure.retryable) || record.failedStage && record.errorCode?.startsWith("AI_") && (record.retryCounts?.[`stage:${record.failedStage}`] ?? (record.retryCounts ? 0 : record.retry)) < MAX_UNIT_RETRIES) actions.push("retry_failed");
    if (record.state === "WAITING_REVIEW" && this.result(record)?.questions.length) actions.push("accept_partial"); return actions;
  }
  controlReplay(id: string, input: unknown): DocumentTaskReceipt | null {
    invariant(uuid(id), "TASK_NOT_FOUND", "Document task does not exist"); const { request, digest } = controlRequest(input); return this.replay(request.requestId, digest, id.toLowerCase());
  }
  control(id: string, input: unknown, config: DocumentConfiguration, expectedVersion?: number): DocumentTaskReceipt {
    invariant(uuid(id), "TASK_NOT_FOUND", "Document task does not exist"); id = id.toLowerCase();
    const { request, digest } = controlRequest(input);
    return transaction(this.db, () => {
      const saved = this.replay(request.requestId, digest, id); if (saved) return saved; const record = this.record(id);
      invariant(expectedVersion === undefined || record.updatedAt === expectedVersion, "STALE_CHECKPOINT", "Task changed during checkpoint validation");
      if (["pause", "interrupt"].includes(request.action)) {
        invariant(request.runId === record.runId && request.checkpointId === null && request.units!.length === 0, "STALE_RUN", "The target document run is no longer current");
        if (active(record.state)) { record.desired = request.action as "pause" | "interrupt"; if (request.action === "pause") record.state = "PAUSING"; this.write(record); }
      } else {
        requireLive(record);
        invariant(record.errorCode !== "TASK_CHECKPOINT_UNREADABLE", "TASK_CHECKPOINT_UNREADABLE", "This task requires its original evidence or an explicit new parse");
        invariant(!active(record.state), "TASK_BUSY", "Wait for the current document run to stop");
        invariant(request.checkpointId === record.checkpointId && request.runId === null, "STALE_CHECKPOINT", "The document checkpoint changed");
        invariant(this.compatible(record, config), "EXECUTION_VERSION_MISMATCH", "This checkpoint does not allow execution with changed code, runtime or model settings");
        invariant(this.actions(record, config).includes(request.action), "INVALID_CONTROL", "This checkpoint does not allow the requested operation");
        this.preflight(record);
        if (request.action === "accept_partial") { record.state = "COMPLETED"; record.phase = "completed"; }
        else {
          if (request.action === "retry_failed") {
            const failures = this.failures(record), selected = request.units!.length || failures.some(failure => failure.retryable) ? selectRetryUnits(failures, request.units!) : [];
            invariant(record.retryCounts !== undefined || record.retry === 0, "TASK_CHECKPOINT_UNREADABLE", "Historical retry counts require their original execution");
            const counts = { ...record.retryCounts }, keys = selected.length ? selected.map(retryKey) : [`stage:${record.failedStage}`];
            for (const key of keys) { invariant((counts[key] ?? 0) < MAX_UNIT_RETRIES, "RETRY_LIMIT_EXCEEDED", "Failed unit retry limit exceeded"); counts[key] = (counts[key] ?? 0) + 1; } record.retryCounts = counts;
            record.retry++; let first = DOCUMENT_STAGES.findIndex(stage => (record.outputs[stage]?.failures ?? []).some(failure => selected.some(unit => failure.stage === unit.stage && failure.index === unit.index)));
            if (selected.some(unit => ["document_parse", "vision_parse", "vision_describe"].includes(unit.stage))) first = Math.min(first, DOCUMENT_STAGES.indexOf("structure"));
            if (!selected.length && record.failedStage) first = DOCUMENT_STAGES.indexOf(record.failedStage);
            invariant(first >= 0, "INVALID_CONTROL", "No retryable failed units are selected");
            record.retryBase = structuredClone(record.outputs); record.retryUnits = structuredClone(selected);
            for (const stage of DOCUMENT_STAGES.slice(first)) delete record.outputs[stage];
          }
          record.state = "PENDING"; record.runId = randomUUID(); record.desired = null; record.errorCode = null; record.failedStage = null;
        }
        this.write(record);
      }
      return this.receipt(record, request.requestId, digest);
    });
  }
  update(id: string, runId: string, change: (record: DocumentRecord) => void): void {
    transaction(this.db, () => { const record = this.record(id); invariant(record.runId === runId, "STALE_RUN", "The document run is no longer current"); change(record); this.write(record); });
  }
  checkpoint(id: string, runId: string, checkpointId: string): void { invariant(checkpointId.length > 0 && checkpointId.length <= 128, "TASK_CHECKPOINT_UNREADABLE", "Invalid checkpoint identity"); this.update(id, runId, record => { record.checkpointId = checkpointId; }); }
  private preflight(record: DocumentRecord): void {
    invariant(!this.accounting(record).unreadable, "TASK_CHECKPOINT_UNREADABLE", "Saved model accounting is unreadable; restore its original records before resuming");
    this.storage.source(record.input.document);
    const seen = new Map<string, string>();
    for (const outputs of [record.outputs, record.retryBase]) {
      if (outputs === null) continue;
      invariant(outputs && typeof outputs === "object" && !Array.isArray(outputs) && Object.keys(outputs).every(stage => DOCUMENT_STAGES.includes(stage as DocumentStage)), "TASK_CHECKPOINT_UNREADABLE", "Saved stage outputs are invalid");
      for (const output of Object.values(outputs)) {
        invariant(output && Array.isArray(output.artifacts) && output.artifacts.length <= 2000, "TASK_CHECKPOINT_UNREADABLE", "Saved stage artifact list is invalid");
        for (const reference of output.artifacts) {
          validateContract("ArtifactReference", reference); const serialized = canonical(reference), previous = seen.get(reference.objectKey);
          invariant(!previous || previous === serialized, "INVALID_REFERENCE", "Saved artifact references conflict"); if (previous) continue;
          this.readArtifact(record.id, reference); seen.set(reference.objectKey, serialized);
        }
        for (const reference of [output.manifest, output.result, output.processing]) if (reference) invariant(output.artifacts.some(item => canonical(item) === canonical(reference)), "INVALID_REFERENCE", "Saved output has no verified artifact");
      }
    }
    const result = this.result(record); validateProcessing(this.processing(record), new Set(result?.questions.map(question => question.id!) ?? []));
  }
  begin(id: string, runId: string, config: AiSnapshot): void {
    this.update(id, runId, record => { requireLive(record); invariant(this.compatible(record, config), "EXECUTION_VERSION_MISMATCH", "Resume with the original execution version or create a new task"); invariant(record.state === "PENDING" && configured(config), "INVALID_CONTROL", "This document run cannot start"); this.preflight(record); record.state = record.desired ? record.state : "RUNNING"; });
    const record = this.record(id); this.calls.createTask(record.input.document.sha256, record.maxCalls, id);
  }
  stage(id: string, runId: string, stage: DocumentStage): DocumentRecord {
    this.update(id, runId, record => { requireLive(record); invariant(active(record.state) && !record.desired, "DOCUMENT_STOP_REQUESTED", "Document work was stopped before the next stage"); record.phase = phases[stage]; }); return this.record(id);
  }
  private verifyOutput(record: DocumentRecord, output: DocumentStageOutput): Map<string, ArtifactReference> {
    invariant(Object.keys(output).every(key => ["artifacts", "manifest", "result", "processing", "failures", "progress", "status"].includes(key)) && Array.isArray(output.artifacts) && output.artifacts.length <= 2000, "INVALID_REFERENCE", "Invalid stage output metadata");
    const byKey = new Map<string, ArtifactReference>();
    for (const reference of output.artifacts) {
      validateContract("ArtifactReference", reference);
      invariant(reference.objectKey.startsWith(`practiq-agent/artifacts/${record.input.document.sha256}/`) && (!byKey.has(reference.objectKey) || canonical(byKey.get(reference.objectKey)) === canonical(reference)), "INVALID_OBJECT_REFERENCE", "Artifact belongs to another source or has conflicting metadata");
      this.storage.artifact(reference); byKey.set(reference.objectKey, reference);
    }
    for (const reference of [output.manifest, output.result, output.processing]) if (reference) invariant(canonical(byKey.get(reference.objectKey)) === canonical(reference), "INVALID_REFERENCE", "Stage output reference was not verified");
    invariant(output.failures === undefined || Array.isArray(output.failures) && output.failures.length <= 2000, "LOCAL_RESPONSE_INVALID", "Invalid failed-unit metadata");
    for (const failure of output.failures ?? []) { validateContract("UnitFailure", failure); invariant(Number.isSafeInteger(failure.index), "LOCAL_RESPONSE_INVALID", "Invalid failed-unit index"); }
    if (output.progress) { validateContract("TaskProgress", output.progress); invariant(Object.values(output.progress).every(count => Object.values(count).every(Number.isSafeInteger) && count.total === count.succeeded + count.failed + count.remaining), "LOCAL_PROCESSING_COUNT_INVALID", "Invalid task progress totals", { key: "progress" }); }
    invariant(output.status === undefined || ["SUCCEEDED", "PARTIAL"].includes(output.status), "LOCAL_RESPONSE_INVALID", "Invalid document result status");
    return byKey;
  }
  saveOutput(id: string, runId: string, stage: DocumentStage, output: DocumentStageOutput): void {
    const byKey = this.verifyOutput(this.record(id), output);
    this.update(id, runId, record => {
      invariant(active(record.state), "STALE_RUN", "Document run already stopped");
      for (const reference of byKey.values()) {
        const saved = this.db.prepare("SELECT reference FROM document_artifacts WHERE task_id=? AND object_key=?").get(id, reference.objectKey), raw = canonical(reference);
        invariant(!saved || saved.reference === raw, "INVALID_REFERENCE", "Saved artifact metadata is immutable");
        this.db.prepare("INSERT OR IGNORE INTO document_artifacts VALUES(?,?,?)").run(id, reference.objectKey, raw);
      }
      record.outputs[stage] = structuredClone(output);
    });
  }
  finish(id: string, runId: string): void {
    const record = this.record(id), output = record.input.generateAnswers ? record.outputs.answers : record.outputs.assemble; invariant(output?.result && output.status, "DOCUMENT_PARSE_FAILED", "Document work has no verified final result"); const result = this.result(record)!, processing = this.processing(record); validateProcessing(processing, new Set(result.questions.map(question => question.id!)));
    const review = output.status === "PARTIAL" || processing?.quality?.reviewRequired || Boolean(processing?.quality?.issues?.length);
    this.update(id, runId, value => { value.state = review && value.input.failurePolicy === "review" ? "WAITING_REVIEW" : "COMPLETED"; value.phase = value.state === "WAITING_REVIEW" ? "result_review" : "completed"; value.desired = null; value.errorCode = null; });
  }
  stop(id: string, runId: string, code?: string, stage?: DocumentStage): void {
    this.update(id, runId, record => { record.state = record.desired === "interrupt" ? "CANCELLED" : record.desired === "pause" ? "PAUSED" : code ? "FAILED" : "INTERRUPTED"; record.desired = null; record.errorCode = code ?? null; record.failedStage = code ? stage ?? null : null; });
  }
  unfinished(): DocumentRecord[] {
    const records: DocumentRecord[] = [];
    for (const row of this.db.prepare("SELECT id FROM document_tasks WHERE CASE WHEN json_valid(record) THEN json_extract(record,'$.state') IN ('PENDING','RUNNING','PAUSING') ELSE 1 END ORDER BY created_at,id").iterate()) {
      try { const record = this.readRecord(String(row.id)); if (!record.deleting) records.push(record); }
      catch (error) { if (!(error instanceof AppError && error.code === "TASK_CHECKPOINT_UNREADABLE")) throw error; }
    }
    return records;
  }
  recover(id: string): void { const record = this.record(id); this.stop(id, record.runId); }
  result(record: DocumentRecord): DocumentParseResult | null {
    const reference = finalOutput(record)?.result; if (!reference) return null; const value = parseJson(this.storage.artifact(reference)); validateContract("DocumentParseResult", value); return validateParsedDocument(value) as unknown as DocumentParseResult;
  }
  private processing(record: DocumentRecord): DocumentProcessing | null {
    const reference = finalOutput(record)?.processing; if (!reference) return null; const value = parseJson(this.storage.artifact(reference)); validateContract("DocumentProcessing", value); return value as DocumentProcessing;
  }
  private savedResult(record: DocumentRecord) {
    try { const result = this.result(record), processing = this.processing(record); validateProcessing(processing, new Set(result?.questions.map(question => question.id!) ?? [])); return { result, processing, unreadable: false }; }
    catch (error) { if (!unreadableEvidence(error)) throw error; return { result: null, processing: null, unreadable: true }; }
  }
  private accounting(record: DocumentRecord) {
    const calls = this.calls.db.prepare("SELECT id,call_key,model,usage FROM ai_calls WHERE task_id=? AND endpoint!='https://ocr.tencentcloudapi.com' ORDER BY created_at,id LIMIT 10001").all(record.id);
    const usage: DocumentTaskDetail["usage"] = [], unknownUsageCalls: string[] = [], parserJobs: NonNullable<DocumentTaskDetail["parserJobs"]> = []; let unreadable = false, reserved: number | null = null;
    const inspect = (read: () => void) => { try { read(); } catch (error) { if (!unreadableEvidence(error)) throw error; unreadable = true; } };
    for (const call of calls) {
      let known = false;
      inspect(() => {
        invariant(uuid(call.id), "TASK_CHECKPOINT_UNREADABLE", "Saved model call identity is invalid"); if (call.usage === null) return;
        invariant(Buffer.byteLength(String(call.usage)) <= 65536, "TASK_CHECKPOINT_UNREADABLE", "Saved model usage exceeds its limit");
        const value = parseJson(Buffer.from(String(call.usage)));
        invariant(value !== null && typeof value === "object" && !Array.isArray(value), "TASK_CHECKPOINT_UNREADABLE", "Saved model usage is invalid");
        const item = object(value);
        if (item.inputTokens === undefined && item.outputTokens === undefined) { invariant(Object.keys(item).length === 0 || Object.keys(item).length === 1 && item.status === "unknown", "TASK_CHECKPOINT_UNREADABLE", "Saved unknown usage is invalid"); return; }
        invariant([item.inputTokens, item.outputTokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0) && (item.cachedInputTokens === undefined || Number.isSafeInteger(item.cachedInputTokens) && Number(item.cachedInputTokens) >= 0 && Number(item.cachedInputTokens) <= Number(item.inputTokens)), "TASK_CHECKPOINT_UNREADABLE", "Saved token totals are invalid");
        const entry = { callKey: String(call.id), modelId: String(call.model), inputTokens: Number(item.inputTokens), outputTokens: Number(item.outputTokens), callKind: String(call.call_key).startsWith("answer_generation:") ? "answer_generation" : "document_import" }; validateContract("ModelCallUsage", entry); usage.push(entry); known = true;
      });
      if (!known && uuid(call.id)) unknownUsageCalls.push(call.id);
    }
    inspect(() => {
      invariant(calls.length <= record.maxCalls, "TASK_CHECKPOINT_UNREADABLE", "Saved model receipts exceed the task budget");
      if (!this.executionStore) { reserved = calls.length; return; }
      const allocation = this.executionStore.read(["document_tasks", record.id, "call_allowances"], "ledger"), budget = this.executionStore.readNamespace(["document_tasks", record.id, "budget"]);
      invariant(allocation || calls.length === 0 && budget.length === 0, "TASK_CHECKPOINT_UNREADABLE", "Saved model work has lost its call allocation");
      const { units, reserved: total } = callAllocations(allocation?.value ?? null, record); let spent = 0;
      for (const item of budget) {
        const value = item.value, unit = units.get(item.key);
        invariant(unit && Object.keys(value).length === 3 && value.fingerprint === record.executionFingerprint && value.allowance === unit.allowance && Number.isSafeInteger(value.spent) && Number(value.spent) >= 0 && Number(value.spent) <= unit.allowance, "TASK_CHECKPOINT_UNREADABLE", "Saved unit spend is invalid or unallocated"); spent += Number(value.spent);
      }
      invariant(spent >= calls.length && spent <= total, "TASK_CHECKPOINT_UNREADABLE", "Saved model spend no longer covers its provider receipts"); reserved = total;
    });
    inspect(() => {
      const row = this.calls.db.prepare("SELECT source_digest,max_calls,state FROM ai_tasks WHERE id=?").get(record.id); if (!row) return;
      invariant(row.source_digest === record.input.document.sha256 && row.max_calls === record.maxCalls, "TASK_CHECKPOINT_UNREADABLE", "Saved provider task belongs to another input or budget");
      invariant(Buffer.byteLength(String(row.state)) <= 16 * 1024 * 1024, "TASK_CHECKPOINT_UNREADABLE", "Saved provider state exceeds its limit");
      const value = parseJson(Buffer.from(String(row.state))); invariant(value !== null && typeof value === "object" && !Array.isArray(value), "TASK_CHECKPOINT_UNREADABLE", "Saved provider task state is invalid");
      const jobs = object(value).tencentJobs; if (jobs === undefined) return;
      invariant(jobs !== null && typeof jobs === "object" && !Array.isArray(jobs) && Object.keys(jobs).length <= 300, "TASK_CHECKPOINT_UNREADABLE", "Saved recognition inventory is invalid");
      for (const value of Object.values(jobs)) inspect(() => {
        invariant(value !== null && typeof value === "object" && !Array.isArray(value), "TASK_CHECKPOINT_UNREADABLE", "Saved recognition job is invalid"); const job = object(value);
        invariant([job.taskId, job.requestId].every(value => value == null || typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)), "TASK_CHECKPOINT_UNREADABLE", "Saved recognition IDs are invalid");
        if (job.resultRef != null) validateContract("ArtifactReference", job.resultRef);
        const entry = { status: job.status, taskId: job.taskId ?? null, requestId: job.requestId ?? null, queryRequestId: job.queryRequestId ?? null, errorCode: job.errorCode ?? null, statusUpdatedAt: job.statusUpdatedAt ?? null, successPageCount: job.successPageCount ?? null, failedPageCount: job.failedPageCount ?? null, resultSaved: job.resultRef != null }; validateContract("DocumentParserJob", entry); parserJobs.push(entry as NonNullable<DocumentTaskDetail["parserJobs"]>[number]);
      });
    });
    return { usage, unknownUsageCalls, parserJobs, modelBudget: { limit: record.maxCalls, reserved }, unreadable };
  }
  detail(id: string, config: DocumentConfiguration): DocumentTaskDetail {
    const record = this.record(id); this.unreadable.delete(record.id);
    const saved = this.savedResult(record), { result, processing } = saved, accounting = this.accounting(record), { usage, unknownUsageCalls, parserJobs, modelBudget } = accounting;
    const progress = [...DOCUMENT_STAGES].reverse().map(stage => record.outputs[stage]?.progress).find(Boolean) ?? emptyProgress(), unreadable = saved.unreadable || accounting.unreadable;
    const detail: DocumentTaskDetail = { threadId: record.id, runId: record.runId, parentThreadId: record.input.parentThreadId ?? null, modelConfigured: configured(config), resumeCompatible: this.compatible(record, config), fileName: record.input.document.fileName!, documentRole: record.input.documentRole, pages: record.input.pages, state: expired(record) ? "EXPIRED" : record.state, phase: record.phase, checkpointId: record.checkpointId, updatedAt: new Date(record.updatedAt).toISOString(), expiresAt: expiresAt(record), allowedActions: unreadable ? active(record.state) ? record.desired ? ["interrupt"] : ["pause", "interrupt"] : [] : this.actions(record, config), failures: this.failures(record), blocking: [...(record.errorCode ? [{ code: record.errorCode }] : []), ...(accounting.unreadable ? [{ code: "TASK_ACCOUNTING_UNREADABLE" }] : [])], progress, status: finalOutput(record)?.status ?? null, result, processing, modelBudget, usage, unknownUsageCalls, canExportCompleted: Boolean(result?.questions.length), parserJobs };
    const value = unreadable || record.errorCode === "TASK_CHECKPOINT_UNREADABLE" ? this.diagnostic(record, detail) : detail; validateContract("DocumentTaskDetail", value); return value;
  }
  head(id: string, config: DocumentConfiguration): DocumentTaskHead { const record = this.record(id), head: DocumentTaskHead = { threadId: id, runId: record.runId, state: this.diagnosticState(record), checkpointId: record.checkpointId, updatedAt: new Date(record.updatedAt).toISOString(), modelConfigured: configured(config), resumeCompatible: this.unreadable.get(record.id) !== record.updatedAt && this.compatible(record, config) }; validateContract("DocumentTaskHead", head); return head; }
  list(offset = 0, limit = 20, filter = "", cursor?: string): DocumentTaskList {
    invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && (!filter || ["active", "PENDING", "RUNNING", "PAUSING", "PAUSED", "INTERRUPTED", "CANCELLED", "FAILED", "WAITING_REVIEW", "COMPLETED", "EXPIRED"].includes(filter)), "LOCAL_FILTER_INVALID", "Invalid task pagination or state filter");
    let after: [number, string] | null = null;
    if (cursor !== undefined) {
      try {
        invariant(typeof cursor === "string" && cursor.length > 0 && cursor.length <= 2048 && offset === 0 && /^[A-Za-z0-9_-]+$/.test(cursor), "INVALID_CURSOR", "Invalid task page cursor");
        const bytes = Buffer.from(cursor, "base64url"); invariant(bytes.toString("base64url") === cursor, "INVALID_CURSOR", "Invalid task page cursor"); const value = parseJson(bytes);
        invariant(Array.isArray(value) && value.length === 3 && typeof value[0] === "string" && uuid(value[1]) && value[1] === value[1].toLowerCase() && value[2] === filter, "INVALID_CURSOR", "Task page cursor belongs to another filter");
        const time = Date.parse(value[0]); invariant(Number.isSafeInteger(time) && time >= 0 && new Date(time).toISOString() === value[0], "INVALID_CURSOR", "Invalid task page position"); after = [time, value[1]];
      } catch { invariant(false, "INVALID_CURSOR", "Invalid task page cursor; refresh the task list"); }
    }
    // shortcut: state filters verify preceding saved results/accounting; index diagnostics if large histories make this scan costly.
    const rows = this.db.prepare(`SELECT id,created_at FROM document_tasks ${after ? "WHERE (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC`).iterate(...(after ?? []));
    const items: DocumentTaskList["items"] = []; let skipped = 0, last: { id: string; created: number } | null = null, more = false;
    for (const row of rows) {
      let item: DocumentTaskList["items"][number];
      try {
        const record = this.readRecord(String(row.id)), saved = record.deleting ? { result: null, unreadable: false } : this.savedResult(record);
        if (saved.unreadable || !record.deleting && this.accounting(record).unreadable) this.markUnreadable(record);
        const unavailable = this.unreadable.get(record.id) === record.updatedAt, result = unavailable ? null : saved.result;
        item = { threadId: record.id, fileName: record.input.document.fileName!, documentRole: record.input.documentRole, createdAt: new Date(record.createdAt).toISOString(), expiresAt: record.deleting ? new Date(record.updatedAt).toISOString() : expiresAt(record), state: this.diagnosticState(record), status: unavailable ? null : finalOutput(record)?.status ?? null, checkpointId: record.checkpointId, questionCount: result?.questions.length ?? 0, reviewCount: result?.questions.filter(question => question.needsReview).length ?? 0 };
        validateContract("DocumentTaskSummary", item);
      } catch (error) {
        if (!unreadableEvidence(error)) throw error;
        item = { threadId: String(row.id), fileName: "Unreadable task", createdAt: new Date(Number(row.created_at)).toISOString(), expiresAt: new Date(Number(row.created_at) + DOCUMENT_TTL_MS).toISOString(), state: Date.now() >= Number(row.created_at) + DOCUMENT_TTL_MS ? "EXPIRED" : "FAILED", status: null, checkpointId: null, questionCount: 0, reviewCount: 0 };
      }
      if (filter && item.state !== filter && !(filter === "active" && active(item.state))) continue;
      if (skipped++ < offset) continue;
      if (items.length === limit) { more = true; break; }
      items.push(item); last = { id: String(row.id), created: Number(row.created_at) };
    }
    const value: DocumentTaskList = { items, hasMore: more, nextCursor: more && last ? Buffer.from(canonical([new Date(last.created).toISOString(), last.id, filter])).toString("base64url") : null };
    validateContract("DocumentTaskList", value); return value;
  }
  readArtifact(id: string, reference: unknown): Buffer {
    const record = this.record(id);
    const { objectKey, sha256, sizeBytes, mediaType } = record.input.document;
    if (canonical(reference) === canonical(record.input.document) || canonical(reference) === canonical({ objectKey, sha256, sizeBytes, mediaType })) return this.storage.source(record.input.document);
    validateContract("ArtifactReference", reference); const requested = reference as ArtifactReference, saved = this.db.prepare("SELECT reference FROM document_artifacts WHERE task_id=? AND object_key=?").get(record.id, requested.objectKey);
    invariant(saved && saved.reference === canonical(reference), "INVALID_REFERENCE", "Artifact does not belong to this document task"); return this.storage.artifact(requested);
  }
}
