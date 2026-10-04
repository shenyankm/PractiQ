import { describe, expect, it, vi } from "vitest";
import { Client, ApiError, MAX_BANK_ZIP_BYTES, downloadBlob, fileFormat, sha256, sourceLimit, validateFiles } from "./api";
import { capabilities, task, taskId, runId } from "./test-fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const receipt = { threadId: taskId, requestId: taskId, runId, accepted: true };
function mockUpload(options: { existing?: boolean; badReference?: boolean; badUrl?: boolean; networkAtCreate?: boolean } = {}) {
  let document: Record<string, unknown>;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/uploads") {
      const metadata = JSON.parse(init.body as string);
      document = { ...metadata, objectKey: `practiq-agent/sources/${metadata.sha256}/source.${metadata.sourceType === "text" ? "txt" : metadata.sourceType}` };
      return json({ document: options.badReference ? { ...document, sha256: "0".repeat(64) } : document, upload: options.existing ? null : { method: "PUT", url: (options.badUrl ? "https://untrusted.invalid" : "") + "/api/uploads/content?" + new URLSearchParams(metadata), headers: { "Content-Type": metadata.mediaType } } });
    }
    if (path.startsWith("/api/uploads/content?")) return json(document);
    if (path === "/api/document-tasks") {
      if (options.networkAtCreate) throw new TypeError("connection lost");
      return json(receipt, 202);
    }
    throw new Error(`Unexpected path ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("source selection and bounded upload", () => {
  it("validates formats, filenames, empty files, count and authoritative size before HTTP", () => {
    expect(fileFormat(new File(["x"], "a.JPEG"))).toEqual({ sourceType: "image", mediaType: "image/jpeg" });
    expect(() => fileFormat(new File(["x"], "a.exe"))).toThrow(ApiError);
    expect(() => fileFormat(new File(["x"], `${"a".repeat(256)}.txt`))).toThrow(ApiError);
    expect(() => validateFiles([], capabilities)).toThrow("1–10");
    expect(() => validateFiles(Array.from({ length: 11 }, () => new File(["x"], "a.txt")), capabilities)).toThrow("1–10");
    expect(() => validateFiles([new File([], "a.txt")], capabilities)).toThrow("为空");
    expect(() => validateFiles([new File(["xx"], "a.txt")], { ...capabilities, sourceMaxBytes: 1 })).toThrow("大小限制");
    expect(() => validateFiles([new File(["x"], "a.docx")], { ...capabilities, sourceTypes: ["pdf"] })).toThrow("暂不支持");
    expect(sourceLimit({ ...capabilities, sourceMaxBytes: 101 * 1024 * 1024 })).toBe(101 * 1024 * 1024);
  });
  it("hashes exact bytes, uploads with Bearer, then creates exactly one explicit task", async () => {
    const fetcher = mockUpload();
    const stages: string[] = [];
    const client = new Client("fake-service-token");
    await expect(client.start(new File(["hello"], "a.txt"), capabilities, taskId, "text", stage => stages.push(stage))).resolves.toEqual(receipt);
    expect(stages).toEqual(["hashing", "uploading", "starting"]);
    expect(fetcher.mock.calls).toHaveLength(3);
    const metadata = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(metadata).toEqual({ sourceType: "text", mediaType: "text/plain", fileName: "a.txt", sizeBytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    const create = JSON.parse(fetcher.mock.calls[2][1].body as string);
    expect(create.requestId).toBe(taskId);
    expect(create.document).toMatchObject(metadata);
    expect(create).not.toHaveProperty("officeMode");
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain("fake-service-token");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fake-service-token");
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    }
    client.disconnect();
  });
  it("skips binary PUT when the managed source already exists, and sends Office mode only for Office", async () => {
    const fetcher = mockUpload({ existing: true });
    await new Client("fake").start(new File(["office"], "a.docx"), capabilities, taskId, "text", () => {});
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toMatchObject({ requestId: taskId, officeMode: "text", document: { sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
  });
  it.each([{ badReference: true }, { badUrl: true }])("rejects altered reference or external upload URL before PUT/model submission: %j", async options => {
    const fetcher = mockUpload(options);
    await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, "pdf", () => {})).rejects.toBeInstanceOf(ApiError);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("does not replay an uncertain create automatically and preserves the supplied request ID for explicit retry", async () => {
    const fetcher = mockUpload({ existing: true, networkAtCreate: true });
    const client = new Client("fake");
    const file = new File(["x"], "a.txt");
    await expect(client.start(file, capabilities, taskId, "pdf", () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher.mock.calls).toHaveLength(2);
    await expect(client.start(file, capabilities, taskId, "pdf", () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    const creates = fetcher.mock.calls.filter(([url]) => url === "/api/document-tasks");
    expect(creates.map(([, init]) => JSON.parse(init.body as string).requestId)).toEqual([taskId, taskId]);
  });
  it("blocks unavailable conversion/model and mismatched bytes without posting", async () => {
    const fetcher = mockUpload();
    const client = new Client("fake");
    const office = new File(["x"], "a.xls");
    await expect(client.start(office, { ...capabilities, officeAvailable: false }, taskId, "pdf", () => {})).rejects.toMatchObject({ code: "OFFICE_UNAVAILABLE" });
    await expect(client.start(office, { ...capabilities, modelConfigured: false }, taskId, "pdf", () => {})).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    const file = new File(["x"], "a.txt");
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(new ArrayBuffer(2));
    await expect(client.start(file, capabilities, taskId, "pdf", () => {})).rejects.toMatchObject({ code: "DOCUMENT_SIZE_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("task reads and explicit controls", () => {
  it("reads capabilities/list/detail/preview and deletes using only same-origin authenticated paths", async () => {
    const fetcher = vi.fn(async (url: string) => json(url.includes("capabilities") ? capabilities : url.includes("preview") ? { units: [] } : url.includes("?") ? { items: [], hasMore: false } : { deleted: true }));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    await expect(client.capabilities()).resolves.toEqual(capabilities);
    await client.list(20, "failed"); await client.detail(taskId); await client.preview(taskId); await client.delete(taskId);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/import-capabilities", "/api/document-tasks?limit=20&offset=20&state_filter=failed", `/api/document-tasks/${taskId}`, `/api/document-tasks/${taskId}/preview`, `/api/document-tasks/${taskId}`]);
  });
  it("rejects malformed capability/JSON and never displays server-echoed credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ...capabilities, sourceMaxBytes: -1 })).mockResolvedValueOnce(new Response("<html>wrong route</html>")).mockResolvedValueOnce(json({ detail: { code: "UNAUTHORIZED", message: "fake-secret" } }, 401));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake-secret");
    await expect(client.capabilities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.list(0)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    try { await client.detail(taskId); } catch (error) { expect((error as Error).message).not.toContain("fake-secret"); expect(error).toMatchObject({ status: 401 }); }
  });
  it("targets running operations by run ID, and checkpoint operations by checkpoint ID", async () => {
    const fetcher = vi.fn().mockImplementation(async () => json(receipt, 202)); vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    await client.control({ ...task, runId, allowedActions: ["pause"] }, "pause");
    await client.control({ ...task, allowedActions: ["resume", "retry_failed", "accept_partial"] }, "retry_failed");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ action: "pause", runId, checkpointId: null, units: [] });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ action: "retry_failed", runId: null, checkpointId: "checkpoint-one", units: [] });
    await expect(client.control({ ...task, allowedActions: [] }, "resume")).rejects.toMatchObject({ code: "ACTION_UNAVAILABLE" });
    await expect(client.control({ ...task, allowedActions: ["resume"], modelConfigured: false }, "resume")).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    await expect(client.control({ ...task, allowedActions: ["resume"], resumeCompatible: false }, "resume")).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reuses an uncertain control/reparse intent only when the user explicitly repeats it", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(json(receipt, 202)).mockResolvedValueOnce(json(receipt, 202)).mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(json(receipt, 202));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake"); const paused = { ...task, allowedActions: ["resume"] as const };
    await expect(client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume");
    await client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume");
    const ids = fetcher.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(init.body).requestId);
    expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[1]);
    await expect(client.reparse(taskId)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await client.reparse(taskId);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).requestId).toBe(JSON.parse(fetcher.mock.calls[4][1].body).requestId);
  });
  it("disconnect cancels in-flight reads and rejects new HTTP; token is never persisted", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake"); const pending = client.list(0); client.disconnect();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.list(0)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(() => new Client("\r\nsecret")).toThrow("Token"); expect(() => new Client(" ")).toThrow("Token");
  });
});
describe("checked private downloads", () => {
  it("reads an image by reference and verifies media, actual size and SHA before returning a blob", async () => {
    const bytes = new TextEncoder().encode("fake image");
    const reference = { objectKey: "practiq-agent/artifacts/image.png", sha256: await sha256(bytes.buffer), sizeBytes: bytes.length, mediaType: "image/png" };
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "image/png" } })); vi.stubGlobal("fetch", fetcher);
    const blob = await new Client("fake").image(reference);
    expect(blob.size).toBe(bytes.length); expect(blob.type).toBe("image/png");
    expect(fetcher.mock.calls[0][0]).toBe("/api/artifacts/read"); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(reference);
  });
  it("rejects SVG, altered bytes, oversized streams and mismatched media", async () => {
    const reference = { objectKey: "managed.png", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "image/png" };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png" } })).mockResolvedValueOnce(new Response("xx", { headers: { "Content-Type": "image/png" } })).mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/jpeg" } })).mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": "2" } }));
    vi.stubGlobal("fetch", fetcher); const client = new Client("fake");
    await expect(client.image({ ...reference, mediaType: "image/svg+xml" })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(client.image(reference)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
    await expect(client.image(reference)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(client.image(reference)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
    await expect(client.image(reference)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
  it("exports only completed visible checkpoint ZIPs with auth and a safe local filename", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("PKfake", { headers: { "Content-Type": "application/zip" } })).mockResolvedValueOnce(new Response("html", { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(json({ detail: { code: "STALE_CHECKPOINT" } }, 409)); vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    const exported = await client.exportBank(task);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/document-tasks/${taskId}/export?checkpoint_id=checkpoint-one`);
    expect(exported).toMatchObject({ name: `practiq-bank-${taskId}.zip` }); expect(exported.blob.type).toBe("application/zip");
    await expect(client.exportBank(task)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.exportBank(task)).rejects.toMatchObject({ code: "STALE_CHECKPOINT" });
    await expect(client.exportBank({ ...task, state: "WAITING_REVIEW" })).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  });
  it("releases a download object URL after the browser handoff", () => {
    vi.useFakeTimers(); const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-download"); const revoke = vi.spyOn(URL, "revokeObjectURL"); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadBlob(new Blob(["zip"]), "bank.zip"); expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1); expect(revoke).not.toHaveBeenCalled(); vi.advanceTimersByTime(1000); expect(revoke).toHaveBeenCalledWith("blob:private-download");
  });
  it("allows the shared 300 MiB ZIP ceiling and rejects larger declared responses without allocating them", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("PKfake", { headers: { "Content-Type": "application/zip", "Content-Length": String(257 * 1024 * 1024) } })).mockResolvedValueOnce(new Response("PKfake", { headers: { "Content-Type": "application/zip", "Content-Length": String(MAX_BANK_ZIP_BYTES + 1) } }));
    vi.stubGlobal("fetch", fetcher); const client = new Client("fake");
    await expect(client.exportBank(task)).resolves.toMatchObject({ name: `practiq-bank-${taskId}.zip` });
    await expect(client.exportBank(task)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(MAX_BANK_ZIP_BYTES).toBe(300 * 1024 * 1024);
  });
});
