import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DOCUMENT_TTL_MS, DocumentExecution, executionFingerprint } from "./document-execution.js";
import { DocumentRuntime, type DocumentStages } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";

const input = { schema: "ImportSettings", promptVersion: "execution-test", system: "Return supplied settings", text: "Fixed source" };
const config = (): AiSnapshot => ({ revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 1 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "PRIVATE_TEST_KEY", tencentSecretId: "PRIVATE_TEST_ID", tencentSecretKey: "PRIVATE_TEST_SECRET" } });
const fixtures: { path: string; store: SqliteStore; calls: AiDatabase; tasks: DocumentTasks; checkpoints: SqliteCheckpoints; runtime: DocumentRuntime }[] = [];
async function setup(settings = config(), changes: Partial<DocumentStages> = {}) {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-execution-")), calls = new AiDatabase(path), storage = new AiStorage(path), store = new SqliteStore(path), tasks = new DocumentTasks(path, storage, calls), checkpoints = new SqliteCheckpoints(path);
  const stages: DocumentStages = { prepare: vi.fn(async () => ({ artifacts: [] })), recognize: vi.fn(async () => ({ artifacts: [] })), structure: vi.fn(async () => ({ artifacts: [] })), assemble: vi.fn(async () => ({ artifacts: [] })), ...changes }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store);
  const fixture = { path, store, calls, tasks, checkpoints, runtime }; fixtures.push(fixture);
  const bytes = Buffer.from("original"), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
  const receipt = tasks.create({ requestId: randomUUID(), document }, settings), record = tasks.record(receipt.threadId), controller = new AbortController();
  return { ...fixture, storage, record, controller, config: settings, stages, execution: new DocumentExecution(store, record, settings, controller, () => tasks.record(record.id)) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures) { fixture.runtime.abortAll(); for (const row of fixture.tasks.db.prepare("SELECT id FROM document_tasks").all()) await fixture.runtime.wait(String(row.id)); }
  for (const fixture of fixtures.splice(0)) { fixture.store.stop(); fixture.calls.close(); fixture.tasks.close(); fixture.checkpoints.close(); rmSync(fixture.path, { recursive: true, force: true }); }
});
const success = (settings: AiSnapshot) => new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "ImportSettings", arguments: JSON.stringify(settings.preferences.import) }], usage: { input_tokens: 10, output_tokens: 5 } }));

it("binds semantics and code/runtime while allowing credential, read-concurrency and model-timeout changes", () => {
  const settings = config(), expected = executionFingerprint(settings), operational = structuredClone(settings); operational.revision = "changed"; operational.secrets.modelApiKey = "ROTATED"; operational.secrets.tencentSecretKey = "ROTATED"; operational.preferences.import.tencentConcurrency = 4; operational.preferences.import.readRetryCount = 2; operational.preferences.model.timeoutSeconds = 2;
  expect(executionFingerprint(operational)).toBe(expected); expect(expected).toMatch(/^[a-f0-9]{64}$/);
  for (const change of [
    (value: AiSnapshot) => { value.preferences.model.maxOutputTokens++; }, (value: AiSnapshot) => { value.preferences.model.modelId = "changed"; },
    (value: AiSnapshot) => { value.preferences.maxCalls++; }, (value: AiSnapshot) => { value.preferences.runTimeoutSeconds = 1; }, (value: AiSnapshot) => { value.preferences.tencentCos.enabled = true; },
  ]) { const value = structuredClone(settings); change(value); expect(executionFingerprint(value)).not.toBe(expected); }
});

it("refuses changed or missing execution fingerprints without hiding saved task records", async () => {
  const { tasks, runtime, record, config, stages } = await setup(); await runtime.initialize(record.id); tasks.stop(record.id, record.runId);
  for (const fingerprint of [undefined, "f".repeat(64)]) {
    tasks.update(record.id, record.runId, value => { value.executionFingerprint = fingerprint; });
    expect(tasks.detail(record.id, config)).toMatchObject({ resumeCompatible: false, allowedActions: [] });
    expect(() => tasks.begin(record.id, record.runId, config)).toThrow("original execution"); expect(tasks.record(record.id).id).toBe(record.id);
  }
  expect(stages.prepare).not.toHaveBeenCalled();
});

