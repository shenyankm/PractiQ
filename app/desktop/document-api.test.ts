import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { DesktopDocumentReply, DesktopDocumentRequest } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSettingsView, AiSnapshot } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";
import { Worker } from "node:worker_threads";
import { assertKnownUnitCalls } from "./structured-call.js";
import { PracticeStore } from "./store.js";
import { AiClient } from "./ai-client.js";
import { DatabaseClient } from "./client.js";
import { importDocumentBank } from "./document-bank-import.js";
import { AppError } from "./errors.js";
import { readQuestions } from "./questions.js";
import sharp from "sharp";
import { canonical } from "./questions.js";
import { UnitResults } from "./unit-results.js";
import { readSavedTextInputs, textUnitInput } from "./text-inputs.js";
import { runPreparation, preparationSlots } from "./preparation.js";
import { DocumentTasks } from "./document-tasks.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function archive(source: Buffer) {
  const zip = new ZipFile(); zip.addBuffer(source, "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-api-")), db = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 16, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const view: AiSettingsView = { revision: config.revision, preferences: config.preferences, configured: { modelApiKey: true, tencentSecretId: true, tencentSecretKey: true } };
  const source = Buffer.from(Array.from({ length: 35 }, (_, index) => `${index + 1}. Short answer: Question ${index + 1}\nReference answer: A${index + 1}`).join("\n\n"));
  const modelHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text as string, match = /Use exactly these source record IDs and preserve each supplied field: (.*)\n\n/.exec(text);
    if (!match) throw new Error("Missing source records");
    const questions = Object.keys(JSON.parse(match[1])).map(id => { const number = id.split(":").at(-1); return { id, stem: `Question ${number}`, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: `A${number}` }, sourceText: `Question ${number}\nReference answer: A${number}`, analysis: null, confidence: 1, needsReview: false }; });
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: JSON.stringify({ questions, groups: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const tencentHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { TaskId: "test-job" } }));
    if (action === "DescribeMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE" } }));
    return new Response(await archive(source));
  });
  const api = new DocumentApi(path, db, checkpoints, new ModelClient(db, modelHttp), new TencentClient(db, tencentHttp)), sha256 = hash(source);
  const document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: source.length, sha256, objectKey: sourceKey("text", sha256) }; await api.storage.putSource(document, source);
  const create = { type: "create" as const, revision: config.revision, value: { requestId: randomUUID(), document, graphId: "document_parser" as const } };
  async function request<T extends DesktopDocumentRequest["type"]>(command: Extract<DesktopDocumentRequest, { type: T }>, configuration: AiSnapshot | AiSettingsView = view) {
    return await api.request(command, configuration) as Extract<DesktopDocumentReply, { type: T }>;
  }
  const f = { path, db, checkpoints, config, view, source, document, create, api, request, modelHttp, tencentHttp }; fixtures.push(f); return f;
}

it.each(["recognition", "model"])("stops %s at its money boundary and explicitly resumes after raising limits without replaying completed recognition", async phase => {
  const f = await setup(); f.config.preferences.cost = { enabled: true, currency: "CNY", taskLimitMicros: 1, dailyLimitMicros: 100000000, inputMicrosPerMillion: phase === "model" ? 2000000 : 0, outputMicrosPerMillion: phase === "model" ? 8000000 : 0, tencentMicrosPerPage: phase === "recognition" ? 1 : 0 };
  const receipt = await f.request(f.create, f.config), id = receipt.value.threadId; await f.api.runtime.wait(id); const stopped = f.api.tasks.record(id); expect(stopped.errorCode).toBe("COST_BUDGET_EXCEEDED"); expect(stopped.state).toBe("FAILED"); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).toHaveBeenCalledTimes(phase === "recognition" ? 0 : 3);
  expect(await f.api.store.search(["document_tasks", id, "budget"])).toEqual([]);
  f.config.preferences.cost.taskLimitMicros = 100000000; await f.api.runtime.control(id, { requestId: randomUUID(), action: "resume", checkpointId: stopped.checkpointId }, f.config); await f.api.runtime.wait(id); const completed = f.api.tasks.record(id); expect(completed.state, completed.errorCode ?? "").toBe("COMPLETED"); expect(f.tencentHttp).toHaveBeenCalledTimes(3); expect(f.modelHttp).toHaveBeenCalledTimes(3);
  const report = await f.api.costs.report(f.config.preferences.cost, id); expect(report.recent.filter(item => item.kind === "tencent")).toHaveLength(1); expect(report.task!.reservedMicros).toBeGreaterThan(0); const totals = report.day; await f.api.runtime.delete(id); expect((await f.api.costs.report(f.config.preferences.cost, id)).day).toEqual(totals); expect((await f.api.costs.report(f.config.preferences.cost, id)).task).toEqual(report.task);
});

