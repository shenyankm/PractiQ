import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiDatabase } from "./ai-database.js";
import { AiSettings, type AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { TencentClient, tencentHeaders, tencentResultUrl } from "./tencent.js";

const directories: string[] = [], databases: AiDatabase[] = [];
function database() { const path = mkdtempSync(join(tmpdir(), "practiq-tencent-")); directories.push(path); const db = new AiDatabase(path); databases.push(db); return { path, db }; }
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function config(): Promise<AiSnapshot> {
  const { path } = database(), settings = new AiSettings(path, { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => { throw new Error(); }, decryptStringAsync: async () => { throw new Error(); } }), view = await settings.view();
  return { revision: view.revision, preferences: view.preferences, secrets: { modelApiKey: "unused", tencentSecretId: "test-id", tencentSecretKey: "test-secret" } };
}
const source = { sha256: hash("Source text"), type: "text" as const, bytes: Buffer.from("Source text") };
const response = (value: unknown) => new Response(JSON.stringify({ Response: value }), { headers: { "Content-Type": "application/json" } });

it("matches the Python implementation's TC3 signature over exact UTF-8 JSON bytes", () => {
  expect(tencentHeaders("SubmitMultimodalDocParseJob", '{"FileType":6,"Text":"中文"}', { tencentSecretId: "test-id", tencentSecretKey: "test-secret" }, 1700000000).Authorization).toBe("TC3-HMAC-SHA256 Credential=test-id/2023-11-14/ocr/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=1df420999a68fa116337a0bcdc651e302e048677e929097e7efdcccaa9848884");
});

it("commits an unknown receipt before sending and resumes a known job without resubmitting", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 10), signed = "https://result.cos.ap-guangzhou.myqcloud.com/result.zip?signature=PRIVATE";
  const http = vi.fn(async (_url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") { expect(db.receipt(task, "tencent:source")?.status).toBe("unknown"); expect(JSON.parse(String(init.body))).toMatchObject({ FileType: 6, ResultType: 2, EnableSubImg: false }); return response({ TaskId: "job-one", RequestId: "submit" }); }
    return response({ Status: "Success", ResultUrl: signed, RequestId: "query", SuccessPageNum: 1, FailPageNum: 0 });
  });
  const client = new TencentClient(db, http); expect(await client.submit(task, "source", source, settings)).toBe("job-one");
  expect(await new TencentClient(db, http).submit(task, "source", source, settings)).toBe("job-one"); expect(http).toHaveBeenCalledTimes(1);
  expect((await client.query(task, "source", settings)).resultUrl).toBe(signed);
  expect(JSON.stringify(db.state(task))).not.toContain("PRIVATE"); expect(JSON.stringify(db.receipt(task, "tencent:source"))).not.toContain("test-secret");
});

it.each(["disconnect", "missing-id"])("keeps %s submissions unknown and never automatically retries them", async kind => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 10), http = vi.fn(async () => { if (kind === "disconnect") throw new Error("signed secret URL"); return response({ RequestId: "ack-without-job" }); });
  const client = new TencentClient(db, http); await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" });
  await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(http).toHaveBeenCalledTimes(1); expect(db.receipt(task, "tencent:source")?.status).toBe("unknown");
});

it("retains explicit rejection metadata and refuses conflicting source identities", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 10), http = vi.fn(async () => response({ Error: { Code: "InvalidParameter.Value", Message: "PRIVATE" }, RequestId: "request" }));
  const client = new TencentClient(db, http); await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_REQUEST_REJECTED" });
  expect(db.receipt(task, "tencent:source")).toMatchObject({ status: "failed", result: { providerCode: "InvalidParameter.Value", requestId: "request" } });
  await expect(client.submit(task, "source", { ...source, sha256: hash("Other"), bytes: Buffer.from("Other") }, settings)).rejects.toMatchObject({ code: "TENCENT_JOB_CONFLICT" }); expect(http).toHaveBeenCalledTimes(1); expect(JSON.stringify(db.state(task))).not.toContain("PRIVATE");
});

it("never follows result redirects and rejects arbitrary or credential-bearing download destinations", async () => {
  const { db } = database();
  for (const url of ["http://bucket.cos.ap-guangzhou.myqcloud.com/result", "https://elsewhere.example/result", "https://secret@bucket.cos.ap-guangzhou.myqcloud.com/result", "https://bucket.cos.ap-guangzhou.myqcloud.com/result#fragment", "file:///private"]) expect(() => tencentResultUrl(url)).toThrow();
  const http = vi.fn(async (_url: string, init: RequestInit) => { expect(init.redirect).toBe("error"); return new Response(Buffer.from("zip result")); });
  expect(await new TencentClient(db, http).download("https://bucket.cos.ap-guangzhou.myqcloud.com/result?signature=private")).toEqual(Buffer.from("zip result"));
});

