import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import { AiSettings, type AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { TencentBundle } from "./tencent-bundle.js";
import { TencentClient } from "./tencent.js";
import { TencentResults } from "./tencent-results.js";

const paths: string[] = [], databases: AiDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true }); });
const codecs = JSON.parse(readFileSync(new URL("../fixtures/tencent/zip-codecs.json", import.meta.url), "utf8")) as Record<string, string>, good = Buffer.from(codecs["0"], "base64"), signed = "https://result.cos.ap-guangzhou.myqcloud.com/result.zip?signature=PRIVATE";
const response = (body: unknown) => new Response(JSON.stringify({ Response: body }));
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-tencent-result-")); paths.push(path); const db = new AiDatabase(path); databases.push(db);
  const settings = new AiSettings(path, { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => { throw new Error(); }, decryptStringAsync: async () => { throw new Error(); } }), view = await settings.view(), config: AiSnapshot = { revision: view.revision, preferences: view.preferences, secrets: { modelApiKey: "unused", tencentSecretId: "id", tencentSecretKey: "secret" } }; config.preferences.import.readRetryCount = 0;
  const source = readFileSync(new URL("../fixtures/tencent/image.jpg", import.meta.url)), sha256 = hash(source), reference: DocumentReference = { objectKey: sourceKey("image", sha256), sha256, mediaType: "image/jpeg", sourceType: "image", fileName: "source.jpg", sizeBytes: source.length }, storage = new AiStorage(path);
  await storage.putSource(reference, source); const task = db.createTask(sha256, 10), calls = { submit: 0, query: 0, download: 0 };
  let payload = good, status: Record<string, unknown> = { Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: signed };
  const http = vi.fn(async (_url: string, init: RequestInit) => {
    const action = new Headers(init.headers).get("X-TC-Action");
    if (action === "SubmitMultimodalDocParseJob") { calls.submit++; return response({ TaskId: "job", RequestId: "submit" }); }
    if (action === "DescribeMultimodalDocParseJob") { calls.query++; return response(status); }
    calls.download++; return new Response(payload);
  }), client = new TencentClient(db, http), results = new TencentResults(client, storage), open = (signal?: AbortSignal) => results.open(task, "source", reference, config, { sourceType: "image", pageCount: 1 }, signal);
  return { path, db, storage, reference, config, task, client, results, calls, http, open, payload: (bytes: Buffer) => { payload = bytes; }, status: (value: Record<string, unknown>) => { status = value; } };
}

it("persists raw immutable evidence before decoding and validates every subimage before publishing success", async () => {
  const s = await setup(), original = TencentBundle.open;
  const decode = vi.spyOn(TencentBundle, "open").mockImplementation(async (bytes, options) => {
    const record = s.client.job(s.task, "source"); expect(record.resultValidated).toBe(false); expect(s.storage.artifact(record.resultRef as ArtifactReference)).toEqual(good); return original(bytes, options);
  });
  const image = vi.spyOn(TencentBundle.prototype, "image"), first = await s.open();
  try { expect(first.record.resultValidated).toBe(true); expect(first.bundle.pages[0].figures).toHaveLength(1); expect(image).toHaveBeenCalledWith("image.png"); } finally { first.bundle.close(); }
  decode.mockRestore();
  const reopened = new AiDatabase(s.path); databases.push(reopened);
  const second = await new TencentResults(new TencentClient(reopened, s.http), s.storage).open(s.task, "source", s.reference, s.config, { sourceType: "image", pageCount: 1 }); second.bundle.close();
  expect(s.calls).toEqual({ submit: 1, query: 1, download: 1 }); expect(JSON.stringify(s.db.state(s.task))).not.toContain("PRIVATE");
});

