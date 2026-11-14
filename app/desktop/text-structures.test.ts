import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { ChunkInputs, type ChunkInputsManifest } from "./chunk-inputs.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { TextStructures, type StructuredText } from "./text-structures.js";
import type { RecognizedText } from "./text-documents.js";
import prompts from "./document-prompts.json" with { type: "json" };
import { TextAssembler } from "./text-assembler.js";

it.each([["system", "c0e4b8eacf13b602fd57dbf5b0f7aaac11ebd070a6a533f50d7cfdeabd190657"], ["answerSheet", "e08d19dbf848a22906916090296ffac57a702dc23c49d18d92cf1097efe33c87"]] as const)("retains the complete historical %s extraction prompt", (field, digest) => { expect(hash(prompts[field])).toBe(digest); });

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures) f.runtime.abortAll(); for (const f of fixtures.splice(0)) { await f.runtime.wait(f.receipt.threadId); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup(maxCalls = 16, concurrency = 2, sourceOverride?: string, failurePolicy: "return_partial" | "review" = "return_partial") {
  const path = mkdtempSync(join(tmpdir(), "practiq-text-structure-")), db = new AiDatabase(path), storage = new AiStorage(path), store = new SqliteStore(path), checkpoints = new SqliteCheckpoints(path), tasks = new DocumentTasks(path, storage, db);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const source = sourceOverride ?? Array.from({ length: 35 }, (_, index) => `${index + 1}. Short answer: Question ${index + 1}\nReference answer: A${index + 1}`).join("\n\n"), bytes = Buffer.from(source), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
  const provider = { alter: (_index: number, value: Record<string, unknown>, _request: Record<string, unknown>): Record<string, unknown> => value, before: async (_index: number): Promise<void> => {}, active: 0, peak: 0 };
  const http = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text as string, index = Number(/Fragment (\d+) of/.exec(text)![1]) - 1;
    provider.active++; provider.peak = Math.max(provider.active, provider.peak);
    try {
      await provider.before(index); await new Promise(resolve => setTimeout(resolve, 2));
      const ids = /Use exactly these source record IDs and preserve each supplied field: (.*)\n\n/.exec(text), identifiers = ids ? Object.keys(JSON.parse(ids[1])) : [`unscoped:${index}`];
      const questions = identifiers.map(id => { const number = id.split(":").at(-1); return { id, stem: `Question ${number}`, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: `A${number}` }, sourceText: `Question ${number}\nReference answer: A${number}`, analysis: null, confidence: 1, needsReview: false }; });
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: JSON.stringify(provider.alter(index, { questions, groups: [] }, request)) }], usage: { input_tokens: 10, output_tokens: 5 } }));
    } finally { provider.active--; }
  }), model = new ModelClient(db, http), structures = new TextStructures(storage, model, concurrency);
  const stages = { prepare: vi.fn(async () => ({ artifacts: [] })), recognize: vi.fn(async (context: DocumentStageContext) => {
    const textRef = await storage.putArtifact(bytes, sha256, "text", 0, "text/plain"), chunks = await new ChunkInputs(storage).prepare(context, textRef);
    const value: RecognizedText = { version: 1, source: document, textRef, ocrPageRefs: [], inputParts: [], warnings: [], truncated: false, chunkManifest: chunks.manifest }, manifest = await storage.putArtifact(Buffer.from(JSON.stringify(value)), sha256, "recognized-text", 0, "application/json");
    return { manifest, artifacts: [manifest, textRef, ...chunks.artifacts] };
  }), structure: vi.fn((context: DocumentStageContext) => structures.structure(context)), assemble: vi.fn(async () => { throw new AppError("ACTION_UNAVAILABLE", "Complete merge remains pending"); }) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store);
  const receipt = tasks.create({ requestId: randomUUID(), document, failurePolicy }, config), run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { path, db, storage, store, checkpoints, tasks, config, receipt, runtime, run, resume, structures, stages, http, model, provider, document }; fixtures.push(f); return f;
}
function manifest(f: Awaited<ReturnType<typeof setup>>): StructuredText { return JSON.parse(f.storage.artifact(f.tasks.record(f.receipt.threadId).outputs.structure!.manifest!).toString()); }

