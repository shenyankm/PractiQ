import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopDocumentReply, DesktopDocumentRequest, DocumentTaskReparse } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSettingsView, AiSnapshot } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { DocumentReparser } from "./document-reparse.js";
import { ModelClient } from "./model.js";
import { REPARSE_WARNING } from "./source-selection.js";
import { TencentClient } from "./tencent.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-reparse-")), db = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const view: AiSettingsView = { revision: config.revision, preferences: config.preferences, configured: { modelApiKey: true, tencentSecretId: true, tencentSecretKey: true } };
  const source = Buffer.from(Array.from({ length: 35 }, (_, index) => `${index + 1}. Short answer: Question ${index + 1}\nReference answer: A${index + 1}`).join("\n\n")), controls = { unknown: false };
  const modelHttp = vi.fn(async (_url: string, init: RequestInit) => {
    if (controls.unknown) throw Error("Lost paid response");
    const request = JSON.parse(String(init.body)), text = request.input[1].content[0].text as string, match = /Use exactly these source record IDs and preserve each supplied field: (.*)\n\n/.exec(text); if (!match) throw Error("Missing source records");
    const questions = Object.keys(JSON.parse(match[1])).map(id => { const number = id.split(":").at(-1); return { id, stem: `Question ${number}`, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: `A${number}` }, sourceText: `Question ${number}\nReference answer: A${number}`, analysis: null, confidence: 1, needsReview: false }; });
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: JSON.stringify({ questions, groups: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const zip = new ZipFile(); zip.addBuffer(source, "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); const archive = Buffer.concat(chunks);
  const tencentHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action"); if (action === "SubmitMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { TaskId: "test-job" } }));
    if (action === "DescribeMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE" } }));
    return new Response(archive);
  });
  const api = new DocumentApi(path, db, checkpoints, new ModelClient(db, modelHttp), new TencentClient(db, tencentHttp)), sha256 = hash(source), document = { sourceType: "text" as const, mediaType: "text/plain", fileName: "questions.txt", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length }; await api.storage.putSource(document, source);
  async function request<T extends DesktopDocumentRequest["type"]>(command: Extract<DesktopDocumentRequest, { type: T }>, configuration: AiSnapshot | AiSettingsView = view) { return await f.api.request(command, configuration) as Extract<DesktopDocumentReply, { type: T }>; }
  const f = { path, db, checkpoints, config, view, source, document, api, request, modelHttp, tencentHttp, controls }; fixtures.push(f);
  const admitted = await request({ type: "create", revision: config.revision, value: { requestId: randomUUID(), document } }, config); await api.runtime.wait(admitted.value.threadId);
  const parent = (await request({ type: "detail", revision: config.revision, threadId: admitted.value.threadId })).value; expect(parent.state).toBe("COMPLETED");
  const command = { type: "reparse" as const, revision: config.revision, threadId: parent.threadId, value: { requestId: randomUUID(), selection: { checkpointId: parent.checkpointId!, units: [{ stage: "document_parse" as const, index: 2 }] } } };
  return Object.assign(f, { parent, command });
}
const removeParent = (f: Awaited<ReturnType<typeof setup>>) => f.api.runtime.delete(f.parent.threadId);