it.each(["zip", "image"])("retains invalid %s evidence and explicitly resumes by reading the same job without another paid submission", async failure => {
  const s = await setup(), invalid = failure === "zip" ? Buffer.from("corrupt archive") : Buffer.from(good);
  if (failure === "image") invalid[invalid.indexOf(Buffer.from([137, 80, 78, 71])) + 40] ^= 1;
  s.payload(invalid); await expect(s.open()).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
  const record = s.client.job(s.task, "source"), old = record.resultRef as ArtifactReference;
  expect(record).toMatchObject({ taskId: "job", resultValidated: false, resultValidationError: "TENCENT_RESULT_INVALID", invalidResultRefs: [old] }); expect(s.storage.artifact(old)).toEqual(invalid);
  s.payload(good); const recovered = await s.open();
  try { expect(recovered.record).toMatchObject({ taskId: "job", resultValidated: true, resultValidationError: null, invalidResultRefs: [old] }); expect(recovered.record.resultRef).not.toEqual(old); } finally { recovered.bundle.close(); }
  expect(s.calls).toEqual({ submit: 1, query: 2, download: 2 }); expect(s.storage.artifact(old)).toEqual(invalid);
  const cached = await s.open(); cached.bundle.close(); expect(s.calls).toEqual({ submit: 1, query: 2, download: 2 });
});

it("does not reinterpret damaged cached bytes as authority for another download or recognition", async () => {
  const s = await setup(), first = await s.open(), ref = first.record.resultRef as ArtifactReference; first.bundle.close();
  writeFileSync(join(s.storage.root, ref.objectKey), Buffer.from("damaged")); const before = s.db.state(s.task);
  await expect(s.open()).rejects.toMatchObject({ code: "DOCUMENT_CHECKSUM_MISMATCH" }); expect(s.calls).toEqual({ submit: 1, query: 1, download: 1 }); expect(s.db.state(s.task)).toEqual(before); expect(readFileSync(join(s.storage.root, ref.objectKey))).toEqual(Buffer.from("damaged"));
});

it.each(["Failed", "Unknown"])("retains a %s job and never creates another paid submission on explicit resume", async Status => {
  const s = await setup(); s.status({ Status });
  for (let count = 0; count < 2; count++) await expect(s.open()).rejects.toMatchObject({ code: Status === "Failed" ? "TENCENT_JOB_FAILED" : "TENCENT_JOB_UNKNOWN" });
  expect(s.calls).toEqual({ submit: 1, query: 2, download: 0 }); expect(s.client.job(s.task, "source").taskId).toBe("job");
});

it("leaves an orphan intent untouched and blocks a mismatched source or borrowed artifact", async () => {
  const s = await setup(); s.db.saveState(s.task, { tencentJobs: { source: { sourceSha256: s.reference.sha256, resultType: 9, status: "SUBMITTING" } } }); const before = s.db.state(s.task);
  await expect(s.open()).rejects.toMatchObject({ code: "TENCENT_SUBMISSION_UNKNOWN" }); expect(s.db.state(s.task)).toEqual(before); expect(s.http).not.toHaveBeenCalled();
  s.db.saveState(s.task, { tencentJobs: { source: { sourceSha256: hash("different"), resultType: 9, taskId: "borrowed" } } });
  await expect(s.open()).rejects.toMatchObject({ code: "TENCENT_JOB_CONFLICT" });
  const other = await s.storage.putArtifact(Buffer.from("source"), hash("another-parent"), "source-part", 0, "text/plain");
  await expect(s.results.open(s.task, "part-0", other, s.config, { sourceType: "text", pageCount: 1 })).rejects.toMatchObject({ code: "TENCENT_JOB_CONFLICT" }); expect(s.http).not.toHaveBeenCalled();
});

it("cancels polling before another read and retains the acknowledged task", async () => {
  const s = await setup(), controller = new AbortController(); s.status({ Status: "Processing" });
  const original = s.client.query.bind(s.client), query = vi.spyOn(s.client, "query"); query.mockImplementation(async (...args) => { const result = await original(...args); controller.abort(); return result; });
  await expect(s.open(controller.signal)).rejects.toThrow(); expect(s.calls).toEqual({ submit: 1, query: 1, download: 0 }); expect(s.client.job(s.task, "source").taskId).toBe("job");
  s.status({ Status: "Success", SuccessPageNum: 1, FailPageNum: 0, ResultUrl: signed }); query.mockRestore(); const resumed = await s.open(); resumed.bundle.close(); expect(s.calls).toEqual({ submit: 1, query: 2, download: 1 });
});

