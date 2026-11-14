import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DocumentTaskCreate } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStages } from "./document-runtime.js";
import { DOCUMENT_STAGES, DOCUMENT_TTL_MS, DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { validateQuestion } from "./question-contract.js";
import { TencentClient } from "./tencent.js";
import { SqliteStore } from "./graph-store.js";
import { ZipFile } from "yazl";
import { TencentResults } from "./tencent-results.js";
import type { ArtifactReference } from "../src/contracts.generated.js";

const fixtures: { path: string; tasks: DocumentTasks; calls: AiDatabase; checkpoints: SqliteCheckpoints; runtime: DocumentRuntime; store: SqliteStore }[] = [], paths: string[] = [];
const config = (): AiSnapshot => ({ revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://provider.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 2, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "NEVER_PERSIST_MODEL_KEY", tencentSecretId: "NEVER_PERSIST_TENCENT_ID", tencentSecretKey: "NEVER_PERSIST_TENCENT_KEY" } });
function result() { return { schemaVersion: 3, questions: [validateQuestion({ id: "one", stem: "A supplied question", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, analysis: "Supplied explanation", sourceText: "Original source", needsReview: false })], groups: [], visualElements: [], warnings: [], confidenceScore: 100, missingFields: [] }; }
async function setup(changes: Partial<DocumentStages> = {}, path?: string) {
  path ??= mkdtempSync(join(tmpdir(), "practiq-document-")); if (!paths.includes(path)) paths.push(path);
  const calls = new AiDatabase(path), storage = new AiStorage(path), checkpoints = new SqliteCheckpoints(path), tasks = new DocumentTasks(path, storage, calls), stages = {
    prepare: vi.fn(async () => ({ artifacts: [] })), recognize: vi.fn(async () => ({ artifacts: [] })), structure: vi.fn(async () => ({ artifacts: [] })), answers: vi.fn(async () => ({ artifacts: [] })),
    assemble: vi.fn(async ({ task }) => { const reference = await storage.putArtifact(Buffer.from(JSON.stringify(result())), task.input.document.sha256, "result", task.retry, "application/json"); return { artifacts: [reference], result: reference, status: "SUCCEEDED" as const }; }), ...changes,
  } satisfies DocumentStages;
  const store = new SqliteStore(path), runtime = new DocumentRuntime(tasks, checkpoints, stages, store), fixture = { path, calls, storage, checkpoints, tasks, runtime, stages, store }; fixtures.push(fixture);
  const bytes = Buffer.from("Original source"), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
  return { ...fixture, input: { requestId: randomUUID(), document, graphId: "document_parser" } as DocumentTaskCreate };
}
afterEach(async () => {
  for (const fixture of fixtures) fixture.runtime.abortAll();
  await Promise.all(fixtures.flatMap(fixture => fixture.tasks.db.prepare("SELECT id FROM document_tasks").all().map(row => fixture.runtime.wait(String(row.id)))));
  for (const fixture of fixtures.splice(0)) { fixture.store.stop(); fixture.checkpoints.close(); fixture.tasks.close(); fixture.calls.close(); }
  paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
const control = (action: string, value: { runId?: string | null; checkpointId?: string | null }, extra = {}) => ({ requestId: randomUUID(), action, runId: value.runId ?? null, checkpointId: value.checkpointId ?? null, units: [], ...extra });

it("persists a provider-free initial checkpoint and keeps configuration secrets out of every database", async () => {
  const { tasks, calls, checkpoints, runtime, stages, path, input } = await setup(), receipt = tasks.create(input, config());
  await runtime.initialize(receipt.threadId); const task = tasks.record(receipt.threadId);
  expect(task.state).toBe("PENDING"); expect(task.checkpointId).toBeTypeOf("string");
  expect((await checkpoints.getTuple({ configurable: { thread_id: `document:${task.id}` } }))!.checkpoint.channel_values).toMatchObject({ taskId: task.id, inputDigest: task.inputDigest });
  expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_tasks").get()!.n).toBe(0); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).not.toHaveBeenCalled());
  for (const file of readdirSync(path).filter(name => name.includes("sqlite"))) expect(readFileSync(join(path, file)).toString()).not.toMatch(/NEVER_PERSIST_/);
});

it("persists a missing initial checkpoint before acknowledging a keyless receipt replay", async () => {
  const { tasks, calls, runtime, stages, input } = await setup(), snapshot = config(), receipt = tasks.create(input, snapshot);
  expect(tasks.record(receipt.threadId).checkpointId).toBeNull();
  const view = { revision: snapshot.revision, preferences: snapshot.preferences, configured: { modelApiKey: true, tencentSecretId: true, tencentSecretKey: true } };
  expect(await runtime.start(receipt, view)).toEqual(receipt); expect(tasks.record(receipt.threadId).checkpointId).toBeTypeOf("string");
  expect(tasks.record(receipt.threadId).state).toBe("PENDING"); expect(calls.db.prepare("SELECT count(*) AS n FROM ai_tasks").get()!.n).toBe(0);
  DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).not.toHaveBeenCalled());
});

it("replays only matching admissions, including after settings change, without creating another task", async () => {
  const { tasks, input } = await setup(), first = tasks.create(input, config()), changed = config(); changed.preferences.maxCalls = 1; changed.secrets.modelApiKey = "";
  expect(tasks.create(input, changed)).toEqual(first);
  expect(() => tasks.create({ ...input, generateAnswers: true }, config())).toThrow("already used"); expect(tasks.db.prepare("SELECT COUNT(*) AS n FROM document_tasks").get()!.n).toBe(1);
  expect(tasks.record(first.threadId).maxCalls).toBe(2);
});

it.each(["extra", "csv", "office-mode", "text-pages", "answer-generation", "parent"])("rejects %s admission before creating a task", async kind => {
  const { tasks, input } = await setup();
  const value = kind === "extra" ? { ...input, modelApiKey: "malicious" } : kind === "csv" ? { ...input, document: { ...input.document, sourceType: "csv", fileName: "source.csv" } } : kind === "office-mode" ? { ...input, officeMode: "pdf" } : kind === "text-pages" ? { ...input, pages: [1] } : kind === "answer-generation" ? { ...input, documentRole: "answers", generateAnswers: true } : { ...input, parentThreadId: randomUUID() };
  expect(() => tasks.create(value, config())).toThrow(); expect(tasks.db.prepare("SELECT COUNT(*) AS n FROM document_tasks").get()!.n).toBe(0);
});

it("acknowledges a real checkpoint before starting the substituted stages and returns strict shared task contracts", async () => {
  const { tasks, runtime, stages, input } = await setup(), receipt = await runtime.create(input, config());
  expect(tasks.record(receipt.threadId).checkpointId).toBeTypeOf("string"); await runtime.wait(receipt.threadId);
  expect(tasks.detail(receipt.threadId, config())).toMatchObject({ state: "COMPLETED", phase: "completed", status: "SUCCEEDED", result: { questions: [{ id: "one" }] }, modelBudget: { limit: 2, reserved: 0 }, canExportCompleted: true });
  expect(tasks.head(receipt.threadId, config())).toMatchObject({ state: "COMPLETED", modelConfigured: true, resumeCompatible: true }); expect(tasks.list().items[0]).toMatchObject({ threadId: receipt.threadId, questionCount: 1 });
  expect(await runtime.create(input, config())).toEqual(receipt); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(stage === "answers" ? 0 : 1));
});

it("pauses between stages and resumes from SQLite without replaying completed stages", async () => {
  let release!: () => void, arrived!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { arrived = resolve; });
  const recognize = vi.fn(async () => { arrived(); await gate; return { artifacts: [] }; }), { tasks, runtime, stages, input } = await setup({ recognize });
  const receipt = await runtime.create(input, config());
  try {
    await entered; const pause = control("pause", { runId: receipt.runId });
    expect(await runtime.control(receipt.threadId, pause, config())).toMatchObject({ runId: receipt.runId }); expect(tasks.record(receipt.threadId).state).toBe("PAUSING");
    release(); await runtime.wait(receipt.threadId); const paused = tasks.detail(receipt.threadId, config()); expect(paused.state).toBe("PAUSED"); expect(stages.structure).not.toHaveBeenCalled();
    const resume = control("resume", { checkpointId: paused.checkpointId }), modelOnly = config(); modelOnly.secrets.tencentSecretId = ""; modelOnly.secrets.tencentSecretKey = "";
    expect(tasks.detail(receipt.threadId, modelOnly).modelConfigured).toBe(true);
    await runtime.control(receipt.threadId, resume, modelOnly); await runtime.wait(receipt.threadId);
    expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(stage === "answers" ? 0 : 1));
    expect(await runtime.control(receipt.threadId, resume, config())).toMatchObject({ requestId: resume.requestId }); expect(recognize).toHaveBeenCalledTimes(1);
  } finally { release(); await runtime.wait(receipt.threadId); }
});

