import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AiDatabase } from "./ai-database.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { TencentClient, tencentInputLimit } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";
import { cosAuthorization, sourceUrl, stagingObject, validateStaging } from "./tencent-staging.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
const json = (value: unknown) => new Response(JSON.stringify({ Response: value }));
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-cos-")), db = new AiDatabase(path), storage = new AiStorage(path), bytes = readFileSync(new URL("../fixtures/tencent/image.jpg", import.meta.url)), sha256 = hash(bytes), document = { objectKey: sourceKey("image", sha256), sha256, mediaType: "image/jpeg", sourceType: "image" as const, fileName: "source.jpg", sizeBytes: bytes.length }; await storage.putSource(document, bytes);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 1, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls: 64, tencentCos: { enabled: true, bucket: "fixture-1250000000", region: "ap-guangzhou" } }, secrets: { modelApiKey: "unused", tencentSecretId: "test-id", tencentSecretKey: "test-secret" } };
  const task = db.createTask(sha256, 64), good = Buffer.from(JSON.parse(readFileSync(new URL("../fixtures/tencent/zip-codecs.json", import.meta.url), "utf8"))["0"], "base64"), provider = { upload: "success", submit: "success", status: "Success", cleanupFails: false, result: good }, calls = { upload: 0, submit: 0, query: 0, download: 0, cleanup: 0 };
  let client: TencentClient;
  const http = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error"); const headers = new Headers(init.headers), method = init.method;
    if (method === "PUT") {
      calls.upload++; expect(client.job(task, "source").status).toBe("STAGING"); expect(db.receipt(task, "tencent:source")).toBeNull(); expect(headers.get("x-cos-acl")).toBe("private"); expect(headers.get("x-cos-server-side-encryption")).toBe("AES256"); expect(url).toMatch(/^https:\/\/fixture-1250000000.cos.ap-guangzhou.myqcloud.com\/practiq-import\/[a-f0-9]{64}\/[a-f0-9]{64}$/); const body = Buffer.from(init.body as Uint8Array), md5 = createHash("md5").update(body).digest(); expect(headers.get("content-md5")).toBe(md5.toString("base64"));
      if (provider.upload === "disconnect") throw Error("PRIVATE signed request");
      return new Response(null, { status: provider.upload === "redirect" ? 302 : provider.upload === "unavailable" ? 500 : 200, headers: { ETag: provider.upload === "checksum" ? "bad" : `"${md5.toString("hex")}"`, Location: "https://untrusted.invalid" } });
    }
    if (method === "DELETE") { calls.cleanup++; const job = client.job(task, "source"); expect(job.resultValidated === true || ["REJECTED", "Failed"].includes(String(job.status))).toBe(true); return new Response(null, { status: provider.cleanupFails ? 503 : 204 }); }
    const action = headers.get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") {
      calls.submit++; expect(db.receipt(task, "tencent:source")?.status).toBe("unknown"); const data = JSON.parse(String(init.body)); expect(data.FileBase64).toBeUndefined(); const signed = new URL(data.FileUrl); expect(signed.hostname).toBe("fixture-1250000000.cos.ap-guangzhou.myqcloud.com"); expect(signed.searchParams.get("q-header-list")).toBe("host"); expect(signed.searchParams.get("q-signature")).toMatch(/^[a-f0-9]{40}$/);
      if (provider.submit === "disconnect") throw Error("PRIVATE signed URL"); if (provider.submit === "missing-id") return json({ RequestId: "ack" }); if (provider.submit === "rejected") return json({ Error: { Code: "InvalidParameter.Value", Message: "PRIVATE" }, RequestId: "rejected" }); return json({ TaskId: "job", RequestId: "submit" });
    }
    if (action === "DescribeMultimodalDocParseJob") { calls.query++; return json({ Status: provider.status, SuccessPageNum: 1, FailPageNum: 0, ResultUrl: "https://result.cos.ap-guangzhou.myqcloud.com/result.zip?signature=PRIVATE" }); }
    calls.download++; return new Response(provider.result);
  });
  client = new TencentClient(db, http); const results = new TencentResults(client, storage), open = () => results.open(task, "source", document, config, { sourceType: "image", pageCount: 1 });
  const f = { path, db, storage, document, bytes, task, config, client, results, http, provider, calls, good, open }; fixtures.push(f); return f;
}