it("does not label an interrupted validation as a corrupt result or discard its saved archive", async () => {
  const s = await setup(), controller = new AbortController(), image = TencentBundle.prototype.image;
  vi.spyOn(TencentBundle.prototype, "image").mockImplementation(async function (this: TencentBundle, member) { const result = await image.call(this, member); controller.abort(); return result; });
  await expect(s.open(controller.signal)).rejects.toThrow(); expect(s.client.job(s.task, "source")).toMatchObject({ resultValidated: false, resultValidationError: null }); expect(s.client.job(s.task, "source").invalidResultRefs).toBeUndefined();
  vi.restoreAllMocks(); const cached = await s.open(); cached.bundle.close(); expect(s.calls).toEqual({ submit: 1, query: 1, download: 1 });
});

it.each([0, 1])("only permits an empty result when Tencent explicitly reports no successes and failures exist: %s", async SuccessPageNum => {
  const s = await setup(), zip = new ZipFile(); zip.addBuffer(Buffer.from("inert receipt"), "receipt.txt"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); s.payload(Buffer.concat(chunks));
  s.status({ Status: "Success", SuccessPageNum, FailPageNum: 1, FailedPages: [{ PageNum: 1, ErrorCode: "Unsupported", Message: signed }], ResultUrl: signed });
  if (SuccessPageNum === 0) { const result = await s.open(); try { expect(result.bundle.pages).toEqual([]); expect(result.record).toMatchObject({ failedPageCount: 1, successPageCount: 0, failedPages: [{ PageNum: 1, ErrorCode: "Unsupported" }] }); } finally { result.bundle.close(); } }
  else await expect(s.open()).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
  expect(JSON.stringify(s.db.state(s.task))).not.toContain("PRIVATE");
});

it("retains the shared image-byte cap across every figure occurrence, including repeated members", async () => {
  const s = await setup(), zip = new ZipFile(), data = { width: 100, height: 100, elements: [9, 10].map(index => ({ index, figure_info: {}, polygon: { left_top: { x: 10, y: 10 }, right_top: { x: 40, y: 10 }, left_bottom: { x: 10, y: 40 }, right_bottom: { x: 40, y: 40 } } })) };
  const image = readFileSync(new URL("../fixtures/tencent/image.jpg", import.meta.url));
  zip.addBuffer(Buffer.from('<root><image id="p-9" page-numbers="0" src="image.jpg"/><image id="p-10" page-numbers="0" src="image.jpg"/></root>'), "sample_xml_full.xml"); zip.addBuffer(Buffer.from(JSON.stringify(data)), "sample_ocr_page0.json"); zip.addBuffer(image, "image.jpg"); zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); s.payload(Buffer.concat(chunks));
  const decode = vi.spyOn(TencentBundle.prototype, "image");
  await expect(s.results.open(s.task, "source", s.reference, s.config, { sourceType: "image", pageCount: 1, limits: { visionMaxBytes: image.length } })).rejects.toMatchObject({ code: "TENCENT_RESULT_TOO_LARGE" });
  expect(decode).toHaveBeenCalledTimes(1); expect(s.client.job(s.task, "source")).toMatchObject({ resultValidated: false, resultValidationError: "TENCENT_RESULT_TOO_LARGE" });
});

it("resumes a known historical job without inventing a paid-call receipt", async () => {
  const s = await setup(); s.client.updateJob(s.task, "source", { sourceSha256: s.reference.sha256, resultType: 9, taskId: "historical-job", status: "Created" });
  const result = await s.open(); result.bundle.close(); expect(s.calls).toEqual({ submit: 0, query: 1, download: 1 }); expect(s.db.receipt(s.task, "tencent:source")).toBeNull();
});
