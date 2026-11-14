import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient, type StructuredInput } from "./model.js";
import { sourcePresencePlan, splitChunkPlan } from "./source-chunks.js";
import { validateSourceContext, validateSourceFields, type SourceFieldContext } from "./source-fields.js";
import { structuredCall, type StructuredCallResult } from "./structured-call.js";
import { UnitResults } from "./unit-results.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures) f.runtime.abortAll(); for (const f of fixtures.splice(0)) { await f.runtime.wait(f.receipt.threadId); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
const source = "1. Short answer: Q\nReference answer: A", question = () => ({ id: "fragment:1:1", stem: "Q", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "A" }, sourceText: source, analysis: null, confidence: 0.9, needsReview: false });
const completion = (questions: unknown[], index = 0): Record<string, unknown> => ({ status: "completed", output: [{ id: `provider-${index}`, call_id: `call-${index}`, type: "function_call", name: "UnitParseResult", arguments: JSON.stringify({ questions }) }], usage: { input_tokens: 10 + index, output_tokens: 5 } });
async function setup(responses: ((index: number) => Record<string, unknown> | Response) = () => completion([question()]), allowance = 4, scope?: SourceFieldContext) {
  const path = mkdtempSync(join(tmpdir(), "practiq-correction-")), db = new AiDatabase(path), storage = new AiStorage(path), checkpoints = new SqliteCheckpoints(path), tasks = new DocumentTasks(path, storage, db), store = new SqliteStore(path);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY_KEY", tencentSecretId: "test", tencentSecretKey: "test" } };
  const bytes = Buffer.from(source), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
  const http = vi.fn(async () => { const response = responses(http.mock.calls.length - 1); return response instanceof Response ? response : new Response(JSON.stringify(response)); }), client = new ModelClient(db, http), spans = splitChunkPlan(source).spans, presence = sourcePresencePlan(source, spans)[0], input: StructuredInput = { schema: "UnitParseResult", promptVersion: "source-field-v1", system: "Extract supplied content only; never solve questions", text: source }, outcomes: StructuredCallResult[] = [];
  const validation = scope ?? { index: 0, expectedNodeCount: 1, presence, requireTypeLabels: true };
  const perform = async (context: DocumentStageContext) => { validateSourceContext(validation); if (allowance > 0) await context.execution.allocate([{ key: "document_parse:0:0", calls: allowance }]); return structuredCall(context, client, "document_parse:0:0", allowance, input, value => validateSourceFields(value, validation)); };
  const stages = { prepare: vi.fn(async () => ({ artifacts: [] })), recognize: vi.fn(async () => ({ artifacts: [] })), structure: vi.fn(async (context: DocumentStageContext) => { const result = await perform(context); outcomes.push(result); if (result.failureCode) throw new AppError(result.failureCode, "Structured unit did not complete"); const units = new UnitResults(store, storage, context.task.id, sha256, context.task.executionFingerprint!), saved = await units.save({ stage: "document_parse", index: 0, round: context.task.retry, inputDigest: hash(source) }, { parsed: result.parsed, visuals: [] }); return { artifacts: [saved.resultRef!] }; }), assemble: vi.fn(async () => { throw new AppError("ACTION_UNAVAILABLE", "Merge remains pending; no final result is fabricated"); }) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store);
  const receipt = tasks.create({ requestId: randomUUID(), document, graphId: "document_parser" }, config), run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { path, db, storage, checkpoints, tasks, store, config, client, http, input, outcomes, stages, runtime, receipt, run, resume, perform }; fixtures.push(f); return f;
}

