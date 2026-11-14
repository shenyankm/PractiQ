import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopDocumentReply, DesktopDocumentRequest } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSettingsView, AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { ModelClient } from "./model.js";
import { sourceKey } from "./ai-storage.js";
import { TencentClient } from "./tencent.js";
import { validateParsedQuestion } from "./question-contract.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup(options: { maxCalls?: number; supplied?: boolean; count?: number } = {}) {
  const path = mkdtempSync(join(tmpdir(), "practiq-generated-workflow-")), db = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: options.maxCalls ?? 16, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const view: AiSettingsView = { revision: config.revision, preferences: config.preferences, configured: { modelApiKey: true, tencentSecretId: true, tencentSecretKey: true } };
  const source = Buffer.from(Array.from({ length: options.count ?? 2 }, (_, index) => `${index + 1}. Short answer: Question ${index + 1}${options.supplied && index === 1 ? "\nReference answer: A2" : ""}`).join("\n\n"));
  const controls = { unknown: false, invalid: false, empty: false, reject: false }, seen: Record<string, unknown>[] = [];
  const modelHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), name = request.tools[0].name, text = request.input[1].content[0].text as string; seen.push(request);
    let result: unknown;
    if (name === "UnitParseResult") {
      const match = /Use exactly these source record IDs and preserve each supplied field: (.*)\n\n/.exec(text); if (!match) throw new Error("Missing source records");
      const questions = Object.keys(JSON.parse(match[1])).map(id => { const number = id.split(":").at(-1)!, supplied = options.supplied && number === "2"; return { id, stem: `Question ${number}`, answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: supplied ? { text: "A2" } : null, sourceText: `Question ${number}${supplied ? "\nReference answer: A2" : ""}`, analysis: null, confidence: 1, needsReview: false }; });
      result = { questions, groups: [] };
    } else {
      expect(name).toBe("GeneratedAnswer"); const question = JSON.parse(text).question;
      if (controls.unknown && question.stem === "Question 2") throw new Error("Lost paid response");
      if (controls.reject) return new Response("", { status: 401 });
      result = controls.invalid ? { answerPayload: { correct: ["invented"] }, analysis: "Invalid" } : controls.empty ? { answerPayload: null, analysis: null } : { answerPayload: { text: `Generated ${question.stem}` }, analysis: `Explanation ${question.stem}` };
    }
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name, arguments: JSON.stringify(result) }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  const zip = new ZipFile(); zip.addBuffer(source, "source_md_full.md"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); const archive = Buffer.concat(chunks);
  const tencentHttp = vi.fn(async (_url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { TaskId: "test-job" } }));
    if (action === "DescribeMultimodalDocParseJob") return new Response(JSON.stringify({ Response: { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE" } }));
    return new Response(archive);
  });
  const api = new DocumentApi(path, db, checkpoints, new ModelClient(db, modelHttp), new TencentClient(db, tencentHttp)), sha256 = hash(source);
  const document = { fileName: "questions.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: source.length, sha256, objectKey: sourceKey("text", sha256) }; await api.storage.putSource(document, source);
  const create = { type: "create" as const, revision: config.revision, value: { requestId: randomUUID(), document, generateAnswers: true } };
  async function request<T extends DesktopDocumentRequest["type"]>(command: Extract<DesktopDocumentRequest, { type: T }>, configuration: AiSnapshot | AiSettingsView = view) { return await f.api.request(command, configuration) as Extract<DesktopDocumentReply, { type: T }>; }
  const f = { path, db, checkpoints, config, view, source, document, create, api, request, modelHttp, tencentHttp, controls, seen }; fixtures.push(f); return f;
}
async function run(f: Awaited<ReturnType<typeof setup>>) {
  const admitted = await f.request(f.create, f.config); await f.api.runtime.wait(admitted.value.threadId);
  const detail = (await f.request({ type: "detail", revision: f.config.revision, threadId: admitted.value.threadId })).value;
  return { admitted, detail, threadId: admitted.value.threadId };
}

it("runs a separate LangGraph generation node, preserving supplied fields, source proofs and passive exports", async () => {
  const f = await setup({ supplied: true }), { admitted, detail, threadId } = await run(f), record = f.api.tasks.record(threadId);
  expect(detail.state).toBe("COMPLETED"); expect(detail.result!.questions.map(question => question.answerPayload)).toEqual([{ text: "Generated Question 1" }, { text: "A2" }]);
  expect(detail.result!.questions.every(question => question.needsReview)).toBe(true); expect(detail.result!.warnings.filter(warning => warning.startsWith("AI 生成"))).toHaveLength(2);
  expect(detail.modelBudget).toEqual({ limit: 16, reserved: 12 }); expect(detail.usage).toHaveLength(3); expect(f.modelHttp).toHaveBeenCalledTimes(3);
  expect(detail.usage!.map(call => call.callKind).sort()).toEqual(["answer_generation", "answer_generation", "document_import"]);
  const extracted = JSON.parse(f.api.storage.artifact(record.outputs.assemble!.result!).toString());
  expect(extracted.questions.map((question: any) => question.answerPayload)).toEqual([null, { text: "A2" }]);
  expect(detail.result!.questions.map(question => question.sourceText)).toEqual(extracted.questions.map((question: any) => question.sourceText));
  expect((await f.checkpoints.getTuple({ configurable: { thread_id: `document:${threadId}` } }))!.checkpoint.channel_values.lastStage).toBe("answers");
  expect((await f.request(f.create, f.config)).value).toEqual(admitted.value);
  const store = f.api.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all(), task = f.api.tasks.record(threadId);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await f.request({ type: "detail", revision: f.config.revision, threadId })).value.result).toEqual(detail.result);
    const bank = (await f.request({ type: "bank", revision: f.config.revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "full" } })).value;
    expect(bank.result).toEqual(detail.result); expect(bank.processing!.quality!.reviewRequired).toBe(true);
  }
  expect(f.modelHttp).toHaveBeenCalledTimes(3); expect(f.api.tasks.record(threadId)).toEqual(task); expect(f.api.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all()).toEqual(store);
  await f.api.close(); f.api = new DocumentApi(f.path, f.db, f.checkpoints, new ModelClient(f.db, f.modelHttp), new TencentClient(f.db, f.tencentHttp));
  expect((await f.request({ type: "detail", revision: f.config.revision, threadId })).value.result).toEqual(detail.result); expect(f.modelHttp).toHaveBeenCalledTimes(3);
});