it("matches the historical Python COS V5 signature over sorted and encoded private headers", async () => {
  const f = await setup(); expect(cosAuthorization("PUT", `/practiq-import/${"a".repeat(64)}/${"b".repeat(64)}`, { host: "fixture-1250000000.cos.ap-guangzhou.myqcloud.com", "content-type": "text/plain", "content-length": "11", "content-md5": "test+/==", "x-cos-acl": "private", "x-cos-server-side-encryption": "AES256" }, f.config, 1700000000, 330)).toBe("q-sign-algorithm=sha1&q-ak=test-id&q-sign-time=1700000000;1700000330&q-key-time=1700000000;1700000330&q-header-list=content-length;content-md5;content-type;host;x-cos-acl;x-cos-server-side-encryption&q-url-param-list=&q-signature=8045813fbb1a246f13f2ea3e7bfac6d61f8ac23f");
});

it("persists staging before upload and a paid claim before submit, validates local evidence before cleanup and never persists signed URLs", async () => {
  const f = await setup(), first = await f.open(); first.bundle.close(); expect(first.record).toMatchObject({ resultValidated: true, staging: { deleted: true } }); expect(f.calls).toEqual({ upload: 1, submit: 1, query: 1, download: 1, cleanup: 1 });
  const before = f.db.state(f.task), second = await f.open(); second.bundle.close(); expect(f.db.state(f.task)).toEqual(before); expect(f.calls).toEqual({ upload: 1, submit: 1, query: 1, download: 1, cleanup: 1 }); const persisted = JSON.stringify(f.db.db.prepare("SELECT * FROM ai_tasks").all()) + JSON.stringify(f.db.db.prepare("SELECT * FROM ai_calls").all()); for (const secret of ["q-signature", "PRIVATE", "test-secret", "FileUrl"]) expect(persisted).not.toContain(secret); expect(f.storage.source(f.document)).toEqual(f.bytes);
});

it.each(["disconnect", "checksum", "redirect", "unavailable"])("retains a %s upload intent and retries only on an explicit new call without Base64 fallback", async outcome => {
  const f = await setup(); f.provider.upload = outcome; await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_COS_UPLOAD_FAILED" }); expect(f.calls).toEqual({ upload: 1, submit: 0, query: 0, download: 0, cleanup: 0 }); expect(f.client.job(f.task, "source").status).toBe("STAGING"); expect(f.db.receipt(f.task, "tencent:source")).toBeNull();
  f.provider.upload = "success"; const recovered = await f.open(); recovered.bundle.close(); expect(f.calls).toEqual({ upload: 2, submit: 1, query: 1, download: 1, cleanup: 1 });
});

it.each(["disconnect", "missing-id"])("retains staged input after a %s submission and refuses every replay or cleanup", async outcome => {
  const f = await setup(); f.provider.submit = outcome; await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); const before = f.db.state(f.task); await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); await expect(f.client.cleanupSource(f.task, "source", f.config)).rejects.toMatchObject({ code: "TENCENT_COS_CONFLICT" }); expect(f.calls).toEqual({ upload: 1, submit: 1, query: 0, download: 0, cleanup: 0 }); expect(f.db.state(f.task)).toEqual(before); expect(f.db.receipt(f.task, "tencent:source")?.status).toBe("unknown");
});