it("interrupts active work without starting another run and requires explicit resumption", async () => {
  let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; }); let count = 0;
  const structure = vi.fn(async ({ signal }) => { if (++count === 1) { arrived(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new AppError("AI_RESULT_UNKNOWN", "Outcome unknown")), { once: true })); } return { artifacts: [] }; });
  const { tasks, runtime, input, stages } = await setup({ structure }), receipt = await runtime.create(input, config()); await entered;
  await runtime.control(receipt.threadId, control("interrupt", { runId: receipt.runId }), config()); await runtime.wait(receipt.threadId);
  expect(tasks.record(receipt.threadId).state).toBe("CANCELLED"); expect(stages.assemble).not.toHaveBeenCalled();
  await runtime.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config()); await runtime.wait(receipt.threadId);
  expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); expect(structure).toHaveBeenCalledTimes(2); expect(stages.prepare).toHaveBeenCalledTimes(1);
});

it("holds run ownership through aborted-node cleanup and retains a completed output for explicit resume", async () => {
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { tasks, runtime, input, stages } = await setup({ prepare: vi.fn(async () => { arrived(); await gate; return { artifacts: [] }; }) }), receipt = await runtime.create(input, config());
  try {
    await entered; runtime.abortAll(); let settled = false; const stopping = runtime.settle().then(() => { settled = true; }); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(runtime.active()).toBe(1); expect(tasks.record(receipt.threadId).state).toBe("RUNNING"); expect(() => runtime.delete(receipt.threadId)).toThrowError(expect.objectContaining({ code: "TASK_BUSY" }));
    release(); await stopping; expect(runtime.active()).toBe(0); expect(tasks.record(receipt.threadId)).toMatchObject({ state: "FAILED", outputs: { prepare: { artifacts: [] } } }); expect(stages.recognize).not.toHaveBeenCalled();
    await runtime.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config()); await runtime.wait(receipt.threadId);
    expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); expect(stages.prepare).toHaveBeenCalledTimes(1); expect(stages.recognize).toHaveBeenCalledTimes(1);
  } finally { release(); await runtime.wait(receipt.threadId); }
});