it("persists the first run deadline and refuses to extend it when the same run is reopened", async () => {
  const { store, execution, record, config, tasks } = await setup(), start = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await execution.run(async () => {}); const saved = await store.get(["document_tasks", record.id, "deadlines"], record.runId); expect(saved?.value.at).toBe(start + 1800_000);
  clock.mockReturnValue(start + 1800_000);
  const reopened = new DocumentExecution(store, record, config, new AbortController(), () => tasks.record(record.id)), perform = vi.fn(async () => {});
  await expect(reopened.run(perform)).rejects.toMatchObject({ code: "RUN_DEADLINE_EXCEEDED" }); expect(perform).not.toHaveBeenCalled(); expect((await store.get(["document_tasks", record.id, "deadlines"], record.runId))?.value.at).toBe(saved?.value.at);
});

it("gives explicit resume a new deadline while preserving task and unit spend", async () => {
  const { execution, store, tasks, runtime, record, config } = await setup(), start = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await runtime.initialize(record.id); await execution.run(async () => { await execution.allocate([{ key: "document_parse:0", calls: 2 }]); await execution.unit("document_parse:0", 2, () => execution.reserve("document_parse:0", 2)); });
  tasks.stop(record.id, record.runId); clock.mockReturnValue(start + 2000_000);
  tasks.control(record.id, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(record.id).checkpointId }, config);
  const next = tasks.record(record.id), resumed = new DocumentExecution(store, next, config, new AbortController(), () => tasks.record(record.id)); await resumed.run(async () => {});
  expect(next.runId).not.toBe(record.runId); expect((await store.get(["document_tasks", record.id, "deadlines"], next.runId))?.value.at).toBe(start + 3800_000);
  expect((await store.get(["document_tasks", record.id, "budget"], "document_parse:0"))?.value.spent).toBe(1);
});

it("blocks an expired persisted run before any LangGraph stage or provider claim", async () => {
  const { runtime, tasks, store, calls, record, stages } = await setup();
  await store.put(["document_tasks", record.id, "deadlines"], record.runId, { at: Date.now() - 1, fingerprint: record.executionFingerprint! });
  await runtime.run(record.id, config()); expect(tasks.record(record.id)).toMatchObject({ state: "FAILED", errorCode: "RUN_DEADLINE_EXCEEDED" }); expect(stages.prepare).not.toHaveBeenCalled(); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get()!.n).toBe(0);
});