it("runs the embedded graph and exposes validated passive task, budget, review and artifact reads", async () => {
  const f = await setup(), admitted = await f.request(f.create, f.config), threadId = admitted.value.threadId, revision = f.config.revision;
  await f.api.runtime.wait(threadId); const detail = await f.request({ type: "detail", revision, threadId });
  expect(detail.value.state).toBe("COMPLETED"); expect(detail.value.result?.questions).toHaveLength(35); expect(detail.value.usage).toHaveLength(3);
  expect(detail.value.modelBudget?.reserved).toBeGreaterThan(detail.value.usage!.length);
  const list = await f.request({ type: "list", revision, offset: 0, limit: 20, state: "COMPLETED" }); expect(list.value.items.map(item => item.threadId)).toEqual([threadId]);
  expect((await f.request({ type: "head", revision, threadId })).value.state).toBe("COMPLETED");
  const review = await f.request({ type: "preview", revision, threadId, includeResult: true }); expect(review.value.units.some(unit => unit.stage === "result")).toBe(true); expect(review.value.units.filter(unit => unit.stage === "document_parse")).toHaveLength(3);
  expect((await f.request({ type: "preview", revision, threadId, includeResult: false })).value.units.some(unit => unit.stage === "result")).toBe(false);
  const sourceOnly = (await f.request({ type: "preview", revision, threadId, includeResult: false })).value;
  expect(sourceOnly.units.every(unit => !unit.questions.length && !unit.groups.length && !unit.visualElements?.length)).toBe(true);
  expect(sourceOnly.units.every(unit => unit.sourceRef && unit.stage === "document_parse")).toBe(true);
  const { objectKey, sha256, sizeBytes, mediaType } = f.document, original = await f.request({ type: "artifact", revision, threadId, reference: { objectKey, sha256, sizeBytes, mediaType } }); expect(Buffer.from(original.value.bytes, "base64")).toEqual(f.source);
  expect(await f.request(f.create)).toEqual(admitted); expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
  expect(JSON.stringify({ detail, review })).not.toContain("TEST_ONLY"); expect(JSON.stringify(detail)).not.toContain("signature=PRIVATE");
});

it.each(["pause", "interrupt", "close"] as const)("drains a real blocked preparation worker on %s before releasing task ownership", async action => {
  const f = await setup(), shared = new SharedArrayBuffer(8); let exited = false, closed = false;
  if (action === "close") fixtures.splice(fixtures.indexOf(f), 1);
  vi.spyOn(f.api.runtime.stages, "prepare").mockImplementation(context => runPreparation(context.signal, 5000, { failed: "PREPARATION_FAILED", timeout: "PREPARATION_TIMEOUT" }, () => {
    const worker = new Worker("const {workerData,parentPort}=require('node:worker_threads'),state=new Int32Array(workerData);Atomics.store(state,0,1);while(!Atomics.load(state,1))Atomics.wait(state,1,0);parentPort.postMessage({});", { eval: true, env: {}, execArgv: [], workerData: shared, resourceLimits: { maxOldGenerationSizeMb: 64 } }); worker.on("exit", () => { exited = true; }); return worker;
  }, () => ({ artifacts: [] })));
  try {
    const admitted = await f.request(f.create, f.config), threadId = admitted.value.threadId, revision = f.config.revision; await vi.waitFor(() => expect(Atomics.load(new Int32Array(shared), 0)).toBe(1));
    expect((await f.request({ type: "head", revision, threadId })).value.state).toBe("RUNNING"); expect(f.api.storage.source(f.document)).toEqual(f.source);
    if (action !== "close") {
      await f.request({ type: "control", revision, threadId, value: { requestId: randomUUID(), action, runId: admitted.value.runId } });
      if (action === "pause") { expect(f.api.tasks.record(threadId).state).toBe("PAUSING"); expect(preparationSlots.busy()).toBe(true); Atomics.store(new Int32Array(shared), 1, 1); Atomics.notify(new Int32Array(shared), 1); }
      await f.api.runtime.wait(threadId); const record = f.api.tasks.record(threadId); expect(record.state).toBe(action === "pause" ? "PAUSED" : "CANCELLED"); expect(Boolean(record.outputs.prepare)).toBe(action === "pause");
    } else {
      await f.api.close(); closed = true; const retained = new DocumentTasks(f.path, f.api.storage, f.db); try { const record = retained.record(threadId); expect(record.state).toBe("FAILED"); expect(record.outputs.prepare).toBeUndefined(); } finally { retained.close(); }
    }
    expect(exited).toBe(true); expect(preparationSlots.busy()).toBe(false); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE task_id=?").get(threadId)!.n).toBe(0);
  } finally { Atomics.store(new Int32Array(shared), 1, 1); Atomics.notify(new Int32Array(shared), 1); if (action === "close") { if (!closed) await f.api.close(); f.checkpoints.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } }
});

