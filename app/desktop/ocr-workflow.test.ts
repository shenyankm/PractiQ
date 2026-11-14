import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { SqliteStore } from "./graph-store.js";
import { DocumentTasks } from "./document-tasks.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { ModelClient } from "./model.js";
import { TextStructures } from "./text-structures.js";
import { UnitResults } from "./unit-results.js";
import { AppError } from "./errors.js";
import type { RecognizedText } from "./text-documents.js";
import type { StructuredOcr } from "./ocr-structures.js";
import type { StoredOcrPage } from "./ocr-inputs.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { for (const f of fixtures) f.runtime.abortAll(); for (const f of fixtures.splice(0)) { await f.runtime.wait(f.receipt.threadId); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.directory, { recursive: true, force: true }); } vi.restoreAllMocks(); });
const page = (index: number, text: string): StoredOcrPage => ({ page: index, elements: [{ text_info: { content: text } }], figures: [] });
const question = { id: "page:1:1", stem: "Alpha?", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: null, contentBlocks: [], sourceText: "1. Alpha?", confidence: .9, needsReview: false };
async function setup(pages = [page(0, "1. Alpha?"), page(1, "Reference material")], maxCalls = 32, failurePolicy: "return_partial" | "review" = "return_partial", original = "1. Alpha? original bytes") {
  const directory = mkdtempSync(join(tmpdir(), "practiq-ocr-structure-")), db = new AiDatabase(directory), storage = new AiStorage(directory), store = new SqliteStore(directory), checkpoints = new SqliteCheckpoints(directory), tasks = new DocumentTasks(directory, storage, db);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const bytes = Buffer.from(original), sha256 = hash(bytes), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", sha256, sizeBytes: bytes.length, objectKey: sourceKey("text", sha256) }; await storage.putSource(document, bytes);
  const provider = { alter: (_index: number, _context: boolean, value: Record<string, unknown>, _request: Record<string, unknown>): unknown => value };
  const http = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text, index = Number(/PRIMARY is page (\d+)/.exec(text)![1]) - 1, context = text.includes("\nCONTEXT:\n");
    const result = { questions: index === 0 ? [{ ...question, ...(context ? { contentBlocks: [{ partType: "text", role: "material", textValue: "Reference material" }] } : {}) }] : [], groups: [], figures: [] };
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "OcrPageParseResult", arguments: JSON.stringify(provider.alter(index, context, result, request)) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  }), model = new ModelClient(db, http), structures = new TextStructures(storage, model, 2);
  const stages = { prepare: vi.fn(async () => ({ artifacts: [] })), recognize: vi.fn(async (_context: DocumentStageContext) => {
    const refs = []; for (const [index, input] of pages.entries()) refs.push(await storage.putArtifact(Buffer.from(JSON.stringify(input)), sha256, "ocr-page", index, "application/json"));
    const value: RecognizedText = { version: 1, source: document, textRef: null, chunkManifest: null, ocrPageRefs: refs, inputParts: [], warnings: [], truncated: pages.some(page => "failed" in page) }, manifest = await storage.putArtifact(Buffer.from(JSON.stringify(value)), sha256, "recognized-text", 0, "application/json"); return { manifest, artifacts: [manifest, ...refs] };
  }), structure: vi.fn((context: DocumentStageContext) => structures.structure(context)), assemble: vi.fn(async () => { throw new AppError("ACTION_UNAVAILABLE", "OCR merge remains pending"); }) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store), receipt = tasks.create({ requestId: randomUUID(), document, failurePolicy }, config);
  const run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { directory, db, storage, store, checkpoints, tasks, runtime, receipt, config, provider, http, stages, structures, run, resume, pages }; fixtures.push(f); return f;
}
function output(f: Awaited<ReturnType<typeof setup>>): StructuredOcr { return JSON.parse(f.storage.artifact(f.tasks.record(f.receipt.threadId).outputs.structure!.manifest!).toString()); }
async function payload(f: Awaited<ReturnType<typeof setup>>, index = 0) { const task = f.tasks.record(f.receipt.threadId), unit = output(f).units[index]; return (await new UnitResults(f.store, f.storage, task.id, task.input.document.sha256, task.executionFingerprint!).get(unit))!.payload; }