it.each(["request", "response-body"])("aborts a real in-flight HTTP %s at the run deadline and keeps its unknown receipt", async stalled => {
  let requests = 0; const server = createServer((_request, response) => { requests++; if (stalled === "response-body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"status":'); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const settings = config(); settings.preferences.runTimeoutSeconds = 0.5; settings.preferences.model.timeoutSeconds = 2; settings.preferences.model.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`; let model!: ModelClient;
    const fixture = await setup(settings, { structure: async ({ execution, task, config }) => { await execution.allocate([{ key: "document_parse:0", calls: 2 }]); await execution.unit("document_parse:0", 2, () => model.structured(task.id, "first", input, config)); return { artifacts: [] }; } }); model = new ModelClient(fixture.calls);
    await fixture.runtime.run(fixture.record.id, settings);
    expect(requests).toBe(1); expect(fixture.tasks.record(fixture.record.id)).toMatchObject({ state: "FAILED", errorCode: "RUN_DEADLINE_EXCEEDED" }); expect(fixture.calls.receipt(fixture.record.id, "first")?.status).toBe("unknown"); expect(fixture.stages.assemble).not.toHaveBeenCalled();
    await fixture.runtime.control(fixture.record.id, { requestId: randomUUID(), action: "resume", checkpointId: fixture.tasks.record(fixture.record.id).checkpointId }, settings); await fixture.runtime.wait(fixture.record.id);
    expect(requests).toBe(1); expect(fixture.tasks.record(fixture.record.id).errorCode).toBe("AI_RESULT_UNKNOWN"); expect((await fixture.store.get(["document_tasks", fixture.record.id, "budget"], "document_parse:0"))?.value.spent).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("keeps task expiry as the upper bound even for a very long configured run", async () => {
  const settings = config(); settings.preferences.runTimeoutSeconds = Number.MAX_SAFE_INTEGER;
  const { execution, store, record } = await setup(settings); await execution.run(async () => {});
  expect((await store.get(["document_tasks", record.id, "deadlines"], record.runId))?.value.at).toBe(record.createdAt + DOCUMENT_TTL_MS);
});

it("spends per-unit allowance before I/O, reuses successes, and retains unknown charges", async () => {
  const fixture = await setup(), { execution, calls, record, config, store } = fixture, http = vi.fn(async () => success(config)), client = new ModelClient(calls, http); calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  await execution.run(() => execution.unit("document_parse:0", 2, async () => {
    await client.structured(record.id, "first", input, config); await client.structured(record.id, "first", input, config); expect(http).toHaveBeenCalledTimes(1);
    const unknown = new ModelClient(calls, async () => { throw new Error("PRIVATE_TRANSPORT"); }); await expect(unknown.structured(record.id, "second", input, config)).rejects.toMatchObject({ code: "AI_RESULT_UNKNOWN" });
    await expect(client.structured(record.id, "second", input, config)).rejects.toMatchObject({ code: "AI_RESULT_UNKNOWN" }); await expect(client.structured(record.id, "third", input, config)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
  }));
  expect(http).toHaveBeenCalledTimes(1); expect(calls.receipt(record.id, "third")).toBeNull(); expect((await store.get(["document_tasks", record.id, "budget"], "document_parse:0"))?.value).toMatchObject({ spent: 2, allowance: 2 });
  expect(readFileSync(join(fixture.path, "ai-store-v1.sqlite")).toString()).not.toContain("PRIVATE_");
});

it("keeps async-local unit budgets isolated across parallel tasks and units", async () => {
  const fixtures = await Promise.all([setup(), setup()]);
  await Promise.all(fixtures.map(({ execution, calls, record, config }) => {
    calls.createTask(record.input.document.sha256, record.maxCalls, record.id); const client = new ModelClient(calls, async () => success(config));
    return execution.run(() => Promise.all([0, 1].map(index => execution.unit(`document_parse:${index}`, 1, async () => { await client.structured(record.id, `unit:${index}`, input, config); await expect(client.structured(record.id, `unit:${index}:extra`, input, config)).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" }); }))));
  }));
  for (const { store, record, calls } of fixtures) { for (const index of [0, 1]) expect((await store.get(["document_tasks", record.id, "budget"], `document_parse:${index}`))?.value.spent).toBe(1); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get()!.n).toBe(2); }
});

it("durably reserves worst-case unit calls without refunding unused allowance on resume", async () => {
  const f = await setup();
  await f.execution.run(async () => {
    expect(await f.execution.allocate([{ key: "document_parse:0:0", calls: 4 }, { key: "document_parse:1:0", calls: 4 }])).toEqual(new Map([["document_parse:0:0", 4], ["document_parse:1:0", 4]]));
    expect(await f.execution.allocate([{ key: "document_parse:0:0", calls: 4 }, { key: "document_parse:2:0", calls: 4 }])).toEqual(new Map([["document_parse:0:0", 4], ["document_parse:2:0", 2]]));
    expect(await f.execution.allocate([{ key: "document_parse:1:1", calls: 4 }])).toEqual(new Map([["document_parse:1:1", 0]]));
  });
  const reopened = new DocumentExecution(f.store, f.record, f.config, new AbortController(), () => f.tasks.record(f.record.id));
  await reopened.run(async () => { expect(await reopened.allocate([{ key: "document_parse:2:0", calls: 4 }])).toEqual(new Map([["document_parse:2:0", 2]])); });
});
it("serializes competing dispatch allocations and rejects a changed original unit limit", async () => {
  const f = await setup();
  await f.execution.run(async () => {
    const results = await Promise.all([0, 1, 2].map(index => f.execution.allocate([{ key: `document_parse:${index}:0`, calls: 4 }])));
    expect(results.map(value => [...value.values()][0])).toEqual([4, 4, 2]);
    await expect(f.execution.allocate([{ key: "document_parse:0:0", calls: 8 }])).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  });
});
it.each(["fingerprint", "limit", "negative", "total", "fields"])("refuses %s allocation damage without resetting reservations", async damage => {
  const f = await setup(), path = ["document_tasks", f.record.id, "call_allowances"];
  const value: Record<string, unknown> = { fingerprint: f.record.executionFingerprint!, limit: 10, units: { "document_parse:0:0": { calls: 4, allowance: 4 } } };
  if (damage === "fingerprint") value.fingerprint = "a".repeat(64); if (damage === "limit") value.limit = 20;
  if (damage === "negative") value.units = { "document_parse:0:0": { calls: 4, allowance: -1 } };
  if (damage === "total") value.units = Object.fromEntries([0, 1, 2].map(index => [`document_parse:${index}:0`, { calls: 4, allowance: 4 }]));
  if (damage === "fields") value.extra = true;
  await f.store.put(path, "ledger", value);
  await f.execution.run(async () => { await expect(f.execution.allocate([{ key: "document_parse:3:0", calls: 4 }])).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" }); });
  expect((await f.store.get(path, "ledger"))!.value).toEqual(value);
});

it("requires a unit scope for model calls and rejects a changed allowance or stale run", async () => {
  const { execution, calls, record, config, tasks } = await setup(), http = vi.fn(async () => success(config)), client = new ModelClient(calls, http); calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  await expect(execution.reserve("document_parse:0", 1)).rejects.toMatchObject({ code: "EXECUTION_STORE_REQUIRED" });
  await execution.run(async () => {
    await expect(client.structured(record.id, "no-unit", input, config)).rejects.toMatchObject({ code: "EXECUTION_STORE_REQUIRED" });
    await execution.unit("document_parse:0", 1, () => client.structured(record.id, "first", input, config));
    await expect(execution.unit("document_parse:0", 2, () => client.structured(record.id, "second", input, config))).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
    tasks.update(record.id, record.runId, value => { value.runId = randomUUID(); }); expect(() => execution.guard()).toThrow("no longer current");
    tasks.db.prepare("UPDATE document_tasks SET record=json_set(record,'$.runId',?) WHERE id=?").run(record.runId, record.id);
  }); expect(http).toHaveBeenCalledTimes(1);
});

it("never sends a duplicate paid call when parallel continuations share a call identity", async () => {
  const { execution, calls, record, config } = await setup(), http = vi.fn(async () => success(config)), client = new ModelClient(calls, http); calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  await execution.run(() => execution.unit("document_parse:0", 4, async () => {
    const results = await Promise.allSettled([client.structured(record.id, "same", input, config), client.structured(record.id, "same", input, config)]); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  })); expect(http).toHaveBeenCalledTimes(1);
});

it("guards Tencent admission with the same run deadline without spending model allowance", async () => {
  const { execution, calls, record, config, store } = await setup(), http = vi.fn(async () => new Response(JSON.stringify({ Response: { TaskId: "job", RequestId: "request" } }))), client = new TencentClient(calls, http); calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  await execution.run(async () => { await client.submit(record.id, "source", { sha256: record.input.document.sha256, bytes: Buffer.from("original"), type: "text" }, config); });
  expect(http).toHaveBeenCalledTimes(1); expect(await store.search(["document_tasks", record.id, "budget"])).toEqual([]);
});

it("rechecks the immutable source after admission before creating any provider task", async () => {
  const { runtime, record, storage, tasks, calls, stages } = await setup(), path = join(storage.root, record.input.document.objectKey), damaged = Buffer.from("tampered"); writeFileSync(path, damaged);
  await runtime.run(record.id, config()); expect(tasks.record(record.id).errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_tasks").get()!.n).toBe(0); expect(stages.prepare).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(damaged);
});

it.each(["bytes", "ownership", "unlisted"])("blocks resume on damaged saved-stage %s without discarding its evidence", async damage => {
  const { runtime, record, storage, tasks, stages } = await setup(); await runtime.initialize(record.id); tasks.begin(record.id, record.runId, config());
  const reference = await storage.putArtifact(Buffer.from("evidence"), record.input.document.sha256, "evidence", 0, "text/plain"), path = join(storage.root, reference.objectKey);
  tasks.saveOutput(record.id, record.runId, "prepare", { artifacts: [reference], manifest: reference }); tasks.stop(record.id, record.runId);
  if (damage === "bytes") writeFileSync(path, "damaged!");
  if (damage === "ownership") tasks.db.prepare("DELETE FROM document_artifacts WHERE task_id=?").run(record.id);
  if (damage === "unlisted") tasks.update(record.id, record.runId, value => { value.outputs.prepare!.artifacts = []; });
  const before = readFileSync(path), count = tasks.db.prepare("SELECT COUNT(*) AS n FROM document_operations").get()!.n;
  await expect(runtime.control(record.id, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(record.id).checkpointId }, config())).rejects.toMatchObject({ code: damage === "bytes" ? "DOCUMENT_CHECKSUM_MISMATCH" : "INVALID_REFERENCE" });
  expect(tasks.record(record.id).state).toBe("INTERRUPTED"); expect(tasks.db.prepare("SELECT COUNT(*) AS n FROM document_operations").get()!.n).toBe(count); expect(readFileSync(path)).toEqual(before); expect(stages.recognize).not.toHaveBeenCalled();
});

it.each(["deadline", "budget", "unavailable"])("refuses %s Store damage without resetting an allowance or sending a request", async damage => {
  const { execution, store, calls, record, config } = await setup(), http = vi.fn(async () => success(config)), client = new ModelClient(calls, http); calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  if (damage === "deadline") {
    await store.put(["document_tasks", record.id, "deadlines"], record.runId, { at: "1800", fingerprint: record.executionFingerprint! });
    await expect(execution.run(async () => {})).rejects.toMatchObject({ code: "TASK_CHECKPOINT_UNREADABLE" });
  } else {
    await execution.run(() => execution.unit("document_parse:0", 1, async () => {
      if (damage === "unavailable") store.stop(); else await store.put(["document_tasks", record.id, "budget"], "document_parse:0", { spent: "0", allowance: 1, fingerprint: record.executionFingerprint! });
      await expect(client.structured(record.id, "refused", input, config)).rejects.toMatchObject({ code: damage === "unavailable" ? "EXECUTION_STORE_UNAVAILABLE" : "TASK_CHECKPOINT_UNREADABLE" });
      if (damage === "budget") expect((await store.get(["document_tasks", record.id, "budget"], "document_parse:0"))?.value.spent).toBe("0");
    }));
  }
  expect(http).not.toHaveBeenCalled(); expect(calls.receipt(record.id, "refused")).toBeNull();
});

it("rejects provider target changes inside an otherwise valid graph scope", async () => {
  const { execution, calls, record, config, store } = await setup(), http = vi.fn(async () => success(config)), client = new ModelClient(calls, http), tencent = new TencentClient(calls, http), changed = structuredClone(config); changed.preferences.model.modelId = "different"; calls.createTask(record.input.document.sha256, record.maxCalls, record.id);
  await execution.run(() => execution.unit("document_parse:0", 1, async () => {
    await expect(client.structured(record.id, "refused", input, changed)).rejects.toMatchObject({ code: "EXECUTION_VERSION_MISMATCH" });
    await expect(tencent.submit(record.id, "refused", { bytes: Buffer.from("original"), sha256: record.input.document.sha256, type: "text" }, changed)).rejects.toMatchObject({ code: "EXECUTION_VERSION_MISMATCH" });
  }));
  expect(http).not.toHaveBeenCalled(); expect(calls.db.prepare("SELECT COUNT(*) AS n FROM ai_calls").get()!.n).toBe(0); expect(await store.search(["document_tasks", record.id, "budget"])).toEqual([]);
});

it.each(["missing", "changed"])("preserves %s historical builds before any checkpoint rewrite or queue admission", async kind => {
  const { runtime, tasks, record, checkpoints, config } = await setup(); await runtime.initialize(record.id);
  tasks.update(record.id, record.runId, value => { value.executionBuild = kind === "missing" ? undefined : "f".repeat(64); });
  const before = tasks.record(record.id), checkpoint = await checkpoints.getTuple({ configurable: { thread_id: `document:${record.id}` } });
  await expect(runtime.initialize(record.id)).rejects.toMatchObject({ code: "EXECUTION_VERSION_MISMATCH" }); await runtime.recover();
  expect(tasks.record(record.id)).toEqual(before); expect(await checkpoints.getTuple({ configurable: { thread_id: `document:${record.id}` } })).toEqual(checkpoint);
  for (let index = 0; index < 4; index++) expect(tasks.create({ ...record.input, requestId: randomUUID() }, config).accepted).toBe(true);
  expect(() => tasks.create({ ...record.input, requestId: randomUUID() }, config)).toThrow("queue is full");
});