it("replays an old interrupt receipt without aborting the subsequent run", async () => {
  let first!: () => void, second!: () => void, release!: () => void, count = 0, secondSignal: AbortSignal | undefined;
  const firstEntered = new Promise<void>(resolve => { first = resolve; }), secondEntered = new Promise<void>(resolve => { second = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup({ structure: async ({ signal }) => { if (++count === 1) { first(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new AppError("AI_RESULT_UNKNOWN", "Stopped")), { once: true })); } else { secondSignal = signal; second(); await gate; } return { artifacts: [] }; } }), { runtime, tasks, input } = fixture;
  const initial = await runtime.create(input, config());
  try {
    await firstEntered; const request = control("interrupt", { runId: initial.runId }), accepted = await runtime.control(initial.threadId, request, config()); await runtime.wait(initial.threadId);
    await runtime.control(initial.threadId, control("resume", { checkpointId: tasks.record(initial.threadId).checkpointId }), config()); await secondEntered; const before = tasks.record(initial.threadId);
    expect(await runtime.control(initial.threadId, request, config())).toEqual(accepted); expect(secondSignal!.aborted).toBe(false); expect(tasks.record(initial.threadId)).toEqual(before);
    release(); await runtime.wait(initial.threadId); expect(tasks.record(initial.threadId).state).toBe("COMPLETED");
  } finally { release(); runtime.abortAll(); await runtime.wait(initial.threadId); }
});

