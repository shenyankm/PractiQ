import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentTaskDetail, DocumentTaskReview } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { DocumentRuntime } from "./document-runtime.js";
import { DOCUMENT_TTL_MS } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";
import { BoundedZip } from "./zip.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.calls.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-diagnostics-")), calls = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path), http = vi.fn(async (): Promise<Response> => { throw Error("Diagnostics cannot call providers"); });
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const api = new DocumentApi(path, calls, checkpoints, new ModelClient(calls, http), new TencentClient(calls, http)), source = Buffer.from("Supplied source and answers"), sha256 = hash(source), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length }; await api.storage.putSource(document, source);
  const zip = await BoundedZip.open(new URL("../fixtures/service-export/partial-media-bank.zip", import.meta.url).pathname, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  let root; try { root = JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString()); } finally { zip.close(); }
  const runtime = new DocumentRuntime(api.tasks, checkpoints, { prepare: async () => ({ artifacts: [] }), recognize: async () => ({ artifacts: [] }), structure: async () => ({ artifacts: [] }), assemble: async () => {
    const result = await api.storage.putArtifact(Buffer.from(JSON.stringify(root.result)), sha256, "result", 0, "application/json"), processing = await api.storage.putArtifact(Buffer.from(JSON.stringify(root.processing)), sha256, "processing", 0, "application/json"); return { artifacts: [result, processing], result, processing, status: root.status };
  } }, api.store);
  const add = async () => { const task = api.tasks.create({ requestId: randomUUID(), document }, config); await runtime.run(task.threadId, config); expect(api.tasks.record(task.threadId).state).toBe("COMPLETED"); return api.tasks.record(task.threadId); };
  const record = await add(), f = { path, calls, checkpoints, api, config, http, document, source, record, add }; fixtures.push(f); return f;
}
function snapshot(f: Awaited<ReturnType<typeof setup>>) {
  return { tasks: f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all(), operations: f.api.tasks.db.prepare("SELECT * FROM document_operations ORDER BY request_id").all(), artifacts: f.api.tasks.db.prepare("SELECT * FROM document_artifacts ORDER BY task_id,object_key").all(), calls: f.calls.db.prepare("SELECT * FROM ai_calls ORDER BY id").all(), aiTasks: f.calls.db.prepare("SELECT * FROM ai_tasks ORDER BY id").all(), checkpoints: f.checkpoints.db.prepare("SELECT * FROM checkpoints ORDER BY thread_id,id").all(), writes: f.checkpoints.db.prepare("SELECT * FROM checkpoint_writes ORDER BY thread_id,checkpoint_id,task_id,idx").all(), store: f.api.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all() };
}
async function detail(f: Awaited<ReturnType<typeof setup>>) { return (await f.api.request({ type: "detail", revision: f.config.revision, threadId: f.record.id }, f.config)).value as DocumentTaskDetail; }