it("dispatches actual OCR PRIMARY/context calls from the text graph and reuses the immutable unit", async () => {
  const f = await setup(), task = await f.run(); expect(task.failedStage).toBe("assemble"); expect(task.errorCode).toBe("ACTION_UNAVAILABLE");
  expect(f.http).toHaveBeenCalledTimes(3); expect(output(f).units.every(unit => unit.status === "succeeded")).toBe(true);
  expect((await payload(f))!.parsed.questions[0].contentBlocks[0]).toMatchObject({ textValue: "Reference material", role: "material" });
  const receipts = f.db.db.prepare("SELECT call_key,status FROM ai_calls WHERE task_id=? ORDER BY call_key").all(task.id); expect(receipts).toHaveLength(3); expect(receipts.every(row => row.status === "succeeded")).toBe(true); expect(receipts.some(row => String(row.call_key).includes(":context:"))).toBe(true);
  const original = output(f).units[0].resultRef!; await f.resume(); expect(f.http).toHaveBeenCalledTimes(3); expect(output(f).units[0].resultRef).toEqual(original);
});
it("never copies or enriches an empty PRIMARY page", async () => {
  const f = await setup([page(0, "Background only"), page(1, "1. A neighboring question?")]); f.provider.alter = index => ({ questions: index === 1 ? [{ ...question, id: "page:2:1", stem: "A neighboring question?", sourceText: "1. A neighboring question?" }] : [], groups: [], figures: [] }); await f.run(); expect(f.http).toHaveBeenCalledTimes(3); expect(output(f).units.every(unit => unit.status === "succeeded")).toBe(true);
  expect((await payload(f))!.parsed.questions).toEqual([]); expect(f.http.mock.calls.filter(([, init]) => String(init.body).includes("PRIMARY is page 1.")).length).toBe(1);
});
it("rejects changed PRIMARY identities during context and retains durable correction usage", async () => {
  const f = await setup(); let contexts = 0;
  f.provider.alter = (index, context, value) => { if (index === 0 && context && contexts++ === 0) return { ...value, questions: [{ ...question, id: "page:1:9" }] }; return value; };
  await f.run(); expect(contexts).toBe(2); expect(f.http).toHaveBeenCalledTimes(4); expect(output(f).units[0].status).toBe("succeeded");
  expect(f.db.db.prepare("SELECT status FROM ai_calls WHERE call_key LIKE '%:context:%' ORDER BY call_key").all().map(row => row.status)).toEqual(["failed", "succeeded"]);
});
it("keeps PRIMARY results for review when the complete context exceeds the input cap", async () => {
  const f = await setup([page(0, "1. Alpha?"), page(1, "x".repeat(64000))]); await f.run(); const result = await payload(f);
  expect(result!.contextSkipped).toBe(true); expect(result!.parsed.questions[0].needsReview).toBe(true); expect(output(f).units[0].status).toBe("succeeded");
  expect(f.db.db.prepare("SELECT call_key FROM ai_calls WHERE call_key LIKE '%:context:%'").all()).toHaveLength(0);
});
it("retains failed source pages and never crosses their barrier or starts a model for them", async () => {
  const f = await setup([page(0, "1. Alpha?"), { page: 1, failed: true }, page(2, "Reference material")]); await f.run(); expect(output(f).units[1]).toMatchObject({ status: "failed", code: "TENCENT_PAGE_FAILED" }); expect(f.http).toHaveBeenCalledTimes(2);
  expect(f.http.mock.calls.every(([, init]) => !String(init.body).includes("PRIMARY DRAFT"))).toBe(true);
});
it("preserves an unknown context call and reuses PRIMARY without resubmitting on resume", async () => {
  const f = await setup(); f.provider.alter = (index, context, value) => { if (index === 0 && context) throw new Error("lost upstream connection"); return value; };
  const task = await f.run(); expect(task.errorCode).toBe("AI_RESULT_UNKNOWN"); const calls = f.http.mock.calls.length; await f.resume(); expect(f.http).toHaveBeenCalledTimes(calls); expect(f.tasks.record(task.id).errorCode).toBe("AI_RESULT_UNKNOWN");
  expect(f.db.db.prepare("SELECT status FROM ai_calls WHERE call_key LIKE '%:context:%'").all()).toEqual([{ status: "unknown" }]);
});
it("exhausts a shared page allowance without resetting it between PRIMARY and context", async () => {
  const f = await setup(undefined, 2); f.provider.alter = (index, context, value) => { if (index === 0 && !context && f.http.mock.calls.length === 1) return { ...value, questions: [{ ...question, questionTypeId: null }] }; return value; }; await f.run();
  expect(f.http.mock.calls.length).toBeLessThanOrEqual(2); expect(output(f).units.every(unit => unit.status === "failed")).toBe(true); expect(output(f).units[0].code).toBe("MODEL_BUDGET_EXCEEDED");
});

