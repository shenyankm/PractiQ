import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStages } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { ModelClient } from "./model.js";
import { validateQuestion } from "./question-contract.js";
import { SqliteStore } from "./graph-store.js";

const modelInput = { schema: "ImportSettings", promptVersion: "recovery-test-v1", system: "Return the supplied settings", text: "Fixed test input" };
function stages(storage: AiStorage, calls: AiDatabase): DocumentStages {
  return {
    prepare: async () => ({ artifacts: [] }), recognize: async () => ({ artifacts: [] }),
    structure: async ({ task, config, signal, execution }) => {
      await execution.allocate([{ key: "document_parse:0", calls: 2 }]);
      const value = await execution.unit("document_parse:0", 2, () => new ModelClient(calls).structured(task.id, `unit:${task.retry}`, modelInput, config, signal)), manifest = await storage.putArtifact(Buffer.from(JSON.stringify(value.value)), task.input.document.sha256, "unit", task.retry, "application/json"); return { artifacts: [manifest], manifest };
    },
    assemble: async ({ task }) => {
      const result = { schemaVersion: 3, questions: [validateQuestion({ id: "one", stem: "Frozen question", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, analysis: "Reference explanation", sourceText: "Original source", needsReview: false })], groups: [], visualElements: [], warnings: [], confidenceScore: 100, missingFields: [] }, reference = await storage.putArtifact(Buffer.from(JSON.stringify(result)), task.input.document.sha256, "result", 0, "application/json"); return { artifacts: [reference], result: reference, status: "SUCCEEDED" };
    },
  };
}
function finish(response: ServerResponse, settings: AiSnapshot["preferences"]["import"]) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "ImportSettings", arguments: JSON.stringify(settings) }], usage: { input_tokens: 10, output_tokens: 5 } })); }

it.each(["unknown", "succeeded"])("recovers a SIGKILL after a %s provider receipt without automatically making another call", async outcome => {
  const directory = mkdtempSync(join(tmpdir(), "practiq-document-kill-")); let httpCalls = 0, arrived!: () => void;
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 30 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 2, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_KEY", tencentSecretId: "TEST_ID", tencentSecretKey: "TEST_SECRET" } };
  const server = createServer((_request, response) => { httpCalls++; if (outcome === "succeeded" || httpCalls > 1) finish(response, config.preferences.import); arrived(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); config.preferences.model.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  let child: ReturnType<typeof spawn> | undefined, calls: AiDatabase | undefined, tasks: DocumentTasks | undefined, checkpoints: SqliteCheckpoints | undefined, store: SqliteStore | undefined;
  try {
    calls = new AiDatabase(directory); const storage = new AiStorage(directory); tasks = new DocumentTasks(directory, storage, calls);
    const bytes = Buffer.from("Original source"), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
    const receipt = tasks.create({ requestId: randomUUID(), document }, config); tasks.close(); calls.close(); tasks = undefined; calls = undefined;
    const module = (name: string) => new URL(`../.build/electron/app/desktop/${name}.js`, import.meta.url).href;
    const script = `
      const [{AiDatabase},{AiStorage},{SqliteCheckpoints},{DocumentTasks},{DocumentRuntime},{ModelClient},{validateQuestion},{SqliteStore}]=await Promise.all(${JSON.stringify(["ai-database", "ai-storage", "checkpoints", "document-tasks", "document-runtime", "model", "question-contract", "graph-store"].map(module))}.map(url=>import(url)));
      const directory=${JSON.stringify(directory)}, config=${JSON.stringify(config)}, calls=new AiDatabase(directory), storage=new AiStorage(directory), checkpoints=new SqliteCheckpoints(directory), tasks=new DocumentTasks(directory,storage,calls),store=new SqliteStore(directory);
      const runtime=new DocumentRuntime(tasks,checkpoints,{
        prepare:async()=>({artifacts:[]}),recognize:async()=>({artifacts:[]}),
        structure:async({task,signal,execution})=>{await execution.allocate([{key:'document_parse:0',calls:2}]);const value=await execution.unit('document_parse:0',2,()=>new ModelClient(calls).structured(task.id,'unit:'+task.retry,${JSON.stringify(modelInput)},config,signal));process.stdout.write('provider-saved\\n');await new Promise(()=>{});return value;},
        assemble:async()=>({artifacts:[]})
      },store);
      await runtime.run(${JSON.stringify(receipt.threadId)},config);process.exit(0);
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; const saved = new Promise<void>(resolve => child!.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("provider-saved")) resolve(); }));
    child.stderr!.on("data", () => {});
    const bounded = <T,>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Recovery child did not reach its provider boundary")), 8000); timer.unref(); })]);
    await bounded(requested); if (outcome === "succeeded") await bounded(saved);
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) }); child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
    calls = new AiDatabase(directory); tasks = new DocumentTasks(directory, storage, calls); checkpoints = new SqliteCheckpoints(directory); store = new SqliteStore(directory); const runtime = new DocumentRuntime(tasks, checkpoints, stages(storage, calls), store);
    expect(calls.receipt(receipt.threadId, "unit:0")?.status).toBe(outcome);
    await runtime.recover(); expect(tasks.record(receipt.threadId).state).toBe("INTERRUPTED"); expect(httpCalls).toBe(1); expect(runtime.active()).toBe(0);
    await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); expect(httpCalls).toBe(1);
    if (outcome === "unknown") {
      expect(tasks.detail(receipt.threadId, config)).toMatchObject({ state: "FAILED", allowedActions: ["resume", "retry_failed"], unknownUsageCalls: [expect.any(String)] });
      await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "retry_failed", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); expect(httpCalls).toBe(2); expect(calls.receipt(receipt.threadId, "unit:0")?.status).toBe("unknown");
    }
    expect(tasks.detail(receipt.threadId, config)).toMatchObject({ state: "COMPLETED", status: "SUCCEEDED", result: { questions: [{ id: "one" }] }, modelBudget: { limit: 2, reserved: 2 } });
    expect((await store.get(["document_tasks", receipt.threadId, "budget"], "document_parse:0"))?.value.spent).toBe(outcome === "unknown" ? 2 : 1);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    store?.stop(); checkpoints?.close(); tasks?.close(); calls?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
