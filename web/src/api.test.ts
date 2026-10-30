import { describe, expect, it, vi } from "vitest";
import { Client, ApiError, MAX_BANK_ZIP_BYTES, downloadBlob, fileFormat, readBytes, sha256, sourceLimit, validateFiles } from "./api";
import { capabilities, task, taskId, runId } from "./test-fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const receipt = { threadId: taskId, requestId: taskId, runId, accepted: true };

it("exports ordered chunk views without a contiguous reassembly copy", async () => {
  const backing = new Uint8Array([255, 80, 75, 0, 128, 255]);
  const chunks = [backing.subarray(1, 3), new Uint8Array(), backing.subarray(3, 5)];
  const response = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { headers: { "Content-Type": "application/zip" } });
  const fetcher = vi.fn(async (_path: string, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetcher);
  const copy = vi.spyOn(Uint8Array.prototype, "set");
  const exported = await new Client("fake").exportBank(task);
  const copiedBytes = copy.mock.calls.reduce((total, [bytes]) => total + bytes.length, 0);
  copy.mockRestore();
  // JSDOM's Blob still takes one immutable copy of these bytes.
  expect(copiedBytes).toBe(4);
  backing.fill(1);
  expect([...new Uint8Array(await exported.blob.arrayBuffer())]).toEqual([80, 75, 0, 128]);
  expect(exported.blob.type).toBe("application/zip");
  expect(response.body?.locked).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer fake");
});

it("cancels an observed oversized body and releases the reader", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel }));
  await expect(readBytes(response, 5)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
});

it("retains bounded bodyless responses and normalizes streamed subarray bytes", async () => {
  const bytes = new Uint8Array([255, 80, 75, 0, 128, 255]);
  const response = new Response(null);
  vi.spyOn(response, "arrayBuffer").mockResolvedValue(bytes.buffer);
  expect(await readBytes(response, bytes.length)).toEqual(bytes);
  await expect(readBytes(response, bytes.length - 1)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(1, 5)); controller.close(); } }));
  expect([...new Uint8Array((await readBytes(streamed, 4)).buffer)]).toEqual([80, 75, 0, 128]);
});

it("verifies OCR evidence and strips document-only fields from original-file reads", async () => {
  const bytes = new TextEncoder().encode('{"text":"Source <script>inert</script>"}');
  const reference = { objectKey: "managed-ocr", sha256: await sha256(bytes.buffer), sizeBytes: bytes.length, mediaType: "application/json" };
  const fetcher = vi.fn().mockImplementation(async (_path, init) => new Response(bytes, { headers: { "Content-Type": JSON.parse(init.body as string).mediaType } }));
  vi.stubGlobal("fetch", fetcher);
  const client = new Client("fake");
  expect((await client.evidence(reference, taskId)).size).toBe(bytes.length);
  await client.source({ ...reference, mediaType: "text/plain", sourceType: "text", fileName: "source.txt" }, taskId);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...reference, mediaType: "text/plain" });
  await expect(client.evidence({ ...reference, sha256: "0".repeat(64) }, taskId)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
});

it.each([{ mediaType: "text/html" }, { sizeBytes: 25 * 1024 * 1024 + 1 }, { sizeBytes: 1.5 }])("rejects unsafe evidence metadata before fetching: %s", async change => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(new Client("fake").evidence({ objectKey: "managed", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "application/json", ...change }, taskId)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["headers", "body"])("bounds stalled %s and permits the next read", async stage => {
  vi.useFakeTimers();
  let signal: AbortSignal;
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    signal = init.signal!;
    if (stage === "headers") return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason)); } }));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new Client("fake");
  const pending = expect(client.capabilities()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  fetcher.mockImplementation(async () => json(capabilities));
  await expect(client.capabilities()).resolves.toMatchObject(capabilities);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not replay a timed out mutation and preserves its request ID for explicit retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
  vi.stubGlobal("fetch", fetcher);
  const client = new Client("fake");
  const pending = expect(client.reparse(taskId)).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(125_000);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const first = JSON.parse(fetcher.mock.calls[0][1].body as string);
  fetcher.mockImplementation(async (_path, init) => json({ ...receipt, requestId: JSON.parse(init.body as string).requestId }));
  await client.reparse(taskId);
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual(first);
});