it("reuses verified unit artifacts after a crash gap before the structure output is published", async () => {
  const f = await setup(); let completed: StructuredOcr | undefined;
  f.stages.structure.mockImplementationOnce(async context => { const result = await f.structures.structure(context); completed = JSON.parse(f.storage.artifact(result.manifest!).toString()); throw new AppError("CRASH_PROBE", "Interrupted after durable page results"); });
  expect((await f.run()).errorCode).toBe("CRASH_PROBE"); expect(f.http).toHaveBeenCalledTimes(3); await f.resume(); expect(f.http).toHaveBeenCalledTimes(3); expect(output(f).units).toEqual(completed!.units);
});
it("retries only selected failed OCR pages and retains successful siblings and per-page retry counts", async () => {
  const f = await setup(); f.provider.alter = (index, _context, value) => index === 0 ? { ...value, questions: [{ ...question, questionTypeId: null }] } : value; await f.run();
  expect(output(f).units[0]).toMatchObject({ status: "failed", code: "OUTPUT_STALLED" }); const sibling = output(f).units[1].resultRef!; expect(f.http).toHaveBeenCalledTimes(3);
  f.provider.alter = (_index, _context, value) => value;
  const task = f.tasks.record(f.receipt.threadId); await f.runtime.control(task.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: task.checkpointId, units: [{ stage: "vision_parse", index: 0 }] }, f.config); await f.runtime.wait(task.id);
  expect(f.http).toHaveBeenCalledTimes(5); expect(output(f).units[0]).toMatchObject({ status: "succeeded", round: 1 }); expect(output(f).units[1].resultRef).toEqual(sibling); expect(f.tasks.record(task.id).retryCounts).toEqual({ "vision_parse:0": 1 });
});
it("validates every later page identity before sending the first model request", async () => {
  const f = await setup(); f.pages[1].page = 19; expect((await f.run()).errorCode).toBe("CHUNK_INPUTS_INVALID"); expect(f.http).not.toHaveBeenCalled(); expect(f.db.db.prepare("SELECT * FROM ai_calls").all()).toEqual([]);
});

import sharp from "sharp";
it("labels immutable figure previews and attaches only original references and coordinates", async () => {
  const f = await setup([page(0, "1. Alpha?")]), bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } }).png().toBuffer(), imageRef = await f.storage.putArtifact(bytes, f.tasks.record(f.receipt.threadId).input.document.sha256, "figure", 0, "image/png");
  const primary = f.pages[0]; if ("failed" in primary) throw new Error(); primary.figures = [{ elementIndex: 7, kind: "image", bbox: [.2, .2, .5, .5], cropBbox: [.1, .1, .6, .6], imageMember: null, imageRef }];
  const recognize = f.stages.recognize.getMockImplementation()!; f.stages.recognize.mockImplementation(async context => { const result = await recognize(context); return { ...result, artifacts: [...result.artifacts, imageRef] }; });
  f.provider.alter = (_index, _context, value, request) => { const content = (request.input as { content: { text?: string; type: string }[] }[])[1].content; expect(content[1].text).toContain("elementIndex=7"); expect(content[2].type).toBe("input_image"); expect(content[0].text).not.toContain(imageRef.objectKey); expect(content[0].text).not.toContain('"cropBbox"'); return { ...value, figures: [{ elementIndex: 7, description: "Source figure", questionIndexes: [0] }] }; };
  await f.run(); expect(f.http).toHaveBeenCalledTimes(1); expect((await payload(f))!.visuals[0]).toMatchObject({ imageRef, bbox: [.2, .2, .5, .5], cropBbox: [.1, .1, .6, .6], page: 0 }); expect((await payload(f))!.parsed.questions[0].needsReview).toBe(true);
});