it.each(["count", "id", "stem", "answer", "label"])("corrects a supplied-source %s violation and retains both calls and usage", async kind => {
  const f = await setup(index => { const bad = { ...question(), ...(kind === "id" ? { id: "wrong-id" } : kind === "stem" ? { stem: "rewritten" } : kind === "answer" ? { answerPayload: null } : kind === "label" ? { questionTypeId: null } : {}) }; return completion(index ? [question()] : kind === "count" ? [] : [bad], index); });
  const task = await f.run(); expect(task.failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(2); const result = f.outcomes[0]; expect(result.failureCode).toBeNull(); expect(result.calls.map(call => call.status)).toEqual(["failed", "succeeded"]); expect(result.calls.map(call => call.usage)).toEqual([{ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }, { inputTokens: 11, outputTokens: 5, cachedInputTokens: 0 }]);
  const first = f.db.receipt(task.id, "document_parse:0:0:attempt:1")!; expect(first.result).toMatchObject({ validationCode: "OUTPUT_INVALID", output: expect.any(String), feedback: expect.any(String) });
  const secondPayload = JSON.parse(String(f.http.mock.calls[1][1].body)); expect(secondPayload.input[1].content[0].text).toBe(source); expect(secondPayload.input[2]).toMatchObject({ role: "assistant", content: (first.result as { output: string }).output }); expect(secondPayload.input[3].content).toContain("never invent source content"); expect(JSON.stringify(secondPayload)).not.toContain("TEST_ONLY_KEY");
});

it.each(["fence", "trailing-comma", "missing-closer"])("repairs model %s punctuation locally without a second paid call", async kind => {
  const f = await setup(() => {
    const result = completion([question()]), call = (result.output as { arguments: string }[])[0], source = call.arguments;
    call.arguments = kind === "fence" ? "```json\n" + source + "\n```" : kind === "trailing-comma" ? source.slice(0, -1) + ",}" : source.slice(0, -1);
    return result;
  });
  expect((await f.run()).failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(1);
  expect(f.outcomes[0].calls).toHaveLength(1); expect(f.outcomes[0].calls[0]).toMatchObject({ status: "succeeded", usage: { inputTokens: 10, outputTokens: 5 } });
});

it("corrects a proven OCR punctuation loss through the durable model boundary", async () => {
  const f = await setup(index => completion([{ id: "page:1:parent", stem: "Title", answerMode: "word_bank", questionTypeId: "Word bank", passage: [{ partType: "text", textValue: "Snow is " }, { partType: "blank", questionId: "child-a" }, { partType: "text", textValue: index ? ". Grass is " : " Grass is " }, { partType: "blank", questionId: "child-b" }, { partType: "text", textValue: "." }] }], index), 4, { index: 0, expectedNodeCount: null, presence: null, ocr: { text: "Snow is [1]. Grass is [2]." } });
  expect((await f.run()).failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(2);
  expect(f.outcomes[0].calls.map(call => call.status)).toEqual(["failed", "succeeded"]);
  const correction = JSON.parse(String(f.http.mock.calls[1][1].body)); expect(correction.input[3].content).toContain("Preserve every source passage character and punctuation");
});

it("does not spend a model call on an invalid persisted source scope", async () => {
  const f = await setup(undefined, 4, { index: 0, expectedNodeCount: null, presence: null, ocr: { text: 1 } } as unknown as SourceFieldContext);
  expect((await f.run()).errorCode).toBe("CHUNK_INPUTS_INVALID"); expect(f.http).not.toHaveBeenCalled();
  expect(f.db.receipt(f.receipt.threadId, "document_parse:0:0:attempt:1")).toBeNull();
});

it("replays the durable failed attempt after a pause and spends only the new correction call", async () => {
  const f = await setup(index => completion(index ? [question()] : [{ ...question(), answerPayload: null }], index)), original = f.client.structured.bind(f.client); let pause = true;
  vi.spyOn(f.client, "structured").mockImplementation(async (...args) => { try { return await original(...args); } catch (error) { if (pause) { pause = false; const task = f.tasks.record(f.receipt.threadId); f.tasks.control(task.id, { requestId: randomUUID(), action: "pause", runId: task.runId }, f.config); } throw error; } });
  const stopped = await f.run(); expect(stopped.state).toBe("PAUSED"); expect(f.http).toHaveBeenCalledTimes(1); expect((await f.store.get(["document_tasks", stopped.id, "budget"], "document_parse:0:0"))!.value.spent).toBe(1);
  const resumed = await f.resume(); expect(resumed.failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(2); expect((await f.store.get(["document_tasks", stopped.id, "budget"], "document_parse:0:0"))!.value.spent).toBe(2); expect(f.outcomes[0].calls).toHaveLength(2); expect(new Set(f.outcomes[0].calls.map(call => call.id)).size).toBe(2);
});

it("reuses a succeeded paid receipt after interruption before the unit artifact commits", async () => {
  const f = await setup(), save = vi.spyOn(UnitResults.prototype, "save").mockImplementationOnce(async () => { throw new AppError("DOCUMENT_STOP_REQUESTED", "Interrupted before unit save"); });
  const first = await f.run(); expect(first.failedStage).toBe("structure"); expect(f.db.receipt(first.id, "document_parse:0:0:attempt:1")!.status).toBe("succeeded"); expect(f.http).toHaveBeenCalledTimes(1); save.mockRestore();
  const resumed = await f.resume(); expect(resumed.failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(1); expect((await f.store.get(["document_tasks", resumed.id, "budget"], "document_parse:0:0"))!.value.spent).toBe(1); expect(resumed.outputs.structure!.artifacts).toHaveLength(1);
});

it("stops repeated invalid content after two calls despite different provider IDs and usage", async () => {
  const f = await setup(index => completion([{ ...question(), answerPayload: null }], index)), task = await f.run(); expect(task.errorCode).toBe("OUTPUT_STALLED"); expect(f.http).toHaveBeenCalledTimes(2); expect(f.outcomes[0].calls).toHaveLength(2); expect(f.outcomes[0].calls.every(call => call.status === "failed")).toBe(true);
});
it("caps changing invalid outputs at four paid calls", async () => {
  const f = await setup(index => completion([{ ...question(), stem: `wrong-${index}` }], index)), task = await f.run(); expect(task.errorCode).toBe("OUTPUT_INVALID"); expect(f.http).toHaveBeenCalledTimes(4); expect((await f.store.get(["document_tasks", task.id, "budget"], "document_parse:0:0"))!.value.spent).toBe(4);
});
it.each([0, 1])("respects the preallocated allowance %s without an extra paid request", async allowance => {
  const f = await setup(index => completion([{ ...question(), stem: `wrong-${index}` }], index), allowance), task = await f.run(); expect(task.errorCode).toBe("MODEL_BUDGET_EXCEEDED"); expect(f.http).toHaveBeenCalledTimes(allowance); expect(f.db.receipt(task.id, `document_parse:0:0:attempt:${allowance + 1}`)).toBeNull();
});
it.each(["disconnect", "server-error", "error-envelope"])("never repairs or automatically replays an uncertain %s result", async kind => {
  const f = await setup(() => { if (kind === "disconnect") throw new TypeError("PRIVATE_PROVIDER_ERROR"); return new Response(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR" } }), { status: kind === "server-error" ? 500 : 200 }); });
  const first = await f.run(); expect(first.errorCode).toBe("AI_RESULT_UNKNOWN"); const second = await f.resume(); expect(second.errorCode).toBe("AI_RESULT_UNKNOWN"); expect(f.http).toHaveBeenCalledTimes(1); const receipt = f.db.receipt(first.id, "document_parse:0:0:attempt:1")!; expect(receipt.status).toBe("unknown"); expect(JSON.stringify(receipt)).not.toContain("PRIVATE_PROVIDER_ERROR");
});
it.each(["truncated", "usage"])("stops a %s response without a correction loop", async kind => {
  const f = await setup(() => { const response = completion([question()]); if (kind === "truncated") { response.status = "incomplete"; response.incomplete_details = { reason: "max_output_tokens" }; } else delete response.usage; return response; }), task = await f.run();
  expect(task.errorCode).toBe(kind === "truncated" ? "OUTPUT_TRUNCATED" : "AI_USAGE_MISSING"); expect(f.http).toHaveBeenCalledTimes(1); expect(f.db.receipt(task.id, "document_parse:0:0:attempt:1")!.status).toBe("failed");
});
it.each([409, 429])("retries an explicit HTTP %s rejection with a separate durable claim", async status => {
  const f = await setup(index => index ? completion([question()], index) : new Response("non-JSON provider rejection", { status })), task = await f.run(); expect(task.failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(2); expect(f.outcomes[0].calls[0]).toMatchObject({ status: "failed", result: { code: "AI_REQUEST_REJECTED", status }, usage: { status: "unknown" } });
});
it.each([401, 402, 403, 404])("stops a permanent HTTP %s rejection without retrying", async status => {
  const f = await setup(() => new Response("PRIVATE_PROVIDER_ERROR", { status })), task = await f.run(); expect(task.errorCode).toBe(status === 402 ? "AI_PROVIDER_BALANCE_REQUIRED" : status === 404 ? "AI_PROVIDER_ERROR" : "AI_PROVIDER_AUTH_ERROR"); expect(f.http).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.db.receipt(task.id, "document_parse:0:0:attempt:1"))).not.toContain("PRIVATE_PROVIDER_ERROR");
});
it("keeps the original input limit before paying for a large correction transcript", async () => {
  const f = await setup(() => completion([{ ...question(), stem: "wrong".repeat(300) }])); f.input.text = "x".repeat(63500); const task = await f.run(); expect(task.errorCode).toBe("MODEL_INPUT_TOO_LARGE"); expect(f.http).toHaveBeenCalledTimes(1); expect(f.db.receipt(task.id, "document_parse:0:0:attempt:2")).toBeNull();
});
it.each(["scope", "internal"])("does not ask the provider to correct a local %s validation failure", async kind => {
  const f = await setup(), original = f.client.structured.bind(f.client);
  vi.spyOn(f.client, "structured").mockImplementation((task, key, input, config, signal) => original(task, key, input, config, signal, () => { if (kind === "scope") throw new AppError("CHUNK_INPUTS_INVALID", "Invalid saved scope"); throw new TypeError("PRIVATE_LOCAL_ERROR"); }));
  const task = await f.run(); expect(task.errorCode).toBe(kind === "scope" ? "CHUNK_INPUTS_INVALID" : "AI_VALIDATOR_FAILED"); expect(f.http).toHaveBeenCalledTimes(1); const receipt = f.db.receipt(task.id, "document_parse:0:0:attempt:1")!;
  expect(receipt).toMatchObject({ status: "failed", result: { validationCode: "NOT_RUN" }, usage: { inputTokens: 10, outputTokens: 5 } }); expect(JSON.stringify(receipt)).not.toContain("PRIVATE_LOCAL_ERROR");
  const resumed = await f.resume(); expect(resumed.errorCode).toBe(task.errorCode); expect(f.http).toHaveBeenCalledTimes(1);
});
