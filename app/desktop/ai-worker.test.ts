import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

it("keeps practice responsive while an independent AI worker waits for a model response", async () => {
  const { AiClient } = await import(fileURLToPath(new URL("../.build/electron/app/desktop/ai-client.js", import.meta.url))), { DatabaseClient } = await import(fileURLToPath(new URL("../.build/electron/app/desktop/client.js", import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), "practiq-worker-")), ai = new AiClient(directory), practice = new DatabaseClient(directory);
  const preferences = { model: { provider: "openai", baseUrl: "", modelId: "test", maxOutputTokens: 1000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } };
  let respond: ServerResponse | undefined, arrived!: () => void, settled = false;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((_request, response) => { respond = response; arrived(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); preferences.model.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const revision = randomUUID();
  writeFileSync(join(directory, "electron-ai-settings-v1.json"), JSON.stringify({ version: 1, revision, preferences, secrets: { modelApiKey: null, tencentSecretId: null, tencentSecretKey: null } }));
  try {
    const task = await ai.call({ type: "create_task", sourceDigest: "a".repeat(64), maxCalls: 10 });
    const result = ai.call({ type: "structured", taskId: task, key: "one", input: { schema: "ImportSettings", promptVersion: "v1", system: "Return settings", text: "Source" }, config: { revision, preferences, secrets: { modelApiKey: "test-key", tencentSecretId: "", tencentSecretKey: "" } } }).then((value: unknown) => { settled = true; return value; });
    await requested;
    const pending = new DatabaseSync(join(directory, "ai.sqlite"), { readOnly: true });
    try { expect(pending.prepare("SELECT status FROM ai_calls").get()!.status).toBe("unknown"); } finally { pending.close(); }
    expect(await practice.request({ type: "save_bank", id: null, title: "Offline works", description: "" })).toMatchObject({ ok: true }); expect(settled).toBe(false);
    const closing = ai.close(); expect(ai.close()).toBe(closing); await expect(ai.call({ type: "status" })).rejects.toMatchObject({ code: "LOCAL_WORK_UNAVAILABLE" });
    respond!.writeHead(200, { "Content-Type": "application/json" }); respond!.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "ImportSettings", arguments: JSON.stringify(preferences.import) }], usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(await result).toMatchObject({ value: preferences.import, usage: { inputTokens: 1, outputTokens: 2 } });
    await closing; const retained = new DatabaseSync(join(directory, "ai.sqlite"), { readOnly: true });
    try { expect(retained.prepare("SELECT status FROM ai_calls").get()!.status).toBe("succeeded"); } finally { retained.close(); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ai.close(); await practice.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("boots the compiled AI worker with a corrupt admission while retaining unknown calls and recovering healthy work", async () => {
  const get = (name: string) => import(new URL(`../.build/electron/app/desktop/${name}.js`, import.meta.url).href);
  const [{ AiClient }, { AiDatabase }, { AiStorage, sourceKey }, { DocumentTasks }, { hash }] = await Promise.all(["ai-client", "ai-database", "ai-storage", "document-tasks", "assets"].map(get));
  const directory = mkdtempSync(join(tmpdir(), "practiq-worker-primary-")), calls = new AiDatabase(directory), storage = new AiStorage(directory), tasks = new DocumentTasks(directory, storage, calls);
  const config = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "test", maxOutputTokens: 1000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  let ai: InstanceType<typeof AiClient> | undefined, seeded = false;
  try {
    const bytes = Buffer.from("Keep the original source"), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text", mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
    const bad = tasks.create({ requestId: randomUUID(), document }, config), healthy = tasks.create({ requestId: randomUUID(), document }, config);
    const record = tasks.record(bad.threadId), raw = JSON.stringify({ ...record, state: "RUNNING", input: null }); tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run(raw, bad.threadId);
    calls.createTask(sha256, 10, bad.threadId); const unknown = calls.claim(bad.threadId, "unknown", { inputDigest: sha256, endpoint: "https://model.example/v1/responses", model: "test", promptVersion: "v1" }), receipts = calls.db.prepare("SELECT * FROM ai_calls").all();
    tasks.close(); calls.close(); seeded = true; ai = new AiClient(directory);
    const listed = await ai.call({ type: "document", config, request: { type: "list", revision: config.revision, offset: 0, limit: 20, state: "" } });
    expect(listed).toMatchObject({ value: { items: expect.arrayContaining([expect.objectContaining({ threadId: bad.threadId, state: "FAILED" }), expect.objectContaining({ threadId: healthy.threadId, state: "INTERRUPTED", checkpointId: expect.any(String) })]) } });
    expect(await ai.call({ type: "status" })).toMatchObject({ ready: true, unknownCalls: 1 }); await ai.close();
    const taskDb = new DatabaseSync(join(directory, "document-tasks-v1.sqlite"), { readOnly: true }), callDb = new DatabaseSync(join(directory, "ai.sqlite"), { readOnly: true });
    try { expect(taskDb.prepare("SELECT record FROM document_tasks WHERE id=?").get(bad.threadId)!.record).toBe(raw); expect(callDb.prepare("SELECT * FROM ai_calls").all()).toEqual(receipts); expect(callDb.prepare("SELECT id,status FROM ai_calls").get()).toMatchObject({ id: unknown.id, status: "unknown" }); } finally { taskDb.close(); callDb.close(); }
    expect(storage.source(document)).toEqual(bytes);
  } finally { if (ai) await ai.close(); if (!seeded) { tasks.close(); calls.close(); } rmSync(directory, { recursive: true, force: true }); }
});