import { ZipFile } from "yazl";
import { TextDocuments } from "./text-documents.js";
import { TencentClient } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";
it("routes actual differing Tencent text recognition into the OCR model stage", async () => {
  const f = await setup(), zip = new ZipFile(); zip.addBuffer(Buffer.from("1. Alpha?"), "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); const archive = Buffer.concat(chunks);
  const http = vi.fn(async (_url: string, init?: RequestInit) => {
    const action = new Headers(init?.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { TaskId: "known-ocr-job" } }));
    if (action === "DescribeMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/source?signature=TEST_ONLY" } }));
    return new Response(archive);
  }), documents = new TextDocuments(f.storage, new TencentResults(new TencentClient(f.db, http), f.storage));
  f.stages.prepare.mockImplementation(context => documents.prepare(context)); f.stages.recognize.mockImplementation(context => documents.recognize(context));
  expect((await f.run()).failedStage).toBe("assemble"); expect(http).toHaveBeenCalledTimes(3); expect(f.http).toHaveBeenCalledTimes(1); expect(output(f).units[0].status).toBe("succeeded"); expect((await payload(f))!.parsed.questions[0].stem).toBe("Alpha?");
  await f.resume(); expect(http).toHaveBeenCalledTimes(3); expect(f.http).toHaveBeenCalledTimes(1);
});
it("retains template-like context text verbatim without replacing source placeholders", async () => {
  const f = await setup([page(0, "1. Alpha?"), page(1, "Literal {draft} and {context} $& source")]); await f.run();
  const context = f.http.mock.calls.map(([, init]) => JSON.parse(String(init.body)).input[1].content[0].text as string).find(text => text.includes("\nPRIMARY DRAFT:\n"))!;
  expect(context).toContain("Literal {draft} and {context} $& source"); expect(JSON.parse(context.split("\nPRIMARY DRAFT:\n")[1]).questions[0].stem).toBe("Alpha?");
});