it.each(["create", "resume"])("replays an old %s receipt without starting an unrelated pending run", async action => {
  const { runtime, tasks, stages, input } = await setup(), initial = tasks.create(input, config()); await runtime.initialize(initial.threadId); tasks.stop(initial.threadId, initial.runId);
  const request = control("resume", { checkpointId: tasks.record(initial.threadId).checkpointId }), accepted = tasks.control(initial.threadId, request, config());
  tasks.stop(initial.threadId, accepted.runId); tasks.control(initial.threadId, control("resume", { checkpointId: tasks.record(initial.threadId).checkpointId }), config()); const before = tasks.record(initial.threadId);
  expect(action === "create" ? await runtime.start(initial, config()) : await runtime.control(initial.threadId, request, config())).toEqual(action === "create" ? initial : accepted);
  expect(runtime.active()).toBe(0); expect(tasks.record(initial.threadId)).toEqual(before); expect(stages.prepare).not.toHaveBeenCalled();
});

it("honors a replay for the same pending admission once and fences a stale scheduled run", async () => {
  const { runtime, tasks, stages, input } = await setup(), initial = tasks.create(input, config()); await runtime.initialize(initial.threadId); tasks.stop(initial.threadId, initial.runId);
  const request = control("resume", { checkpointId: tasks.record(initial.threadId).checkpointId }), accepted = tasks.control(initial.threadId, request, config()), before = tasks.record(initial.threadId);
  await runtime.run(initial.threadId, config(), initial.runId); expect(tasks.record(initial.threadId)).toEqual(before); expect(stages.prepare).not.toHaveBeenCalled();
  expect(await runtime.control(initial.threadId, request, config())).toEqual(accepted); await runtime.wait(initial.threadId); expect(tasks.record(initial.threadId).state).toBe("COMPLETED");
  expect(await runtime.control(initial.threadId, request, config())).toEqual(accepted); await runtime.wait(initial.threadId); expect(stages.prepare).toHaveBeenCalledTimes(1);
});

it.each(["pause", "interrupt"] as const)("stops a queued admission on explicit %s without scheduling a model run", async action => {
  for (const initialized of [false, true]) {
    const { runtime, tasks, stages, calls, input } = await setup(), admitted = tasks.create(input, config()); if (initialized) await runtime.initialize(admitted.threadId);
    const request = control(action, { runId: admitted.runId }), accepted = await runtime.control(admitted.threadId, request, config());
    expect(tasks.record(admitted.threadId)).toMatchObject({ state: action === "pause" ? "PAUSED" : "CANCELLED", checkpointId: expect.any(String) }); const before = tasks.record(admitted.threadId);
    expect(await runtime.control(admitted.threadId, request, config())).toEqual(accepted); await runtime.run(admitted.threadId, config(), admitted.runId); expect(tasks.record(admitted.threadId)).toEqual(before);
    expect(stages.prepare).not.toHaveBeenCalled(); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get()!.n).toBe(0);
  }
});

it("recovers an admitted task without executing stages or creating provider claims", async () => {
  const { tasks, runtime, stages, input, calls } = await setup(), receipt = tasks.create(input, config());
  await runtime.recover(); expect(tasks.record(receipt.threadId)).toMatchObject({ state: "INTERRUPTED", checkpointId: expect.any(String) }); expect(runtime.active()).toBe(0);
  DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).not.toHaveBeenCalled()); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get()!.n).toBe(0);
  await runtime.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config()); await runtime.wait(receipt.threadId); expect(tasks.record(receipt.threadId).state).toBe("COMPLETED");
});

it("fences stale runs/checkpoints, changed targets and conflicting operation request IDs", async () => {
  const { tasks, runtime, input } = await setup(), receipt = tasks.create(input, config()); await runtime.initialize(receipt.threadId);
  expect(() => tasks.control(receipt.threadId, control("pause", { runId: randomUUID() }), config())).toThrow("no longer current");
  const pause = control("pause", { runId: receipt.runId }); const saved = tasks.control(receipt.threadId, pause, config()); expect(tasks.control(receipt.threadId, pause, config())).toEqual(saved);
  expect(() => tasks.control(receipt.threadId, { ...pause, action: "interrupt" }, config())).toThrow("already used"); tasks.stop(receipt.threadId, receipt.runId);
  expect(() => tasks.control(receipt.threadId, control("resume", { checkpointId: "stale" }), config())).toThrow("checkpoint changed"); const changed = config(); changed.preferences.model.modelId = "different";
  expect(tasks.detail(receipt.threadId, changed)).toMatchObject({ resumeCompatible: false, allowedActions: [] }); expect(() => tasks.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), changed)).toThrow("does not allow");
});