it("bounds export body reception and cancels its reader", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/zip" } })));
  const client = new Client("fake");
  const pending = expect(client.exportBank(task)).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(600_000);
  await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("disconnect cancels a stalled response body and clears its deadline", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
  const client = new Client("fake");
  const pending = expect(client.capabilities()).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  client.disconnect();
  await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

function mockUpload(options: { existing?: boolean; badReference?: boolean; badUploadedReference?: boolean; badUrl?: boolean; networkAtCreate?: boolean } = {}) {
  let document: Record<string, unknown>;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/uploads") {
      const metadata = JSON.parse(init.body as string);
      metadata.fileName = metadata.fileName.trim();
      document = { ...metadata, objectKey: `practiq-agent/sources/${metadata.sha256}/source.${metadata.sourceType === "text" ? "txt" : metadata.sourceType}` };
      return json({ document: options.badReference ? { ...document, sha256: "0".repeat(64) } : document, upload: options.existing ? null : { method: "PUT", url: (options.badUrl ? "https://untrusted.invalid" : "") + "/api/uploads/content?" + new URLSearchParams(metadata), headers: { "Content-Type": metadata.mediaType } } });
    }
    if (path.startsWith("/api/uploads/content?")) return json(options.badUploadedReference ? { ...document, sha256: "0".repeat(64) } : Object.fromEntries(Object.entries(document).reverse()));
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
  it("uses the optional Office ceiling before hashing or HTTP and retains larger PDF limits", async () => {
    const limits = { ...capabilities, sourceMaxBytes: 100 * 1024 * 1024, officeSourceMaxBytes: 25 * 1024 * 1024 };
    const office = new File(["x"], "large.docx");
    Object.defineProperty(office, "size", { value: 25 * 1024 * 1024 + 1 });
    const read = vi.spyOn(office, "arrayBuffer"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new Client("fake").start(office, limits, taskId, () => {})).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
    expect(read).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    const pdf = new File(["x"], "large.pdf"); Object.defineProperty(pdf, "size", { value: office.size });
    expect(() => validateFiles([pdf], limits)).not.toThrow();
    const boundary = new File(["x"], "exact.xlsx"); Object.defineProperty(boundary, "size", { value: limits.officeSourceMaxBytes });
    expect(() => validateFiles([boundary], limits)).not.toThrow();
    expect(() => validateFiles([office], { ...capabilities, sourceMaxBytes: limits.sourceMaxBytes })).not.toThrow();
  });
  it("validates formats, filenames, empty files, count and authoritative size before HTTP", () => {
    expect(fileFormat(new File(["x"], "a.JPEG"))).toEqual({ sourceType: "image", mediaType: "image/jpeg" });
    expect(fileFormat(new File(["x"], "a.md"))).toEqual({ sourceType: "markdown", mediaType: "text/markdown" });
    expect(fileFormat(new File(["x"], "a.pptx"))).toEqual({ sourceType: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    expect(() => fileFormat(new File(["x"], "a.csv"))).toThrow(ApiError);
    expect(() => fileFormat(new File(["x"], "a.exe"))).toThrow(ApiError);
    expect(() => fileFormat(new File(["x"], `${"a".repeat(256)}.txt`))).toThrow(ApiError);
    expect(() => validateFiles([], capabilities)).toThrow("1–10");
    expect(() => validateFiles(Array.from({ length: 11 }, () => new File(["x"], "a.txt")), capabilities)).toThrow("1–10");
    expect(() => validateFiles([new File([], "a.txt")], capabilities)).toThrow("为空");
    expect(() => validateFiles([new File(["xx"], "a.txt")], { ...capabilities, sourceMaxBytes: 1 })).toThrow("大小限制");
    expect(() => validateFiles([new File(["x"], "a.docx")], { ...capabilities, sourceTypes: ["pdf"] })).toThrow("暂不支持");
    expect(sourceLimit({ ...capabilities, sourceMaxBytes: 101 * 1024 * 1024 })).toBe(101 * 1024 * 1024);
  });
  it("hashes exact bytes, uploads with Bearer authentication, accepts reordered fields, then creates one explicit task", async () => {
    const fetcher = mockUpload();
    const stages: string[] = [];
    const client = new Client("fake-service-token");
    await expect(client.start(new File(["hello"], "a.txt"), capabilities, taskId, stage => stages.push(stage))).resolves.toEqual(receipt);
    expect(stages).toEqual(["hashing", "uploading", "starting"]);
    expect(fetcher.mock.calls).toHaveLength(3);
    const metadata = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(metadata).toEqual({ sourceType: "text", mediaType: "text/plain", fileName: "a.txt", sizeBytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    const create = JSON.parse(fetcher.mock.calls[2][1].body as string);
    expect(create.requestId).toBe(taskId);
    expect(create.document).toMatchObject(metadata);
    expect(create).not.toHaveProperty("officeMode");
    expect(create).not.toHaveProperty("deduplicateQuestions");
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain("fake-service-token");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fake-service-token");
      expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    }
    client.disconnect();
  });
  it.each([" notes.txt", "notes.txt ", "\nnotes.txt\t"])("normalizes filename whitespace before upload and strict reference checks: %j", async name => {
    const fetcher = mockUpload();
    await expect(new Client("fake").start(new File(["hello"], name), capabilities, taskId, () => {})).resolves.toEqual(receipt);
    expect(fetcher.mock.calls).toHaveLength(3);
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toMatchObject({ fileName: "notes.txt" });
    expect(JSON.parse(fetcher.mock.calls[2][1].body as string).document).toMatchObject({ fileName: "notes.txt" });
  });
  it("skips existing binary upload and lets the server route Office automatically", async () => {
    const fetcher = mockUpload({ existing: true });
    await new Client("fake").start(new File(["office"], "a.docx"), capabilities, taskId, () => {});
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toMatchObject({ requestId: taskId, document: { sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
  });
  it.each([false, true])("sends deduplication only when explicitly enabled (%s)", async deduplicateQuestions => {
    const fetcher = mockUpload({ existing: true });
    await new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {}, deduplicateQuestions);
    const create = JSON.parse(fetcher.mock.calls[1][1].body as string);
    if (deduplicateQuestions) expect(create).toHaveProperty("deduplicateQuestions", true);
    else expect(create).not.toHaveProperty("deduplicateQuestions");
  });
  it.each([{ badReference: true }, { badUrl: true }])("rejects altered reference or external upload URL before PUT/model submission: %j", async options => {
    const fetcher = mockUpload(options);
    await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toBeInstanceOf(ApiError);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("rejects an altered uploaded reference before task creation", async () => {
    const fetcher = mockUpload({ badUploadedReference: true });
    await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    expect(fetcher.mock.calls.map(([url]) => new URL(url, location.origin).pathname)).toEqual(["/api/uploads", "/api/uploads/content"]);
  });
  it.each(["OFFICE_NOT_CONFIGURED", "TENCENT_NOT_CONFIGURED"])("identifies a pre-creation %s rejection and allows only explicit resubmission", async code => {
    const fetcher = mockUpload({ existing: true }), original = fetcher.getMockImplementation()!;
    let configured = false;
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (path === "/api/document-tasks" && !configured) return json({ detail: { code } }, 503);
      return original(path, init);
    });
    const client = new Client("fake");
    const file = new File(["hello"], "fixture.txt");
    await expect(client.start(file, capabilities, taskId, () => {})).rejects.toMatchObject({
      code, status: 503, message: expect.stringContaining("本次提交未创建任务"),
    });
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/document-tasks")).toHaveLength(1);
    configured = true;
    await expect(client.start(file, capabilities, taskId, () => {})).resolves.toEqual(receipt);
    const creates = fetcher.mock.calls.filter(([path]) => path === "/api/document-tasks");
    expect(creates).toHaveLength(2);
    expect(creates.map(([, init]) => JSON.parse(init.body as string).requestId)).toEqual([taskId, taskId]);
  });
  it("does not replay an uncertain create automatically and preserves the supplied request ID for explicit retry", async () => {
    const fetcher = mockUpload({ existing: true, networkAtCreate: true });
    const client = new Client("fake");
    const file = new File(["x"], "a.txt");
    await expect(client.start(file, capabilities, taskId, () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher.mock.calls).toHaveLength(2);
    await expect(client.start(file, capabilities, taskId, () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    const creates = fetcher.mock.calls.filter(([url]) => url === "/api/document-tasks");
    expect(creates.map(([, init]) => JSON.parse(init.body as string).requestId)).toEqual([taskId, taskId]);
  });
  it("blocks unavailable cloud parsing/model and mismatched bytes without posting", async () => {
    const fetcher = mockUpload();
    const client = new Client("fake");
    const office = new File(["x"], "a.xls");
    await expect(client.start(office, { ...capabilities, parserConfigured: false }, taskId, () => {})).rejects.toMatchObject({ code: "TENCENT_NOT_CONFIGURED" });
    await expect(client.start(office, { ...capabilities, modelConfigured: false }, taskId, () => {})).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    const file = new File(["x"], "a.txt");
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(new ArrayBuffer(2));
    await expect(client.start(file, capabilities, taskId, () => {})).rejects.toMatchObject({ code: "DOCUMENT_SIZE_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("task reads and explicit controls", () => {
  it.each([8 * 1024 * 1024, 150 * 1024 * 1024])("accepts local and COS transport ceilings: %s", async parserInputMaxBytes => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...capabilities, parserInputMaxBytes })));
    await expect(new Client("fake").capabilities()).resolves.toMatchObject({ parserInputMaxBytes });
  });
  it.each([0, -1, 3, 1.5, "8388608", 150 * 1024 * 1024 + 1])("rejects an invalid Tencent per-job limit: %s", async parserInputMaxBytes => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...capabilities, parserInputMaxBytes })));
    await expect(new Client("fake").capabilities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it.each([0, -1, 1.5, "25", 26 * 1024 * 1024])("rejects an invalid optional Office limit: %s", async officeSourceMaxBytes => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...capabilities, officeSourceMaxBytes })));
    await expect(new Client("fake").capabilities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("accepts absent or null Office limits from older or non-Office services", async () => {
    const noOffice = { ...capabilities, officeAvailable: false, officeModes: [], sourceTypes: ["text"], officeSourceMaxBytes: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(capabilities)).mockResolvedValueOnce(json(noOffice)));
    const client = new Client("fake");
    await expect(client.capabilities()).resolves.toEqual(capabilities);
    await expect(client.capabilities()).resolves.toEqual(noOffice);
  });
  it("reads capabilities/list/detail/preview and deletes using only same-origin authenticated paths", async () => {
    const fetcher = vi.fn(async (url: string) => json(url.includes("capabilities") ? capabilities : url.includes("preview") ? { units: [] } : url.includes("?") ? { items: [], hasMore: false } : { deleted: true }));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    await expect(client.capabilities()).resolves.toEqual(capabilities);
    await client.list(20, "failed"); await client.detail(taskId); await client.preview(taskId); await client.delete(taskId);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/import-capabilities", "/api/document-tasks?limit=20&offset=20&state_filter=failed", `/api/document-tasks/${taskId}`, `/api/document-tasks/${taskId}/preview`, `/api/document-tasks/${taskId}`]);
    await client.preview(taskId, undefined, false);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/document-tasks/${taskId}/preview?include_result=false`);
  });
  it("rejects malformed capability/JSON and never displays server-echoed credentials", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ...capabilities, sourceMaxBytes: -1 })).mockResolvedValueOnce(new Response("<html>wrong route</html>")).mockResolvedValueOnce(json({ detail: { code: "UNAUTHORIZED", message: "fake-secret" } }, 401));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake-secret");
    await expect(client.capabilities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.list(0)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.detail(taskId)).rejects.toMatchObject({ status: 401, message: expect.not.stringContaining("fake-secret") });
  });
  it("targets running operations by run ID, and checkpoint operations by checkpoint ID", async () => {
    const fetcher = vi.fn().mockImplementation(async (_path: string, init: RequestInit) => json({ ...receipt, requestId: JSON.parse(init.body as string).requestId }, 202)); vi.stubGlobal("fetch", fetcher);
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
  it.each([{ modelConfigured: false }, { resumeCompatible: false }])("rejects all checkpoint controls without HTTP when deployment is unavailable: %j", async change => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    const actions = ["resume", "retry_failed", "accept_partial"] as const;
    for (const action of actions) {
      await expect(client.control({ ...task, state: "WAITING_REVIEW", allowedActions: [...actions], ...change }, action)).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("submits compatible review acceptance only on explicit control", async () => {
    const fetcher = vi.fn().mockImplementation(async (_path: string, init: RequestInit) => json({ ...receipt, requestId: JSON.parse(init.body as string).requestId }, 202)); vi.stubGlobal("fetch", fetcher);
    await new Client("fake").control({ ...task, state: "WAITING_REVIEW", allowedActions: ["accept_partial"] }, "accept_partial");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ action: "accept_partial", checkpointId: task.checkpointId, runId: null });
  });
  it("reuses an uncertain control/reparse intent only when the user explicitly repeats it", async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
      if ([1, 4].includes(++attempts)) throw new TypeError("lost");
      return json({ ...receipt, requestId: JSON.parse(init.body as string).requestId }, 202);
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake"); const paused = { ...task, allowedActions: ["resume"] as const };
    await expect(client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume");
    await client.control({ ...paused, allowedActions: [...paused.allowedActions] }, "resume");
    const ids = fetcher.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(init.body as string).requestId);
    expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[1]);
    await expect(client.reparse(taskId)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await client.reparse(taskId);
    expect(JSON.parse(fetcher.mock.calls[3][1].body as string).requestId).toBe(JSON.parse(fetcher.mock.calls[4][1].body as string).requestId);
  });
  it("disconnect cancels in-flight reads and rejects new HTTP; token is never persisted", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake"); const pending = client.list(0); client.disconnect();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.list(0)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(() => new Client("\r\nsecret")).toThrow("服务访问令牌"); expect(() => new Client(" ")).toThrow("服务访问令牌");
  });
});
describe("checked private downloads", () => {
  it("reads an image by reference and verifies media, actual size and SHA before returning a blob", async () => {
    const bytes = new TextEncoder().encode("fake image");
    const reference = { objectKey: "practiq-agent/artifacts/image.png", sha256: await sha256(bytes.buffer), sizeBytes: bytes.length, mediaType: "image/png" };
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "image/png" } })); vi.stubGlobal("fetch", fetcher);
    const blob = await new Client("fake").image(reference, taskId);
    expect(blob.size).toBe(bytes.length); expect(blob.type).toBe("image/png");
    expect(fetcher.mock.calls[0][0]).toBe(`/api/artifacts/read?thread_id=${taskId}`); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(reference);
  });
  it("rejects SVG, altered bytes, oversized streams and mismatched media", async () => {
    const reference = { objectKey: "managed.png", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "image/png" };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png" } })).mockResolvedValueOnce(new Response("xx", { headers: { "Content-Type": "image/png" } })).mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/jpeg" } })).mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": "2" } }));
    vi.stubGlobal("fetch", fetcher); const client = new Client("fake");
    await expect(client.image({ ...reference, mediaType: "image/svg+xml" }, taskId)).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(client.image(reference, taskId)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
    await expect(client.image(reference, taskId)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(client.image(reference, taskId)).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
    await expect(client.image(reference, taskId)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
  it("exports only completed visible checkpoint ZIPs with auth and a safe local filename", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("PKfake", { headers: { "Content-Type": "application/zip" } })).mockResolvedValueOnce(new Response("html", { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(json({ detail: { code: "STALE_CHECKPOINT" } }, 409)); vi.stubGlobal("fetch", fetcher);
    const client = new Client("fake");
    const exported = await client.exportBank(task);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/document-tasks/${taskId}/export?checkpoint_id=checkpoint-one&scope=full`);
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
  it.each(["declared size", "content type", "error response"] as const)("cancels unread response bodies rejected for %s", async failure => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: failure === "error response" ? 503 : 200,
      headers: { "Content-Type": failure === "content type" ? "text/html" : "application/zip", "Content-Length": failure === "content type" ? "1" : String(MAX_BANK_ZIP_BYTES + 1) },
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(new Client("fake").exportBank(task)).rejects.toMatchObject({ code: failure === "declared size" ? "RESPONSE_TOO_LARGE" : failure === "content type" ? "INVALID_RESPONSE" : "HTTP_503" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
});


it.each([
  ["read", "/api/import-capabilities", 503, "DATABASE_UNAVAILABLE", /读取失败/],
  ["write", "/api/document-tasks/example/reparse", 503, "SERVER_UNAVAILABLE", /操作结果尚未确认/],
  ["read", "/api/import-capabilities", 429, "TOO_MANY_REQUESTS", /过于频繁/],
  ["write", "/api/document-tasks/example/reparse", 409, "STALE_RUN", /任务状态已更新/],
])("gives actionable safe feedback for %s %s", async (kind, _path, status, code, message) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code, message: "secret remote diagnostics" } }), { status: status as number })));
  const client = new Client("fake");
  const result = kind === "write" ? client.reparse(taskId) : client.capabilities();
  await expect(result).rejects.toThrow(message as RegExp);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["metadata", "content"] as const)("offers upload retry when %s transport fails without starting a task", async stage => {
  const fetcher = mockUpload(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (stage === "metadata" ? path === "/api/uploads" : path.startsWith("/api/uploads/content?")) throw new TypeError("Connection lost");
    return original(path, init);
  });
  await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toThrow("重试上传");
  expect(fetcher.mock.calls.some(([path]) => path === "/api/document-tasks")).toBe(false);
});
it.each(["metadata", "content"] as const)("offers upload retry when %s returns a server error without starting a task", async stage => {
  const fetcher = mockUpload(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (stage === "metadata" ? path === "/api/uploads" : path.startsWith("/api/uploads/content?")) return json({ detail: { code: "UPLOAD_STORAGE_UNAVAILABLE" } }, 503);
    return original(path, init);
  });
  await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toThrow("重试上传");
  expect(fetcher.mock.calls.some(([path]) => path === "/api/document-tasks")).toBe(false);
});
it.each(["metadata", "content"] as const)("offers upload retry when %s times out without starting a task", async stage => {
  vi.useFakeTimers();
  const fetcher = mockUpload(), original = fetcher.getMockImplementation()!;
  let stalled = false;
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (stage === "metadata" ? path === "/api/uploads" : path.startsWith("/api/uploads/content?")) {
      stalled = true;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    return original(path, init);
  });
  const pending = expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toThrow("上传超时");
  await vi.waitFor(() => expect(stalled).toBe(true));
  await vi.advanceTimersByTimeAsync(125_000); await pending;
  expect(fetcher.mock.calls.some(([path]) => path === "/api/document-tasks")).toBe(false);
});
it.each(["network", "server", "timeout"] as const)("treats POST artifact reads as passive when %s fails", async failure => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (failure === "network") throw new TypeError("Connection lost");
    if (failure === "server") return json({ detail: { code: "ARTIFACT_UNAVAILABLE" } }, 503);
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  });
  vi.stubGlobal("fetch", fetcher);
  const reference = { objectKey: "managed.png", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "image/png" };
  const pending = expect(new Client("fake").image(reference, taskId)).rejects.toThrow(/重试读取/);
  if (failure === "timeout") await vi.advanceTimersByTimeAsync(125_000);
  await pending;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].method).toBe("POST");
});

