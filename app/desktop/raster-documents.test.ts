import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ZipFile } from "yazl";
import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";
import { TextDocuments, type TextInputLimits } from "./text-documents.js";
import { TextStructures } from "./text-structures.js";
import { TextAssembler } from "./text-assembler.js";
import type { RecognizedRaster } from "./raster-documents.js";
import { completedDetail } from "./completed-result.js";
import { documentBankSnapshot } from "./document-bank.js";
import { UnitResults } from "./unit-results.js";
import { ocrUnitInput, readSavedOcrInputs } from "./ocr-inputs.js";
import { DocumentReparser } from "./document-reparse.js";
import { PAGE_SELECTION_WARNING, REPARSE_WARNING } from "./source-selection.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { for (const f of fixtures) f.runtime.abortAll(); for (const f of fixtures.splice(0)) { await f.runtime.wait(f.receipt.threadId); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } vi.restoreAllMocks(); });
async function setup(payload: Buffer, type: "pdf" | "image", limits: Partial<TextInputLimits> = {}, pages?: number[]) {
  const path = mkdtempSync(join(tmpdir(), "practiq-raster-")), db = new AiDatabase(path), storage = new AiStorage(path), store = new SqliteStore(path), checkpoints = new SqliteCheckpoints(path), tasks = new DocumentTasks(path, storage, db);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls: 256, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const sha256 = hash(payload), document: DocumentReference = { fileName: type === "pdf" ? "source.pdf" : "source.png", sourceType: type, mediaType: type === "pdf" ? "application/pdf" : "image/png", sizeBytes: payload.length, sha256, objectKey: sourceKey(type, sha256) }; await storage.putSource(document, payload);
  const jobs: Buffer[] = [], provider = { failed: new Set<number>(), figure: false, nativeSubimage: true }, subimage = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const tencentHttp = vi.fn(async (url: string, init: RequestInit) => {
    const data = init.body ? JSON.parse(String(init.body)) : {}, action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") { expect(data.ResultType).toBe(9); expect(data.EnableSubImg).toBe(true); const saved = await store.get(["document_tasks", receipt.threadId, "tencent_inputs"], "source"); expect(saved).not.toBeNull(); jobs.push(Buffer.from(data.FileBase64, "base64")); return new Response(JSON.stringify({ Response: { TaskId: `job-${jobs.length - 1}` } })); }
    if (action === "DescribeMultimodalDocParseJob") { const index = Number(data.TaskId.split("-")[1]); return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: provider.failed.has(index) ? 0 : 1, FailPageNum: provider.failed.has(index) ? 1 : 0, ResultUrl: `https://result.cos.ap-guangzhou.myqcloud.com/${index}?signature=PRIVATE` } })); }
    const index = Number(new URL(url).pathname.slice(1)), zip = new ZipFile();
    if (provider.failed.has(index)) zip.addBuffer(Buffer.from("failed receipt"), "receipt.txt");
    else { const elements: unknown[] = [{ type: 2, text_info: { content: `${index + 1}. Short answer: Alpha${index}?` } }]; if (provider.figure) elements.push({ index: 7, figure_info: {}, polygon: { left_top: { x: 20, y: 20 }, right_top: { x: 60, y: 20 }, left_bottom: { x: 20, y: 60 }, right_bottom: { x: 60, y: 60 } } }); zip.addBuffer(Buffer.from(JSON.stringify({ width: 100, height: 100, elements })), "x_ocr_page0.json"); if (provider.figure && provider.nativeSubimage) { zip.addBuffer(subimage, "image.png"); zip.addBuffer(Buffer.from('<root><image id="p-7" page-numbers="0" src="image.png"/></root>'), "x_xml_full.xml"); } }
    zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return new Response(Buffer.concat(chunks));
  });
  const modelHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text, index = Number(/PRIMARY is page (\d+)/.exec(text)![1]) - 1;
    expect(text).not.toContain("Original UTF-8 source");
    const result = { questions: [{ id: `page:${index + 1}:1`, stem: `Alpha${index}?`, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: null, contentBlocks: [], sourceText: `${index + 1}. Short answer: Alpha${index}?`, confidence: .9, needsReview: false }], groups: [], figures: provider.figure ? [{ elementIndex: 7, description: "Native figure", questionIndexes: [0] }] : [] };
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "OcrPageParseResult", arguments: JSON.stringify(result) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const client = new TencentClient(db, tencentHttp), documents = new TextDocuments(storage, new TencentResults(client, storage), limits), structures = new TextStructures(storage, new ModelClient(db, modelHttp), 2), assembler = new TextAssembler(storage);
  const stages = { prepare: vi.fn((context: DocumentStageContext) => documents.prepare(context)), recognize: vi.fn((context: DocumentStageContext) => documents.recognize(context)), structure: vi.fn((context: DocumentStageContext) => structures.structure(context)), assemble: vi.fn((context: DocumentStageContext) => assembler.assemble(context)) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store), receipt = tasks.create({ requestId: randomUUID(), document, ...(pages ? { pages } : {}) }, config);
  const run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { path, db, storage, store, checkpoints, tasks, runtime, receipt, config, documents, stages, client, tencentHttp, modelHttp, jobs, provider, document, subimage, run, resume }; fixtures.push(f); return f;
}
function recognized(f: Awaited<ReturnType<typeof setup>>): RecognizedRaster { return JSON.parse(f.storage.artifact(f.tasks.record(f.receipt.threadId).outputs.recognize!.manifest!).toString()); }
const image = () => sharp({ create: { width: 40, height: 40, channels: 4, background: "white" } }).png().toBuffer();
it.each(["pdf", "image"] as const)("publishes a complete %s through real preparation, Tencent decoding, OCR structuring and assembly", async type => {
  const source = type === "pdf" ? readFileSync(new URL("../fixtures/pdf/unembedded-cjk.pdf", import.meta.url)) : await image(), f = await setup(source, type), task = await f.run();
  expect(task.errorCode).toBeNull(); expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble?.status).toBe("SUCCEEDED"); expect(f.jobs).toEqual([source]); expect(f.modelHttp).toHaveBeenCalledTimes(1);
  const output = recognized(f); expect(output).toMatchObject({ version: 2, textRef: null, chunkManifest: null, inputParts: [], truncated: false }); expect(output.pageRefs).toHaveLength(1); expect(JSON.parse(f.storage.artifact(task.outputs.assemble!.result!).toString()).questions[0].stem).toBe("Alpha0?");
  expect(f.storage.source(f.document)).toEqual(source); expect(JSON.stringify(f.db.state(task.id))).not.toContain("PRIVATE");
});
it.each(["pdf", "image"] as const)("retains an explicitly selected original %s page and its warning", async type => {
  const f = await setup(type === "pdf" ? readFileSync(new URL("../fixtures/pdf/unembedded-cjk.pdf", import.meta.url)) : await image(), type, {}, [1]), task = await f.run();
  expect(task.state).toBe("COMPLETED"); expect(f.tasks.result(task)!.warnings).toContain(PAGE_SELECTION_WARNING); expect(f.modelHttp).toHaveBeenCalledTimes(1); expect(f.tasks.detail(task.id, f.config).processing!.questionSources![0].unitIndex).toBe(0);
});
it("rejects unavailable image pages before the first paid submission", async () => {
  const f = await setup(await image(), "image", {}, [2]), task = await f.run(); expect(task.errorCode).toBe("SOURCE_SELECTION_INVALID"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled();
});
it("reparses one original raster tile with frozen bounds and no new Tencent submissions", async () => {
  const f = await setup(readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), "image", { inputBytes: 700 }, [1]); f.provider.figure = true;
  const parent = await f.run(), before = f.tasks.detail(parent.id, f.config), parserCalls = f.tencentHttp.mock.calls.length, modelCalls = f.modelHttp.mock.calls.length, original = recognized(f);
  expect(original.inputParts.length).toBeGreaterThan(1);
  const receipt = await new DocumentReparser(f.tasks, f.store).create(parent.id, { requestId: randomUUID(), selection: { checkpointId: parent.checkpointId, units: [{ stage: "vision_parse", index: 1 }] } }, f.config); await f.runtime.start(receipt, f.config); await f.runtime.wait(receipt.threadId);
  const child = f.tasks.record(receipt.threadId), detail = f.tasks.detail(child.id, f.config); expect(child.state).toBe("COMPLETED"); expect(detail.result!.questions).toHaveLength(1); expect(detail.processing!.questionSources!.map(source => source.unitIndex)).toEqual([1]);
  expect(detail.result!.warnings).toContain(REPARSE_WARNING); expect(detail.result!.visualElements![0]).toMatchObject({ page: 1, bbox: [.2, .2, .6, .6], sourceRef: original.pageRefs[1] });
  expect(f.tencentHttp).toHaveBeenCalledTimes(parserCalls); expect(f.modelHttp).toHaveBeenCalledTimes(modelCalls + 2); expect(detail.modelBudget).toEqual({ limit: 256, reserved: 8 }); expect(f.tasks.detail(parent.id, f.config)).toEqual(before);
});
it("publishes verified native Tencent subimages with the original fixed bounds and full-page source", async () => {
  const f = await setup(await image(), "image"); f.provider.figure = true; const task = await f.run(); expect(task.state).toBe("COMPLETED"); const result = JSON.parse(f.storage.artifact(task.outputs.assemble!.result!).toString()), output = recognized(f), visual = result.visualElements[0];
  expect(visual).toMatchObject({ bbox: [.2, .2, .6, .6], sourceRef: output.pageRefs[0] }); expect(f.storage.artifact(visual.imageRef)).toEqual(f.subimage); expect(result.questions[0].needsReview).toBe(true);
});