it.each(["rejected", "Failed"])("cleans a known %s outcome while keeping the receipt and never resubmitting", async outcome => {
  const f = await setup(); if (outcome === "rejected") f.provider.submit = outcome; else f.provider.status = outcome;
  for (let index = 0; index < 2; index++) await expect(f.open()).rejects.toMatchObject({ code: outcome === "rejected" ? "TENCENT_REQUEST_REJECTED" : "TENCENT_JOB_FAILED" }); expect(f.calls.upload).toBe(1); expect(f.calls.submit).toBe(1); expect(f.calls.cleanup).toBe(1); expect(f.client.job(f.task, "source")).toMatchObject({ staging: { deleted: true } });
});

it("retains unvalidated and unknown job inputs instead of deleting their remote evidence", async () => {
  const f = await setup(); f.provider.result = Buffer.from("bad archive"); await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); expect(f.calls.cleanup).toBe(0); expect(f.client.job(f.task, "source").resultValidated).toBe(false); f.provider.result = f.good; const recovered = await f.open(); recovered.bundle.close(); expect(f.calls.submit).toBe(1); expect(f.calls.cleanup).toBe(1);
});

it("retries only cleanup after a validated-result cleanup failure and retains the local result", async () => {
  const f = await setup(); f.provider.cleanupFails = true; await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_COS_CLEANUP_FAILED" }); expect(f.client.job(f.task, "source")).toMatchObject({ resultValidated: true, staging: { deleted: false, cleanupError: "TENCENT_COS_CLEANUP_FAILED" } }); f.provider.cleanupFails = false;
  const recovered = await f.open(); recovered.bundle.close(); expect(f.calls).toEqual({ upload: 1, submit: 1, query: 1, download: 1, cleanup: 2 }); expect(f.client.job(f.task, "source")).toMatchObject({ resultValidated: true, staging: { deleted: true } }); expect(JSON.stringify(f.db.state(f.task))).not.toContain("cleanupError");
});

it.each(["bucket", "region", "transport", "borrowed_object", "extra_url"])("refuses %s changes without contacting a new destination or discarding the old staging record", async kind => {
  const f = await setup(); f.provider.upload = "disconnect"; await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_COS_UPLOAD_FAILED" });
  if (kind === "bucket") f.config.preferences.tencentCos.bucket = "other-1250000000"; if (kind === "region") f.config.preferences.tencentCos.region = "ap-beijing"; if (kind === "transport") f.config.preferences.tencentCos.enabled = false;
  if (kind === "borrowed_object" || kind === "extra_url") { const job = f.client.job(f.task, "source"), staging = { ...job.staging as object, ...(kind === "extra_url" ? { url: "https://untrusted.invalid" } : { objectKey: stagingObject(f.config, randomUUID(), "source", f.document.sha256).objectKey }) }; f.client.updateJob(f.task, "source", { staging }); }
  const before = f.db.state(f.task); await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_COS_CONFLICT" }); expect(f.db.state(f.task)).toEqual(before); expect(f.calls.upload).toBe(1);
});

it("bounds private URL inputs by source type while preserving the additional Base64 cap", async () => {
  const f = await setup(), bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 1), source = { type: "doc" as const, bytes, sha256: hash(bytes) }; f.db.createTask(source.sha256, 64, randomUUID());
  expect(tencentInputLimit("doc", true)).toBe(150 * 1024 * 1024); expect(tencentInputLimit("xlsx", true)).toBe(10 * 1024 * 1024); expect(tencentInputLimit("image", true)).toBe(30 * 1024 * 1024); expect(tencentInputLimit("doc", false)).toBe(8 * 1024 * 1024);
  expect(await f.client.submit(f.task, "source", source, f.config)).toBe("job"); expect(f.calls.upload).toBe(1); const local = structuredClone(f.config); local.preferences.tencentCos.enabled = false; await expect(f.client.submit(f.task, "too-large", source, local)).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" }); expect(f.calls.upload).toBe(1);
});

it("confines signed URLs to their owned path and rejects hostile COS settings before network work", async () => {
  const f = await setup(), stage = stagingObject(f.config, f.task, "source", f.document.sha256); expect(sourceUrl(stage, f.config, 1700000000)).toMatch(/^https:\/\/fixture-/);
  expect(() => validateStaging({ ...stage, objectKey: "user-data/keep" }, f.config, f.task, "source", f.document.sha256)).toThrow(); f.config.preferences.tencentCos.bucket = "https://untrusted.invalid"; await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_COS_NOT_CONFIGURED" }); expect(f.http).not.toHaveBeenCalled();
});