it("runs all three actual text model units in bounded batches with original extraction instructions", async () => {
  const f = await setup(10), task = await f.run(), output = manifest(f);
  expect(task.failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(3); expect(f.provider.peak).toBe(2);
  expect(output.units.map(unit => [unit.index, unit.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
  expect(task.outputs.structure?.progress?.chunks).toEqual({ total: 3, succeeded: 3, failed: 0, remaining: 0 });
  const ledger = (await f.store.get(["document_tasks", task.id, "call_allowances"], "ledger"))!.value.units;
  expect(ledger).toEqual({ "document_parse:0:0": { calls: 4, allowance: 4 }, "document_parse:1:0": { calls: 4, allowance: 4 }, "document_parse:2:0": { calls: 4, allowance: 2 } });
  const request = JSON.parse(String(f.http.mock.calls[0][1].body)); expect(request.input[0].content[0].text).toContain("Extract assessment questions faithfully from the supplied fragment."); expect(request.input[1].content[0].text).toContain("exactly 16 validated source records");
  const questions = output.units.flatMap(unit => JSON.parse(f.storage.artifact(unit.resultRef!).toString()).parsed.questions); expect(questions).toHaveLength(35); expect(questions.at(-1)).toMatchObject({ stem: "Question 35", answerPayload: { text: "A35" } });
});
it("retains budget-exhausted units explicitly without allocating a new paid call", async () => {
  const f = await setup(5); await f.run(); expect(f.http).toHaveBeenCalledTimes(2);
  expect(manifest(f).units[2]).toMatchObject({ status: "failed", code: "MODEL_BUDGET_EXCEEDED" });
  expect(f.tasks.record(f.receipt.threadId).outputs.structure?.failures).toEqual([{ stage: "document_parse", index: 2, code: "MODEL_BUDGET_EXCEEDED", retryable: false }]);
});
it("reuses completed units and their reserved allowances after pause", async () => {
  const f = await setup(16, 1); let pause = true;
  f.provider.before = async () => { if (pause) { pause = false; const task = f.tasks.record(f.receipt.threadId); f.tasks.control(task.id, { requestId: randomUUID(), action: "pause", runId: task.runId }, f.config); } };
  expect((await f.run()).state).toBe("PAUSED"); expect(f.http).toHaveBeenCalledTimes(1);
  const receipt = f.db.receipt(f.receipt.threadId, "document_parse:0:0:attempt:1");
  expect((await f.resume()).failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(3); expect(f.db.receipt(f.receipt.threadId, "document_parse:0:0:attempt:1")).toEqual(receipt);
});
it("reuses all paid units after interruption before the structure manifest commits", async () => {
  const f = await setup(), original = f.storage.putArtifact.bind(f.storage); let interrupt = true;
  vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (args[2] === "structured-text" && interrupt) { interrupt = false; throw new AppError("DOCUMENT_STOP_REQUESTED", "Interrupted before manifest commit"); } return original(...args); });
  expect((await f.run()).failedStage).toBe("structure"); expect(f.http).toHaveBeenCalledTimes(3);
  expect((await f.resume()).failedStage).toBe("assemble"); expect(f.http).toHaveBeenCalledTimes(3); expect(manifest(f).units.every(unit => unit.status === "succeeded")).toBe(true);
});
it("retries only selected failed units and preserves the earlier partial manifest", async () => {
  const f = await setup(); let fail = true;
  f.provider.alter = (index, value) => index === 1 && fail ? { ...value, questions: [] } : value;
  const first = await f.run(), old = first.outputs.structure!.manifest!, before = f.storage.artifact(old); expect(manifest(f).units[1]).toMatchObject({ status: "failed", code: "OUTPUT_STALLED" }); expect(f.http).toHaveBeenCalledTimes(4);
  fail = false; await f.runtime.control(first.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: first.checkpointId, units: [{ stage: "document_parse", index: 1 }] }, f.config); await f.runtime.wait(first.id);
  expect(f.http).toHaveBeenCalledTimes(5); expect(manifest(f).units.map(unit => unit.round)).toEqual([0, 1, 0]); expect(f.tasks.readArtifact(first.id, old)).toEqual(before);
});
it("never automatically replays unknown paid units or starts a later batch", async () => {
  const f = await setup(); f.provider.before = async index => { if (!index) throw new TypeError("PRIVATE_DISCONNECT"); };
  expect((await f.run()).errorCode).toBe("AI_RESULT_UNKNOWN"); expect(f.http.mock.calls.length).toBeLessThanOrEqual(2); const calls = f.http.mock.calls.length;
  expect((await f.resume()).errorCode).toBe("AI_RESULT_UNKNOWN"); expect(f.http).toHaveBeenCalledTimes(calls);
});
it("checks unknown receipts in later batches before starting any unit and permits only explicit retry", async () => {
  const f = await setup(), recognize = f.stages.recognize.getMockImplementation()!;
  f.stages.recognize.mockImplementation(async context => {
    const output = await recognize(context);
    await context.execution.allocate([{ key: "document_parse:2:0", calls: 4 }]); await context.execution.unit("document_parse:2:0", 4, () => context.execution.reserve("document_parse:2:0", 4));
    f.db.claim(context.task.id, "document_parse:2:0:attempt:1", { inputDigest: hash("unknown historical request"), endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" });
    return output;
  });
  const stopped = await f.run(); expect(stopped.errorCode).toBe("AI_RESULT_UNKNOWN"); expect(f.http).not.toHaveBeenCalled();
  expect((await f.resume()).errorCode).toBe("AI_RESULT_UNKNOWN"); expect(f.http).not.toHaveBeenCalled();
  await f.runtime.control(stopped.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: f.tasks.record(stopped.id).checkpointId }, f.config); await f.runtime.wait(stopped.id);
  expect(f.http).toHaveBeenCalledTimes(3); expect(f.db.receipt(stopped.id, "document_parse:2:0:attempt:1")?.status).toBe("unknown");
});
it("verifies a damaged last chunk before sending any model request", async () => {
  const f = await setup(), recognize = f.stages.recognize.getMockImplementation()!;
  f.stages.recognize.mockImplementation(async context => { const output = await recognize(context), value = JSON.parse(f.storage.artifact(output.manifest).toString()) as RecognizedText, chunks = JSON.parse(f.storage.artifact(value.chunkManifest!).toString()) as ChunkInputsManifest; writeFileSync(join(f.storage.root, chunks.chunkRefs.at(-1)!.objectKey), "damaged"); return output; });
  expect((await f.run()).errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(f.http).not.toHaveBeenCalled();
});
it("rejects hash-valid replacement text that no longer proves the immutable source", async () => {
  const f = await setup(), recognize = f.stages.recognize.getMockImplementation()!;
  f.stages.recognize.mockImplementation(async context => {
    const output = await recognize(context), value = JSON.parse(f.storage.artifact(output.manifest).toString()) as RecognizedText;
    value.textRef = await f.storage.putArtifact(Buffer.from("Forged replacement"), f.document.sha256, "text", 0, "text/plain");
    const replacement = await f.storage.putArtifact(Buffer.from(JSON.stringify(value)), f.document.sha256, "recognized-text", 0, "application/json");
    return { ...output, manifest: replacement, artifacts: [...output.artifacts, value.textRef, replacement] };
  });
  expect((await f.run()).errorCode).toBe("CHUNK_INPUTS_INVALID"); expect(f.http).not.toHaveBeenCalled();
});
it("refuses damaged cached unit evidence before paying for the remaining units", async () => {
  const f = await setup(16, 1); let pause = true; f.provider.before = async () => { if (pause) { pause = false; const task = f.tasks.record(f.receipt.threadId); f.tasks.control(task.id, { requestId: randomUUID(), action: "pause", runId: task.runId }, f.config); } };
  await f.run(); const saved = await f.store.get(["document_tasks", f.receipt.threadId, "units"], "document_parse-0"), reference = saved!.value.resultRef as { objectKey: string }, path = join(f.storage.root, reference.objectKey); writeFileSync(path, "damage"); const before = readFileSync(path);
  expect((await f.resume()).errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(f.http).toHaveBeenCalledTimes(1); expect(readFileSync(path)).toEqual(before);
});

it("counts two explicit retries per failed unit across more than two task rounds", async () => {
  const f = await setup(64); let repaired = -1;
  f.provider.alter = (index, value) => index === repaired ? value : { ...value, questions: [] };
  let task = await f.run(); expect(f.http).toHaveBeenCalledTimes(6);
  const original = task.outputs.structure!.manifest!, bytes = f.storage.artifact(original);
  for (const [round, index] of [0, 0, 1, 1, 2].entries()) {
    if (round === 4) repaired = 2;
    const request = { requestId: randomUUID(), action: "retry_failed", checkpointId: task.checkpointId, units: [{ stage: "document_parse", index }] };
    const receipt = await f.runtime.control(task.id, request, f.config); await f.runtime.wait(task.id); task = f.tasks.record(task.id);
    expect(task.retry).toBe(round + 1); expect(task.retryCounts![`document_parse:${index}`]).toBe(index === 2 ? 1 : round % 2 + 1);
    expect(f.tasks.control(task.id, request, f.config)).toEqual(receipt);
  }
  expect(task.retryCounts).toEqual({ "document_parse:0": 2, "document_parse:1": 2, "document_parse:2": 1 });
  expect(manifest(f).units.map(unit => [unit.round, unit.status])).toEqual([[2, "failed"], [4, "failed"], [5, "succeeded"]]);
  expect(f.http).toHaveBeenCalledTimes(15); expect(f.tasks.readArtifact(task.id, original)).toEqual(bytes);
  const detail = f.tasks.detail(task.id, f.config); expect(detail.failures.map(failure => failure.retriesRemaining)).toEqual([0, 0]); expect(detail.allowedActions).not.toContain("retry_failed");
  const before = structuredClone(task); await expect(f.runtime.control(task.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: task.checkpointId, units: [{ stage: "document_parse", index: 0 }] }, f.config)).rejects.toThrow(); expect(f.tasks.record(task.id)).toEqual(before); expect(f.http).toHaveBeenCalledTimes(15);
});

it("assembles three real text model units into a verified result and processing receipt", async () => {
  const f = await setup(), assembler = new TextAssembler(f.storage); f.runtime.stages.assemble = context => assembler.assemble(context);
  const task = await f.run(), detail = f.tasks.detail(task.id, f.config);
  expect(task).toMatchObject({ state: "COMPLETED", errorCode: null, failedStage: null }); expect(f.http).toHaveBeenCalledTimes(3);
  expect(detail).toMatchObject({ status: "SUCCEEDED", failures: [], canExportCompleted: true, progress: { chunks: { total: 3, succeeded: 3, failed: 0, remaining: 0 } }, processing: { chunks: { total: 3, succeeded: 3 }, quality: { reviewRequired: true, reviewQuestionCount: 35 } } });
  expect(detail.result!.questions.map(question => question.id)).toEqual(Array.from({ length: 35 }, (_, index) => `q${index}`));
  expect(detail.result!.questions.map(question => question.answerPayload)).toEqual(Array.from({ length: 35 }, (_, index) => ({ text: `A${index + 1}` })));
  expect(f.tasks.readArtifact(task.id, task.outputs.assemble!.result!)).toEqual(f.storage.artifact(task.outputs.assemble!.result!));
});
it.each(["return_partial", "review"] as const)("rejects only a conflicting successful unit, retains partial results, and retries explicitly: %s", async policy => {
  const stems = ["First?", "Second?", "Third?"], source = stems.map((stem, index) => `${index + 1}. ${stem}\n${"x".repeat(21000)}\n`).join("");
  const f = await setup(32, 2, source, policy), assembler = new TextAssembler(f.storage); f.runtime.stages.assemble = context => assembler.assemble(context); let corrected = false;
  f.provider.alter = index => ({ questions: [{ id: index === 1 && !corrected ? "same" : index === 0 ? "same" : `item:${index}`, stem: stems[index], answerMode: "short_answer", questionTypeId: "Short answer", sourceText: stems[index], answerPayload: null, confidence: 1 }], groups: [] });
  let task = await f.run(); const original = task.outputs.structure!.manifest!, firstManifest = manifest(f), rejected = firstManifest.units[1], originalBytes = f.storage.artifact(rejected.resultRef!);
  expect(f.tasks.detail(task.id, f.config)).toMatchObject({ state: policy === "review" ? "WAITING_REVIEW" : "COMPLETED", status: "PARTIAL", failures: [{ stage: "document_parse", index: 1, code: "OUTPUT_INVALID", retriesRemaining: 2 }], canExportCompleted: true });
  expect(f.tasks.result(task)!.questions.map(question => question.stem)).toEqual(["First?", "Third?"]); expect(f.http).toHaveBeenCalledTimes(3);
  expect((await f.store.get(["document_tasks", task.id, "units"], "document_parse-1"))!.value).toMatchObject({ status: "rejected", resultRef: rejected.resultRef });
  if (policy === "review") { await f.runtime.control(task.id, { requestId: randomUUID(), action: "accept_partial", checkpointId: task.checkpointId }, f.config); await f.runtime.wait(task.id); task = f.tasks.record(task.id); }
  corrected = true; await f.runtime.control(task.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: task.checkpointId, units: [{ stage: "document_parse", index: 1 }] }, f.config); await f.runtime.wait(task.id); task = f.tasks.record(task.id);
  expect(f.tasks.detail(task.id, f.config)).toMatchObject({ state: policy === "review" ? "WAITING_REVIEW" : "COMPLETED", status: "SUCCEEDED", failures: [], processing: { quality: { reviewRequired: true } } });
  if (policy === "review") { await f.runtime.control(task.id, { requestId: randomUUID(), action: "accept_partial", checkpointId: task.checkpointId }, f.config); expect(f.tasks.record(task.id).state).toBe("COMPLETED"); }
  expect(f.tasks.result(task)!.questions.map(question => question.stem)).toEqual(stems); expect(f.http).toHaveBeenCalledTimes(4);
  expect(manifest(f).units.map(unit => unit.round)).toEqual([0, 1, 0]); expect(f.tasks.readArtifact(task.id, original)).toEqual(f.storage.artifact(original)); expect(f.tasks.readArtifact(task.id, rejected.resultRef!)).toEqual(originalBytes);
});

it("recovers the rejection-to-result storage gap without replaying successful model units", async () => {
  const stems = ["First?", "Second?"], source = stems.map((stem, index) => `${index + 1}. ${stem}\n${"x".repeat(21000)}\n`).join(""), f = await setup(24, 2, source), assembler = new TextAssembler(f.storage);
  f.runtime.stages.assemble = context => assembler.assemble(context);
  f.provider.alter = index => ({ questions: [{ id: "same", stem: stems[index], answerMode: "short_answer", questionTypeId: "Short answer", sourceText: stems[index], answerPayload: null, confidence: 1 }], groups: [] });
  const original = f.storage.putArtifact.bind(f.storage); let fail = true;
  vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (args[2] === "result" && fail) { fail = false; throw new AppError("OBJECT_STORE_UNAVAILABLE", "Stopped after durable rejection"); } return original(...args); });
  let task = await f.run(); expect(task).toMatchObject({ state: "FAILED", failedStage: "assemble", errorCode: "OBJECT_STORE_UNAVAILABLE" }); expect(f.http).toHaveBeenCalledTimes(2);
  expect((await f.store.get(["document_tasks", task.id, "units"], "document_parse-1"))!.value).toMatchObject({ status: "rejected", resultRef: expect.any(Object) });
  task = await f.resume(); expect(f.tasks.detail(task.id, f.config)).toMatchObject({ state: "COMPLETED", status: "PARTIAL", failures: [{ index: 1, code: "OUTPUT_INVALID" }] }); expect(f.http).toHaveBeenCalledTimes(2);
  expect(f.tasks.result(task)!.questions.map(question => question.stem)).toEqual(["First?"]);
});