it("preserves partial results and artifact ownership during an explicit failed-unit retry", async () => {
  let storage!: AiStorage;
  const structure = vi.fn(async ({ task }) => { const manifest = await storage.putArtifact(Buffer.from(JSON.stringify({ attempt: task.retry })), task.input.document.sha256, "units", task.retry, "application/json"); return { artifacts: [manifest], manifest, failures: task.retry ? [] : [{ stage: "document_parse" as const, index: 0, code: "OUTPUT_INVALID", retryable: true }] }; });
  const assemble = vi.fn(async ({ task }) => { const reference = await storage.putArtifact(Buffer.from(JSON.stringify(result())), task.input.document.sha256, "result", task.retry, "application/json"); return { artifacts: [reference], result: reference, status: task.retry ? "SUCCEEDED" as const : "PARTIAL" as const }; });
  const fixture = await setup({ structure, assemble }); storage = fixture.storage; const { tasks, runtime, input } = fixture;
  const receipt = await runtime.create({ ...input, failurePolicy: "review" }, config()); await runtime.wait(receipt.threadId); const partial = tasks.detail(receipt.threadId, config()), original = tasks.record(receipt.threadId).outputs.structure!.manifest!;
  expect(partial).toMatchObject({ state: "WAITING_REVIEW", allowedActions: ["retry_failed", "accept_partial"], canExportCompleted: true });
  await runtime.control(receipt.threadId, control("retry_failed", { checkpointId: partial.checkpointId }), config()); await runtime.wait(receipt.threadId);
  expect(tasks.detail(receipt.threadId, config())).toMatchObject({ state: "COMPLETED", status: "SUCCEEDED", failures: [] }); expect(structure).toHaveBeenCalledTimes(2); expect(fixture.stages.prepare).toHaveBeenCalledTimes(1);
  expect(tasks.readArtifact(receipt.threadId, original).toString()).toBe('{"attempt":0}'); expect(tasks.record(receipt.threadId).retryBase?.structure?.manifest).toEqual(original);
  const other = tasks.create({ ...input, requestId: randomUUID() }, config()); expect(() => tasks.readArtifact(other.threadId, original)).toThrow("does not belong");
});

it("accepts a verified partial result without calling stages again", async () => {
  const { tasks, runtime, input, stages, storage } = await setup({ assemble: vi.fn(async ({ task }) => { const reference = await storage.putArtifact(Buffer.from(JSON.stringify(result())), task.input.document.sha256, "partial", 0, "application/json"); return { artifacts: [reference], result: reference, status: "PARTIAL" }; }) });
  const receipt = await runtime.create({ ...input, failurePolicy: "review" }, config()); await runtime.wait(receipt.threadId); expect(tasks.record(receipt.threadId).state).toBe("WAITING_REVIEW");
  await runtime.control(receipt.threadId, control("accept_partial", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config()); expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(stage === "answers" ? 0 : 1));
});

it.each(["review", "return_partial"] as const)("honors %s for successful results with quality warnings", async policy => {
  for (const reason of ["flag", "issue", "clean"] as const) {
    const { tasks, runtime, input, stages, storage } = await setup({ assemble: vi.fn(async ({ task }) => {
      const document = result(); document.questions[0].needsReview = reason !== "clean";
      const reference = await storage.putArtifact(Buffer.from(JSON.stringify(document)), task.input.document.sha256, "result", 0, "application/json");
      const processing = await storage.putArtifact(Buffer.from(JSON.stringify({ chunks: { total: 1, succeeded: 1, skipped: 0 }, visuals: { total: 0, succeeded: 0, skipped: 0 }, truncated: false, failures: [], questionSources: [{ questionId: "one", stage: "document_parse", unitIndex: 0 }], quality: { reviewRequired: reason === "flag", reviewQuestionCount: reason === "clean" ? 0 : 1, ...(reason === "issue" ? { issues: [{ questionId: "one", code: "NEEDS_REVIEW" }] } : {}) } })), task.input.document.sha256, "processing", 0, "application/json");
      return { artifacts: [reference, processing], result: reference, processing, status: "SUCCEEDED" };
    }) });
    const receipt = await runtime.create({ ...input, failurePolicy: policy }, config()); await runtime.wait(receipt.threadId);
    const waiting = policy === "review" && reason !== "clean", detail = tasks.detail(receipt.threadId, config()), record = tasks.record(receipt.threadId);
    expect(detail).toMatchObject({ state: waiting ? "WAITING_REVIEW" : "COMPLETED", status: "SUCCEEDED", allowedActions: waiting ? ["accept_partial"] : [], canExportCompleted: true });
    tasks.head(receipt.threadId, config()); tasks.list(); tasks.detail(receipt.threadId, config()); expect(tasks.record(receipt.threadId)).toEqual(record);
    if (waiting) {
      const request = control("accept_partial", { checkpointId: detail.checkpointId }); await runtime.control(receipt.threadId, request, config()); const accepted = tasks.record(receipt.threadId);
      await runtime.control(receipt.threadId, request, config()); expect(tasks.record(receipt.threadId)).toEqual(accepted); expect(accepted).toMatchObject({ state: "COMPLETED", outputs: record.outputs });
    }
    DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(stage === "answers" ? 0 : 1));
  }
});