it("admits at most one paid submission after concurrent staging acknowledgements", async () => {
  const f = await setup(), uploads: (() => void)[] = [], original = f.http.getMockImplementation()!;
  f.http.mockImplementation(async (url, init) => { if (init.method === "PUT") { expect(f.client.job(f.task, "source").status).toBe("STAGING"); f.calls.upload++; await new Promise<void>(resolve => uploads.push(resolve)); return new Response(null, { headers: { ETag: `"${createHash("md5").update(Buffer.from(init.body as Uint8Array)).digest("hex")}"` } }); } return original(url, init); });
  const source = { sha256: f.document.sha256, bytes: f.bytes, type: "image" as const }, first = f.client.submit(f.task, "source", source, f.config); await vi.waitFor(() => expect(uploads).toHaveLength(1));
  f.config.preferences.import.tencentConcurrency = 2; const second = f.client.submit(f.task, "source", source, f.config); await vi.waitFor(() => expect(uploads).toHaveLength(2)); uploads[0](); expect(await first).toBe("job"); uploads[1](); await expect(second).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(f.calls.submit).toBe(1); expect(f.client.job(f.task, "source").status).toBe("Created");
});

it.each(["upload", "submit", "cleanup"])("survives real SIGKILL during %s without automatically resubmitting paid recognition", async phase => {
  const f = await setup(), base = new URL("../.build/electron/app/desktop/", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const d=JSON.parse(process.argv[1]), get=n=>import(d.base+n+'.js'), [{AiDatabase},{AiStorage},{TencentClient},{TencentResults},{createHash}]=await Promise.all([get('ai-database'),get('ai-storage'),get('tencent'),get('tencent-results'),import('node:crypto')]);
    const db=new AiDatabase(d.path), storage=new AiStorage(d.path), kill=()=>process.kill(process.pid,'SIGKILL'), client=new TencentClient(db,async(url,init)=>{
      if(init.method==='PUT'){if(d.phase==='upload')kill();return new Response(null,{headers:{ETag:'"'+createHash('md5').update(init.body).digest('hex')+'"'}});}
      if(init.method==='DELETE')kill(); const action=new Headers(init.headers).get('X-TC-Action'); if(action==='SubmitMultimodalDocParseJob'){if(d.phase==='submit')kill();return new Response(JSON.stringify({Response:{TaskId:'job'}}));} if(action==='DescribeMultimodalDocParseJob')return new Response(JSON.stringify({Response:{Status:'Success',SuccessPageNum:1,FailPageNum:0,ResultUrl:'https://result.cos.ap-guangzhou.myqcloud.com/result'}})); return new Response(Buffer.from(d.good,'base64'));
    });await new TencentResults(client,storage).open(d.task,'source',d.document,d.config,{sourceType:'image',pageCount:1});
  `, JSON.stringify({ base, path: f.path, task: f.task, document: f.document, config: f.config, good: f.good.toString("base64"), phase })], { timeout: 15000, encoding: "utf8" });
  expect(child.signal, child.stderr).toBe("SIGKILL"); const state = f.client.job(f.task, "source");
  if (phase === "submit") { expect(f.db.receipt(f.task, "tencent:source")?.status).toBe("unknown"); await expect(f.open()).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(f.http).not.toHaveBeenCalled(); }
  else { const recovered = await f.open(); recovered.bundle.close(); expect(f.calls.submit).toBe(phase === "upload" ? 1 : 0); expect(f.calls.upload).toBe(phase === "upload" ? 1 : 0); expect(f.calls.cleanup).toBe(1); if (phase === "cleanup") expect(state.resultValidated).toBe(true); }
  expect(f.storage.source(f.document)).toEqual(f.bytes);
});