import { TextAssembler } from "./text-assembler.js";
it("publishes the actual OCR graph result with provenance and immutable raw units", async () => {
  const f = await setup(); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context)); const task = await f.run();
  expect(task.state).toBe("COMPLETED"); expect(task.errorCode).toBeNull(); expect(task.outputs.assemble!.status).toBe("SUCCEEDED");
  const result = f.tasks.result(task)!; expect(result.questions[0]).toMatchObject({ id: "q0", stem: "Alpha?", answerPayload: null, needsReview: true }); expect(result.questions[0].contentBlocks[0]).toMatchObject({ textValue: "Reference material" });
  expect(f.tasks.detail(task.id, f.config).processing!.questionSources).toEqual([{ questionId: "q0", stage: "vision_parse", unitIndex: 0 }]);
  expect((await payload(f))!.parsed.questions[0].id).toBe("page:1:1"); expect(f.tasks.readArtifact(task.id, task.outputs.assemble!.result!)).toEqual(f.storage.artifact(task.outputs.assemble!.result!)); expect(f.http).toHaveBeenCalledTimes(3);
});
it("publishes partial OCR evidence and a failed-page placeholder without inventing image bytes", async () => {
  const f = await setup([page(0, "1. Alpha?"), { page: 1, failed: true }, page(2, "Reference material")]); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context)); const task = await f.run();
  expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble!.status).toBe("PARTIAL"); const result = f.tasks.result(task)!;
  expect(result.missingFields).toContain("questions"); expect(result.visualElements[0]).toMatchObject({ page: 1, sourceRef: null, imageRef: null, label: "未完成识别的原页", questionIds: [], documentOnly: false });
  const detail = f.tasks.detail(task.id, f.config); expect(detail.processing!.visuals).toMatchObject({ total: 3, succeeded: 2 }); expect(detail.processing!.failures).toContainEqual(expect.objectContaining({ stage: "vision_parse", index: 1, code: "TENCENT_PAGE_FAILED" })); expect(f.http).toHaveBeenCalledTimes(2);
});
it("requires explicit acceptance of a partial OCR run under the review policy", async () => {
  const f = await setup([page(0, "1. Alpha?"), { page: 1, failed: true }], 32, "review"); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context)); const task = await f.run(); expect(task.state).toBe("WAITING_REVIEW"); const calls = f.http.mock.calls.length;
  await f.runtime.control(task.id, { requestId: randomUUID(), action: "accept_partial", checkpointId: task.checkpointId }, f.config); expect(f.tasks.record(task.id).state).toBe("COMPLETED"); expect(f.http).toHaveBeenCalledTimes(calls);
});
it("removes unsupported answers only from the final projection while retaining raw receipts", async () => {
  const f = await setup([page(0, "1. Alpha?")]); f.provider.alter = (_index, _context, value) => ({ ...value, questions: [{ ...question, answerPayload: { text: "unsupported answer" }, analysis: "unsupported analysis" }] }); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context)); const task = await f.run(), result = f.tasks.result(task)!;
  expect(result.questions[0]).toMatchObject({ answerPayload: null, analysis: null, needsReview: true }); expect(result.warnings.some(warning => warning.includes("removed unverified answerPayload, analysis"))).toBe(true); expect((await payload(f))!.parsed.questions[0].answerPayload).toEqual({ text: "unsupported answer" });
});
it("retains reference answers supplied by the original UTF-8 source even when OCR differs", async () => {
  const f = await setup([page(0, "1. Alpha?")], 32, "return_partial", "1. Short answer: Alpha?\nReference answer: A"); f.provider.alter = (_index, _context, value) => ({ ...value, questions: [{ ...question, answerPayload: { text: "A" } }] }); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context)); const task = await f.run(); expect(f.tasks.result(task)!.questions[0].answerPayload).toEqual({ text: "A" });
});
it("does not enable PDF page-range links for text OCR and retains incomplete-context review", async () => {
  const f = await setup([page(0, "1. Alpha?\nSee page 4"), page(1, "Adjacent material"), page(2, "Other material"), page(3, "Restricted far-page marker")]); await f.run();
  const first = f.http.mock.calls.map(([, init]) => JSON.parse(String(init.body)).input[1].content[0].text as string).filter(text => text.includes("PRIMARY is page 1.")); expect(first.every(text => !text.includes("Restricted far-page marker"))).toBe(true); expect((await payload(f))!.parsed.questions[0].needsReview).toBe(true);
});
it("retains a durable merge rejection across a publication gap and retries only the conflicting page", async () => {
  const f = await setup([page(0, "Reading comprehension — Passage title\nArticle: Original passage"), page(1, "Continuation material")], 32, "review");
  const parent = { id: "page:1:1", stem: "Passage title", answerMode: "reading", questionTypeId: "Reading comprehension", answerPayload: null, passage: [{ partType: "text", textValue: "Original passage" }], sourceText: "Reading comprehension — Passage title\nArticle: Original passage", confidence: .9, needsReview: true, sourceScore: 1 };
  let conflict = true; f.provider.alter = (index, _context, value) => ({ ...value, questions: [{ ...parent, sourceScore: index === 1 && conflict ? 2 : 1 }] }); f.stages.assemble.mockImplementation(context => new TextAssembler(f.storage).assemble(context));
  const reject = UnitResults.prototype.reject; vi.spyOn(UnitResults.prototype, "reject").mockImplementationOnce(async function(unit) { await reject.call(this, unit); throw new AppError("CRASH_PROBE", "Interrupted after durable merge rejection"); });
  let task = await f.run(); expect(task.errorCode).toBe("CRASH_PROBE"); const calls = f.http.mock.calls.length, sibling = output(f).units[0].resultRef; await f.resume(); task = f.tasks.record(task.id); expect(task.state).toBe("WAITING_REVIEW"); expect(f.http).toHaveBeenCalledTimes(calls); expect(f.tasks.detail(task.id, f.config).processing!.failures).toContainEqual(expect.objectContaining({ stage: "vision_parse", index: 1, code: "OUTPUT_INVALID" }));
  conflict = false; await f.runtime.control(task.id, { requestId: randomUUID(), action: "retry_failed", checkpointId: task.checkpointId, units: [{ stage: "vision_parse", index: 1 }] }, f.config); await f.runtime.wait(task.id); task = f.tasks.record(task.id);
  expect(task.state).toBe("WAITING_REVIEW"); expect(task.outputs.assemble!.status).toBe("SUCCEEDED"); expect(f.tasks.detail(task.id, f.config).processing!.quality!.reviewRequired).toBe(true);
  await f.runtime.control(task.id, { requestId: randomUUID(), action: "accept_partial", checkpointId: task.checkpointId }, f.config); expect(f.tasks.record(task.id).state).toBe("COMPLETED");
  expect(output(f).units[0].resultRef).toEqual(sibling); expect(f.http).toHaveBeenCalledTimes(calls + 2); expect(f.tasks.result(task)!.questions).toHaveLength(1); expect(f.tasks.result(task)!.questions[0].sourceScore).toBe(1);
});