it("reuses an uncertain source intent by verified content when caller changes the request ID", async () => {
  const fetcher = mockUpload({ networkAtCreate: true }); const client = new Client("fake");
  for (const id of [taskId, runId]) await expect(client.start(new File(["same"], "same.txt"), capabilities, id, () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  const creates = fetcher.mock.calls.filter(call => call[0] === "/api/document-tasks");
  expect(creates).toHaveLength(2);
  expect(JSON.parse(creates[0][1].body as string)).toEqual(JSON.parse(creates[1][1].body as string));
});

it("recovers a create after reload with its original request and options without persisting credentials", async () => {
  const fetcher = mockUpload({ networkAtCreate: true });
  const first = new Client("private-token");
  await expect(first.start(new File(["same"], "same.txt"), capabilities, taskId, () => {}, true)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  first.disconnect();
  const restored = new Client("private-token");
  expect(restored.pendingImports()).toHaveLength(1);
  expect(JSON.stringify(localStorage)).not.toContain("private-token");
  const original = restored.pendingImports()[0];
  fetcher.mockImplementation(async (_path, init) => json({ ...receipt, requestId: JSON.parse(init.body as string).requestId }, 202));
  await restored.retryImport(original.requestId);
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string)).toEqual(original);
  expect(restored.pendingImports()).toEqual([]);
});

it("refuses a new create when recovery metadata cannot be saved", async () => {
  const fetcher = mockUpload({ existing: true });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  await expect(new Client("fake").start(new File(["x"], "a.txt"), capabilities, taskId, () => {})).rejects.toMatchObject({ code: "RECOVERY_STORAGE_UNAVAILABLE" });
  expect(fetcher.mock.calls.some(([url]) => url === "/api/document-tasks")).toBe(false);
});

it("persists only verified file metadata even if an upload response has extra fields", async () => {
  const fetcher = mockUpload({ existing: true, networkAtCreate: true });
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (path, init) => {
    const response = await original(path, init);
    if (path !== "/api/uploads") return response;
    const prepared = await response.json();
    return json({ ...prepared, document: { ...prepared.document, secret: "must-not-persist" } });
  });
  const client = new Client("private-token");
  await expect(client.start(new File(["same"], "same.txt"), capabilities, taskId, () => {})).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  expect(client.pendingImports()).toHaveLength(1);
  expect(JSON.stringify(localStorage)).not.toContain("must-not-persist");
});