it("reviews the final generated-answer quality without repeating generation on acceptance", async () => {
  const { tasks, runtime, input, stages, storage } = await setup({ answers: vi.fn(async ({ task }) => {
    const reference = await storage.putArtifact(Buffer.from(JSON.stringify(result())), task.input.document.sha256, "answers", 0, "application/json");
    const processing = await storage.putArtifact(Buffer.from(JSON.stringify({ chunks: { total: 1, succeeded: 1, skipped: 0 }, visuals: { total: 0, succeeded: 0, skipped: 0 }, truncated: false, failures: [], questionSources: [], quality: { reviewRequired: true, reviewQuestionCount: 1, issues: [] } })), task.input.document.sha256, "answer-processing", 0, "application/json");
    return { artifacts: [reference, processing], result: reference, processing, status: "SUCCEEDED" };
  }) });
  const receipt = await runtime.create({ ...input, failurePolicy: "review", generateAnswers: true }, config()); await runtime.wait(receipt.threadId); const detail = tasks.detail(receipt.threadId, config());
  expect(detail).toMatchObject({ state: "WAITING_REVIEW", status: "SUCCEEDED", allowedActions: ["accept_partial"] });
  await runtime.control(receipt.threadId, control("accept_partial", { checkpointId: detail.checkpointId }), config()); expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(1));
});

it("sanitizes unexpected stage failures before persisting checkpoint errors", async () => {
  const { tasks, runtime, input, path } = await setup({ recognize: vi.fn(async () => { throw new Error("DO_NOT_PERSIST_PROVIDER_SECRET https://private.example?token=secret"); }) }), receipt = await runtime.create(input, config()); await runtime.wait(receipt.threadId);
  expect(tasks.detail(receipt.threadId, config())).toMatchObject({ state: "FAILED", blocking: [{ code: "DOCUMENT_RUN_FAILED" }] });
  for (const file of readdirSync(path).filter(name => name.includes("sqlite"))) expect(readFileSync(join(path, file)).toString()).not.toContain("DO_NOT_PERSIST_PROVIDER_SECRET");
});

it("rejects artifacts from another source and preserves immutable artifact metadata", async () => {
  const { tasks, runtime, input, storage } = await setup(), receipt = tasks.create(input, config()); await runtime.initialize(receipt.threadId); tasks.begin(receipt.threadId, receipt.runId, config());
  const foreign = await storage.putArtifact(Buffer.from("foreign"), "a".repeat(64), "evidence", 0, "text/plain"); expect(() => tasks.saveOutput(receipt.threadId, receipt.runId, "recognize", { artifacts: [foreign] })).toThrow("another source");
  expect(tasks.record(receipt.threadId).outputs.recognize).toBeUndefined(); expect(() => tasks.readArtifact(receipt.threadId, foreign)).toThrow();
});