it("bounds recognition job admission before making another paid submission", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1), http = vi.fn();
  db.saveState(task, { tencentJobs: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [String(index), { status: "SUBMITTING" }])) });
  await expect(new TencentClient(db, http).submit(task, "overflow", source, settings)).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" }); expect(http).not.toHaveBeenCalled(); expect(db.receipt(task, "tencent:overflow")).toBeNull();
});

it("binds the Office page ceiling to its receipt and refuses a changed ceiling without resubmission", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 10), office = { ...source, type: "docx" as const, maxPages: 2 }, http = vi.fn(async (_url: string, init: RequestInit) => { expect(JSON.parse(String(init.body))).toMatchObject({ FileType: 2, FileEndPageNumber: 2 }); expect(db.receipt(task, "tencent:office")?.status).toBe("unknown"); return response({ TaskId: "bounded-office-job" }); }), client = new TencentClient(db, http);
  expect(await client.submit(task, "office", office, settings)).toBe("bounded-office-job"); expect(await client.submit(task, "office", office, settings)).toBe("bounded-office-job");
  await expect(client.submit(task, "office", { ...office, maxPages: 3 }, settings)).rejects.toMatchObject({ code: "TENCENT_JOB_CONFLICT" });
  for (const maxPages of [0, 301, 1.5]) await expect(client.submit(task, "invalid", { ...office, maxPages }, settings)).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" });
  await expect(client.submit(task, "invalid", { ...source, maxPages: 2 }, settings)).rejects.toMatchObject({ code: "TENCENT_SOURCE_TOO_LARGE" }); expect(http).toHaveBeenCalledTimes(1); expect(db.receipt(task, "tencent:invalid")).toBeNull();
});

it.each([{}, { sourceSha256: source.sha256, status: "SUBMITTING" }])("never replaces an orphaned submission intent with a new paid call: %j", async record => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1), http = vi.fn(), client = new TencentClient(db, http);
  db.saveState(task, { tencentJobs: { source: record } }); const before = db.state(task);
  await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(db.state(task)).toEqual(before); expect(db.receipt(task, "tencent:source")).toBeNull(); expect(http).not.toHaveBeenCalled();
});

it("recovers a persisted acknowledgement before the job projection without accepting conflicting identities", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1), http = vi.fn(), client = new TencentClient(db, http), target = { inputDigest: hash(JSON.stringify({ resultType: 2, sourceSha256: source.sha256, type: "text" })), endpoint: "https://ocr.tencentcloudapi.com", model: "multimodal-doc-parse", promptVersion: "2018-11-19-v1" };
  db.saveState(task, { tencentJobs: { source: { sourceSha256: source.sha256, resultType: 2, status: "SUBMITTING" } } }); db.claim(task, "tencent:source", target); db.finish(task, "tencent:source", "succeeded", { taskId: "known-job" }, null);
  expect(await client.submit(task, "source", source, settings)).toBe("known-job"); expect(db.state(task)).toMatchObject({ tencentJobs: { source: { taskId: "known-job", status: "Created" } } });
  db.saveState(task, { tencentJobs: { source: { sourceSha256: source.sha256, resultType: 2, status: "Created", taskId: "conflicting-job" } } });
  await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_JOB_CONFLICT" }); expect(http).not.toHaveBeenCalled();
});

it.each([408, 429, 500, 502, 503, 504, "transport", "body", "RequestLimitExceeded.Account", "InternalError.Timeout"])("retries only the safe known-job read after %s", async failure => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1); settings.preferences.import = { ...settings.preferences.import, readRetryCount: 1, retryBaseSeconds: 0.5 };
  db.saveState(task, { tencentJobs: { source: { sourceSha256: source.sha256, taskId: "existing", status: "Created" } } });
  const http = vi.fn(async () => {
    if (http.mock.calls.length > 1) return response({ Status: "Processing" });
    if (failure === "transport") throw new TypeError("PRIVATE");
    if (failure === "body") return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("PRIVATE")); } }));
    return typeof failure === "number" ? new Response("PRIVATE", { status: failure }) : response({ Error: { Code: failure, Message: "PRIVATE" }, RequestId: "read-failure" });
  });
  expect(await new TencentClient(db, http).query(task, "source", settings)).toMatchObject({ status: "Processing", taskId: "existing" }); expect(http).toHaveBeenCalledTimes(2); expect(db.receipt(task, "tencent:source")).toBeNull(); expect(JSON.stringify(db.state(task))).not.toContain("PRIVATE");
});

