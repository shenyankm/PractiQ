import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { ArtifactReference, DocumentReference, DocumentTaskCreate } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentRuntime, type DocumentStageContext } from "./document-runtime.js";
import { DocumentTasks } from "./document-tasks.js";
import { AppError } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { TencentClient } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";
import { splitText, TextDocuments, type TextInputLimits, type RecognizedText } from "./text-documents.js";
import { ChunkInputs, type ChunkInputsManifest } from "./chunk-inputs.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const f of fixtures) f.runtime.abortAll();
  for (const f of fixtures.splice(0)) { for (const row of f.tasks.db.prepare("SELECT id FROM document_tasks").all()) await f.runtime.wait(String(row.id)); f.store.stop(); f.checkpoints.close(); f.tasks.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); }
});
async function archive(text: string | null): Promise<Buffer> {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from(text === null ? "empty receipt" : text), text === null ? "receipt.txt" : "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
async function setup(payload: Buffer, limits: Partial<TextInputLimits> = {}, sourceType: "text" | "markdown" = "text") {
  const path = mkdtempSync(join(tmpdir(), "practiq-text-document-")), db = new AiDatabase(path), storage = new AiStorage(path), store = new SqliteStore(path), checkpoints = new SqliteCheckpoints(path), tasks = new DocumentTasks(path, storage, db);
  const config: AiSnapshot = { revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://provider.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "test-only", tencentSecretId: "test-id", tencentSecretKey: "test-secret" } };
  const sha256 = hash(payload), document: DocumentReference = { fileName: sourceType === "text" ? "source.txt" : "source.md", sourceType, mediaType: sourceType === "text" ? "text/plain" : "text/markdown", sizeBytes: payload.length, sha256, objectKey: sourceKey(sourceType, sha256) }; await storage.putSource(document, payload);
  const jobs: Buffer[] = [], counts = { submits: 0, queries: 0, downloads: 0 }, provider = { render: (bytes: Buffer, _index: number): string | null => new TextDecoder("utf-8", { fatal: true }).decode(bytes), counts: (_index: number) => ({ SuccessPageNum: 1, FailPageNum: 0 }) };
  const http = vi.fn(async (url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action"), data = init.body ? JSON.parse(String(init.body)) : {};
    if (action === "SubmitMultimodalDocParseJob") { counts.submits++; jobs.push(Buffer.from(data.FileBase64, "base64")); return new Response(JSON.stringify({ Response: { TaskId: `job-${jobs.length - 1}` } })); }
    if (action === "DescribeMultimodalDocParseJob") { counts.queries++; const index = Number(String(data.TaskId).split("-")[1]); return new Response(JSON.stringify({ Response: { Status: "Success", ...provider.counts(index), ResultUrl: `https://result.cos.ap-guangzhou.myqcloud.com/${index}?signature=PRIVATE` } })); }
    counts.downloads++; const index = Number(new URL(url).pathname.slice(1)); return new Response(await archive(provider.render(jobs[index], index)));
  }), client = new TencentClient(db, http), documents = new TextDocuments(storage, new TencentResults(client, storage), limits);
  const stages = { prepare: vi.fn((context: DocumentStageContext) => documents.prepare(context)), recognize: vi.fn((context: DocumentStageContext) => documents.recognize(context)), structure: vi.fn(async () => { throw new AppError("ACTION_UNAVAILABLE", "Full parser stages remain pending"); }), assemble: vi.fn(async () => { throw new Error("Do not synthesize final results"); }) }, runtime = new DocumentRuntime(tasks, checkpoints, stages, store);
  const input: DocumentTaskCreate = { requestId: randomUUID(), document, graphId: "document_parser" }, receipt = tasks.create(input, config);
  const run = async () => { await runtime.run(receipt.threadId, config); return tasks.record(receipt.threadId); }, resume = async () => { await runtime.control(receipt.threadId, { requestId: randomUUID(), action: "resume", checkpointId: tasks.record(receipt.threadId).checkpointId }, config); await runtime.wait(receipt.threadId); return tasks.record(receipt.threadId); };
  const f = { path, db, storage, store, checkpoints, tasks, runtime, input, config, receipt, run, resume, documents, stages, jobs, counts, provider, http, client }; fixtures.push(f); return f;
}
function recognized(f: Awaited<ReturnType<typeof setup>>): RecognizedText { return JSON.parse(f.storage.artifact(f.tasks.record(f.receipt.threadId).outputs.recognize!.manifest!).toString()); }

it("matches the historical Python splitter's fixed byte-for-byte corpus", () => {
  const corpus = JSON.parse(readFileSync(new URL("../fixtures/tencent/text-splits.json", import.meta.url), "utf8")) as { cases: { name: string; payload: string; limit: number; maxParts: number; parts?: string[]; error?: string }[] };
  expect(corpus.cases).toHaveLength(27);
  for (const input of corpus.cases) {
    const perform = () => splitText(Buffer.from(input.payload, "base64"), input.limit, input.maxParts);
    if (input.error) { expect(perform, input.name).toThrow(); try { perform(); } catch (error) { expect(error, input.name).toMatchObject({ code: input.error }); } }
    else expect(perform().map(part => part.toString("base64")), input.name).toEqual(input.parts);
  }
});

it.each([4, 7, 20, 50])("retains every UTF-8 byte and line boundary at a %s-byte split limit", limit => {
  const source = Buffer.from("\ufeff题目\nA.你好\n\n答案：🙂\n"), parts = splitText(source, limit, 100);
  expect(Buffer.concat(parts)).toEqual(source); expect(parts.every(part => part.length > 0 && part.length <= limit)).toBe(true); expect(parts.map(part => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part)).join("")).toBe(source.toString()); expect(splitText(source, limit, 100)).toEqual(parts);
  parts[0][0] = 0; expect(source[0]).not.toBe(0);
});

it.each([[Buffer.from("12345678"), 4, 1, "TENCENT_SOURCE_TOO_LARGE"], [Buffer.from("🙂"), 3, 10, "TENCENT_SOURCE_TOO_LARGE"], [Buffer.from([97, 255]), 4, 10, "DOCUMENT_ENCODING_INVALID"]] as const)("rejects an impossible or invalid text split without losing bytes", (source, limit, parts, code) => {
  expect(() => splitText(source, limit, parts)).toThrow(); try { splitText(source, limit, parts); } catch (error) { expect(error).toMatchObject({ code }); }
});

it.each(["text", "markdown"] as const)("prepares every ordered %s source part before paid work and retains exact original-text proofs", async kind => {
  const source = Buffer.from("第一题\n第二题\n第三题\n"), f = await setup(source, { inputBytes: 12 }, kind), write = vi.spyOn(f.storage, "putArtifact");
  const send = f.http.getMockImplementation()!; f.http.mockImplementation(async (url, init) => {
    if (new Headers(init.headers).get("X-TC-Action") === "SubmitMultimodalDocParseJob") {
      const saved = await f.store.get(["document_tasks", f.receipt.threadId, "tencent_inputs"], "source"); expect(saved).not.toBeNull();
      const plan = JSON.parse(f.storage.artifact(saved!.value.manifest as ArtifactReference).toString()); expect(plan.parts.map((part: { byteStart: number }) => part.byteStart)).toEqual([0, 10, 20]);
      expect(write.mock.calls.filter(call => call[2] === "ocr-input")).toHaveLength(3); plan.parts.forEach((part: { reference: ArtifactReference }) => expect(f.storage.artifact(part.reference).length).toBeLessThanOrEqual(12));
      expect(JSON.parse(String(init.body))).toMatchObject({ FileType: kind === "text" ? 6 : 5, ResultType: 2, EnableSubImg: false });
    } return send(url, init);
  });
  const task = await f.run(), output = recognized(f); expect(task.failedStage).toBe("structure"); expect(task.errorCode).toBe("ACTION_UNAVAILABLE"); expect(f.stages.assemble).not.toHaveBeenCalled();
  expect(Buffer.concat(f.jobs)).toEqual(source); expect(f.counts).toEqual({ submits: 3, queries: 3, downloads: 3 }); expect(output.inputParts.map(part => [part.byteStart, part.byteEnd])).toEqual([[0, 10], [10, 20], [20, 30]]); expect(output.truncated).toBe(false); expect(f.storage.artifact(output.textRef!).toString()).toBe(source.toString());
  expect(f.storage.source(f.input.document)).toEqual(source); expect(f.tasks.readArtifact(task.id, output.ocrPageRefs[2])).toEqual(f.storage.artifact(output.ocrPageRefs[2])); expect(JSON.stringify(f.db.state(task.id))).not.toContain("PRIVATE");
  expect(f.db.db.prepare("SELECT count(*) AS n FROM ai_calls WHERE endpoint!='https://ocr.tencentcloudapi.com'").get()!.n).toBe(0);
});

it("keeps an exact-limit source unsplit and strips only its initial UTF-8 BOM from text proofs", async () => {
  const source = Buffer.from("\ufeff题目🙂"), f = await setup(source, { inputBytes: source.length }); await f.run(); const output = recognized(f);
  expect(f.jobs).toEqual([source]); expect(output.inputParts).toEqual([]); expect(f.storage.artifact(output.textRef!).toString()).toBe("题目🙂"); expect(f.storage.source(f.input.document)).toEqual(source);
});

it.each(["parts", "characters", "encoding", "empty"])("rejects %s preparation before any paid submission or durable partial plan", async kind => {
  const f = await setup(kind === "encoding" ? Buffer.from([65, 255]) : Buffer.from(kind === "empty" ? "\ufeff\u0085\x1c" : "123456789"), kind === "parts" ? { inputBytes: 4, maxParts: 2 } : kind === "characters" ? { maxChars: 8 } : {}), task = await f.run();
  expect(task.failedStage).toBe("prepare"); expect(task.errorCode).toBe(kind === "encoding" ? "DOCUMENT_ENCODING_INVALID" : kind === "empty" ? "DOCUMENT_PROCESSING_FAILED" : "TENCENT_SOURCE_TOO_LARGE"); expect(f.http).not.toHaveBeenCalled(); expect(await f.store.get(["document_tasks", task.id, "tencent_inputs"], "source")).toBeNull();
});

it("does not send even the first paid request if a later part cannot be written", async () => {
  const f = await setup(Buffer.from("123456789"), { inputBytes: 4 }), put = f.storage.putArtifact.bind(f.storage);
  vi.spyOn(f.storage, "putArtifact").mockImplementation(async (...args) => { if (args[2] === "ocr-input" && args[3] === 1) throw new Error("disk unavailable"); return put(...args); });
  const task = await f.run(); expect(task.failedStage).toBe("prepare"); expect(f.http).not.toHaveBeenCalled(); expect(await f.store.get(["document_tasks", task.id, "tencent_inputs"], "source")).toBeNull(); expect(f.storage.source(f.input.document).toString()).toBe("123456789");
});

it("reuses a durable preparation after interruption before its graph output commits", async () => {
  const f = await setup(Buffer.from("123456789"), { inputBytes: 4 }), writes = vi.spyOn(f.storage, "putArtifact");
  f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Interrupted after durable preparation"); });
  const task = await f.run(); expect(task.outputs.prepare).toBeUndefined(); expect(f.http).not.toHaveBeenCalled(); expect(await f.store.get(["document_tasks", task.id, "tencent_inputs"], "source")).not.toBeNull();
  await f.resume(); expect(writes.mock.calls.filter(call => call[2] === "ocr-input")).toHaveLength(3); expect(writes.mock.calls.filter(call => call[2] === "tencent-inputs")).toHaveLength(1); expect(recognized(f).textRef).not.toBeNull(); expect(f.counts.submits).toBe(3);
});

it("verifies every saved part before the first request, including a damaged later part", async () => {
  const f = await setup(Buffer.from("123456789"), { inputBytes: 4 });
  f.stages.recognize.mockImplementationOnce(async context => {
    const plan = JSON.parse(f.storage.artifact(context.task.outputs.prepare!.manifest!).toString()); writeFileSync(join(f.storage.root, plan.parts[2].reference.objectKey), "damage"); return f.documents.recognize(context);
  });
  const task = await f.run(); expect(task.errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(f.http).not.toHaveBeenCalled(); expect(task.outputs.prepare).toBeDefined();
  await expect(f.resume()).rejects.toMatchObject({ code: "DOCUMENT_CHECKSUM_MISMATCH" }); expect(f.http).not.toHaveBeenCalled();
});

it("refuses a changed preparation policy without replacing the saved plan", async () => {
  const f = await setup(Buffer.from("123456789"), { inputBytes: 4 }); f.stages.prepare.mockImplementationOnce(async context => { await f.documents.prepare(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Pause after receipt"); }); await f.run();
  const before = await f.store.get(["document_tasks", f.receipt.threadId, "tencent_inputs"], "source"), changed = new TextDocuments(f.storage, new TencentResults(f.client, f.storage), { inputBytes: 5 }); f.stages.prepare.mockImplementation(context => changed.prepare(context));
  const task = await f.resume(); expect(task.errorCode).toBe("TENCENT_INPUTS_INVALID"); expect((await f.store.get(["document_tasks", task.id, "tencent_inputs"], "source"))!.value).toEqual(before!.value); expect(f.http).not.toHaveBeenCalled();
});

it("never restores original-text proofs by inserting newlines between provider fragments", async () => {
  const f = await setup(Buffer.from("first\nsecond"), { inputBytes: 6 }); f.provider.render = bytes => bytes.toString().trimEnd(); await f.run(); const output = recognized(f);
  expect(output.textRef).toBeNull(); expect(output.truncated).toBe(false); expect(output.ocrPageRefs).toHaveLength(2); expect(output.warnings.join(" ")).toContain("original-text source proofs are unavailable");
  expect(output.ocrPageRefs.map(ref => JSON.parse(f.storage.artifact(ref).toString()).elements[0].text_info.content)).toEqual(["first", "second"]);
});

it("keeps explicit failed pages and missing-page evidence instead of establishing text proofs", async () => {
  const f = await setup(Buffer.from("first\nsecond"), { inputBytes: 6 }); f.provider.counts = index => index === 0 ? { SuccessPageNum: 0, FailPageNum: 1 } : { SuccessPageNum: 1, FailPageNum: 0 }; f.provider.render = (bytes, index) => index === 0 ? null : bytes.toString(); await f.run(); const output = recognized(f);
  expect(output).toMatchObject({ textRef: null, truncated: true }); expect(JSON.parse(f.storage.artifact(output.ocrPageRefs[0]).toString())).toEqual({ page: 0, failed: true }); expect(output.warnings.join(" ")).toContain("failed or missing pages");
});

it("bounds parallel submissions while retaining source order when downloads complete out of order", async () => {
  const source = Buffer.from("first\nsecond\nthird\nfourth\n"), f = await setup(source, { inputBytes: 8 }), original = f.http.getMockImplementation()!; let active = 0, peak = 0; const completions: number[] = [];
  f.http.mockImplementation(async (url, init) => {
    const action = new Headers(init.headers).get("X-TC-Action"); if (action === "SubmitMultimodalDocParseJob") { active++; peak = Math.max(peak, active); }
    if (init.method === "GET") { const index = Number(new URL(url).pathname.slice(1)); await new Promise(resolve => setTimeout(resolve, index % 2 === 0 ? 25 : 1)); const result = await original(url, init); completions.push(index); active--; return result; }
    return original(url, init);
  }); await f.run(); const output = recognized(f);
  expect(peak).toBe(2); expect(active).toBe(0); expect(completions[0]).toBe(1); expect(f.storage.artifact(output.textRef!)).toEqual(source); expect(output.ocrPageRefs.map(ref => JSON.parse(f.storage.artifact(ref).toString()).page)).toEqual([0, 1, 2, 3]);
});

it("drains cancelled siblings, starts no queued parts after failure and resumes only acknowledged jobs", async () => {
  const f = await setup(Buffer.from("first\nsecond\nthird\nfourth\n"), { inputBytes: 8 }), original = f.http.getMockImplementation()!; let entered!: () => void, drained = false; const sibling = new Promise<void>(resolve => { entered = resolve; });
  f.http.mockImplementation(async (url, init) => {
    if (init.method === "GET") {
      const index = Number(new URL(url).pathname.slice(1));
      if (index === 0) { await sibling; return new Response("invalid archive"); }
      if (index === 1) { entered(); await new Promise<void>((_resolve, reject) => { const abort = () => { drained = true; reject(init.signal!.reason); }; if (init.signal!.aborted) abort(); else init.signal!.addEventListener("abort", abort, { once: true }); }); }
    } return original(url, init);
  });
  const task = await f.run(); expect(task.errorCode).toBe("TENCENT_RESULT_INVALID"); expect(drained).toBe(true); expect(f.counts.submits).toBe(2); expect(f.client.job(task.id, "source-0-1").resultValidationError).toBeUndefined(); expect(f.client.job(task.id, "source-0-1").taskId).toBe("job-1");
  f.http.mockImplementation(original); await f.resume(); expect(f.counts.submits).toBe(4); expect(f.stages.prepare).toHaveBeenCalledTimes(1); expect(f.storage.artifact(recognized(f).textRef!).toString()).toBe("first\nsecond\nthird\nfourth\n");
});

const denseSource = () => Buffer.from(Array.from({ length: 33 }, (_, index) => `${index + 1}. Short answer: Q${index + 1}🙂\nReference answer: A${index + 1}`).join("\n"));
it("persists source-aligned model fragments and presence gates through the real text graph", async () => {
  const source = denseSource(), f = await setup(source); let checked = false;
  f.stages.recognize.mockImplementationOnce(async context => {
    const output = await f.documents.recognize(context), recognized: RecognizedText = JSON.parse(f.storage.artifact(output.manifest!).toString()), reader = new ChunkInputs(f.storage), plan = reader.read(context, recognized.chunkManifest!, recognized.textRef!); checked = true;
    expect(plan.nodeCounts).toEqual([16, 16, 1]); expect(plan.headers).toEqual([null, null, null]); expect(plan.spans.every(span => span.overlapStart === span.overlapEnd && span.overlapStart === span.start)).toBe(true);
    expect(Buffer.concat(plan.chunkRefs.map(ref => f.storage.artifact(ref)))).toEqual(source); expect(plan.presence.map(hints => Object.keys(hints!).length)).toEqual([16, 16, 1]); expect(plan.presence[2]!["33"]).toMatchObject({ need_stem: true, need_answer: true, answer_source: "33. Short answer: Q33🙂\nReference answer: A33" });
    expect(() => reader.read(context, recognized.chunkManifest!, recognized.textRef!, { complete: false })).toThrow("differ"); return output;
  }); const task = await f.run(), output = recognized(f), plan = JSON.parse(f.storage.artifact(output.chunkManifest!).toString()) as ChunkInputsManifest;
  expect(checked).toBe(true); plan.chunkRefs.forEach(ref => expect(f.tasks.readArtifact(task.id, ref)).toEqual(f.storage.artifact(ref))); expect(task.failedStage).toBe("structure"); expect(f.counts.submits).toBe(1);
});

it("reuses durable chunks after interruption before recognition's graph output commits", async () => {
  const f = await setup(denseSource()), writes = vi.spyOn(f.storage, "putArtifact");
  f.stages.recognize.mockImplementationOnce(async context => { await f.documents.recognize(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Interrupted after durable chunks"); });
  const first = await f.run(); expect(first.outputs.recognize).toBeUndefined(); expect(await f.store.get(["document_tasks", first.id, "chunk_inputs"], "source")).not.toBeNull();
  await f.resume(); expect(writes.mock.calls.filter(call => call[2] === "chunk")).toHaveLength(3); expect(writes.mock.calls.filter(call => call[2] === "chunk-inputs")).toHaveLength(1); expect(f.counts).toEqual({ submits: 1, queries: 1, downloads: 1 }); expect(recognized(f).chunkManifest).not.toBeNull();
});

it("retains damaged later chunks without regenerating them or making another provider call", async () => {
  const f = await setup(denseSource()); let damaged!: ArtifactReference;
  f.stages.recognize.mockImplementationOnce(async context => { const output = await f.documents.recognize(context), result: RecognizedText = JSON.parse(f.storage.artifact(output.manifest!).toString()), plan: ChunkInputsManifest = JSON.parse(f.storage.artifact(result.chunkManifest!).toString()); damaged = plan.chunkRefs[2]; writeFileSync(join(f.storage.root, damaged.objectKey), "damaged chunk"); return output; });
  const first = await f.run(); expect(first.errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(first.outputs.recognize).toBeUndefined();
  const second = await f.resume(); expect(second.errorCode).toBe("DOCUMENT_CHECKSUM_MISMATCH"); expect(f.counts).toEqual({ submits: 1, queries: 1, downloads: 1 }); expect(readFileSync(join(f.storage.root, damaged.objectKey)).toString()).toBe("damaged chunk"); expect(f.stages.structure).not.toHaveBeenCalled();
});

it("refuses a semantically altered chunk manifest even when its bytes and hash are valid", async () => {
  const f = await setup(denseSource()); f.stages.recognize.mockImplementationOnce(async context => { await f.documents.recognize(context); throw new AppError("DOCUMENT_STOP_REQUESTED", "Stop before checkpoint"); });
  const first = await f.run(), namespace = ["document_tasks", first.id, "chunk_inputs"], saved = (await f.store.get(namespace, "source"))!.value.manifest as ArtifactReference, original = f.storage.artifact(saved), plan: ChunkInputsManifest = JSON.parse(original.toString()); plan.nodeCounts[0] = 15;
  const altered = await f.storage.putArtifact(Buffer.from(JSON.stringify(plan)), f.input.document.sha256, "chunk-inputs", 0, "application/json"); await f.store.update(namespace, "source", () => ({ manifest: altered }));
  const resumed = await f.resume(); expect(resumed.errorCode).toBe("CHUNK_INPUTS_INVALID"); expect(f.storage.artifact(saved)).toEqual(original); expect(f.counts).toEqual({ submits: 1, queries: 1, downloads: 1 }); expect(f.stages.structure).not.toHaveBeenCalled();
});