it("reports acknowledged parser jobs and safe page counts without exposing signed URLs or spending model allowance", async () => {
  const { tasks, runtime, input, calls } = await setup(), receipt = tasks.create(input, config()); await runtime.initialize(receipt.threadId); tasks.begin(receipt.threadId, receipt.runId, config());
  const signed = "https://result.cos.ap-guangzhou.myqcloud.com/result.zip?signature=PRIVATE_SIGNED_VALUE", http = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({ Response: new Headers(init.headers).get("X-TC-Action") === "SubmitMultimodalDocParseJob" ? { TaskId: "job-one", RequestId: "submitted" } : { Status: "Success", RequestId: "queried", ResultUrl: signed, SuccessPageNum: 1, FailPageNum: 0 } }))), client = new TencentClient(calls, http);
  await client.submit(receipt.threadId, "source", { bytes: Buffer.from("Original source"), sha256: input.document.sha256, type: "text" }, config()); await client.query(receipt.threadId, "source", config());
  const detail = tasks.detail(receipt.threadId, config()); expect(detail).toMatchObject({ parserJobs: [{ status: "Success", taskId: "job-one", requestId: "submitted", queryRequestId: "queried", successPageCount: 1, failedPageCount: 0, resultSaved: false }], modelBudget: { limit: 2, reserved: 0 }, usage: [], unknownUsageCalls: [] }); expect(JSON.stringify(detail)).not.toContain("PRIVATE_SIGNED_VALUE");
});

it("resumes a corrupt Tencent result through the real LangGraph checkpoint without replaying recognition", async () => {
  let client!: TencentClient, storage!: AiStorage, payload = Buffer.from("invalid archive"), submits = 0, queries = 0, downloads = 0;
  const recognize = vi.fn(async ({ task, config: settings, signal }) => {
    const output = await new TencentResults(client, storage).open(task.id, "source", task.input.document, settings, { sourceType: "text", pageCount: 1 }, signal);
    try { expect(output.bundle.pages[0].elements[0]).toMatchObject({ text_info: { content: "Original source" } }); return { artifacts: [output.record.resultRef as ArtifactReference] }; }
    finally { output.bundle.close(); }
  }), fixture = await setup({ recognize }); storage = fixture.storage;
  client = new TencentClient(fixture.calls, async (_url, init) => {
    const action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") { submits++; return new Response(JSON.stringify({ Response: { TaskId: "saved-job" } })); }
    if (action === "DescribeMultimodalDocParseJob") { queries++; return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE_SIGNED_VALUE" } })); }
    downloads++; return new Response(payload);
  });
  const { runtime, tasks, input, calls, stages } = fixture, receipt = await runtime.create(input, config()); await runtime.wait(receipt.threadId);
  expect(tasks.record(receipt.threadId)).toMatchObject({ state: "FAILED", errorCode: "TENCENT_RESULT_INVALID", failedStage: "recognize" }); expect(stages.structure).not.toHaveBeenCalled();
  const invalidRef = client.job(receipt.threadId, "source").resultRef as ArtifactReference;
  const zip = new ZipFile(); zip.addBuffer(Buffer.from("Original source"), "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); payload = Buffer.concat(chunks);
  await runtime.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config()); await runtime.wait(receipt.threadId);
  expect(tasks.record(receipt.threadId).state).toBe("COMPLETED"); expect({ submits, queries, downloads }).toEqual({ submits: 1, queries: 2, downloads: 2 }); expect(stages.prepare).toHaveBeenCalledTimes(1); expect(recognize).toHaveBeenCalledTimes(2); expect(stages.structure).toHaveBeenCalledTimes(1);
  const reference = tasks.record(receipt.threadId).outputs.recognize!.artifacts[0]; expect(tasks.readArtifact(receipt.threadId, reference)).toEqual(payload); expect(storage.artifact(invalidRef).toString()).toBe("invalid archive");
  expect(tasks.detail(receipt.threadId, config())).toMatchObject({ parserJobs: [{ taskId: "saved-job", resultSaved: true }], modelBudget: { limit: 2, reserved: 0 } }); expect(JSON.stringify(calls.state(receipt.threadId))).not.toContain("PRIVATE_SIGNED_VALUE");
});

it("refuses an unknown document database without changing its bytes", () => {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-unknown-")); paths.push(path); const file = join(path, "document-tasks-v1.sqlite"), unknown = new DatabaseSync(file); unknown.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('retained')"); unknown.close(); const bytes = readFileSync(file), calls = new AiDatabase(path);
  try { expect(() => new DocumentTasks(path, new AiStorage(path), calls)).toThrow("Unsupported document task"); expect(readFileSync(file)).toEqual(bytes); } finally { calls.close(); }
});