it.each([true, false])("projects stopped OCR units with nativeSubimage=%s without creating crops or artifacts", async nativeSubimage => {
  const f = await setup(await image(), "image"); f.provider.figure = true; f.provider.nativeSubimage = nativeSubimage;
  f.stages.assemble.mockImplementationOnce(async () => { throw new AppError("LOCAL_FILE_INVALID", "Stopped before assembly"); });
  const task = await f.run(), source = recognized(f); expect(task.state).toBe("FAILED"); expect(task.outputs.assemble).toBeUndefined();
  const saved = await f.store.search(["document_tasks", task.id, "units"], { limit: 1000 }), writes = vi.spyOn(f.storage, "putArtifact"), updates = vi.spyOn(f.store, "update"), detail = await completedDetail(f.storage, f.store, task, f.tasks.detail(task.id, f.config));
  expect(detail.status).toBe("PARTIAL"); expect(detail.canExportCompleted).toBe(true); expect(detail.result!.questions).toHaveLength(1);
  const visual = detail.result!.visualElements![0]; expect(visual).toMatchObject({ bbox: [.2, .2, .6, .6], sourceRef: source.pageRefs[0], questionIds: [detail.result!.questions[0].id] });
  if (nativeSubimage) { expect(visual.imageRef).toBeTruthy(); expect(f.storage.artifact(visual.imageRef!)).toEqual(f.subimage); }
  else { expect(visual.imageRef).toBeNull(); expect(detail.result!.questions[0].missingFields).toContain("media"); expect(detail.result!.questions[0].needsReview).toBe(true); }
  const bank = documentBankSnapshot(task, detail, { threadId: task.id, checkpointId: task.checkpointId!, scope: "completed" }); expect(bank.status).toBe("PARTIAL");
  expect(await completedDetail(f.storage, f.store, task, f.tasks.detail(task.id, f.config))).toEqual(detail);
  expect(writes).not.toHaveBeenCalled(); expect(updates).not.toHaveBeenCalled(); expect(await f.store.search(["document_tasks", task.id, "units"], { limit: 1000 })).toEqual(saved); expect(f.tasks.record(task.id)).toEqual(task);
  expect(f.modelHttp).toHaveBeenCalledTimes(1); expect(f.tencentHttp).toHaveBeenCalledTimes(3);
});

