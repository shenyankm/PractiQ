import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import type { ArtifactReference } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import { AiStorage, SOURCE_FORMATS, sourceKey } from "./ai-storage.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { TencentClient, FILE_TYPES } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";
import { TextDocuments, type TextInputLimits } from "./text-documents.js";
import { TextStructures } from "./text-structures.js";
import { TextAssembler } from "./text-assembler.js";
import type { RecognizedOffice } from "./office-documents.js";
import { visibleWorkbook } from "./office-workbook.js";
import { visibleLegacySlides } from "./office-legacy-slides.js";
import { DocumentReparser } from "./document-reparse.js";
import { PAGE_SELECTION_WARNING } from "./source-selection.js";
import { BoundedZip } from "./zip.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { for (const f of fixtures) f.runtime.abortAll(); for (const f of fixtures.splice(0)) { await f.runtime.wait(f.receipt.threadId); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.directory, { recursive: true, force: true }); } vi.restoreAllMocks(); });
async function setup(type: "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" = "docx", limits: Partial<TextInputLimits> = {}, payload?: Buffer, pages?: number[], cos = false) {
  const directory = mkdtempSync(join(tmpdir(), "practiq-office-")), db = new AiDatabase(directory), storage = new AiStorage(directory), store = new SqliteStore(directory), checkpoints = new SqliteCheckpoints(directory), tasks = new DocumentTasks(directory, storage, db);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  if (cos) config.preferences.tencentCos = { enabled: true, bucket: "fixture-1250000000", region: "ap-guangzhou" };
  const bytes = payload ?? readFileSync(new URL(`../fixtures/office/${type === "ppt" ? "hidden-slides.ppt" : type === "pptx" ? "smoke.pptx" : `${type.startsWith("xls") ? "中文 表格" : "中文 试卷"}.${type}`}`, import.meta.url)), sha256 = hash(bytes), document = { ...SOURCE_FORMATS[type], fileName: `source.${type}`, sha256, sizeBytes: bytes.length, objectKey: sourceKey(type, sha256) }; await storage.putSource(document, bytes);
  const provider = { sheets: type === "xlsx" ? ["题目", "隐藏表"] : [], failLast: false }, submissions: Buffer[] = []; let pageLimit = 300;
  let uploaded: Buffer;
  const tencentHttp = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "PUT") { uploaded = Buffer.from(init.body as Uint8Array); return new Response(null, { headers: { ETag: `"${createHash("md5").update(uploaded).digest("hex")}"` } }); }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const action = new Headers(init.headers).get("X-TC-Action"), data = init.body ? JSON.parse(String(init.body)) : {}, count = Math.min(pageLimit, 1 + provider.sheets.length);
    if (action === "SubmitMultimodalDocParseJob") { expect(data).toMatchObject({ FileType: FILE_TYPES[type], ResultType: 9, EnableSubImg: true, FileEndPageNumber: limits.maxParts ?? 300 }); pageLimit = data.FileEndPageNumber; if (cos) { expect(data.FileUrl).toMatch(/^https:\/\/fixture-/); expect(data.FileBase64).toBeUndefined(); } submissions.push(cos ? uploaded : Buffer.from(data.FileBase64, "base64")); expect(await store.get(["document_tasks", receipt.threadId, "tencent_inputs"], "source")).not.toBeNull(); return new Response(JSON.stringify({ Response: { TaskId: "office-job" } })); }
    if (action === "DescribeMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: count - Number(provider.failLast), FailPageNum: Number(provider.failLast), ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/office?signature=PRIVATE" } }));
    const zip = new ZipFile(); for (let index = 0; index < count - Number(provider.failLast); index++) { const page = index ? { table_name: provider.sheets[index - 1], fields: [], rows: [] } : { width: 100, height: 100, elements: [{ type: 2, text_info: { content: "1. Short answer: Alpha?" } }] }; zip.addBuffer(Buffer.from(JSON.stringify(page)), `x_ocr_page${index}.json`); } zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return new Response(Buffer.concat(chunks));
  });
  const modelHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text, index = Number(/PRIMARY is page (\d+)/.exec(text)![1]) - 1; expect(text).not.toContain("Original UTF-8 source");
    const result = { questions: index ? [] : [{ id: "page:1:1", stem: "Alpha?", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: null, contentBlocks: [], sourceText: "1. Short answer: Alpha?", confidence: .9, needsReview: false }], groups: index ? [{ title: provider.sheets[index - 1], questionIndexes: [] }] : [], figures: [] };
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "OcrPageParseResult", arguments: JSON.stringify(result) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const client = new TencentClient(db, tencentHttp), documents = new TextDocuments(storage, new TencentResults(client, storage), limits), structures = new TextStructures(storage, new ModelClient(db, modelHttp), 2), assembler = new TextAssembler(storage);
  const stages = { prepare: vi.fn((context: DocumentStageContext) => documents.prepare(context)), recognize: vi.fn((context: DocumentStageContext) => documents.recognize(context)), structure: vi.fn((context: DocumentStageContext) => structures.structure(context)), assemble: vi.fn((context: DocumentStageContext) => assembler.assemble(context)) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store), receipt = tasks.create({ requestId: randomUUID(), document, ...(pages ? { pages } : {}) }, config);
  const run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { directory, db, storage, store, checkpoints, tasks, runtime, receipt, config, client, documents, stages, tencentHttp, modelHttp, submissions, provider, bytes, document, run, resume }; fixtures.push(f); return f;
}
function recognized(f: Awaited<ReturnType<typeof setup>>): RecognizedOffice { return JSON.parse(f.storage.artifact(f.tasks.record(f.receipt.threadId).outputs.recognize!.manifest!).toString()); }
it.each([false, true])("preserves binary PPT sources and submits only live visibility changes: COS %s", async cos => {
  const f = await setup("ppt", {}, undefined, undefined, cos), task = await f.run(), expected = visibleLegacySlides(f.bytes, 300, new AbortController().signal);
  expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(f.submissions).toEqual([expected.bytes]); expect(f.storage.source(f.document)).toEqual(f.bytes); expect(recognized(f).inputParts[0].preparation).toBe("visible_powerpoint_slides");
  expect(task.outputs.assemble!.status).toBe("PARTIAL"); expect(recognized(f).warnings.join(" ")).toContain("fewer pages than declared presentation slides");
});
it("rejects an encrypted binary PPT before creating a provider intent", async () => {
  const f = await setup("ppt", {}, readFileSync(new URL("../fixtures/office/hidden-slide-mini.ppt", import.meta.url))), bytes = Buffer.from(f.bytes), marker = Buffer.from("5fc091e3", "hex"), position = bytes.indexOf(marker); expect(position).toBeGreaterThan(0); bytes.writeUInt32LE(0xf3d1c4df, position);
  const corrupt = await setup("ppt", {}, bytes), task = await corrupt.run(); expect(task.errorCode).toBe("OFFICE_INPUT_INVALID"); expect(corrupt.tencentHttp).not.toHaveBeenCalled(); expect(corrupt.modelHttp).not.toHaveBeenCalled(); expect(corrupt.db.state(task.id)).not.toHaveProperty("tencentJobs");
});
it("reuses a durable binary visibility derivative across a checkpoint gap and selected reparse", async () => {
  const f = await setup("ppt"), writes = vi.spyOn(f.storage, "putArtifact"); f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); expect((await f.run()).outputs.prepare).toBeUndefined(); expect(f.tencentHttp).not.toHaveBeenCalled();
  const task = await f.resume(), before = f.tasks.detail(task.id, f.config), calls = f.tencentHttp.mock.calls.length; expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(writes.mock.calls.filter(call => call[2] === "visible-slides")).toHaveLength(1);
  const child = await new DocumentReparser(f.tasks, f.store).create(task.id, { requestId: randomUUID(), selection: { checkpointId: task.checkpointId, units: [{ stage: "vision_parse", index: 0 }] } }, f.config); await f.runtime.start(child, f.config); await f.runtime.wait(child.threadId);
  expect(f.tasks.record(child.threadId).state).toBe("COMPLETED"); expect(f.tencentHttp).toHaveBeenCalledTimes(calls); expect(f.submissions).toHaveLength(1); expect(f.tasks.detail(task.id, f.config)).toEqual(before);
});
it("uses private staging for a valid Office document above 8 MiB without a local converter", async () => {
  const original = await BoundedZip.open(fileURLToPath(new URL("../fixtures/office/中文 试卷.docx", import.meta.url)), { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 1000 }), archive = new ZipFile();
  try { for (const name of original.entries.keys()) archive.addBuffer(await original.read(name, 25 * 1024 * 1024), name); } finally { original.close(); }
  archive.addBuffer(Buffer.alloc(9 * 1024 * 1024), "word/media/padding.bin", { compress: false }); archive.end(); const chunks: Buffer[] = []; for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBeGreaterThan(8 * 1024 * 1024); const f = await setup("docx", {}, bytes, undefined, true), task = await f.run(); expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(f.submissions).toHaveLength(1); expect(f.submissions[0].equals(bytes)).toBe(true); expect(f.client.job(task.id, "source-0-0")).toMatchObject({ resultValidated: true, staging: { deleted: true } }); expect(f.storage.source(f.document).equals(bytes)).toBe(true);
});
it("retains the original hidden-sheet workbook and its visibility-only derivative through private staging", async () => {
  const f = await setup("xlsx", {}, undefined, undefined, true), task = await f.run(); expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(recognized(f).inputParts[0].preparation).toBe("visible_excel_sheets"); expect(f.submissions[0]).toEqual((await visibleWorkbook(f.bytes, 300, new AbortController().signal)).bytes); expect(f.storage.source(f.document)).toEqual(f.bytes); expect(f.client.job(task.id, "source-0-0")).toMatchObject({ staging: { deleted: true } });
});
it.each([false, true])("submits hidden PPTX slides visibly while retaining the original: COS %s", async cos => {
  const bytes = readFileSync(new URL("../fixtures/office/hidden-slides.pptx", import.meta.url)), f = await setup("pptx", {}, bytes, undefined, cos), task = await f.run();
  expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(f.submissions).toHaveLength(1); expect(f.storage.source(f.document)).toEqual(bytes);
  const policy = { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true }, submitted = await BoundedZip.fromBytes(f.submissions[0], policy), original = await BoundedZip.fromBytes(bytes, policy);
  try {
    for (const name of original.entries.keys()) { const before = await original.read(name, policy.expandedBytes), after = await submitted.read(name, policy.expandedBytes); expect(after).toEqual(name === "ppt/slides/slide2.xml" ? Buffer.from(before.toString().replace('show="false"', 'show="true"')) : before); }
  } finally { submitted.close(); original.close(); }
  expect(recognized(f).inputParts[0].preparation).toBe("visible_powerpoint_slides");
  expect(task.outputs.assemble!.status).toBe("PARTIAL"); expect(recognized(f).warnings.join(" ")).toContain("fewer pages than declared presentation slides");
});
it("recovers a hidden-slide snapshot gap without rewriting it or resubmitting recognition", async () => {
  const f = await setup("pptx", {}, readFileSync(new URL("../fixtures/office/hidden-slides.pptx", import.meta.url))), writes = vi.spyOn(f.storage, "putArtifact");
  f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); expect((await f.run()).outputs.prepare).toBeUndefined(); expect(f.tencentHttp).not.toHaveBeenCalled();
  const task = await f.resume(); expect(task.state, task.errorCode ?? "").toBe("COMPLETED"); expect(writes.mock.calls.filter(call => call[2] === "visible-slides")).toHaveLength(1); expect(f.submissions).toHaveLength(1);
  const before = f.tasks.detail(task.id, f.config), calls = f.tencentHttp.mock.calls.length, child = await new DocumentReparser(f.tasks, f.store).create(task.id, { requestId: randomUUID(), selection: { checkpointId: task.checkpointId, units: [{ stage: "vision_parse", index: 0 }] } }, f.config);
  await f.runtime.start(child, f.config); await f.runtime.wait(child.threadId); expect(f.tasks.record(child.threadId).state).toBe("COMPLETED"); expect(f.tencentHttp).toHaveBeenCalledTimes(calls); expect(f.stages.prepare).toHaveBeenCalledTimes(2); expect(f.tasks.detail(task.id, f.config)).toEqual(before);
});
it("does not pay when a hidden-slide derivative cannot be persisted", async () => {
  const f = await setup("pptx", {}, readFileSync(new URL("../fixtures/office/hidden-slides.pptx", import.meta.url))), put = f.storage.putArtifact.bind(f.storage);
  vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (args[2] === "visible-slides") throw new Error("disk unavailable"); return put(...args); });
  expect((await f.run()).failedStage).toBe("prepare"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled();
});
it.each(["content", "order", "preparation"])("refuses a rehashed hidden-slide receipt with changed %s before paid work", async kind => {
  const f = await setup("pptx", {}, readFileSync(new URL("../fixtures/office/hidden-slides.pptx", import.meta.url)));
  f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); const first = await f.run(), namespace = ["document_tasks", first.id, "tencent_inputs"], previous = (await f.store.get(namespace, "source"))!.value.manifest as ArtifactReference, plan = JSON.parse(f.storage.artifact(previous).toString());
  if (kind === "content") {
    const archive = await BoundedZip.fromBytes(f.storage.artifact(plan.submission), { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
    try { const slide = "ppt/slides/slide2.xml", changed = Buffer.from((await archive.read(slide, 2 * 1024 * 1024)).toString().replace("答案 A", "答案 B")); plan.submission = await f.storage.putArtifact(await archive.replace(new Map([[slide, changed]]), 25 * 1024 * 1024), f.document.sha256, "visible-slides", 0, f.document.mediaType); } finally { archive.close(); }
  } else if (kind === "order") plan.slides.reverse(); else plan.preparation = "visible_excel_sheets";
  const manifest = await f.storage.putArtifact(Buffer.from(JSON.stringify(plan)), f.document.sha256, "tencent-inputs", 0, "application/json"); await f.store.update(namespace, "source", () => ({ manifest }));
  expect((await f.resume()).errorCode).toBe("TENCENT_INPUTS_INVALID"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.storage.source(f.document)).toEqual(f.bytes);
});
it.each(["doc", "docx", "pptx", "xls", "xlsx"] as const)("completes %s through Tencent and the shared OCR graph without local conversion", async type => {
  const f = await setup(type), task = await f.run(); expect(task.errorCode).toBeNull(); expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble?.status, JSON.stringify(task.outputs.assemble?.processing ? JSON.parse(f.storage.artifact(task.outputs.assemble.processing).toString()) : task)).toBe("SUCCEEDED"); expect(f.submissions).toHaveLength(1); const output = recognized(f), result = JSON.parse(f.storage.artifact(task.outputs.assemble!.result!).toString());
  expect(result.questions[0].stem).toBe("Alpha?"); expect(output).toMatchObject({ version: 3, textRef: null, chunkManifest: null, truncated: false }); expect(output.pageRefs).toEqual(output.ocrPageRefs); expect(f.storage.source(f.document)).toEqual(f.bytes); expect(JSON.stringify(f.db.state(task.id))).not.toContain("PRIVATE");
  if (type === "xlsx") { expect(output.inputParts[0].preparation).toBe("visible_excel_sheets"); expect(f.submissions[0]).toEqual((await visibleWorkbook(f.bytes, 300, new AbortController().signal)).bytes); expect(f.submissions[0].equals(f.bytes)).toBe(false); } else expect(f.submissions[0]).toEqual(f.bytes);
});
it("retains missing native worksheet coverage as partial rather than proving a complete workbook", async () => {
  const f = await setup("xlsx"); f.provider.sheets = ["题目"]; const task = await f.run(); expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble?.status).toBe("PARTIAL"); expect(recognized(f).warnings.join(" ")).toContain("coverage of every workbook sheet");
});
it("selects an Office page and reparses it without repeating recognition or visibility preparation", async () => {
  const f = await setup("xlsx", {}, undefined, [1]), parent = await f.run(); expect(parent.state).toBe("COMPLETED"); expect(recognized(f).ocrPageRefs).toHaveLength(3); expect(f.modelHttp).toHaveBeenCalledTimes(2); expect(f.tasks.result(parent)!.warnings).toContain(PAGE_SELECTION_WARNING);
  const before = f.tasks.detail(parent.id, f.config), parser = f.tencentHttp.mock.calls.length, receipt = await new DocumentReparser(f.tasks, f.store).create(parent.id, { requestId: randomUUID(), selection: { checkpointId: parent.checkpointId, units: [{ stage: "vision_parse", index: 0 }] } }, f.config);
  await f.runtime.start(receipt, f.config); await f.runtime.wait(receipt.threadId); const child = f.tasks.record(receipt.threadId); expect(child.state).toBe("COMPLETED"); expect(f.tasks.detail(child.id, f.config).processing!.questionSources!.map(source => source.unitIndex)).toEqual([0]);
  expect(f.modelHttp).toHaveBeenCalledTimes(4); expect(f.tencentHttp).toHaveBeenCalledTimes(parser); expect(f.submissions).toHaveLength(1); expect(f.stages.prepare).toHaveBeenCalledOnce(); expect(f.stages.recognize).toHaveBeenCalledOnce(); expect(f.tasks.detail(parent.id, f.config)).toEqual(before);
  expect(f.tasks.detail(child.id, f.config).modelBudget).toEqual({ limit: 64, reserved: 8 }); expect(JSON.parse(f.storage.artifact(child.outputs.structure!.manifest!).toString()).units.map((unit: { index: number }) => unit.index)).toEqual([0]);
});
it("rejects Office pages outside the retained recognition inventory before model work", async () => {
  const f = await setup("xlsx", {}, undefined, [4]), task = await f.run(); expect(task.errorCode).toBe("SOURCE_SELECTION_INVALID"); expect(f.submissions).toHaveLength(1); expect(f.modelHttp).not.toHaveBeenCalled();
});
it("bounds the actual Office provider request and retains page-ceiling diagnostics", async () => {
  const f = await setup("docx", { maxParts: 1 }), task = await f.run(); expect(task.state).toBe("COMPLETED"); expect(task.outputs.assemble?.status).toBe("PARTIAL"); expect(recognized(f).warnings.join(" ")).toContain("configured page limit");
});
it("reuses a visibility snapshot after a checkpoint publication gap", async () => {
  const f = await setup("xlsx"), writes = vi.spyOn(f.storage, "putArtifact"); f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); expect((await f.run()).outputs.prepare).toBeUndefined(); expect(f.tencentHttp).not.toHaveBeenCalled();
  expect((await f.resume()).state).toBe("COMPLETED"); expect(writes.mock.calls.filter(call => call[2] === "visible-workbook")).toHaveLength(1); expect(f.submissions).toHaveLength(1);
});
it("never pays when a workbook snapshot cannot be persisted or exceeds the current transport limit", async () => {
  const f = await setup("xlsx"), put = f.storage.putArtifact.bind(f.storage); vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (args[2] === "visible-workbook") throw new Error("disk unavailable"); return put(...args); }); expect((await f.run()).failedStage).toBe("prepare"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.modelHttp).not.toHaveBeenCalled();
  const large = await setup("docx", { inputBytes: 700 }), task = await large.run(); expect(task.errorCode).toBe("TENCENT_SOURCE_TOO_LARGE"); expect(large.tencentHttp).not.toHaveBeenCalled(); expect(large.modelHttp).not.toHaveBeenCalled();
});
it("rejects a rehashed snapshot that alters original worksheet content before paid work", async () => {
  const f = await setup("xlsx"); f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Checkpoint gap"); }); const first = await f.run(), namespace = ["document_tasks", first.id, "tencent_inputs"], previous = (await f.store.get(namespace, "source"))!.value.manifest as ArtifactReference, plan = JSON.parse(f.storage.artifact(previous).toString());
  plan.submission = await f.storage.putArtifact(Buffer.from("forged workbook"), f.document.sha256, "visible-workbook", 0, f.document.mediaType); const manifest = await f.storage.putArtifact(Buffer.from(JSON.stringify(plan)), f.document.sha256, "tencent-inputs", 0, "application/json"); await f.store.update(namespace, "source", () => ({ manifest })); expect((await f.resume()).errorCode).toBe("TENCENT_INPUTS_INVALID"); expect(f.tencentHttp).not.toHaveBeenCalled(); expect(f.storage.source(f.document)).toEqual(f.bytes);
});