it("preserves the original 180-day execution expiry before starting or resuming provider work", async () => {
  const { tasks, runtime, input, calls, stages } = await setup(), receipt = tasks.create(input, config()); await runtime.initialize(receipt.threadId);
  const created = tasks.record(receipt.threadId).createdAt, clock = vi.spyOn(Date, "now").mockReturnValue(created + DOCUMENT_TTL_MS - 1);
  try {
    expect(tasks.detail(receipt.threadId, config()).expiresAt).toBe(new Date(created + DOCUMENT_TTL_MS).toISOString()); expect(tasks.head(receipt.threadId, config()).state).toBe("PENDING");
    clock.mockReturnValue(created + DOCUMENT_TTL_MS); await runtime.run(receipt.threadId, config());
    expect(tasks.record(receipt.threadId)).toMatchObject({ state: "FAILED", errorCode: "TASK_EXPIRED" });
    expect(tasks.detail(receipt.threadId, config())).toMatchObject({ state: "EXPIRED", allowedActions: [], blocking: [{ code: "TASK_EXPIRED" }] });
    expect(tasks.list(0, 20, "EXPIRED").items.map(item => item.threadId)).toEqual([receipt.threadId]); expect(tasks.list(0, 20, "FAILED").items).toEqual([]);
    expect(() => tasks.control(receipt.threadId, control("resume", { checkpointId: tasks.record(receipt.threadId).checkpointId }), config())).toThrow("expired");
    expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_tasks").get()!.n).toBe(0); DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).not.toHaveBeenCalled());
  } finally { clock.mockRestore(); }
});

it("retains verified results and passive artifact access after task expiry", async () => {
  const { tasks, runtime, input, stages } = await setup(), receipt = await runtime.create(input, config()); await runtime.wait(receipt.threadId);
  const record = tasks.record(receipt.threadId), reference = record.outputs.assemble!.result!, before = tasks.readArtifact(receipt.threadId, reference), clock = vi.spyOn(Date, "now").mockReturnValue(record.createdAt + DOCUMENT_TTL_MS);
  try {
    expect(tasks.detail(receipt.threadId, config())).toMatchObject({ state: "EXPIRED", canExportCompleted: true, result: { questions: [{ id: "one" }] }, allowedActions: [] });
    expect(tasks.head(receipt.threadId, config()).state).toBe("EXPIRED"); expect(tasks.readArtifact(receipt.threadId, reference)).toEqual(before); expect(tasks.record(receipt.threadId).outputs).toEqual(record.outputs);
    DOCUMENT_STAGES.forEach(stage => expect(stages[stage]).toHaveBeenCalledTimes(stage === "answers" ? 0 : 1));
  } finally { clock.mockRestore(); }
});

it("preserves an in-flight stage output at expiry and blocks the next stage", async () => {
  const fixture = await setup({ recognize: vi.fn(async () => { clock.mockReturnValue(created + DOCUMENT_TTL_MS); return { artifacts: [] }; }) }), { tasks, runtime, input, stages } = fixture;
  const receipt = tasks.create(input, config()), created = tasks.record(receipt.threadId).createdAt, clock = vi.spyOn(Date, "now").mockReturnValue(created + DOCUMENT_TTL_MS - 1);
  try {
    await runtime.run(receipt.threadId, config()); expect(tasks.record(receipt.threadId)).toMatchObject({ errorCode: "TASK_EXPIRED", outputs: { recognize: { artifacts: [] } } }); expect(stages.structure).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it.each([null, [], { "document_parse:0": 3 }, { "document_parse:0": -1 }, { "document_parse:0": 0.5 }, { "unknown:0": 1 }])("rejects malformed persisted unit retry counts without replacing their data: %j", async retryCounts => {
  const { tasks, input } = await setup(), receipt = tasks.create(input, config()), task = tasks.record(receipt.threadId);
  const raw = JSON.stringify({ ...task, retryCounts }); tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(raw, task.id);
  expect(() => tasks.record(task.id)).toThrowError(expect.objectContaining({ code: "TASK_CHECKPOINT_UNREADABLE" }));
  expect(tasks.db.prepare("SELECT record FROM document_tasks WHERE id=?").get(task.id)!.record).toBe(raw);
});