async function paid(f: Awaited<ReturnType<typeof setup>>) {
  const target = { inputDigest: f.document.sha256, endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" };
  f.calls.claim(f.record.id, "known", target); f.calls.finish(f.record.id, "known", "succeeded", {}, { inputTokens: 11, outputTokens: 5 }); const unknown = f.calls.claim(f.record.id, "unknown", target);
  await f.api.store.put(["document_tasks", f.record.id, "call_allowances"], "ledger", { fingerprint: f.record.executionFingerprint!, limit: 64, units: { fixture: { calls: 2, allowance: 2 } } });
  await f.api.store.put(["document_tasks", f.record.id, "budget"], "fixture", { fingerprint: f.record.executionFingerprint!, allowance: 2, spent: 2 }); return unknown;
}

it.each(["input", "digest", "null", "array", "json", "oversized", "state", "phase", "outputs", "retry_base", "retry_units", "desired", "target", "updated_at", "timestamp_range", "checkpoint", "error_code"])('isolates a damaged %s admission at startup and restores its original metadata without replay', async kind => {
  const f = await setup(), unknown = await paid(f), healthy = await f.add(), original = f.api.tasks.db.prepare("SELECT record FROM document_tasks WHERE id=?").get(f.record.id)!.record;
  const broken: Record<string, unknown> = { ...f.record, state: "RUNNING" };
  if (kind === "input") broken.input = null; else if (kind === "digest") broken.inputDigest = "a".repeat(64); else if (kind === "phase") broken.phase = "private-signed-url";
  else if (kind === "outputs") broken.outputs = []; else if (kind === "retry_base") broken.retryBase = { prepare: null }; else if (kind === "retry_units") broken.retryUnits = {};
  else if (kind === "desired") broken.desired = "resume"; else if (kind === "target") broken.target = null; else if (kind === "updated_at") broken.updatedAt = -1; else if (kind === "error_code") broken.errorCode = "private signed URL";
  else if (kind === "state") broken.state = "unknown"; else if (kind === "checkpoint") broken.checkpointId = {}; else if (kind === "oversized") broken.extra = "x".repeat(16 * 1024 * 1024);
  else if (kind === "timestamp_range") { broken.createdAt = Date.UTC(10000, 0, 1); broken.updatedAt = broken.createdAt; }
  const raw = kind === "json" ? '{"state":"RUNNING","truncated":' : JSON.stringify(kind === "null" ? null : kind === "array" ? [] : broken);
  f.api.tasks.db.exec("PRAGMA ignore_check_constraints=ON"); try { f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(raw, f.record.id); } finally { f.api.tasks.db.exec("PRAGMA ignore_check_constraints=OFF"); } const before = snapshot(f);
  await f.api.close(); f.api = new DocumentApi(f.path, f.calls, f.checkpoints, new ModelClient(f.calls, f.http), new TencentClient(f.calls, f.http));
  const list = await f.api.request({ type: "list", revision: f.config.revision, offset: 0, limit: 20, state: "" }, f.config);
  expect(list).toMatchObject({ value: { items: expect.arrayContaining([expect.objectContaining({ threadId: f.record.id, state: "FAILED", fileName: "Unreadable task" }), expect.objectContaining({ threadId: healthy.id, state: "COMPLETED" })]) } });
  await expect(detail(f)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  await expect(f.api.request({ type: "head", revision: f.config.revision, threadId: f.record.id }, f.config)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  const accepted = JSON.parse(String(f.api.tasks.db.prepare("SELECT receipt FROM document_operations WHERE request_id=?").get(f.record.input.requestId)!.receipt));
  expect(await f.api.request({ type: "create", revision: f.config.revision, value: f.record.input }, f.config)).toEqual({ type: "create", value: accepted });
  for (const action of ["pause", "interrupt", "resume", "retry_failed", "accept_partial"]) await expect(f.api.runtime.control(f.record.id, { requestId: randomUUID(), action, runId: f.record.runId, checkpointId: f.record.checkpointId }, f.config)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  await expect(f.api.runtime.delete(f.record.id)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  expect(snapshot(f)).toEqual(before); expect(f.calls.receipt(f.record.id, "unknown")?.id).toBe(unknown.id); expect(f.api.storage.source(f.document)).toEqual(f.source); expect(f.http).not.toHaveBeenCalled();
  f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(original, f.record.id); await f.api.runtime.recover();
  expect(await detail(f)).toMatchObject({ state: "COMPLETED", resumeCompatible: true, unknownUsageCalls: [unknown.id], result: { questions: expect.any(Array) } }); expect(f.calls.receipt(f.record.id, "unknown")?.status).toBe("unknown"); expect(f.http).not.toHaveBeenCalled();
});

it("keeps four corrupt running admissions out of capacity and recovers healthy work without provider calls", async () => {
  const f = await setup();
  for (let i = 0; i < 4; i++) { const id = randomUUID(); f.api.tasks.db.prepare("INSERT INTO document_tasks VALUES(?,?,?,?)").run(id, f.record.createdAt, f.record.updatedAt, JSON.stringify({ ...f.record, id, state: "RUNNING", input: null })); }
  const damaged = f.api.tasks.db.prepare("SELECT * FROM document_tasks WHERE id<>? ORDER BY id").all(f.record.id), pending = f.api.tasks.create({ requestId: randomUUID(), document: f.document }, f.config);
  await f.api.runtime.recover(); expect(f.api.tasks.record(pending.threadId)).toMatchObject({ state: "INTERRUPTED", checkpointId: expect.any(String) }); expect(f.http).not.toHaveBeenCalled();
  vi.spyOn(f.api.runtime.stages, "prepare").mockImplementation(async () => { throw new AppError("TEST_PREPARATION_STOP", "Stop before provider work"); });
  const admitted = await f.api.request({ type: "create", revision: f.config.revision, value: { requestId: randomUUID(), document: f.document } }, f.config); expect(admitted.type).toBe("create"); if (admitted.type !== "create") throw Error("Wrong receipt"); await f.api.runtime.wait(admitted.value.threadId);
  expect(f.api.tasks.record(admitted.value.threadId)).toMatchObject({ state: "FAILED", errorCode: "TEST_PREPARATION_STOP" });
  expect(f.api.tasks.db.prepare("SELECT * FROM document_tasks WHERE id<>? AND id<>? AND id<>? ORDER BY id").all(f.record.id, pending.threadId, admitted.value.threadId)).toEqual(damaged); expect(f.http).not.toHaveBeenCalled();
});

it("replays an acknowledged resume after primary damage and requires an explicit continuation after original-record restoration", async () => {
  const f = await setup(), unknown = await paid(f); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = "PAUSED"; });
  const request = { requestId: randomUUID(), action: "resume", checkpointId: f.record.checkpointId }, accepted = f.api.tasks.control(f.record.id, request, f.config), original = f.api.tasks.db.prepare("SELECT record FROM document_tasks WHERE id=?").get(f.record.id)!.record;
  f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(JSON.stringify({ ...f.api.tasks.record(f.record.id), input: null }), f.record.id); const before = snapshot(f);
  expect(await f.api.runtime.control(f.record.id, request, f.config)).toEqual(accepted); expect(f.api.runtime.active()).toBe(0); expect(snapshot(f)).toEqual(before);
  f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(original, f.record.id); await f.api.runtime.recover(); expect(f.api.tasks.record(f.record.id).state).toBe("INTERRUPTED"); expect(f.http).not.toHaveBeenCalled();
  await f.api.runtime.control(f.record.id, { requestId: randomUUID(), action: "resume", checkpointId: f.api.tasks.record(f.record.id).checkpointId }, f.config); await f.api.runtime.wait(f.record.id);
  expect(await detail(f)).toMatchObject({ state: "COMPLETED", unknownUsageCalls: [unknown.id] }); expect(f.calls.receipt(f.record.id, "unknown")?.status).toBe("unknown"); expect(f.http).not.toHaveBeenCalled();
});

it.each(["task_database", "checkpoint_io", "checkpoint_timeout"])("propagates %s outages during recovery without rewriting an admission", async kind => {
  const f = await setup(); f.api.tasks.create({ requestId: randomUUID(), document: f.document }, f.config); const before = snapshot(f);
  const error = kind === "checkpoint_timeout" ? new DOMException("Timed out", "TimeoutError") : Object.assign(new Error("Storage unavailable"), { code: kind === "task_database" ? "ERR_SQLITE_ERROR" : "EIO" });
  if (kind === "task_database") { const prepare = f.api.tasks.db.prepare.bind(f.api.tasks.db); vi.spyOn(f.api.tasks.db, "prepare").mockImplementation(sql => { if (sql.startsWith("SELECT record")) throw error; return prepare(sql); }); }
  else vi.spyOn(f.checkpoints, "getTuple").mockRejectedValue(error);
  await expect(f.api.runtime.recover()).rejects.toBe(error); vi.restoreAllMocks(); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["scalar", "array", "negative", "fraction", "unsafe", "partial", "cache", "unknown_shape"])("isolates %s usage while retaining valid totals and the uncertain call identity", async kind => {
  const f = await setup(), unknown = await paid(f), usage = kind === "scalar" ? "broken" : kind === "array" ? [] : kind === "negative" ? { inputTokens: -1, outputTokens: 2 } : kind === "fraction" ? { inputTokens: 1.5, outputTokens: 2 } : kind === "unsafe" ? { inputTokens: 1e20, outputTokens: 2 } : kind === "partial" ? { inputTokens: 1 } : kind === "cache" ? { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 } : { status: "unknown", unexpected: true };
  f.calls.db.prepare("UPDATE ai_calls SET usage=? WHERE id=?").run(JSON.stringify(usage), unknown.id); const before = snapshot(f), value = await detail(f);
  expect(value).toMatchObject({ state: "FAILED", resumeCompatible: false, allowedActions: [], modelBudget: { limit: 64, reserved: 2 }, usage: [{ inputTokens: 11, outputTokens: 5 }], unknownUsageCalls: [unknown.id], canExportCompleted: false }); expect(value.blocking).toContainEqual({ code: "TASK_ACCOUNTING_UNREADABLE" });
  expect(f.api.tasks.list(0, 20, "FAILED").items.map(item => item.threadId)).toContain(f.record.id); expect(f.api.tasks.head(f.record.id, f.config).resumeCompatible).toBe(false); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["missing", "fingerprint", "limit", "underallocated", "overspent", "lost_spend", "unallocated"])("reports unknown reservation totals for %s accounting without inventing zero", async kind => {
  const f = await setup(), unknown = await paid(f), path = ["document_tasks", f.record.id, "call_allowances"], budget = ["document_tasks", f.record.id, "budget"], allocation = f.api.store.read(path, "ledger")!.value;
  if (kind === "missing") await f.api.store.delete(path, "ledger");
  if (kind === "fingerprint") await f.api.store.put(path, "ledger", { ...allocation, fingerprint: "f".repeat(64) });
  if (kind === "limit") await f.api.store.put(path, "ledger", { ...allocation, limit: 63 });
  if (kind === "underallocated") await f.api.store.put(path, "ledger", { ...allocation, units: { fixture: { calls: 2, allowance: 1 } } });
  if (kind === "overspent") await f.api.store.put(budget, "fixture", { fingerprint: f.record.executionFingerprint!, allowance: 2, spent: 3 });
  if (kind === "lost_spend") await f.api.store.delete(budget, "fixture");
  if (kind === "unallocated") await f.api.store.put(budget, "borrowed", { fingerprint: f.record.executionFingerprint!, allowance: 1, spent: 0 });
  const before = snapshot(f), value = await detail(f); expect(value).toMatchObject({ state: "FAILED", allowedActions: [], resumeCompatible: false, modelBudget: { limit: 64, reserved: null }, usage: [{ inputTokens: 11, outputTokens: 5 }], unknownUsageCalls: [unknown.id] });
  expect((await f.api.request({ type: "preview", revision: f.config.revision, threadId: f.record.id, includeResult: false }, f.config)).value).toMatchObject({ state: "FAILED", units: [], corrections: null }); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["scalar_state", "array_jobs", "invalid_job", "source", "budget"])("isolates %s provider metadata and retains independent model receipts", async kind => {
  const f = await setup(); await paid(f);
  if (kind === "source" || kind === "budget") f.calls.db.prepare(`UPDATE ai_tasks SET ${kind === "source" ? "source_digest" : "max_calls"}=? WHERE id=?`).run(kind === "source" ? "f".repeat(64) : 63, f.record.id);
  else f.calls.saveState(f.record.id, kind === "scalar_state" ? [] : kind === "array_jobs" ? { tencentJobs: [] } : { tencentJobs: { good: { status: "SUBMITTING", requestId: "retained-request" }, bad: { status: "Success", requestId: { signedUrl: "PRIVATE" } } } });
  const before = snapshot(f), value = await detail(f); expect(value.state).toBe("FAILED"); expect(value.usage).toHaveLength(1); expect(value.unknownUsageCalls).toHaveLength(1); expect(value.blocking).toContainEqual({ code: "TASK_ACCOUNTING_UNREADABLE" });
  expect(value.parserJobs).toEqual(kind === "invalid_job" ? [expect.objectContaining({ status: "SUBMITTING", requestId: "retained-request" })] : []); expect(JSON.stringify(value)).not.toContain("PRIVATE"); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["resume", "retry_failed", "accept_partial"] as const)("refuses new %s admission with lost accounting before checkpoint writes, receipts or provider work", async action => {
  const f = await setup(); await paid(f); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = action === "accept_partial" ? "WAITING_REVIEW" : "FAILED"; record.failedStage = "structure"; record.errorCode = "AI_RESPONSE_INVALID"; }); await f.api.store.delete(["document_tasks", f.record.id, "call_allowances"], "ledger"); const before = snapshot(f);
  await expect(f.api.runtime.control(f.record.id, { requestId: randomUUID(), action, checkpointId: f.record.checkpointId }, f.config)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" }); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("clears an accounting diagnostic only after explicit refresh verifies restored records", async () => {
  const f = await setup(); await paid(f); const namespace = ["document_tasks", f.record.id, "call_allowances"], original = f.api.store.read(namespace, "ledger")!.value; await f.api.store.put(namespace, "ledger", {}); expect((await detail(f)).modelBudget.reserved).toBeNull();
  await f.api.store.put(namespace, "ledger", original); const before = snapshot(f); expect((await detail(f)).state).toBe("COMPLETED"); expect(f.api.tasks.head(f.record.id, f.config).resumeCompatible).toBe(true); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["PENDING", "RUNNING", "PAUSING", "EXPIRED"] as const)("preserves %s stop/expiry priority when call accounting is corrupt", async state => {
  const f = await setup(); await paid(f); await f.api.store.delete(["document_tasks", f.record.id, "call_allowances"], "ledger"); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = state === "EXPIRED" ? "COMPLETED" : state; if (state === "EXPIRED") record.createdAt = Date.now() - DOCUMENT_TTL_MS - 1; });
  const before = snapshot(f), value = await detail(f); expect(value).toMatchObject({ state, modelBudget: { limit: 64, reserved: null }, allowedActions: state === "EXPIRED" ? [] : ["pause", "interrupt"] }); expect(f.api.tasks.list().items[0].state).toBe(state); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["missing_result", "checksum", "invalid_json", "invalid_processing", "missing_checkpoint", "invalid_checkpoint", "wrong_admission", "manifest"])("isolates %s without modifying evidence or hiding independent usage receipts", async kind => {
  const f = await setup(), result = f.record.outputs.assemble!.result!, resultPath = join(f.api.storage.root, result.objectKey);
  f.calls.claim(f.record.id, "known", { inputDigest: f.document.sha256, endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" }); f.calls.finish(f.record.id, "known", "succeeded", {}, { inputTokens: 11, outputTokens: 5 });
  f.calls.claim(f.record.id, "unknown", { inputDigest: f.document.sha256, endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" });
  await f.api.store.put(["document_tasks", f.record.id, "call_allowances"], "ledger", { fingerprint: f.record.executionFingerprint!, limit: 64, units: { fixture: { calls: 2, allowance: 2 } } });
  await f.api.store.put(["document_tasks", f.record.id, "budget"], "fixture", { fingerprint: f.record.executionFingerprint!, allowance: 2, spent: 2 });
  if (kind === "missing_result") rmSync(resultPath);
  if (kind === "checksum") writeFileSync(resultPath, "damaged original bytes");
  if (["invalid_json", "invalid_processing", "manifest"].includes(kind)) {
    const ref = await f.api.storage.putArtifact(Buffer.from(kind === "invalid_json" ? "{" : "{}"), f.document.sha256, "invalid", 0, "application/json");
    f.api.tasks.update(f.record.id, f.record.runId, record => { if (kind === "manifest") record.outputs.recognize = { artifacts: [ref], manifest: ref }; else record.outputs.assemble![kind === "invalid_processing" ? "processing" : "result"] = ref; });
  }
  if (kind === "missing_checkpoint") await f.checkpoints.deleteThread(`document:${f.record.id}`);
  if (kind === "invalid_checkpoint") f.checkpoints.db.prepare("UPDATE checkpoints SET checkpoint=? WHERE thread_id=? AND id=?").run(Buffer.from("{"), `document:${f.record.id}`, f.record.checkpointId);
  if (kind === "wrong_admission") { const tuple = (await f.checkpoints.getTuple({ configurable: { thread_id: `document:${f.record.id}`, checkpoint_id: f.record.checkpointId } }))!; tuple.checkpoint.channel_values.inputDigest = "f".repeat(64); await f.checkpoints.put(tuple.config, tuple.checkpoint, tuple.metadata!); }
  const before = snapshot(f), value = await detail(f);
  expect(value).toMatchObject({ state: "FAILED", resumeCompatible: false, allowedActions: [], blocking: [{ code: "TASK_CHECKPOINT_UNREADABLE" }], result: null, processing: null, status: null, canExportCompleted: false, modelBudget: { limit: 64, reserved: 2 }, usage: [{ inputTokens: 11, outputTokens: 5 }] }); expect(value.unknownUsageCalls).toHaveLength(1);
  const preview = (await f.api.request({ type: "preview", revision: f.config.revision, threadId: f.record.id, includeResult: false }, f.config)).value as DocumentTaskReview; expect(preview).toMatchObject({ state: "FAILED", units: [], corrections: null });
  expect(f.api.tasks.head(f.record.id, f.config)).toMatchObject({ state: "FAILED", resumeCompatible: false }); expect(f.api.tasks.list().items[0].state).toBe("FAILED");
  await expect(f.api.exportBankZip({ threadId: f.record.id, checkpointId: f.record.checkpointId!, scope: "full" }, f.config, join(f.path, "blocked.zip"))).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  expect(snapshot(f)).toEqual(before); expect(f.api.storage.source(f.document)).toEqual(f.source); expect(f.http).not.toHaveBeenCalled();
});

it("keeps broken rows visible and filtered cursor pagination stable without adopting or deleting unknown metadata", async () => {
  const f = await setup(), valid = await f.add(), bad = await f.add(); f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(JSON.stringify({ version: "unknown" }), bad.id);
  const result = f.record.outputs.assemble!.result!; writeFileSync(join(f.api.storage.root, result.objectKey), "corrupt shared result"); const before = snapshot(f);
  const found = []; let cursor: string | undefined;
  do { const page = f.api.tasks.list(0, 1, "FAILED", cursor); found.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(new Set(found.map(item => item.threadId))).toEqual(new Set([f.record.id, valid.id, bad.id])); expect(found.find(item => item.threadId === bad.id)).toMatchObject({ fileName: "Unreadable task", checkpointId: null, questionCount: 0 });
  await expect(f.api.runtime.delete(bad.id)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" }); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("clears the volatile diagnostic only after an explicit refresh verifies restored bytes", async () => {
  const f = await setup(), path = join(f.api.storage.root, f.record.outputs.assemble!.result!.objectKey), original = readFileSync(path), before = snapshot(f); writeFileSync(path, "damaged"); await detail(f);
  writeFileSync(path, original); expect((await detail(f)).state).toBe("COMPLETED"); expect(f.api.tasks.head(f.record.id, f.config).resumeCompatible).toBe(true); expect(f.api.tasks.list(0, 20, "COMPLETED").items.map(item => item.threadId)).toContain(f.record.id); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["PENDING", "RUNNING", "PAUSING", "EXPIRED"] as const)("retains %s lifecycle priority and stop controls despite broken evidence", async state => {
  const f = await setup(); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = state === "EXPIRED" ? "COMPLETED" : state; if (state === "EXPIRED") record.createdAt = Date.now() - DOCUMENT_TTL_MS - 1; });
  writeFileSync(join(f.api.storage.root, f.record.outputs.assemble!.result!.objectKey), "damaged"); const before = snapshot(f), value = await detail(f); expect(value.state).toBe(state); expect(value.allowedActions).toEqual(state === "EXPIRED" ? [] : ["pause", "interrupt"]); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["resume", "retry_failed", "accept_partial"] as const)("refuses new %s admission on a missing checkpoint without resetting the graph or recording a receipt", async action => {
  const f = await setup(); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = action === "accept_partial" ? "WAITING_REVIEW" : "PAUSED"; }); await f.checkpoints.deleteThread(`document:${f.record.id}`); const before = snapshot(f);
  await expect(f.api.runtime.control(f.record.id, { requestId: randomUUID(), action, checkpointId: f.record.checkpointId }, f.config)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  await expect(f.api.runtime.initialize(f.record.id)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" }); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("replays an acknowledged control receipt even when the saved checkpoint later becomes unreadable", async () => {
  const f = await setup(); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = "WAITING_REVIEW"; }); const request = { requestId: randomUUID(), action: "accept_partial", checkpointId: f.record.checkpointId };
  const receipt = await f.api.runtime.control(f.record.id, request, f.config); await f.checkpoints.deleteThread(`document:${f.record.id}`); const before = snapshot(f);
  expect(await f.api.runtime.control(f.record.id, request, f.config)).toEqual(receipt); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("retains a durable unreadable-checkpoint failure as a diagnostic instead of offering resume", async () => {
  const f = await setup(); f.api.tasks.stop(f.record.id, f.record.runId, "TASK_CHECKPOINT_UNREADABLE"); const before = snapshot(f);
  expect(await detail(f)).toMatchObject({ state: "FAILED", allowedActions: [], result: null, resumeCompatible: false, canExportCompleted: false });
  await expect(f.api.runtime.control(f.record.id, { requestId: randomUUID(), action: "resume", checkpointId: f.record.checkpointId }, f.config)).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" }); expect(snapshot(f)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("fences a control admission when the task changes during its read-only checkpoint probe", async () => {
  const f = await setup(); f.api.tasks.update(f.record.id, f.record.runId, record => { record.state = "PAUSED"; }); const count = f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_operations").get()!.n;
  const validate = f.api.runtime.validateCheckpoint.bind(f.api.runtime); vi.spyOn(f.api.runtime, "validateCheckpoint").mockImplementation(async record => { await validate(record); f.api.tasks.update(record.id, record.runId, value => { value.errorCode = "DOCUMENT_RUN_FAILED"; }); });
  await expect(f.api.runtime.control(f.record.id, { requestId: randomUUID(), action: "resume", checkpointId: f.record.checkpointId }, f.config)).rejects.toMatchObject({ code: "STALE_CHECKPOINT" });
  expect(f.api.tasks.record(f.record.id).state).toBe("PAUSED"); expect(f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_operations").get()!.n).toBe(count); expect(f.http).not.toHaveBeenCalled();
});

it.each(["database", "closed_database", "store", "timeout", "file_io"])("propagates %s failures instead of misreporting corruption", async kind => {
  const f = await setup(), error = kind === "store" ? new AppError("EXECUTION_STORE_UNAVAILABLE", "Store closed") : kind === "timeout" ? new DOMException("Timed out", "TimeoutError") : kind === "closed_database" ? Object.assign(new TypeError("Database closed"), { code: "ERR_INVALID_STATE" }) : Object.assign(new Error("Storage unavailable"), { code: kind === "database" ? "ERR_SQLITE_ERROR" : "EIO" });
  if (kind === "store") vi.spyOn(f.api.store, "read").mockImplementation(() => { throw error; }); else if (kind === "file_io") vi.spyOn(f.api.storage, "artifact").mockImplementation(() => { throw error; }); else vi.spyOn(f.checkpoints, "getTuple").mockRejectedValue(error);
  await expect(detail(f)).rejects.toBe(error); expect(f.api.tasks.head(f.record.id, f.config).state).toBe("COMPLETED"); expect(f.http).not.toHaveBeenCalled();
});