it.each(["not JSON", "{}", '[{}]', '[{"requestId":"bad"}]'])("rejects malformed recovery metadata without posting: %s", raw => {
  localStorage.setItem("practiq-import-intents-v1", raw);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect(() => new Client("fake").pendingImports()).toThrow("原提交恢复记录");
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.getItem("practiq-import-intents-v1")).toBe(raw);
});

it("reselecting a pending source after reload keeps the original deduplication option", async () => {
  const fetcher = mockUpload({ networkAtCreate: true });
  const file = new File(["same"], "same.txt");
  await expect(new Client("fake").start(file, capabilities, taskId, () => {}, true)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  await expect(new Client("fake").start(file, capabilities, runId, () => {}, false)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  const bodies = fetcher.mock.calls.filter(([url]) => url === "/api/document-tasks").map(([, init]) => JSON.parse(init.body as string));
  expect(bodies[1]).toEqual(bodies[0]);
  const client = new Client("fake"); client.forgetImport(taskId);
  expect(client.pendingImports()).toEqual([]);
});

it.each([{ limit: -1, unitCalls: 4, contextUnitCalls: 8 }, { limit: 400, unitCalls: 0, contextUnitCalls: 8 }, { limit: 400, unitCalls: 4, contextUnitCalls: 1.5 }])("rejects invalid model capacity: %s", async modelBudget => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...capabilities, modelBudget })));
  await expect(new Client("fake").capabilities()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it.each([null, {}, { ...receipt, requestId: runId }, { ...receipt, accepted: "yes" }, { ...receipt, accepted: false }, { ...receipt, runId: null }, { ...receipt, runId: undefined }])("retains the original intent when a creation receipt is invalid: %s", async invalid => {
  const upload = mockUpload(); const bodies: unknown[] = []; let fail = true;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    if (path !== "/api/document-tasks") return upload(path, init);
    const body = JSON.parse(init.body as string); bodies.push(body);
    if (fail) { fail = false; return json(invalid); }
    return json({ ...receipt, requestId: body.requestId });
  }));
  const client = new Client("fake"); const file = new File(["source"], "source.txt");
  await expect(client.start(file, capabilities, taskId, () => {})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(client.start(file, capabilities, runId, () => {})).resolves.toMatchObject({ requestId: taskId });
  expect(bodies[0]).toEqual(bodies[1]);
});