it("never generates on passive selection or default import and rejects generation for answer sheets", async () => {
  const f = await setup(); expect(f.modelHttp).not.toHaveBeenCalled(); expect(f.tencentHttp).not.toHaveBeenCalled();
  f.create.value.generateAnswers = false;
  const { detail, threadId } = await run(f); expect(detail.state).toBe("COMPLETED"); expect(detail.result!.questions.every(question => question.answerPayload === null)).toBe(true);
  expect(f.api.tasks.record(threadId).outputs.answers).toBeUndefined();
  expect(f.seen.every(request => (request.tools as any)[0].name === "UnitParseResult")).toBe(true);
  await expect(f.request({ ...f.create, value: { ...f.create.value, requestId: randomUUID(), generateAnswers: true, documentRole: "answers" } }, f.config)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
});

it("keeps earlier generated answers after an unknown call and requires explicit retry without resetting budget", async () => {
  const f = await setup(); f.controls.unknown = true; const { detail, threadId } = await run(f);
  expect(detail.state).toBe("FAILED"); expect(detail.blocking).toContainEqual({ code: "AI_RESULT_UNKNOWN" }); expect(detail.status).toBe("PARTIAL");
  expect(detail.result!.questions.map(question => question.answerPayload)).toEqual([{ text: "Generated Question 1" }, null]); expect(detail.unknownUsageCalls).toHaveLength(1); expect(f.modelHttp).toHaveBeenCalledTimes(3);
  const original = JSON.parse(f.api.storage.artifact(f.api.tasks.record(threadId).outputs.assemble!.result!).toString()); expect(original.questions.every((question: any) => question.answerPayload === null)).toBe(true);
  const bank = (await f.request({ type: "bank", revision: f.config.revision, value: { threadId, checkpointId: detail.checkpointId!, scope: "completed" } })).value;
  expect(bank.result.questions.map(question => question.answerPayload)).toEqual([{ text: "Generated Question 1" }, null]);
  await f.api.close(); f.api = new DocumentApi(f.path, f.db, f.checkpoints, new ModelClient(f.db, f.modelHttp), new TencentClient(f.db, f.tencentHttp));
  let stopped = (await f.request({ type: "detail", revision: f.config.revision, threadId })).value; expect(stopped.result).toEqual(detail.result); expect(f.modelHttp).toHaveBeenCalledTimes(3);
  await f.request({ type: "control", revision: f.config.revision, threadId, value: { requestId: randomUUID(), action: "resume", checkpointId: stopped.checkpointId } }, f.config); await f.api.runtime.wait(threadId);
  stopped = (await f.request({ type: "detail", revision: f.config.revision, threadId })).value; expect(stopped.state).toBe("FAILED"); expect(f.modelHttp).toHaveBeenCalledTimes(3);
  f.controls.unknown = false;
  await f.request({ type: "control", revision: f.config.revision, threadId, value: { requestId: randomUUID(), action: "retry_failed", checkpointId: stopped.checkpointId } }, f.config); await f.api.runtime.wait(threadId);
  const completed = (await f.request({ type: "detail", revision: f.config.revision, threadId })).value;
  expect(completed.state).toBe("COMPLETED"); expect(completed.result!.questions.map(question => question.answerPayload)).toEqual([{ text: "Generated Question 1" }, { text: "Generated Question 2" }]); expect(completed.unknownUsageCalls).toHaveLength(1);
  expect(completed.modelBudget).toEqual({ limit: 16, reserved: 16 }); expect(f.modelHttp).toHaveBeenCalledTimes(4);
});

it("shares extraction and generation reservations and retains questions when no calls remain", async () => {
  const f = await setup({ maxCalls: 4 }), { detail } = await run(f);
  expect(detail.state).toBe("COMPLETED"); expect(detail.status).toBe("PARTIAL"); expect(detail.modelBudget).toEqual({ limit: 4, reserved: 4 }); expect(f.modelHttp).toHaveBeenCalledTimes(1);
  expect(detail.result!.questions).toHaveLength(2); expect(detail.result!.warnings.some(warning => warning.includes("任务调用预算不足"))).toBe(true);
});

it.each(["invalid", "empty", "reject"] as const)("keeps supplied extraction after known %s generation without replay", async mode => {
  const f = await setup({ count: 1 }); f.controls[mode] = true; const { detail, threadId } = await run(f);
  expect(detail.state).toBe("COMPLETED"); expect(detail.status).toBe("PARTIAL"); expect(detail.result!.questions[0].answerPayload).toBeNull(); expect(detail.result!.warnings.some(warning => warning.includes("原提取内容已保留"))).toBe(true);
  expect(f.modelHttp).toHaveBeenCalledTimes(mode === "invalid" ? 3 : 2);
  const count = f.modelHttp.mock.calls.length; await f.request({ type: "detail", revision: f.config.revision, threadId }); expect(f.modelHttp).toHaveBeenCalledTimes(count);
});

it.each([true, false])("uses parent context and accepts only task-owned source figures: %s", async owned => {
  const f = await setup({ count: 1 }), assemble = f.api.runtime.stages.assemble, bytes = readFileSync(new URL("../fixtures/images/gray16.png", import.meta.url));
  f.api.runtime.stages.assemble = async context => {
    const output = await assemble(context), result = JSON.parse(f.api.storage.artifact(output.result!).toString()), question = result.questions[0];
    const parent = validateParsedQuestion({ id: "material", stem: "Fixture reading material", answerMode: "reading", questionTypeId: "Reading", answerPayload: null, sourceText: "Fixture material", passage: [{ partType: "text", textValue: "Parent passage" }] });
    question.parentId = parent.id; result.questions.unshift(parent);
    const image = await f.api.storage.putArtifact(bytes, f.document.sha256, "fixture-figure", 0, "image/png");
    result.visualElements = [{ description: "Fixed source figure", questionIds: [parent.id], imageRef: image, bbox: [0, 0, 1, 1], kind: "image" }];
    const reference = await f.api.storage.putArtifact(Buffer.from(JSON.stringify(result)), f.document.sha256, "fixture-assembly", 0, "application/json");
    return { ...output, result: reference, artifacts: [...output.artifacts, reference, ...(owned ? [image] : [])] };
  };
  const { detail } = await run(f);
  if (!owned) { expect(detail.state).toBe("FAILED"); expect(detail.blocking).toContainEqual({ code: "INVALID_REFERENCE" }); expect(f.modelHttp).toHaveBeenCalledTimes(1); return; }
  expect(detail.state).toBe("COMPLETED"); expect(f.modelHttp).toHaveBeenCalledTimes(2);
  const messages = f.seen.at(-1)!.input as { content: { type: string; text?: string; image_url?: string }[] }[], prompt = JSON.parse(messages[1].content[0].text!);
  expect(prompt.context).toHaveLength(1); expect(prompt.context[0]).toMatchObject({ id: "material", passage: [{ textValue: "Parent passage" }] });
  expect(messages[1].content.find(content => content.type === "input_image")!.image_url).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(detail.result!.questions[0].answerPayload).toBeNull(); expect(detail.result!.questions[1].answerPayload).toEqual({ text: "Generated Question 1" });
});

it("rechecks the immutable source before generation can reserve or send paid work", async () => {
  const f = await setup({ count: 1 }), assemble = f.api.runtime.stages.assemble;
  f.api.runtime.stages.assemble = async context => {
    const output = await assemble(context); writeFileSync(join(f.api.storage.root, f.document.objectKey), Buffer.alloc(f.document.sizeBytes)); return output;
  };
  const { detail } = await run(f);
  expect(detail.state).toBe("FAILED"); expect(detail.blocking).toContainEqual({ code: "DOCUMENT_CHECKSUM_MISMATCH" });
  expect(f.modelHttp).toHaveBeenCalledTimes(1); expect(detail.modelBudget).toEqual({ limit: 16, reserved: 4 });
  expect(detail.result!.questions[0]).toMatchObject({ stem: "Question 1", answerPayload: null });
});