it("rejects a rehashed OCR unit that changes immutable figure bounds during partial export", async () => {
  const f = await setup(await image(), "image"); f.provider.figure = true; f.stages.assemble.mockImplementationOnce(async () => { throw new AppError("LOCAL_FILE_INVALID", "Stopped before assembly"); }); const task = await f.run();
  const results = new UnitResults(f.store, f.storage, task.id, f.document.sha256, task.executionFingerprint!), loaded = (await results.get(ocrUnitInput(task, readSavedOcrInputs(f.storage, task), 0).identity))!;
  loaded.payload!.visuals[0].bbox = [.1, .1, .8, .8]; const reference = await f.storage.putArtifact(Buffer.from(JSON.stringify(loaded.payload)), f.document.sha256, "unit-result", 0, "application/json");
  await f.store.put(results.namespace, "vision_parse-0", { ...loaded.record, resultRef: reference }); const before = await f.store.get(results.namespace, "vision_parse-0"), writes = vi.spyOn(f.storage, "putArtifact");
  await expect(completedDetail(f.storage, f.store, task, f.tasks.detail(task.id, f.config))).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" });
  expect(await f.store.get(results.namespace, "vision_parse-0")).toEqual(before); expect(writes).not.toHaveBeenCalled(); expect(f.modelHttp).toHaveBeenCalledTimes(1);
});
it("splits actual rendered PDF pixels before submission and retains the immutable original page", async () => {
  const source = readFileSync(new URL("../fixtures/pdf/unembedded-cjk.pdf", import.meta.url)), f = await setup(source, "pdf", { inputBytes: 700 }), task = await f.run(); expect(task.state).toBe("COMPLETED"); const output = recognized(f);
  expect(output.inputParts.length).toBeGreaterThan(1); expect(output.inputParts.every(part => part.sourcePage === 0 && part.reference.mediaType === "image/png")).toBe(true); expect(f.jobs.every(bytes => bytes.length <= 700)).toBe(true); expect(output.pageRefs).toEqual(output.inputParts.map(part => part.reference));
  const original = await sharp(f.storage.artifact(output.inputParts[0].originalPageRef)).raw().toBuffer(), restored = Buffer.alloc(original.length), width = 556;
  for (const part of output.inputParts) { const [left, top, right, bottom] = part.pixelBounds, bytes = await sharp(f.storage.artifact(part.reference)).raw().toBuffer(); for (let y = top; y < bottom; y++) bytes.copy(restored, (y * width + left) * 3, (y - top) * (right - left) * 3, (y - top + 1) * (right - left) * 3); } expect(restored).toEqual(original); expect(f.storage.source(f.document)).toEqual(source);
});
it("retains failed tile placeholders, source images and partial diagnostics", async () => {
  const f = await setup(readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), "image", { inputBytes: 700 }); f.provider.failed.add(0); const task = await f.run(); expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble?.status).toBe("PARTIAL"); const output = recognized(f), result = JSON.parse(f.storage.artifact(task.outputs.assemble!.result!).toString());
  expect(output.truncated).toBe(true); expect(JSON.parse(f.storage.artifact(output.ocrPageRefs[0]).toString())).toEqual({ page: 0, failed: true }); expect(result.visualElements.some((visual: { sourceRef?: unknown }) => JSON.stringify(visual.sourceRef) === JSON.stringify(output.pageRefs[0]))).toBe(true);
});
it("splits an oversized image with exact ordered source bounds and reuses durable preparation after a checkpoint gap", async () => {
  const source = readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), f = await setup(source, "image", { inputBytes: 700 }), writes = vi.spyOn(f.storage, "putArtifact");
  f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); const first = await f.run(); expect(first.outputs.prepare).toBeUndefined(); expect(f.tencentHttp).not.toHaveBeenCalled();
  const before = writes.mock.calls.filter(call => call[2] === "ocr-input").length, task = await f.resume(); expect(task.state).toBe("COMPLETED"); const output = recognized(f);
  expect(output.inputParts.length).toBeGreaterThan(1); expect(output.pageRefs).toEqual(output.inputParts.map(part => part.reference)); expect(f.jobs.length).toBe(output.inputParts.length); expect(f.jobs.every(bytes => bytes.length <= 700)).toBe(true); expect(output.inputParts.reduce((sum, part) => sum + (part.pixelBounds[2] - part.pixelBounds[0]) * (part.pixelBounds[3] - part.pixelBounds[1]), 0)).toBe(64 * 32);
  expect(writes.mock.calls.filter(call => call[2] === "ocr-input")).toHaveLength(before); expect(f.storage.source(f.document)).toEqual(source);
});
it.each(["tile_write", "source_write", "parts", "invalid"])("rejects %s before the first paid submission", async failure => {
  const source = failure === "invalid" ? Buffer.from("invalid PNG") : readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), f = await setup(source, "image", { inputBytes: 700, ...(failure === "parts" ? { maxParts: 1 } : {}) }), put = f.storage.putArtifact.bind(f.storage);
  vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (failure === "tile_write" && args[2] === "ocr-input" && args[3] === 1 || failure === "source_write" && args[2] === "source-page") throw new Error("disk unavailable"); return put(...args); });
  const task = await f.run(); expect(task.failedStage).toBe("prepare"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled(); expect(await f.store.get(["document_tasks", task.id, "tencent_inputs"], "source")).toBeNull();
});
it("checks a damaged later raster tile before starting any Tencent submission", async () => {
  const f = await setup(readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), "image", { inputBytes: 700 });
  f.stages.recognize.mockImplementationOnce(async context => { const plan = JSON.parse(f.storage.artifact(context.task.outputs.prepare!.manifest!).toString()); writeFileSync(join(f.storage.root, plan.parts[1].reference.objectKey), "damaged"); return f.documents.recognize(context); });
  const task = await f.run(); expect(task.errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled();
});
it.each(["engine", "bounds"])("rejects a changed %s in a rehashed saved raster manifest", async damage => {
  const f = await setup(readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url)), "image", { inputBytes: 700 }); f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); const first = await f.run(), namespace = ["document_tasks", first.id, "tencent_inputs"], saved = (await f.store.get(namespace, "source"))!.value.manifest as ArtifactReference, plan = JSON.parse(f.storage.artifact(saved).toString());
  if (damage === "engine") plan.engine.versions.vips = "changed"; else plan.parts[0].pixelBounds[2]--;
  const manifest = await f.storage.putArtifact(Buffer.from(JSON.stringify(plan)), f.document.sha256, "tencent-inputs", 0, "application/json"); await f.store.update(namespace, "source", () => ({ manifest })); const task = await f.resume(); expect(task.errorCode).toBe("TENCENT_INPUTS_INVALID"); expect(f.tencentHttp).not.toHaveBeenCalled();
});