it.each([400, 401, 403, 404, 302, "json", "duplicate", "envelope", "oversize", "InvalidParameter.Value"])("does not retry permanent or malformed reads: %s", async failure => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1); db.saveState(task, { tencentJobs: { source: { taskId: "existing" } } });
  const http = vi.fn(async () => typeof failure === "number" ? new Response("PRIVATE", { status: failure }) : failure === "json" ? new Response("PRIVATE") : failure === "duplicate" ? new Response('{"Response":{},"Response":{}}') : failure === "envelope" ? response([]) : failure === "oversize" ? new Response("x".repeat(65537)) : response({ Error: { Code: failure, Message: "PRIVATE" } }));
  await expect(new TencentClient(db, http).query(task, "source", settings)).rejects.toMatchObject({ code: failure === "InvalidParameter.Value" ? "TENCENT_QUERY_REJECTED" : "TENCENT_API_UNAVAILABLE" }); expect(http).toHaveBeenCalledTimes(1);
});

it("keeps submission throttling unknown after one request and bounds safe read retries", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1); settings.preferences.import = { ...settings.preferences.import, readRetryCount: 1, retryBaseSeconds: 0.5 };
  const http = vi.fn(async () => new Response("PRIVATE", { status: 429 })), client = new TencentClient(db, http);
  await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(http).toHaveBeenCalledTimes(1);
  await expect(client.submit(task, "source", source, settings)).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(http).toHaveBeenCalledTimes(1);
  db.saveState(task, { tencentJobs: { other: { taskId: "existing" } } });
  await expect(client.query(task, "other", settings)).rejects.toMatchObject({ code: "TENCENT_API_UNAVAILABLE" }); expect(http).toHaveBeenCalledTimes(3);
});

it("preserves freshly saved result evidence when a slower query or rejection finishes", async () => {
  const { db } = database(), settings = await config(), task = db.createTask(source.sha256, 1), sourceJob = { sourceSha256: source.sha256, taskId: "existing", status: "Created" }; settings.preferences.import.readRetryCount = 0;
  db.saveState(task, { tencentJobs: { source: sourceJob } });
  let finish!: (value: Response) => void; const http = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })), client = new TencentClient(db, http);
  const pending = client.query(task, "source", settings); await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1)); client.updateJob(task, "source", { resultRef: { sha256: "retained" }, resultValidated: true }); finish(response({ Status: "Processing" })); await pending;
  expect(client.job(task, "source")).toMatchObject({ resultRef: { sha256: "retained" }, resultValidated: true });
  const rejected = client.query(task, "source", settings); await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2)); client.updateJob(task, "source", { resultValidationError: "TENCENT_RESULT_INVALID" }); finish(response({ Error: { Code: "InvalidParameter.Value" } })); await expect(rejected).rejects.toMatchObject({ code: "TENCENT_QUERY_REJECTED" });
  expect(client.job(task, "source")).toMatchObject({ resultRef: { sha256: "retained" }, resultValidated: true, resultValidationError: "TENCENT_RESULT_INVALID" });
  expect(() => client.updateJob(task, "source", { resultValidated: false }, { resultRef: { sha256: "old" } })).toThrow();
  expect(client.job(task, "source").resultValidated).toBe(true);
});

it("retries bounded downloads and stops before another read when cancelled", async () => {
  const { db } = database(), settings = await config(); settings.preferences.import = { ...settings.preferences.import, readRetryCount: 1, retryBaseSeconds: 0.5 };
  const controller = new AbortController(), http = vi.fn(async () => http.mock.calls.length === 1 ? new Response("PRIVATE", { status: 503 }) : new Response("result")), client = new TencentClient(db, http), url = "https://result.cos.ap-guangzhou.myqcloud.com/result?signature=PRIVATE";
  expect(await client.download(url, undefined, settings)).toEqual(Buffer.from("result")); expect(http).toHaveBeenCalledTimes(2);
  const fail = vi.fn(async () => { controller.abort(); throw new TypeError("PRIVATE"); });
  await expect(new TencentClient(db, fail).download(url, controller.signal, settings)).rejects.toThrow(); expect(fail).toHaveBeenCalledTimes(1);
});