it("reparses only the selected original fragment with verified recognition, new receipts and unchanged parent results", async () => {
  const f = await setup(), modelCalls = f.modelHttp.mock.calls.length, parserCalls = f.tencentHttp.mock.calls.length, admitted = (await f.request(f.command, f.config)).value; await f.api.runtime.wait(admitted.threadId);
  const child = (await f.request({ type: "detail", revision: f.config.revision, threadId: admitted.threadId })).value;
  expect(child.state).toBe("COMPLETED"); expect(child.parentThreadId).toBe(f.parent.threadId); expect(child.result!.questions.length).toBeGreaterThan(0); expect(child.result!.questions.length).toBeLessThan(f.parent.result!.questions.length);
  expect(child.processing!.questionSources!.every(source => source.unitIndex === 2)).toBe(true); expect(child.result!.warnings).toContain(REPARSE_WARNING);
  expect(child.parserJobs).toEqual([]); expect(child.modelBudget).toEqual({ limit: 64, reserved: 4 }); expect(child.usage).toHaveLength(1); expect(f.modelHttp).toHaveBeenCalledTimes(modelCalls + 1); expect(f.tencentHttp).toHaveBeenCalledTimes(parserCalls);
  expect((await f.request({ type: "detail", revision: f.config.revision, threadId: f.parent.threadId })).value).toEqual(f.parent);
  const preview = (await f.request({ type: "preview", revision: f.config.revision, threadId: child.threadId, includeResult: false })).value; expect(preview.units.map(unit => unit.index)).toEqual([2]);
  const bank = (await f.request({ type: "bank", revision: f.config.revision, value: { threadId: child.threadId, checkpointId: child.checkpointId!, scope: "full" } })).value; expect(bank.result).toEqual(child.result);
  expect((await f.request(f.command)).value).toEqual(admitted); await removeParent(f); expect((await f.request(f.command)).value).toEqual(admitted);
  const proof = f.api.tasks.record(child.threadId).outputs.prepare!.artifacts.find(reference => reference.objectKey.includes("/reparse-evidence/"))!, evidence = JSON.parse(f.api.tasks.readArtifact(child.threadId, proof).toString());
  expect(evidence).toMatchObject({ taskId: child.threadId, parentThreadId: f.parent.threadId, parentCheckpointId: f.parent.checkpointId, selection: f.command.value.selection });
  expect(JSON.parse(f.api.tasks.readArtifact(child.threadId, evidence.prepare).toString()).taskId).toBe(f.parent.threadId); expect(f.api.tasks.readArtifact(child.threadId, evidence.units[0].resultRef).length).toBeGreaterThan(0);
  await expect(f.request({ ...f.command, value: { ...f.command.value, selection: { ...f.command.value.selection, checkpointId: "changed" } } })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});

it("performs explicit full recognition again while preserving the parent and replaying only its receipt", async () => {
  const f = await setup(), count = f.modelHttp.mock.calls.length, parser = f.tencentHttp.mock.calls.length, command = { ...f.command, value: { requestId: randomUUID() } }, receipt = (await f.request(command, f.config)).value; await f.api.runtime.wait(receipt.threadId);
  const child = (await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value; expect(child.state).toBe("COMPLETED"); expect(child.result!.questions).toEqual(f.parent.result!.questions); expect(f.modelHttp.mock.calls.length).toBe(count * 2); expect(f.tencentHttp.mock.calls.length).toBe(parser * 2);
  expect((await f.request(command)).value).toEqual(receipt); expect(f.tencentHttp.mock.calls.length).toBe(parser * 2); expect((await f.request({ type: "detail", revision: f.config.revision, threadId: f.parent.threadId })).value).toEqual(f.parent);
});

it.each(["stale", "unit", "stage", "incomplete", "expired"])("rejects %s source selection before admitting or charging a child", async kind => {
  const f = await setup(), command = structuredClone(f.command), beforeModel = f.modelHttp.mock.calls.length, beforeParser = f.tencentHttp.mock.calls.length;
  if (kind === "stale") command.value.selection.checkpointId = "stale";
  if (kind === "unit") command.value.selection.units[0].index = 999;
  if (kind === "stage") command.value.selection.units[0].stage = "vision_parse" as "document_parse";
  if (kind === "incomplete") f.api.tasks.update(f.parent.threadId, f.parent.runId!, record => { record.state = "FAILED"; });
  if (kind === "expired") f.api.tasks.update(f.parent.threadId, f.parent.runId!, record => { record.createdAt = 0; });
  await expect(f.request(command, f.config)).rejects.toMatchObject({ code: kind === "stale" ? "STALE_CHECKPOINT" : kind === "expired" ? "TASK_EXPIRED" : "SOURCE_SELECTION_INVALID" });
  expect(f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_tasks").get()!.n).toBe(1); expect(f.modelHttp).toHaveBeenCalledTimes(beforeModel); expect(f.tencentHttp).toHaveBeenCalledTimes(beforeParser);
});

it("cold-resumes a selected child after the parent is removed without contacting Tencent", async () => {
  const f = await setup(), reparser = new DocumentReparser(f.api.tasks, f.api.store), receipt = await reparser.create(f.parent.threadId, f.command.value, f.config), calls = f.modelHttp.mock.calls.length, parserCalls = f.tencentHttp.mock.calls.length;
  expect(f.api.tasks.record(receipt.threadId).checkpointId).toBeNull(); await removeParent(f);
  await f.api.close(); f.api = new DocumentApi(f.path, f.db, f.checkpoints, new ModelClient(f.db, f.modelHttp), new TencentClient(f.db, f.tencentHttp));
  const stopped = (await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value; expect(stopped.state).toBe("INTERRUPTED"); expect(stopped.progress!.chunks.total).toBe(1); expect(f.modelHttp).toHaveBeenCalledTimes(calls);
  await f.request({ type: "control", revision: f.config.revision, threadId: receipt.threadId, value: { requestId: randomUUID(), action: "resume", checkpointId: stopped.checkpointId } }, f.config); await f.api.runtime.wait(receipt.threadId);
  expect((await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value.state).toBe("COMPLETED"); expect(f.modelHttp).toHaveBeenCalledTimes(calls + 1); expect(f.tencentHttp).toHaveBeenCalledTimes(parserCalls);
});

it("rolls back child admission if its artifact receipt cannot commit", async () => {
  const f = await setup(); f.api.tasks.db.exec(`CREATE TEMP TRIGGER reject_seed BEFORE INSERT ON document_artifacts WHEN NEW.task_id!='${f.parent.threadId}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  const calls = f.modelHttp.mock.calls.length; await expect(f.request(f.command, f.config)).rejects.toThrow(); expect(f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_tasks").get()!.n).toBe(1); expect(f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_operations WHERE request_id=?").get(f.command.value.requestId)!.n).toBe(0); expect(f.modelHttp).toHaveBeenCalledTimes(calls);
});

it("reuses verified evidence without Tencent credentials and normalizes duplicate unit selections", async () => {
  const f = await setup(), config = { ...f.config, secrets: { ...f.config.secrets, tencentSecretId: "", tencentSecretKey: "" } }, command = structuredClone(f.command);
  command.value.selection.units.push({ ...command.value.selection.units[0] }); const receipt = (await f.request(command, config)).value; await f.api.runtime.wait(receipt.threadId);
  expect(f.api.tasks.record(receipt.threadId).state).toBe("COMPLETED"); expect((await f.request(f.command)).value).toEqual(receipt);
  await expect(f.request({ ...f.command, value: { requestId: randomUUID() } }, config)).rejects.toMatchObject({ code: "TENCENT_NOT_CONFIGURED" });
});

it("fences a parent checkpoint change before the child and its receipt commit", async () => {
  const f = await setup(), put = f.api.storage.putArtifact.bind(f.api.storage), calls = f.modelHttp.mock.calls.length; let changed = false;
  vi.spyOn(f.api.storage, "putArtifact").mockImplementation(async (...args) => { const reference = await put(...args); if (!changed && args[2] === "recognized-text" && args[0].includes(REPARSE_WARNING)) { changed = true; f.api.tasks.update(f.parent.threadId, f.parent.runId!, record => { record.checkpointId = "changed"; }); } return reference; });
  await expect(f.request(f.command, f.config)).rejects.toMatchObject({ code: "STALE_CHECKPOINT" }); expect(f.api.tasks.db.prepare("SELECT count(*) AS n FROM document_tasks").get()!.n).toBe(1); expect(f.modelHttp).toHaveBeenCalledTimes(calls);
});

it("retains an unknown child call through ordinary resume and retries only on explicit authorization", async () => {
  const f = await setup(); f.controls.unknown = true; const receipt = (await f.request(f.command, f.config)).value; await f.api.runtime.wait(receipt.threadId);
  let detail = (await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value; expect(detail.state).toBe("FAILED"); expect(detail.blocking).toContainEqual({ code: "AI_RESULT_UNKNOWN" }); const count = f.modelHttp.mock.calls.length, parser = f.tencentHttp.mock.calls.length;
  await f.request({ type: "control", revision: f.config.revision, threadId: receipt.threadId, value: { requestId: randomUUID(), action: "resume", checkpointId: detail.checkpointId } }, f.config); await f.api.runtime.wait(receipt.threadId); expect(f.modelHttp).toHaveBeenCalledTimes(count);
  detail = (await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value; f.controls.unknown = false;
  await f.request({ type: "control", revision: f.config.revision, threadId: receipt.threadId, value: { requestId: randomUUID(), action: "retry_failed", checkpointId: detail.checkpointId } }, f.config); await f.api.runtime.wait(receipt.threadId);
  detail = (await f.request({ type: "detail", revision: f.config.revision, threadId: receipt.threadId })).value; expect(detail.state).toBe("COMPLETED"); expect(detail.modelBudget).toEqual({ limit: 64, reserved: 8 }); expect(detail.unknownUsageCalls).toHaveLength(1); expect(f.modelHttp).toHaveBeenCalledTimes(count + 1); expect(f.tencentHttp).toHaveBeenCalledTimes(parser);
});