it("never admits new work with metadata, stale credentials or renderer-supplied fields", async () => {
  const f = await setup();
  await expect(f.request(f.create)).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  await expect(f.api.request({ ...f.create, revision: randomUUID() }, f.config)).rejects.toMatchObject({ code: "LOCAL_SETTINGS_CHANGED" });
  await expect(f.api.request({ ...f.create, config: f.config }, f.config)).rejects.toThrow();
  expect(f.api.tasks.unfinished()).toHaveLength(0); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
});

it("reports embedded capabilities and preferences without model work", async () => {
  const f = await setup(), revision = f.config.revision, capabilities = await f.request({ type: "capabilities", revision });
  expect(capabilities.value).toMatchObject({ modelConfigured: true, parserConfigured: true, officeAvailable: true, officeModes: [], officeSourceMaxBytes: 8 * 1024 * 1024, parserInputMaxBytes: 8 * 1024 * 1024 });
  expect(capabilities.value.sourceTypes).not.toContain("csv"); expect((await f.request({ type: "import_settings", revision })).value).toEqual({ revision, settings: f.config.preferences.import });
  expect((await f.request({ type: "capabilities", revision }, { ...f.view, configured: { modelApiKey: false, tencentSecretId: true, tencentSecretKey: false } })).value).toMatchObject({ modelConfigured: false, parserConfigured: false });
  expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
});