it.each(["bbox", "imageRef", "questionIndexes"])("rejects a forged cached %s even with internally consistent artifact hashes", async field => {
  const f = await setup([page(0, "1. Alpha?")]), primary = f.pages[0]; if ("failed" in primary) throw new Error(); primary.figures = [{ elementIndex: 7, kind: "image", bbox: [.2, .2, .8, .8], imageMember: null }];
  f.provider.alter = (_index, _context, value) => ({ ...value, figures: [{ elementIndex: 7, description: "Fixed source figure", questionIndexes: [0] }] });
  f.stages.assemble.mockImplementation(async context => {
    const task = context.task, stage = task.outputs.structure!, structured = JSON.parse(f.storage.artifact(stage.manifest!).toString()) as StructuredOcr, record = structured.units[0], raw = JSON.parse(f.storage.artifact(record.resultRef!).toString());
    if (field === "bbox") raw.visuals[0].bbox = [0, 0, 1, 1];
    if (field === "questionIndexes") raw.visuals[0].questionIndexes = [99];
    if (field === "imageRef") raw.visuals[0].imageRef = await f.storage.putArtifact(Buffer.from("unrelated bytes"), task.input.document.sha256, "unrelated", 0, "image/png");
    const resultRef = await f.storage.putArtifact(Buffer.from(JSON.stringify(raw)), task.input.document.sha256, "unit-result", 0, "application/json"), altered = { ...record, resultRef }; structured.units[0] = altered;
    await f.store.update(["document_tasks", task.id, "units"], "vision_parse-0", () => altered);
    const manifest = await f.storage.putArtifact(Buffer.from(JSON.stringify(structured)), task.input.document.sha256, "structured-ocr", 0, "application/json"); f.tasks.saveOutput(task.id, task.runId, "structure", { ...stage, manifest, artifacts: [...stage.artifacts, manifest, resultRef] });
    return new TextAssembler(f.storage).assemble({ ...context, task: f.tasks.record(task.id) });
  });
  const task = await f.run(); expect(task.errorCode).toBe("UNIT_RESULT_INVALID"); expect(f.tasks.result(task)).toBeNull(); expect(f.http).toHaveBeenCalledTimes(1);
});