it.each(["reparse", "resume"] as const)("retains an uncertain %s intent after incomplete success receipts", async action => {
  const invalid = [{}, { ...receipt, accepted: false }, { ...receipt, runId: null }];
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); bodies.push(body);
    return json(bodies.length <= invalid.length ? { ...invalid[bodies.length - 1], requestId: body.requestId } : { ...receipt, requestId: body.requestId });
  }));
  const client = new Client("fake");
  const perform = () => action === "reparse" ? client.reparse(taskId) : client.control({ ...task, allowedActions: ["resume"] }, "resume");
  for (let attempt = 0; attempt < invalid.length; attempt++) await expect(perform()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(bodies).toHaveLength(invalid.length);
  await expect(perform()).resolves.toHaveProperty("requestId", bodies[0].requestId);
  expect(bodies).toHaveLength(invalid.length + 1); for (const body of bodies) expect(body).toEqual(bodies[0]);
});

it.each([null, {}, { deleted: false }, { deleted: "true" }])("does not confirm task deletion from a malformed or negative success receipt: %s", async value => {
  vi.stubGlobal("fetch", vi.fn(async () => json(value)));
  await expect(new Client("fake").delete(taskId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it.each(["image", "evidence"] as const)("cancels view-owned %s reads during headers and body, without disconnecting or retrying", async kind => {
  vi.useFakeTimers();
  const bytes = new TextEncoder().encode("x");
  const reference = { objectKey: "managed", sha256: await sha256(bytes.buffer), sizeBytes: bytes.length, mediaType: kind === "image" ? "image/png" : "text/plain" };
  const client = new Client("fake");
  for (const stage of ["headers", "body"]) {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => stage === "headers"
      ? new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
      : response);
    vi.stubGlobal("fetch", fetcher);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const pending = expect(client[kind](reference, taskId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await pending;
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(stage === "body" ? 1 : 0);
    expect(response.body?.locked).toBe(false);
    expect(digest).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    digest.mockRestore();
  }
  expect(client.active).toBe(true);
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { "Content-Type": reference.mediaType } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(client[kind](reference, taskId, new AbortController().signal)).resolves.toMatchObject({ size: 1 });
  await expect(client[kind](reference, taskId, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["image", "evidence"] as const)("retains %s MIME, byte and hash checks with a view signal", async kind => {
  const bytes = new TextEncoder().encode("x");
  const reference = { objectKey: "managed", sha256: await sha256(bytes.buffer), sizeBytes: 1, mediaType: kind === "image" ? "image/png" : "text/plain" };
  const client = new Client("fake");
  const signal = new AbortController().signal;
  for (const [body, mediaType, code] of [
    ["x", "text/html", "ARTIFACT_CHECKSUM_MISMATCH"],
    ["", reference.mediaType, "ARTIFACT_CHECKSUM_MISMATCH"],
    ["xx", reference.mediaType, "RESPONSE_TOO_LARGE"],
    ["y", reference.mediaType, "ARTIFACT_CHECKSUM_MISMATCH"],
  ]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "Content-Type": mediaType } })));
    await expect(client[kind](reference, taskId, signal)).rejects.toMatchObject({ code });
  }
});