it("projects saved banks and selected questions without task metadata, models or stale checkpoints", async () => {
  const f = await setup(), receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.config.revision; await f.api.runtime.wait(threadId);
  const detail = (await f.request({ type: "detail", threadId, revision })).value, value = { threadId, checkpointId: detail.checkpointId!, scope: "full" as const };
  const full = await f.request({ type: "bank", revision, value }); expect(Object.keys(full.value).sort()).toEqual(["processing", "result", "status", "title"]); expect(full.value.result.questions).toHaveLength(35);
  const selected = await f.request({ type: "bank", revision, value: { ...value, questionIndexes: [2] } }); expect(selected.value.result.questions).toHaveLength(1); expect(selected.value.processing!.questionSources).toHaveLength(1);
  await expect(f.request({ type: "bank", revision, value: { ...value, checkpointId: "changed" } })).rejects.toMatchObject({ code: "STALE_CHECKPOINT" });
  await expect(f.request({ type: "bank", revision, value: { ...value, revisionId: randomUUID() } })).rejects.toMatchObject({ code: "CORRECTION_NOT_FOUND" });
  f.api.tasks.update(threadId, receipt.value.runId!, record => { record.state = "WAITING_REVIEW"; record.phase = "result_review"; });
  await expect(f.request({ type: "bank", revision, value })).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  expect((await f.request({ type: "bank", revision, value: { ...value, scope: "completed" } })).value.result.questions).toHaveLength(35);
  expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it.each(["PAUSED", "FAILED"] as const)("projects durable text units after %s without a structure or assembly commit", async state => {
  const f = await setup(), structure = f.api.runtime.stages.structure;
  vi.spyOn(f.api.runtime.stages, "structure").mockImplementation(async context => {
    await structure(context);
    if (state === "PAUSED") f.api.tasks.control(context.task.id, { requestId: randomUUID(), action: "pause", runId: context.task.runId }, f.view);
    throw new AppError(state === "PAUSED" ? "DOCUMENT_STOP_REQUESTED" : "LOCAL_FILE_INVALID", "Simulated stop after durable units");
  });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.view.revision; await f.api.runtime.wait(threadId);
  const before = f.api.tasks.record(threadId); expect(before.state).toBe(state); expect(before.outputs.structure).toBeUndefined(); expect(before.outputs.assemble).toBeUndefined();
  const saved = await f.api.store.search(["document_tasks", threadId, "units"], { limit: 1000 }), files = readdirSync(f.api.storage.root, { recursive: true }).sort(), writes = vi.spyOn(f.api.storage, "putArtifact");
  const detail = (await f.request({ type: "detail", revision, threadId })).value;
  expect(detail).toMatchObject({ state, status: "PARTIAL", canExportCompleted: true, progress: { chunks: { total: 3, succeeded: 3, failed: 0, remaining: 0 } }, processing: { chunks: { total: 3, succeeded: 3 }, quality: { reviewRequired: true } } });
  expect(detail.result!.questions).toHaveLength(35); expect(detail.result!.missingFields).toContain("questions"); expect(detail.result!.warnings![0]).toContain("partial snapshot");
  const command = { type: "bank" as const, revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "completed" as const } }, bank = await f.request(command);
  expect(bank.value.result).toEqual(detail.result); expect(await f.request(command)).toEqual(bank);
  await expect(f.request({ ...command, value: { ...command.value, scope: "full" } })).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  const preview = await f.request({ type: "preview", revision, threadId, includeResult: true }); expect(preview.value.units.filter(unit => unit.stage === "result")).toHaveLength(1);
  expect(preview.value.units.filter(unit => unit.stage === "document_parse")).toHaveLength(3);
  expect(f.api.tasks.record(threadId)).toEqual(before); expect(await f.api.store.search(["document_tasks", threadId, "units"], { limit: 1000 })).toEqual(saved);
  expect(readdirSync(f.api.storage.root, { recursive: true }).sort()).toEqual(files); expect(writes).not.toHaveBeenCalled();
  expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it("exports known successes alongside an uncertain model call without retrying or clearing its receipt", async () => {
  const f = await setup(), provider = f.modelHttp.getMockImplementation()!;
  f.modelHttp.mockImplementation(async (url, init) => {
    if (String(init.body).includes("Fragment 2 of 3")) {
      await vi.waitFor(async () => { const task = f.api.tasks.unfinished()[0], units = await f.api.store.search(["document_tasks", task.id, "units"], { limit: 1000 }); expect(units.some(unit => unit.value.status === "succeeded")).toBe(true); });
      throw new Error("Lost response after dispatch");
    }
    return provider(url, init);
  });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.view.revision; await f.api.runtime.wait(threadId);
  const before = canonical(f.db.state(threadId)), detail = (await f.request({ type: "detail", revision, threadId })).value;
  expect(detail.state).toBe("FAILED"); expect(detail.canExportCompleted).toBe(true); expect(detail.result!.questions.length).toBeGreaterThan(0); expect(detail.result!.questions.length).toBeLessThan(35);
  expect(detail.blocking).toContainEqual({ code: "AI_RESULT_UNKNOWN" }); expect(detail.processing!.failures.length).toBeGreaterThan(0); expect(detail.result!.missingFields).toContain("questions");
  expect(detail.progress!.chunks.total).toBe(detail.progress!.chunks.succeeded + detail.progress!.chunks.failed + detail.progress!.chunks.remaining);
  const bank = await f.request({ type: "bank", revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "completed" } }); expect(bank.value.result).toEqual(detail.result);
  expect(canonical(f.db.state(threadId))).toBe(before); expect(f.modelHttp).toHaveBeenCalledTimes(2); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it.each(["input", "future", "checksum"])("diagnoses a damaged %s in partial projection without repairing saved evidence", async damage => {
  const f = await setup(), structure = f.api.runtime.stages.structure;
  vi.spyOn(f.api.runtime.stages, "structure").mockImplementation(async context => { await structure(context); throw new AppError("LOCAL_FILE_INVALID", "Checkpoint gap"); });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.view.revision; await f.api.runtime.wait(threadId);
  const task = f.api.tasks.record(threadId), results = new UnitResults(f.api.store, f.api.storage, threadId, f.document.sha256, task.executionFingerprint!), unit = (await results.get(textUnitInput(f.api.storage, task, readSavedTextInputs(f.api.storage, task).chunks, 0).identity))!.record;
  if (damage === "checksum") writeFileSync(join(f.api.storage.root, unit.resultRef!.objectKey), "damaged evidence");
  else await f.api.store.put(results.namespace, "document_parse-0", { ...unit, ...(damage === "input" ? { inputDigest: hash("changed") } : { round: task.retry + 1 }) });
  const bytes = readFileSync(join(f.api.storage.root, unit.resultRef!.objectKey)), saved = await f.api.store.get(results.namespace, "document_parse-0");
  const detail = await f.request({ type: "detail", revision, threadId });
  expect(detail.value).toMatchObject({ state: "FAILED", result: null, processing: null, canExportCompleted: false, allowedActions: [], resumeCompatible: false });
  expect(detail.value.blocking).toContainEqual({ code: "TASK_CHECKPOINT_UNREADABLE" }); expect(detail.value.usage).toHaveLength(3);
  expect(await f.api.store.get(results.namespace, "document_parse-0")).toEqual(saved); expect(readFileSync(join(f.api.storage.root, unit.resultRef!.objectKey))).toEqual(bytes);
  expect(f.api.tasks.record(threadId)).toEqual(task); expect(f.modelHttp).toHaveBeenCalledTimes(3);
});

it("refuses partial projection when the stopped checkpoint changes during a unit read", async () => {
  const f = await setup(), structure = f.api.runtime.stages.structure;
  vi.spyOn(f.api.runtime.stages, "structure").mockImplementation(async context => { await structure(context); throw new AppError("LOCAL_FILE_INVALID", "Checkpoint gap"); });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId; await f.api.runtime.wait(threadId);
  const get = f.api.store.get.bind(f.api.store); let changed = false;
  vi.spyOn(f.api.store, "get").mockImplementation(async (...args) => { const value = await get(...args); if (!changed && args[0].at(-1) === "units") { changed = true; f.api.tasks.checkpoint(threadId, receipt.value.runId!, "new-checkpoint"); } return value; });
  await expect(f.request({ type: "detail", revision: f.view.revision, threadId })).rejects.toMatchObject({ code: "STALE_CHECKPOINT" }); expect(f.modelHttp).toHaveBeenCalledTimes(3);
});

it("omits conflicting units from a partial view while leaving their successful receipts unchanged", async () => {
  const f = await setup(), structure = f.api.runtime.stages.structure;
  vi.spyOn(f.api.runtime.stages, "structure").mockImplementation(async context => { await structure(context); throw new AppError("LOCAL_FILE_INVALID", "Checkpoint gap"); });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId; await f.api.runtime.wait(threadId);
  const task = f.api.tasks.record(threadId), source = readSavedTextInputs(f.api.storage, task), results = new UnitResults(f.api.store, f.api.storage, threadId, f.document.sha256, task.executionFingerprint!);
  const first = (await results.get(textUnitInput(f.api.storage, task, source.chunks, 0).identity))!, second = (await results.get(textUnitInput(f.api.storage, task, source.chunks, 1).identity))!;
  second.payload!.parsed.questions![0].parentId = first.payload!.parsed.questions![0].id;
  const reference = await f.api.storage.putArtifact(Buffer.from(JSON.stringify(second.payload)), f.document.sha256, "unit-result", 1, "application/json");
  await f.api.store.put(results.namespace, "document_parse-1", { ...second.record, resultRef: reference }); const before = await f.api.store.search(results.namespace, { limit: 1000 });
  const detail = (await f.request({ type: "detail", revision: f.view.revision, threadId })).value;
  expect(detail.status).toBe("PARTIAL"); expect(detail.result!.questions.length).toBe(35 - second.payload!.parsed.questions!.length);
  expect(detail.processing!.failures).toContainEqual(expect.objectContaining({ stage: "document_parse", index: 1, code: "OUTPUT_INVALID" }));
  expect(await f.api.store.search(results.namespace, { limit: 1000 })).toEqual(before); expect((await f.api.store.get(results.namespace, "document_parse-1"))!.value.status).toBe("succeeded");
  expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it.each(["PENDING", "RUNNING", "PAUSING", "EXPIRED"] as const)("keeps previous results readable but disables bank import for %s tasks", async state => {
  const f = await setup(), receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.view.revision; await f.api.runtime.wait(threadId);
  f.api.tasks.update(threadId, receipt.value.runId!, record => { if (state === "EXPIRED") record.createdAt -= 181 * 24 * 3600 * 1000; else record.state = state; });
  const detail = (await f.request({ type: "detail", revision, threadId })).value;
  expect(detail.state).toBe(state); expect(detail.result!.questions).toHaveLength(35); expect(detail.canExportCompleted).toBe(false);
  await expect(f.request({ type: "bank", revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "completed" } })).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it("does not offer a partial bank when a stopped task has no saved successful questions", async () => {
  const f = await setup(); vi.spyOn(f.api.runtime.stages, "structure").mockImplementation(async () => { throw new AppError("LOCAL_FILE_INVALID", "Stopped before the first unit"); });
  const receipt = await f.request(f.create, f.config), threadId = receipt.value.threadId, revision = f.view.revision; await f.api.runtime.wait(threadId);
  const task = f.api.tasks.record(threadId), detail = (await f.request({ type: "detail", revision, threadId })).value;
  expect(detail.state).toBe("FAILED"); expect(detail.result).toBeNull(); expect(detail.canExportCompleted).toBe(false);
  await expect(f.request({ type: "bank", revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "completed" } })).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  expect(f.api.tasks.record(threadId)).toEqual(task); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it.each(["success", "checkpoint-race", "transport-corruption", "unknown-reply"])("imports checked resources through the main coordinator: %s", async mode => {
  const f = await setup(), pixels = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer(), assemble = f.api.runtime.stages.assemble;
  vi.spyOn(f.api.runtime.stages, "assemble").mockImplementation(async context => {
    const output = await assemble(context), result = JSON.parse(f.api.storage.artifact(output.result!).toString()), image = await f.api.storage.putArtifact(pixels, f.document.sha256, "import-figure", 0, "image/png");
    result.visualElements.push({ kind: "image", description: "Owned figure", questionIds: [result.questions[0].id], imageRef: image });
    const reference = await f.api.storage.putArtifact(Buffer.from(JSON.stringify(result)), f.document.sha256, "result", 0, "application/json"); return { ...output, artifacts: [...output.artifacts, image, reference], result: reference };
  });
  const created = await f.request(f.create, f.config), threadId = created.value.threadId; await f.api.runtime.wait(threadId);
  const checkpointId = f.api.tasks.record(threadId).checkpointId!, practice = new PracticeStore(f.path), ai = Object.create(AiClient.prototype) as AiClient, database = Object.create(DatabaseClient.prototype) as DatabaseClient;
  const command = { type: "import_bank" as const, revision: f.view.revision, value: { threadId, checkpointId, scope: "full" as const } }; let lost = false;
  vi.spyOn(AiClient.prototype, "call").mockImplementation(async input => {
    if (input.type !== "document") throw new Error("Only passive document reads are allowed");
    expect("secrets" in input.config).toBe(false); const reply = await f.api.request(input.request, input.config);
    if (reply.type === "artifact" && mode === "checkpoint-race") f.api.tasks.checkpoint(threadId, created.value.runId!, "changed-during-resource-read");
    if (reply.type === "artifact" && mode === "transport-corruption") { const bytes = Buffer.from(reply.value.bytes, "base64"); bytes[0] ^= 1; reply.value.bytes = bytes.toString("base64"); }
    return reply as never;
  });
  const save = vi.spyOn(DatabaseClient.prototype, "request").mockImplementation(async input => {
    const files = (input as { resources: { bytes: Uint8Array }[] }).resources; expect(files.every(file => file.bytes.byteOffset === 0 && file.bytes.buffer.byteLength === file.bytes.byteLength)).toBe(true);
    const value = await practice.request(input);
    if (mode === "unknown-reply" && !lost) { lost = true; throw new AppError("LOCAL_DATABASE_UNAVAILABLE", "Simulated lost reply after commit"); }
    return { ok: true, value };
  });
  try {
    if (mode === "checkpoint-race" || mode === "transport-corruption") {
      await expect(importDocumentBank(command, f.view, ai, database)).rejects.toMatchObject({ code: mode === "checkpoint-race" ? "STALE_CHECKPOINT" : "DOCUMENT_CHECKSUM_MISMATCH" }); expect(save).not.toHaveBeenCalled(); expect(practice.banks()).toHaveLength(0);
    } else {
      if (mode === "unknown-reply") { await expect(importDocumentBank(command, f.view, ai, database)).rejects.toMatchObject({ code: "LOCAL_DATABASE_UNAVAILABLE" }); expect(save).toHaveBeenCalledOnce(); }
      const receipt = await importDocumentBank(command, f.view, ai, database); expect(receipt.count).toBe(35); expect(practice.banks()).toHaveLength(1);
      expect(readQuestions(practice.db, practice.assets, [receipt.bankId]).some(row => row.visuals.length > 0)).toBe(true); expect(await importDocumentBank(command, f.view, ai, database)).toEqual(receipt); expect(practice.banks()).toHaveLength(1);
    }
    expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
  } finally { practice.close(); }
});

it("filters active tasks without including stopped or expired records", async () => {
  const f = await setup(), first = f.api.tasks.create(f.create.value, f.config), second = f.api.tasks.create({ ...f.create.value, requestId: randomUUID() }, f.config), revision = f.config.revision;
  f.api.tasks.stop(second.threadId, second.runId!);
  expect((await f.request({ type: "list", revision, offset: 0, limit: 20, state: "active" })).value.items.map(item => item.threadId)).toEqual([first.threadId]);
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 181 * 24 * 3600 * 1000);
  try { expect((await f.request({ type: "list", revision, offset: 0, limit: 20, state: "active" })).value.items).toHaveLength(0); }
  finally { clock.mockRestore(); }
  expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
});

it("allows keyless stop controls and refuses keyless execution before changing task state", async () => {
  const f = await setup(), receipt = f.api.tasks.create(f.create.value, f.config), threadId = receipt.threadId, revision = f.config.revision;
  await f.api.runtime.initialize(threadId);
  const stop = { type: "control" as const, revision, threadId, value: { requestId: randomUUID(), action: "pause" as const, runId: receipt.runId } };
  await f.request(stop); expect(f.api.tasks.record(threadId)).toMatchObject({ state: "PAUSED", desired: null });
  const before = f.api.tasks.record(threadId), count = f.api.tasks.db.prepare("SELECT COUNT(*) AS n FROM document_operations").get()!.n;
  await expect(f.request({ type: "control", revision, threadId, value: { requestId: randomUUID(), action: "resume", checkpointId: before.checkpointId } })).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
  expect(f.api.tasks.record(threadId)).toEqual(before); expect(f.api.tasks.db.prepare("SELECT COUNT(*) AS n FROM document_operations").get()!.n).toBe(count);
  expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
});

it("fences original references by task ownership and rejects corrupted budget ledgers", async () => {
  const f = await setup(), receipt = f.api.tasks.create(f.create.value, f.config), threadId = receipt.threadId, revision = f.config.revision;
  const bytes = Buffer.from("another source"), sha256 = hash(bytes), other = { ...f.document, sha256, objectKey: sourceKey("text", sha256), sizeBytes: bytes.length }; await f.api.storage.putSource(other, bytes);
  await expect(f.request({ type: "artifact", revision, threadId, reference: { objectKey: other.objectKey, sha256, sizeBytes: bytes.length, mediaType: other.mediaType } })).rejects.toThrow();
  await expect(f.request({ type: "artifact", revision, threadId, reference: { objectKey: f.document.objectKey, sha256, sizeBytes: f.source.length, mediaType: f.document.mediaType } })).rejects.toThrow();
  const record = f.api.tasks.record(threadId); await f.api.store.put(["document_tasks", threadId, "call_allowances"], "ledger", { fingerprint: record.executionFingerprint, limit: record.maxCalls, units: { test: { calls: 2, allowance: 2 } } });
  expect((await f.request({ type: "detail", revision, threadId })).value.modelBudget).toEqual({ limit: 16, reserved: 2 });
  await f.api.store.put(["document_tasks", threadId, "call_allowances"], "ledger", { fingerprint: "corrupted", limit: 16, units: {} });
  expect((await f.request({ type: "detail", revision, threadId })).value).toMatchObject({ resumeCompatible: false, modelBudget: { limit: 16, reserved: null }, blocking: [{ code: "TASK_ACCOUNTING_UNREADABLE" }, { code: "TASK_CHECKPOINT_UNREADABLE" }] }); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
});

it.each(["document_parse:2:0:attempt:1", "vision_parse:2:0:primary:attempt:1", "vision_parse:2:0:context:attempt:4"])("fences pending rounds against persisted unknown receipt %s", async callKey => {
  const f = await setup(), taskId = f.db.createTask(f.document.sha256, 16), model = new ModelClient(f.db, f.modelHttp), stage = callKey.split(":")[0];
  f.db.claim(taskId, callKey, { inputDigest: hash("unknown input"), endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" });
  expect(() => assertKnownUnitCalls(model, taskId, [`${stage}:0:0`, `${stage}:2:0`])).toThrow("unresolved provider outcome");
  expect(() => assertKnownUnitCalls(model, taskId, [`${stage}:2:1`])).not.toThrow(); expect(f.modelHttp).not.toHaveBeenCalled();
});

it("serves native source tickets and document commands through the production AI worker", async () => {
  const f = await setup(), zip = (await archive(f.source)).toString("base64"), events: string[] = [];
  writeFileSync(join(f.path, "electron-ai-settings-v1.json"), JSON.stringify({ version: 1, revision: f.config.revision, preferences: f.config.preferences, secrets: { modelApiKey: null, tencentSecretId: null, tencentSecretKey: null } }));
  const sourcePath = join(f.path, "worker-source.txt"); writeFileSync(sourcePath, f.source);
  const moduleUrl = new URL("../.build/electron/app/desktop/ai-worker.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    global.fetch = async (url, init) => {
      const action = new Headers(init.headers).get("X-TC-Action"); parentPort.postMessage({ observed: action || init.method || "model" });
      if (action === "SubmitMultimodalDocParseJob") return Response.json({ Response: { TaskId: "worker-job" } });
      if (action === "DescribeMultimodalDocParseJob") return Response.json({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE" } });
      if (String(url).startsWith("https://result.cos.ap-guangzhou.myqcloud.com/")) return new Response(Buffer.from(workerData.zip, "base64"));
      if (String(url) !== "https://model.example/v1/responses") throw Error("Unexpected network target");
      const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text;
      const match = /Use exactly these source record IDs and preserve each supplied field: (.*)\\n\\n/.exec(text);
      if (!match) throw Error("Missing source records");
      const questions = Object.keys(JSON.parse(match[1])).map(id => { const number = id.split(":").at(-1); return { id, stem: "Question " + number, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "A" + number }, sourceText: "Question " + number + "\\nReference answer: A" + number, analysis: null, confidence: 1, needsReview: false }; });
      return Response.json({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: JSON.stringify({ questions, groups: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } });
    };
    import(workerData.moduleUrl).catch(error => { throw error; });
  `, { eval: true, workerData: { directory: f.path, moduleUrl, zip }, env: {} });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  worker.on("message", message => { if (message.observed) events.push(message.observed); else { const promise = pending.get(message.id); pending.delete(message.id); if (message.reply.ok) promise?.resolve(message.reply.value); else promise?.reject(message.reply.error); } });
  worker.on("error", error => { for (const promise of pending.values()) promise.reject(error); pending.clear(); });
  const rpc = (request: unknown) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, request }); });
  const document = (request: unknown, config = f.view as AiSettingsView | AiSnapshot) => rpc({ type: "document", request, config });
  try {
    const selected = await rpc({ type: "pick_sources", paths: [sourcePath], revision: f.config.revision }); expect(JSON.stringify(selected)).not.toContain(f.path);
    const stored = await rpc({ type: "upload_source", ticket: selected[0].nativeTicket, revision: f.config.revision }); expect(events).toHaveLength(0);
    const command = { ...f.create, value: { ...f.create.value, document: stored } }, receipt = await document(command, f.config), threadId = receipt.value.threadId;
    await vi.waitFor(async () => { const reply = await document({ type: "head", revision: f.config.revision, threadId }); expect(reply.value.state).toBe("COMPLETED"); }, { timeout: 10000 });
    expect((await document({ type: "detail", revision: f.config.revision, threadId })).value.result.questions).toHaveLength(35);
    expect((await document({ type: "preview", revision: f.config.revision, threadId, includeResult: true })).value.units).toHaveLength(4);
    const count = events.length; expect(await document(command)).toEqual(receipt); expect(events).toHaveLength(count); expect(count).toBe(6);
  } finally { await worker.terminate(); }
}, 15000);
