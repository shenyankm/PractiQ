import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { capabilities, newTaskId, preview, question, runId, summary, task, taskId } from "./test-fixtures";
import type { DocumentTaskDetail } from "./contracts.generated";

beforeEach(() => window.history.replaceState(null, "", "/"));

it("explains unknown model outcomes next to explicit recovery controls", async () => {
  const http = fakeHTTP({ ...task, state: "INTERRUPTED", status: null, result: null, failures: [], blocking: ["MODEL_RESULT_UNKNOWN"], allowedActions: ["resume"] });
  const user = userEvent.setup(); render(<App />); await connect(user);
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  expect(await screen.findByText(/模型请求已发送，但结果尚未确认/)).toBeTruthy();
  expect(screen.getByText(/继续解析或重试可能再次计费/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续解析" }).hasAttribute("disabled")).toBe(false);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("offers original submission recovery after remount without automatically posting", async () => {
  const http = fakeHTTP(); const user = userEvent.setup();
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST") throw new TypeError("lost"); };
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), new File(["same"], "same.txt"));
  await user.click(screen.getByRole("checkbox", { name: "自动去重" }));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试原提交" });
  const original = http.calls.find(call => call.url === "/api/document-tasks" && call.method === "POST")!.body;
  cleanup(); render(<App />); await connect(user);
  await screen.findByRole("button", { name: "重试原提交" });
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  http.server.intercept = undefined;
  await user.click(screen.getByRole("button", { name: "重试原提交" }));
  await screen.findByText("原提交已确认，正在读取服务端任务。");
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST").map(call => call.body)).toEqual([original, original]);
  expect(screen.queryByRole("button", { name: "重试原提交" })).toBeNull();
});

it("offers an uncertain reparse after remount without replaying it and recovers the original request", async () => {
  const http = fakeHTTP(); const user = userEvent.setup();
  http.server.intercept = url => { if (url.endsWith("/reparse")) throw new TypeError("lost receipt"); };
  render(<App />); await connect(user); await openTask(user);
  await user.click(screen.getByText("其他任务操作"));
  await user.click(screen.getByRole("button", { name: "重新解析为新任务" }));
  const recovery = await screen.findByRole("region", { name: "未确认的重新解析" });
  const original = http.calls.find(call => call.url.endsWith("/reparse"))!;
  expect(within(recovery).getByText(`原重新解析请求 ID：${original.body!.requestId}`)).toBeTruthy();
  cleanup(); render(<App />); await connect(user);
  await screen.findByRole("region", { name: "未确认的重新解析" });
  expect(http.calls.filter(call => call.url.endsWith("/reparse"))).toHaveLength(1);
  expect(JSON.stringify(localStorage)).not.toContain("fake-service-token");
  http.server.intercept = undefined;
  await user.click(screen.getByRole("button", { name: "重试原重新解析" }));
  await screen.findByText("原重新解析请求已确认，正在读取服务端任务。");
  expect(await screen.findByRole("heading", { name: "reparsed.docx", level: 2 })).toBeTruthy();
  expect(http.calls.filter(call => call.url.endsWith("/reparse")).map(call => call.body)).toEqual([original.body, original.body]);
  expect(screen.queryByRole("region", { name: "未确认的重新解析" })).toBeNull();
});

it("lets a user inspect the original task and explicitly clear a reparse hint without submitting", async () => {
  localStorage.setItem("practiq-reparse-intents-v1", JSON.stringify([{ threadId: taskId, requestId: runId }]));
  const http = fakeHTTP(); const user = userEvent.setup();
  render(<App />); await connect(user);
  await user.click(await screen.findByRole("button", { name: "查看原任务" }));
  expect(await screen.findByRole("heading", { name: "sample.docx", level: 2 })).toBeTruthy();
  expect(screen.getByText(/再次重新解析会视为新请求，可能重复计费/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "已核对，清除重新解析记录" }));
  await screen.findByText("本机重新解析恢复记录已清除，服务端任务不受影响。");
  expect(screen.queryByRole("region", { name: "未确认的重新解析" })).toBeNull();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
  expect(localStorage.getItem("practiq-reparse-intents-v1")).toBeNull();
});

it("retains malformed reparse hints and blocks a new reparse without HTTP", async () => {
  localStorage.setItem("practiq-reparse-intents-v1", '[{"threadId":"bad"}]');
  const http = fakeHTTP(); const user = userEvent.setup();
  render(<App />); await connect(user);
  expect(await screen.findByText(/无法读取本机的重新解析恢复记录/)).toBeTruthy();
  await openTask(user); await user.click(screen.getByText("其他任务操作"));
  await user.click(screen.getByRole("button", { name: "重新解析为新任务" }));
  await screen.findByText(/无法读取本机的重新解析恢复记录/);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
  expect(localStorage.getItem("practiq-reparse-intents-v1")).toBe('[{"threadId":"bad"}]');
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("shows uncertain Tencent submission and saved jobs without automatically retrying", async () => {
  const detail: DocumentTaskDetail = { ...task, state: "FAILED", status: null, result: null, allowedActions: ["resume"], parserJobs: [
    { taskId: null, requestId: null, status: "SUBMITTING", resultSaved: false },
    { taskId: "cloud-job-known", requestId: "request-known", queryRequestId: "query-known", errorCode: "UnsupportedFile", statusUpdatedAt: "2026-10-20T00:00:00Z", status: "Success", successPageCount: 3, failedPageCount: 0, resultSaved: true },
  ] };
  const http = fakeHTTP(detail); const user = userEvent.setup();
  render(<App />); await connect(user);
  await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  expect(await screen.findByText(/上次腾讯提交结果尚未确认/)).toBeTruthy();
  expect(screen.getByText(/腾讯文档识别：已保存 1 个任务结果 · 处理中 0 个任务/)).toBeTruthy();
  await user.click(screen.getByText("模型用量与任务诊断"));
  expect(screen.getByText(/"taskId": "cloud-job-known"/)).toBeTruthy();
  expect(screen.getByText(/"queryRequestId": "query-known"/)).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});
type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
function fakeHTTP(initial: DocumentTaskDetail = task) {
  const calls: Call[] = [];
  const records = new Map([[initial.threadId, structuredClone(initial)]]);
  let document: Record<string, unknown>;
  const server: { intercept?: (url: string, init: RequestInit) => Promise<Response | undefined> | Response | undefined } = {};
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, auth: new Headers(init.headers).get("Authorization") });
    const intercepted = await server.intercept?.(url, init); if (intercepted) return intercepted;
    const path = new URL(url, location.origin).pathname;
    if (path === "/api/import-capabilities") return json(capabilities);
    if (path === "/api/import-settings") return json({ revision: taskId, settings: { tencentConcurrency: 5, readRetryCount: 2, retryBaseSeconds: 1 } });
    if (path === "/api/document-tasks" && method === "GET") return json({ items: Array.from(records.values()).map(current => ({ ...summary, threadId: current.threadId, fileName: current.fileName, state: current.state, checkpointId: current.checkpointId, status: current.status })), hasMore: new URL(url, location.origin).searchParams.get("offset") === "0" });
    if (path === "/api/uploads") { document = { ...body, objectKey: `practiq-agent/sources/${body.sha256}/source.${body.sourceType === "text" ? "txt" : body.sourceType}` }; return json({ document, upload: { method: "PUT", url: "/api/uploads/content?" + new URLSearchParams(body), headers: { "Content-Type": body.mediaType } } }); }
    if (path === "/api/uploads/content") return json(document);
    if (path === "/api/document-tasks" && method === "POST") { records.set(newTaskId, { ...task, threadId: newTaskId, fileName: body.document.fileName }); return json({ threadId: newTaskId, requestId: body.requestId, runId, accepted: true }, 202); }
    const id = path.split("/")[3]; const current = records.get(id);
    if (path.includes("/preview")) return json({ ...preview, units: new URL(url, location.origin).searchParams.get("include_result") === "false" && current?.result?.questions.length ? preview.units.filter(unit => unit.stage !== "result") : preview.units, threadId: id, checkpointId: current?.checkpointId, state: current?.state });
    if (path.endsWith("/export")) return new Response("PKfake", { headers: { "Content-Type": "application/zip" } });
    if (path.endsWith("/control")) { records.set(id, { ...current!, state: body.action === "pause" ? "PAUSED" : "RUNNING", runId, allowedActions: body.action === "pause" ? ["resume"] : ["pause", "interrupt"] }); return json({ threadId: id, requestId: body.requestId, runId, accepted: true }, 202); }
    if (path.endsWith("/reparse")) { records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "reparsed.docx", parentThreadId: id, state: "PENDING", phase: "pending", checkpointId: null, result: null }); return json({ threadId: newTaskId, requestId: body.requestId, runId, accepted: true }, 202); }
    if (method === "DELETE") { records.delete(id); return json({ deleted: true }); }
    return json(current);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, records, server, fetcher };
}
async function connect(user: ReturnType<typeof userEvent.setup>) { await user.click(screen.getByRole("link", { name: "开始导入" })); await user.type(screen.getByLabelText("服务访问令牌"), "fake-service-token"); await user.click(screen.getByRole("button", { name: "连接服务" }));
  await screen.findByText(/^服务支持：/);
}
async function openTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await screen.findByRole("heading", { name: "sample.docx", level: 2 });
  await screen.findByText("根据材料选择答案");
}

it("recovers polling after a hung read and backs off repeated failures without mutations", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  render(<App />); await connect(user); await user.click(screen.getByRole("link", { name: "导入记录" })); await screen.findByRole("button", { name: "sample.docx" });
  vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
  let attempts = 0;
  http.server.intercept = (url, init) => {
    if (!url.startsWith("/api/document-tasks?")) return;
    attempts++;
    if (attempts === 1) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    if (attempts <= 3) return json({ detail: { code: "TASK_SERVICE_UNAVAILABLE" } }, 503);
  };
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByText(/请求超时/)).toBeTruthy();
  expect(attempts).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(2700));
  expect(attempts).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(5399));
  expect(attempts).toBe(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(attempts).toBe(3);
  await act(async () => vi.advanceTimersByTimeAsync(10_800));
  expect(attempts).toBe(4);
  expect(screen.getByRole("button", { name: "sample.docx" })).toBeTruthy();
  expect(http.calls.every(call => call.method === 'GET')).toBe(true);
});

it("keeps Token in memory, clears it on remount, and performs no HTTP before connect", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); const persist = vi.spyOn(Storage.prototype, "setItem"); render(<App />);
  expect(screen.getByText(/令牌仅保存在本页内存，刷新后需重填/)).toBeTruthy();
  expect(http.calls.length === 0).toBe(true);
  await connect(user);
  const rules = screen.getByText("格式与导入规则", { selector: "summary" });
  expect(rules.closest("details")?.open).toBe(false);
  expect(screen.getByText("服务支持：PDF、TXT、Markdown、PNG/JPEG、Word (.doc)、Word (.docx)、PPT (.ppt)、PPT (.pptx)、Excel (.xls)、Excel (.xlsx)").closest("details")).toBeNull();
  await user.click(rules);
  expect(rules.closest("details")?.open).toBe(true);
  expect(screen.getByText("服务支持：PDF、TXT、Markdown、PNG/JPEG、Word (.doc)、Word (.docx)、PPT (.ppt)、PPT (.pptx)、Excel (.xls)、Excel (.xlsx)")).toBeTruthy();
  expect(screen.queryByLabelText("服务访问令牌")).toBeNull(); expect(persist).not.toHaveBeenCalled();
  expect(http.calls.every(call => call.auth === "Bearer fake-service-token" && !call.url.includes("fake-service-token") && call.method === "GET")).toBe(true);
  expect(screen.queryByRole("button", { name: "断开连接" })).toBeNull();
  expect(screen.getByText("服务已连接")).toBeTruthy();
  cleanup(); render(<App />); expect((screen.getByLabelText("服务访问令牌") as HTMLInputElement).value).toBe("");
  const count = http.calls.length; vi.useFakeTimers(); await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(http.calls).toHaveLength(count);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
it("selection is passive; explicit Start performs bounded SHA upload and task creation", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user);
  expect(screen.getByText(/开始后将调用 AI，可能产生费用/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "自动去重" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("仅合并完全相同的题目或题组")).toBeTruthy();
  expect((screen.getByLabelText("选择文档") as HTMLInputElement).accept).not.toContain(".csv");
  expect(screen.queryByLabelText("Word / Excel 转换模式")).toBeNull();
  await user.upload(screen.getByLabelText("选择文档"), new File(["office"], "document.docx"));
  expect(screen.getByText(/尚未提交/)).toBeTruthy(); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "开始导入" })); await screen.findByText(/任务已创建。/);
  const mutations = http.calls.filter(call => call.method !== "GET"); expect(mutations.map(call => call.method)).toEqual(["POST", "PUT", "POST"]);
  expect(mutations[0].body).toMatchObject({ sourceType: "docx", sizeBytes: 6 });
  expect(mutations[2].body).toMatchObject({ graphId: "document_parser" });
  expect(mutations[2].body).not.toHaveProperty("officeMode");
  expect(mutations[2].body).not.toHaveProperty("deduplicateQuestions");
  expect(mutations[2].body?.requestId).toMatch(/^[a-f0-9-]{36}$/);
});
it.each(["OFFICE_NOT_CONFIGURED", "TENCENT_NOT_CONFIGURED"])("shows a definite %s rejection and lets the user retry after configuration is fixed", async code => {
  const user = userEvent.setup(); const http = fakeHTTP(); let configured = false;
  http.server.intercept = (url, init) => url === "/api/document-tasks" && init.method === "POST" && !configured ? json({ detail: { code } }, 503) : undefined;
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), new File(["office"], "document.docx"));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  expect(await screen.findByText(/本次提交未创建任务/)).toBeTruthy();
  expect(screen.queryByText(/操作结果尚未确认|不要重复提交/)).toBeNull();
  const retry = screen.getByRole("button", { name: "重试开始" });
  expect(http.records.has(newTaskId)).toBe(false);
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  configured = true;
  await user.click(retry); await screen.findByText(/任务已创建。/);
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates).toHaveLength(2); expect(creates[0].body).toEqual(creates[1].body);
  expect(http.records.has(newTaskId)).toBe(true);
});
it.each([false, true])("never automatically replays uncertain POST, and an explicit retry retains the request and import options (%s)", async deduplicateQuestions => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  let rejectCreate!: () => void;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; return new Promise((_, reject) => { rejectCreate = () => reject(new TypeError("lost reply")); }); } };
  render(<App />); await connect(user); await user.upload(screen.getByLabelText("选择文档"), new File(["office"], "document.docx"));
  const dedup = screen.getByRole("checkbox", { name: "自动去重" }) as HTMLInputElement;
  if (deduplicateQuestions) await user.click(dedup);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await waitFor(() => expect(rejectCreate).toBeDefined()); expect(dedup.disabled).toBe(true);
  await act(async () => rejectCreate()); const retry = await screen.findByRole("button", { name: "重试开始" });
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  expect(screen.queryByLabelText("Word / Excel 转换模式")).toBeNull();
  expect(dedup.disabled).toBe(true); expect(dedup.checked).toBe(deduplicateQuestions);
  await user.click(dedup); expect(dedup.checked).toBe(deduplicateQuestions);
  await user.click(retry); await screen.findByText(/任务已创建。/);
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST"); expect(creates).toHaveLength(2); expect(creates[0].body).toEqual(creates[1].body);
  if (deduplicateQuestions) expect(creates[0].body).toHaveProperty("deduplicateQuestions", true);
  else expect(creates[0].body).not.toHaveProperty("deduplicateQuestions");
});
it("uses service limits and configuration before starting, and keeps provider settings out of the browser", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); http.server.intercept = url => url.includes("capabilities") ? json({ ...capabilities, sourceMaxBytes: 1, modelConfigured: false, parserConfigured: false, officeAvailable: false, officeModes: [], sourceTypes: ["text"] }) : undefined;
  render(<App />); await connect(user); expect(screen.getByText("服务支持：TXT")).toBeTruthy(); expect(screen.getByText("腾讯文档识别尚未配置，当前无法开始新的文档导入。")).toBeTruthy(); await user.upload(screen.getByLabelText("选择文档"), new File(["xx"], "large.txt")); expect(await screen.findByText(/为空或超过/)).toBeTruthy();
  await user.upload(screen.getByLabelText("选择文档"), new File(["x"], "small.txt")); expect((screen.getByRole("button", { name: "开始导入" }) as HTMLButtonElement).disabled).toBe(true);
  await openTask(user); expect((screen.getByRole("button", { name: "重新解析为新任务" }) as HTMLButtonElement).disabled).toBe(false); // Existing task exposes its own current configuration.
  expect(screen.queryByLabelText(/API Key|模型密钥/)).toBeNull(); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});
it("displays the source-specific Office ceiling alongside the configured general ceiling", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = url => url.includes("capabilities") ? json({ ...capabilities, sourceMaxBytes: 100 * 1024 * 1024, officeSourceMaxBytes: 25 * 1024 * 1024 }) : undefined;
  render(<App />); await connect(user);
  expect(screen.getByText(/每个 ≤ 100.0 MiB · Word \/ Excel ≤ 25.0 MiB/)).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});
it("polling paused/partial checkpoints only reads; resume/retry/pause require explicit clicks", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "PAUSED", phase: "chunk_review", allowedActions: ["resume", "retry_failed", "accept_partial"] }); render(<App />); await connect(user); await openTask(user);
  expect(screen.getByRole("button", { name: "重试失败单元" })).toBeTruthy(); expect(screen.getByRole("button", { name: "接受部分结果" })).toBeTruthy();
  await user.click(screen.getByText("模型用量与任务诊断")); expect(screen.getByText(/实际总用量未知/)).toBeTruthy(); expect(screen.getByText(/输入 21 tokens，输出 8 tokens/)).toBeTruthy();
  vi.useFakeTimers(); await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(http.calls.every(call => call.method === "GET")).toBe(true); vi.useRealTimers();
  const previews = http.calls.filter(call => call.url.includes("/preview")).length;
  await user.click(screen.getByRole("button", { name: "继续解析" })); await screen.findByRole("button", { name: "暂停" });
  expect(http.calls.filter(call => call.url.includes("/preview"))).toHaveLength(previews + 1);
  expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(0);
  const resume = http.calls.find(call => call.url.endsWith("/control")); expect(resume?.body).toMatchObject({ action: "resume", runId: null, checkpointId: "checkpoint-one", units: [] });
  await user.click(screen.getByRole("button", { name: "暂停" })); await screen.findByRole("button", { name: "继续解析" });
  expect(http.calls.filter(call => call.url.endsWith("/control")).at(-1)?.body).toMatchObject({ action: "pause", runId, checkpointId: null });
});
it.each([{ modelConfigured: false }, { resumeCompatible: false }])("disables advertised review acceptance for unavailable deployments: %j", async change => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "WAITING_REVIEW", allowedActions: ["accept_partial", "retry_failed"], ...change });
  render(<App />); await connect(user); await openTask(user);
  for (const name of ["接受部分结果", "重试失败单元"]) {
    const button = screen.getByRole("button", { name });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
  }
  expect(screen.getByText(/继续、重试和接受部分结果暂不可用/)).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});
it("submits compatible review acceptance only after an explicit click", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "WAITING_REVIEW", allowedActions: ["accept_partial"] });
  render(<App />); await connect(user); await openTask(user);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
  const button = screen.getByRole("button", { name: "接受部分结果" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  await user.click(button);
  await screen.findByRole("button", { name: "暂停" });
  expect(http.calls.filter(call => call.url.endsWith("/control"))).toHaveLength(1);
  expect(http.calls.find(call => call.url.endsWith("/control"))?.body).toMatchObject({ action: "accept_partial", checkpointId: task.checkpointId });
});
it("recovers failed task/capability reads and ignores obsolete pages after a filter change", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let failList = true, failCap = true, capReads = 0;
  http.server.intercept = url => {
    if (url.includes("capabilities")) {
      capReads++;
      if (failCap) { failCap = false; return json({ detail: { code: "SERVICE_UNAVAILABLE" } }, 503); }
    }
    if (url.startsWith("/api/document-tasks?") && failList) { failList = false; return json({ detail: { code: "TASK_SERVICE_UNAVAILABLE" } }, 503); }
  };
  render(<App />); await user.type(screen.getByLabelText("服务访问令牌"), "fake-service-token"); await user.click(screen.getByRole("button", { name: "连接服务" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("服务访问令牌")).toHaveProperty("value", "fake-service-token");
  expect(screen.queryByLabelText("选择文档")).toBeNull();
  await user.click(screen.getByRole("button", { name: "连接服务" })); await screen.findByText(/^服务支持：/);
  expect(capReads).toBe(2);
  await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "重试任务列表" })); await screen.findByRole("button", { name: "sample.docx" });
  let release!: (response: Response) => void;
  http.server.intercept = url => { if (url.includes("offset=20")) return new Promise(resolve => { release = resolve; }); if (url.includes("state_filter=failed")) return json({ items: [{ ...summary, threadId: newTaskId, fileName: "current-failed.pdf" }], hasMore: false }); };
  await user.click(screen.getByRole("button", { name: "下一页任务" })); await waitFor(() => expect(release).toBeTypeOf("function"));
  await user.selectOptions(screen.getByLabelText("筛选任务状态"), "failed"); await screen.findByRole("button", { name: /current-failed.pdf/ });
  await act(async () => release(json({ items: [summary], hasMore: false }))); expect(screen.queryByRole("button", { name: "sample.docx" })).toBeNull(); expect(http.calls.at(-1)?.url).toContain("offset=0&state_filter=failed");
  await user.click(screen.getByRole("button", { name: "刷新任务列表" })); await screen.findByRole("button", { name: /current-failed.pdf/ });
});
it("disables checkpoint actions when detail/preview reads fail or disagree, then recovers explicitly", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "PAUSED", allowedActions: ["resume"], canExportCompleted: true }); let failDetail = true, failPreview = true;
  http.server.intercept = url => { if (url.endsWith(`/${taskId}`) && failDetail) { failDetail = false; return json({}, 503); } if (url.includes("/preview") && failPreview) { failPreview = false; return json({}, 503); } };
  render(<App />); await connect(user); await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await screen.findByRole("button", { name: "重试任务详情" }); await screen.findByRole("button", { name: "重试检查点预览" });
  http.server.intercept = url => url.includes("/preview") ? json({ ...preview, checkpointId: "different-checkpoint" }) : undefined;
  await user.click(screen.getByRole("button", { name: "重试任务详情" })); await screen.findByRole("button", { name: "继续解析" }); expect((screen.getByRole("button", { name: "继续解析" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "下载题库 ZIP" }) as HTMLButtonElement).disabled).toBe(true);
  http.server.intercept = undefined; await user.click(screen.getByRole("button", { name: "刷新任务详情" })); await waitFor(() => expect((screen.getByRole("button", { name: "继续解析" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("button", { name: "下载题库 ZIP" }) as HTMLButtonElement).disabled).toBe(false);
  http.server.intercept = url => url.endsWith("/control") ? json({ detail: { code: "STALE_CHECKPOINT" } }, 409) : undefined;
  await user.click(screen.getByRole("button", { name: "继续解析" })); expect(await screen.findByText(/STALE_CHECKPOINT/)).toBeTruthy();
});
it.each([false, true])("explains partial export requirements without bypassing readiness (%s)", async canExportCompleted => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "PAUSED", result: null, canExportCompleted });
  render(<App />); await connect(user); await openTask(user);
  expect(screen.getByText("暂停后可下载已完成题目，需有可用题目且检查点一致。")).toBeTruthy();
  expect((screen.getByRole("button", { name: "下载题库 ZIP" }) as HTMLButtonElement).disabled).toBe(!canExportCompleted);
  expect(http.calls.every(call => call.method === "GET" && !call.url.includes("/export?"))).toBe(true);
});
it("exports the current partial checkpoint via authenticated ZIP GET and never starts a model", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bank"); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<App />); await connect(user); await openTask(user);
  expect(screen.queryByText("筛选仅影响显示，导出仍包含全部已完成题目。")).toBeNull();
  await user.type(screen.getByRole("searchbox", { name: "搜索解析题目" }), "absent");
  expect(screen.getByText("显示 0 / 3 条记录")).toBeTruthy();
  expect(screen.getByText("筛选仅影响显示，导出仍包含全部已完成题目。")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "清除结果筛选" }));
  expect(screen.queryByText("筛选仅影响显示，导出仍包含全部已完成题目。")).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "仅看需要复核" }));
  expect(screen.getByText("筛选仅影响显示，导出仍包含全部已完成题目。")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下载题库 ZIP" })); await screen.findByText(/题库 ZIP 已下载/);
  expect(http.calls.find(call => call.url.includes("/export?"))).toMatchObject({ method: "GET", auth: "Bearer fake-service-token", url: `/api/document-tasks/${taskId}/export?checkpoint_id=checkpoint-one&scope=full` });
  expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});
it("creates a reparse task only on explicit action and confirms deletion before HTTP", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user); await openTask(user);
  await user.click(screen.getByRole("button", { name: "删除任务" })); expect(http.calls.some(call => call.method === "DELETE")).toBe(false); await user.click(screen.getByRole("button", { name: "保留任务" }));
  await user.click(screen.getByRole("button", { name: "重新解析为新任务" })); await screen.findByRole("heading", { name: "reparsed.docx", level: 2 }); expect(http.calls.filter(call => call.url.endsWith("/reparse"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "sample.docx" })); await screen.findByRole("heading", { name: "sample.docx", level: 2 });
  await user.click(screen.getByRole("button", { name: "删除任务" })); await user.click(screen.getByRole("button", { name: "确认删除" })); await screen.findByText("任务已删除。"); expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

it("deletes an expired row despite 410 detail reads only after confirmation, retaining failed attempts", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "EXPIRED", allowedActions: [] }); let failDelete = true;
  http.server.intercept = (url, init) => {
    if (init.method === "DELETE" && failDelete) { failDelete = false; return json({ detail: { code: "DELETE_UNAVAILABLE" } }, 503); }
    if (init.method !== "DELETE" && [ `/api/document-tasks/${taskId}`, `/api/document-tasks/${taskId}/preview` ].includes(new URL(url, location.origin).pathname)) return json({ detail: { code: "TASK_EXPIRED" } }, 410);
  };
  render(<App />); await connect(user);
  await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await screen.findByRole("button", { name: "重试任务详情" });
  await user.click(screen.getByRole("button", { name: "删除已过期任务 sample.docx" }));
  expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "保留任务" }));
  await user.click(screen.getByRole("button", { name: "删除已过期任务 sample.docx" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText(/DELETE_UNAVAILABLE/);
  expect(screen.getByRole("group", { name: "删除任务确认" })).toBeTruthy(); expect(http.records.has(taskId)).toBe(true);
  vi.useFakeTimers(); await act(async () => vi.advanceTimersByTimeAsync(6000)); vi.useRealTimers();
  expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "确认删除" })); await screen.findByText("任务已删除。");
  await waitFor(() => expect(screen.queryByRole("button", { name: "删除已过期任务 sample.docx" })).toBeNull());
  expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(2); expect(http.records.has(taskId)).toBe(false);
  expect(screen.getByText("选择一个任务查看结果")).toBeTruthy();
});


it("uses completed heads for automatic wakes but forces explicit refresh", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user); await openTask(user);
  const reads = () => ({detail:http.calls.filter(c=>c.url.endsWith(`/${taskId}`)).length,preview:http.calls.filter(c=>c.url.includes("/preview")).length,head:http.calls.filter(c=>c.url.endsWith("/head")).length});
  expect(reads()).toEqual({detail:1,preview:1,head:0});
  vi.useFakeTimers();
  for (let wake = 0; wake < 20; wake++) await act(async () => {
    if (wake % 2) document.dispatchEvent(new Event("visibilitychange"));
    else window.dispatchEvent(new Event("focus"));
  });
  expect(reads()).toEqual({detail:1,preview:1,head:20});
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
  expect(reads()).toEqual({detail:1,preview:1,head:21});
  vi.useRealTimers();
  await user.click(screen.getByRole("button", { name: "刷新任务详情" }));
  await waitFor(() => expect(reads()).toEqual({detail:2,preview:2,head:21}));
});
it("loads diagnostics on first expansion, retains them on reopen and updates new details", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  const originalStringify = JSON.stringify;
  const diagnostic = vi.fn();
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const value: unknown = args[0];
    if (value && typeof value === "object" && Object.keys(value).length === 5 && ["usage", "unknownUsageCalls", "processing", "blocking", "parserJobs"].every(key => Object.hasOwn(value, key))) diagnostic(value);
    return originalStringify(...args);
  });
  const details = () => screen.getByText("模型用量与任务诊断", { exact: true }).closest("details")!;
  const expected = (current: DocumentTaskDetail) => originalStringify({ usage: current.usage, unknownUsageCalls: current.unknownUsageCalls, processing: current.processing, blocking: current.blocking, parserJobs: current.parserJobs || [] }, null, 2);
  const listReads = () => http.calls.filter(call => call.url.startsWith("/api/document-tasks?")).length;
  try {
    render(<App />); await connect(user); await openTask(user);
    expect(diagnostic).not.toHaveBeenCalled();
    expect(details().open).toBe(false);
    expect(details().querySelector("pre")).toBeNull();
    for (let update = 0; update < 5; update++) {
      http.records.set(taskId, { ...task, updatedAt: `2026-10-20T00:00:0${update}Z` });
      await act(async () => window.dispatchEvent(new Event("focus")));
    }
    expect(diagnostic).not.toHaveBeenCalled();
    let loadedCalls = 0;
    for (const open of [false, true]) {
      if (open) {
        const summary = screen.getByText("模型用量与任务诊断", { exact: true });
        await user.click(summary);
        await waitFor(() => expect(details().querySelector("pre")?.textContent).toBe(expected(task)));
        loadedCalls = diagnostic.mock.calls.length;
        expect(loadedCalls).toBe(1);
      }
      expect(details().open).toBe(open);
      for (const filter of ["completed", ""]) {
        const reads = listReads();
        await user.selectOptions(screen.getByLabelText("筛选任务状态"), filter);
        await waitFor(() => expect(listReads()).toBe(reads + 1));
        await screen.findByRole("button", { name: "sample.docx" });
        expect(diagnostic).toHaveBeenCalledTimes(loadedCalls);
        expect(details().querySelector("pre")?.textContent).toBe(open ? expected(task) : undefined);
      }
    }
    const body = details().querySelector("pre");
    await user.click(screen.getByText("模型用量与任务诊断", { exact: true }));
    await user.click(screen.getByText("模型用量与任务诊断", { exact: true }));
    expect(details().querySelector("pre")).toBe(body);
    expect(diagnostic).toHaveBeenCalledTimes(loadedCalls);
    const current = http.records.get(taskId)!;
    const updated: DocumentTaskDetail = { ...current,
      updatedAt: "2026-10-21T00:00:00Z",
      usage: current.usage.map(call => ({ ...call, inputTokens: 22 })),
      processing: { ...current.processing!, questionSources: [...current.processing!.questionSources!, { questionId: "q-child", stage: "document_parse", unitIndex: 2 }] },
      result: { ...current.result!, warnings: [...current.result!.warnings, "Refreshed diagnostic task"] },
    };
    http.records.set(taskId, updated);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await screen.findByText("Refreshed diagnostic task", { exact: true });
    if (!details().open) await user.click(screen.getByText("模型用量与任务诊断", { exact: true }));
    expect(await screen.findByText("已知用量：1 次调用，输入 22 tokens，输出 8 tokens。", { exact: true })).toBeTruthy();
    expect(details().querySelector("pre")?.textContent).toBe(expected(updated));
    expect(diagnostic).toHaveBeenCalledTimes(loadedCalls + 1);
    expect(diagnostic).toHaveBeenLastCalledWith({ usage: updated.usage, unknownUsageCalls: updated.unknownUsageCalls, processing: updated.processing, blocking: updated.blocking, parserJobs: updated.parserJobs || [] });
    expect(http.calls.every(call => call.method === "GET")).toBe(true);
    expect(http.calls.every(call => call.auth === "Bearer fake-service-token")).toBe(true);
  } finally { stringify.mockRestore(); }
});
it.each(["RUNNING", "PAUSED", "WAITING_REVIEW", "FAILED", "INTERRUPTED"] as const)("reads %s directly for ten polling rounds without redundant heads", async state => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state });
  render(<App />); await connect(user); await openTask(user);
  vi.useFakeTimers();
  await act(async () => window.dispatchEvent(new Event("focus")));
  const before = http.calls.filter(call => call.url.endsWith(`/${taskId}`)).length;
  const delay = state === "RUNNING" ? 3000 : 30000;
  await act(async () => vi.advanceTimersByTimeAsync(delay * 10));
  expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(before + 10);
  expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(0);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it.each([
  { checkpointId: "checkpoint-two" }, { runId }, { state: "RUNNING" as const },
  { modelConfigured: false }, { resumeCompatible: false }, { updatedAt: "2026-10-21T00:00:00Z" },
])("refreshes changed completed heads (%j) and follows active transitions directly", async change => {
  const user = userEvent.setup(); const http = fakeHTTP();
  render(<App />); await connect(user); await openTask(user);
  http.records.set(taskId, { ...task, ...change });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(1);
  expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(2);
  expect(http.calls.filter(call => call.url.includes("/preview"))).toHaveLength("checkpointId" in change || "state" in change ? 2 : 1);
  if ("state" in change) {
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(1);
    expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(3);
    http.records.set(taskId, task);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(2);
    expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(4);
  }
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("disables completed actions after an automatic head failure and restores freshness on wake", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  render(<App />); await connect(user); await openTask(user);
  const download = screen.getByRole("button", { name: "下载题库 ZIP" });
  expect(download).toHaveProperty("disabled", false);
  http.server.intercept = url => url.endsWith("/head") ? json({}, 503) : undefined;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(download).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "重试任务详情" })).toBeTruthy();
  http.server.intercept = undefined;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(download).toHaveProperty("disabled", false);
  expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(1);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it.each(["开始导入", "设置"])("stops invisible records reads in %s and refreshes immediately without losing workspace state", async destination => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "RUNNING", allowedActions: ["pause"] });
  const questions = Array.from({ length: 25 }, (_, index) => question({ id: `q-${index}`, stem: `Kept question ${index}`, parentId: null, optionSourceId: null }));
  http.server.intercept = url => url.includes("/preview") ? json({ ...preview, state: "RUNNING", units: [{ ...preview.units[0], questions }] }) : undefined;
  render(<App />); await connect(user);
  expect(http.calls.some(call => call.url.startsWith("/api/document-tasks"))).toBe(false);
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.selectOptions(screen.getByLabelText("筛选任务状态"), "active");
  await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await screen.findByText("Kept question 0");
  await user.click(screen.getByRole("button", { name: "下一页任务" }));
  await user.type(screen.getByRole("searchbox", { name: "搜索解析题目" }), "Kept");
  await user.click(screen.getByRole("checkbox", { name: "仅看需要复核" }));
  await user.click(screen.getByRole("button", { name: "下一页题目" }));
  const entry = screen.getByText("Kept question 20").closest("details")!;
  await user.click(screen.getByText("Kept question 20"));
  expect(entry.open).toBe(true);
  const panel = screen.getByRole("region", { name: "任务详情" });
  await user.click(screen.getByRole("link", { name: destination }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: destination, level: 1 }));
  const reads = () => http.calls.filter(call => call.url.startsWith("/api/document-tasks")).length;
  const before = reads();
  vi.useFakeTimers();
  for (let tick = 0; tick < 20; tick++) await act(async () => {
    window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(document.hidden).toBe(false);
  expect(reads()).toBe(before);
  vi.useRealTimers();
  let release!: (response: Response) => void;
  http.server.intercept = url => url.endsWith(`/${taskId}`) ? new Promise(resolve => { release = resolve; }) : undefined;
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  expect(reads()).toBe(before + 2);
  expect(screen.getByRole("button", { name: "暂停" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("region", { name: "任务详情" })).toBe(panel);
  expect(screen.getByLabelText("筛选任务状态")).toHaveProperty("value", "active");
  expect(screen.getByText("第 2 页")).toBeTruthy();
  expect(screen.getByRole("searchbox", { name: "搜索解析题目" })).toHaveProperty("value", "Kept");
  expect(screen.getByRole("checkbox", { name: "仅看需要复核" })).toHaveProperty("checked", true);
  expect(screen.getByText("第 21–25 条，共 25 条")).toBeTruthy();
  expect(screen.getByText("Kept question 20", { selector: "summary span" }).closest("details")).toBe(entry);
  expect(entry.open).toBe(true);
  await act(async () => release(json({ ...task, state: "RUNNING", allowedActions: ["pause"] })));
  expect(screen.getByRole("button", { name: "暂停" })).toHaveProperty("disabled", false);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("preserves review state across running checkpoints and resets it for another task", async () => {
  const user = userEvent.setup();
  const running: DocumentTaskDetail = { ...task, state: "RUNNING", result: null, allowedActions: ["pause"] };
  const http = fakeHTTP(running);
  http.records.set(newTaskId, { ...running, threadId: newTaskId, fileName: "other.docx" });
  const questions = Array.from({ length: 25 }, (_, index) => question({ id: `q-${index}`, stem: `Kept question ${index}`, parentId: null, optionSourceId: null }));
  let currentPreview = { ...preview, state: running.state, units: [{ ...preview.units[0], questions }] };
  http.server.intercept = url => url.includes("/preview") ? json({ ...currentPreview, threadId: url.split("/")[3], checkpointId: http.records.get(url.split("/")[3])!.checkpointId }) : undefined;
  render(<App />); await connect(user);
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await user.type(await screen.findByRole("searchbox", { name: "搜索解析题目" }), "Kept");
  await user.click(screen.getByRole("checkbox", { name: "仅看需要复核" }));
  await user.click(screen.getByRole("button", { name: "下一页题目" }));
  await user.click(screen.getByText("Kept question 20"));
  const entry = screen.getByText("Kept question 20", { selector: "summary span" }).closest("details")!;
  await screen.findByRole("heading", { name: "完整题干" });

  http.records.set(taskId, { ...running, checkpointId: "checkpoint-two" });
  currentPreview = { ...currentPreview, checkpointId: "checkpoint-two", units: [{ ...currentPreview.units[0], questions: questions.map(q => q.id === "q-20" ? { ...q, analysis: "Updated checkpoint analysis" } : q) }] };
  vi.useFakeTimers();
  await act(async () => window.dispatchEvent(new Event("focus")));
  // The scheduled running-task poll must retain the review, not only a focus wake.
  http.records.set(taskId, { ...running, checkpointId: "checkpoint-three" });
  currentPreview = { ...currentPreview, checkpointId: "checkpoint-three" };
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  vi.useRealTimers();
  expect(screen.getByRole("searchbox", { name: "搜索解析题目" })).toHaveProperty("value", "Kept");
  expect(screen.getByRole("checkbox", { name: "仅看需要复核" })).toHaveProperty("checked", true);
  expect(screen.getByText("第 21–25 条，共 25 条")).toBeTruthy();
  expect(screen.getByText("Kept question 20", { selector: "summary span" }).closest("details")).toBe(entry);
  expect(entry.open).toBe(true);
  expect(screen.getByText("Updated checkpoint analysis")).toBeTruthy();
  expect(http.calls.filter(call => call.url.includes(`/${taskId}/preview`))).toHaveLength(3);

  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  http.records.set(taskId, { ...running, checkpointId: "checkpoint-four" });
  currentPreview = { ...currentPreview, checkpointId: "checkpoint-four" };
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(screen.getByRole("button", { name: "来源与资源" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "other.docx" }));
  await screen.findByRole("heading", { name: "other.docx", level: 2 });
  expect(screen.getByRole("button", { name: "题目与材料" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("searchbox", { name: "搜索解析题目" })).toHaveProperty("value", "");
  expect(screen.getByRole("checkbox", { name: "仅看需要复核" })).toHaveProperty("checked", false);
  expect(screen.getByText("第 1–20 条，共 25 条")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页题目" }));
  expect(screen.getByText("Kept question 20", { selector: "summary span" }).closest("details")!.open).toBe(false);
  expect(questions[20]).not.toHaveProperty("analysis");
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it.each(["refresh", "task switch"])("recovers the result error boundary through explicit %s without mutations", async recovery => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "RUNNING" });
  http.records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "other.docx" });
  render(<App />); await connect(user); await openTask(user);
  const stringify = JSON.stringify;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const fault = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    // Inject a render-only failure while keeping valid HTTP payloads and the real boundary.
    if (Array.isArray(args[0]) && args[0].length === 1 && args[0][0] === "q-child") throw new Error("Synthetic result render failure");
    return stringify(...args);
  });
  try {
    http.records.set(taskId, { ...task, state: "RUNNING", checkpointId: "checkpoint-two" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.getByRole("heading", { name: "此界面暂时无法显示" })).toBeTruthy();
    expect(errors).toHaveBeenCalled();
  } finally { fault.mockRestore(); errors.mockRestore(); }
  if (recovery === "refresh") {
    await user.click(screen.getByRole("button", { name: "刷新任务详情" }));
  } else {
    await user.click(screen.getByRole("button", { name: "other.docx" }));
    await screen.findByRole("heading", { name: "other.docx", level: 2 });
  }
  expect(await screen.findByText("根据材料选择答案")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "此界面暂时无法显示" })).toBeNull();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("discards an in-flight hidden detail without fetching its preview, then revalidates on return", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "RUNNING", allowedActions: ["pause"] });
  render(<App />); await connect(user); await openTask(user);
  let release!: (response: Response) => void;
  http.server.intercept = url => url.endsWith(`/${taskId}`) ? new Promise(resolve => { release = resolve; }) : undefined;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await user.click(screen.getByRole("link", { name: "设置" }));
  const updated = { ...task, state: "PAUSED" as const, checkpointId: "checkpoint-two", allowedActions: ["resume" as const] };
  http.records.set(taskId, updated);
  const count = http.calls.length;
  await act(async () => release(json(updated)));
  expect(http.calls).toHaveLength(count);
  expect(http.calls.filter(call => call.url.includes("/preview"))).toHaveLength(1);
  http.server.intercept = undefined;
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "继续解析" })).toHaveProperty("disabled", false));
  expect(http.calls.filter(call => call.url.includes("/preview"))).toHaveLength(2);
  expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(0);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("revalidates immediately when records return before a follow-up preview settles", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  render(<App />); await connect(user); await openTask(user);
  const updated = { ...task, checkpointId: "checkpoint-two" };
  http.records.set(taskId, updated);
  let release!: (response: Response) => void;
  http.server.intercept = url => url.includes("/preview") ? new Promise(resolve => { release = resolve; }) : undefined;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await user.click(screen.getByRole("link", { name: "设置" }));
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  const download = screen.getByRole("button", { name: "下载题库 ZIP" });
  expect(download).toHaveProperty("disabled", true);
  const heads = http.calls.filter(call => call.url.endsWith("/head")).length;
  await act(async () => release(json({ ...preview, checkpointId: updated.checkpointId })));
  await waitFor(() => expect(download).toHaveProperty("disabled", false));
  expect(http.calls.filter(call => call.url.endsWith("/head"))).toHaveLength(heads + 1);
  expect(http.calls.filter(call => call.url.endsWith(`/${taskId}`))).toHaveLength(2);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("pauses background polling and reloads when the document becomes visible", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({...task,state:"RUNNING",allowedActions:["pause"]}); render(<App/>); await connect(user); await openTask(user);
  vi.useFakeTimers(); await act(async()=>{window.dispatchEvent(new Event("focus"));});
  const count = http.calls.length;
  Object.defineProperty(document,"hidden",{configurable:true,value:true});
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));await vi.advanceTimersByTimeAsync(9000);});
  expect(http.calls).toHaveLength(count);
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));});
  expect(http.calls.length).toBeGreaterThan(count); vi.useRealTimers();
});
it("keeps a cursor per visited page and resets it when filters change", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); http.server.intercept = url => url.startsWith("/api/document-tasks?") ? json({items:[summary],hasMore:true,nextCursor:"next-page"}):undefined;
  render(<App/>); await connect(user); await user.click(screen.getByRole("link", { name: "导入记录" })); await screen.findByRole("button",{name:/sample.docx/});
  await user.click(screen.getByRole("button",{name:"下一页任务"})); await waitFor(()=>expect(http.calls.at(-1)?.url).toContain("cursor=next-page"));
  await user.click(screen.getByRole("button",{name:"上一页任务"})); await waitFor(()=>expect(http.calls.at(-1)?.url).toContain("offset=0"));
  expect(http.calls.at(-1)?.url).not.toContain("cursor=");
  await user.selectOptions(screen.getByLabelText("筛选任务状态"),"failed"); await waitFor(()=>expect(http.calls.at(-1)?.url).toContain("state_filter=failed"));
  expect(http.calls.at(-1)?.url).not.toContain("cursor=");
});

it("empty task states guide file selection or clear the current filter without submitting", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = url => url.startsWith("/api/document-tasks?") ? json({ items: [], hasMore: false }) : undefined;
  render(<App />);
  await connect(user);
  expect(screen.getByText("格式与导入规则").closest("details")?.open).toBe(false);
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.click(await screen.findByRole("button", { name: "选择第一份文档" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("选择文档")));
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await user.selectOptions(screen.getByLabelText("筛选任务状态"), "failed");
  await screen.findByText("没有符合此状态的任务。");
  await user.click(screen.getByRole("button", { name: "查看全部任务" }));
  await screen.findByRole("button", { name: "选择第一份文档" });
  expect(screen.getByLabelText("筛选任务状态")).toHaveProperty("value", "");
  expect(http.calls.at(-1)?.url).toBe("/api/document-tasks?limit=20&offset=0");
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("removes only unsubmitted files locally and derives picker formats from service capabilities", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = url => url.includes("capabilities") ? json({...capabilities,sourceTypes:["text"],officeAvailable:false,officeModes:[]}) : undefined;
  render(<App/>); await connect(user);
  expect(screen.getByLabelText("选择文档").getAttribute("accept")).toBe(".txt");
  await user.upload(screen.getByLabelText("选择文档"), [new File(["a"],"first.txt"),new File(["b"],"second.txt")]);
  await user.click(screen.getByRole("button", {name:"移除文件 first.txt"}));
  expect(screen.queryByText("first.txt")).toBeNull();
  expect(screen.getByText("second.txt")).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
  await user.click(screen.getByRole("button", {name:"开始导入"}));
  await screen.findByText(/任务已创建。/);
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  expect(screen.queryByRole("button",{name:"移除文件 second.txt"})).toBeNull();
});

it("connects the personal service with passive reads and has no account fields", async () => {
  const user = userEvent.setup(), http = fakeHTTP(); render(<App />);
  await user.type(screen.getByLabelText("服务访问令牌"), "personal-token");
  expect(http.calls.filter(call => call.method === "POST")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "连接服务" }));
  await screen.findByText(/^服务支持：/);
  expect(http.calls.filter(call => call.url === "/api/import-capabilities")).toHaveLength(1);
  expect(http.calls.filter(call => call.method === "POST")).toHaveLength(0);
  expect(screen.queryByLabelText("手机号")).toBeNull();
  expect(screen.queryByText("充值与积分明细")).toBeNull();
});

it.each([false, true])("retains uncertain start across file reselection including invalid selection (%s)", async invalid => {
  const user = userEvent.setup({ applyAccept: false }); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; throw new TypeError("lost reply"); } };
  render(<App />); await connect(user);
  const file = new File(["original"], "original.txt");
  await user.upload(screen.getByLabelText("选择文档"), file);
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试开始" });
  await user.upload(screen.getByLabelText("选择文档"), invalid ? new File(["csv"], "bad.csv") : file);
  expect(screen.getAllByText("original.txt").length).toBeGreaterThan(0);
  expect((screen.getByRole("button", { name: "开始导入" }) as HTMLButtonElement).disabled).toBe(invalid);
  await user.click(screen.getByRole("button", { name: "重试开始" }));
  await screen.findByText(/任务已创建。/);
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates).toHaveLength(2); expect(creates[1].body).toEqual(creates[0].body);
});

it.each(["network", "receipt"])("stops a duplicate-file batch after an uncertain %s result until an explicit retry", async failure => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => {
    if (url === "/api/document-tasks" && init.method === "POST" && fail) {
      fail = false;
      if (failure === "network") throw new TypeError("lost reply");
      return json({});
    }
  };
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), [new File(["same"], "same.txt"), new File(["same"], "same.txt")]);
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试开始" });
  await waitFor(() => expect((screen.getByRole("button", { name: "开始导入" }) as HTMLButtonElement).disabled).toBe(false));
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  expect(screen.getByText(/尚未提交/, { selector: "span" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "重试开始" }));
  await screen.findByText(/任务已创建。/);
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates).toHaveLength(2); expect(creates[1].body).toEqual(creates[0].body);
  expect(screen.getByText(/尚未提交/, { selector: "span" })).toBeTruthy();
});

it("lets users discard a retained failure and reclaim its file slot without another mutation", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST") throw new TypeError("lost reply"); };
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), new File(["old"], "old.txt"));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试开始" });
  const ten = Array.from({ length: 10 }, (_, index) => new File(["new"], `${index}.txt`));
  await user.upload(screen.getByLabelText("选择文档"), ten);
  await screen.findByText(/请先处理保留的失败提交/);
  const mutations = http.calls.filter(call => call.method !== "GET").length;
  await user.click(screen.getByRole("button", { name: "移除文件 old.txt" }));
  expect(screen.queryByRole("button", { name: "重试开始" })).toBeNull();
  await user.upload(screen.getByLabelText("选择文档"), ten);
  expect(screen.queryByText(/请先处理保留的失败提交/)).toBeNull();
  expect(screen.getAllByRole("button", { name: /^移除文件/ })).toHaveLength(10);
  expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(mutations);
});

it("shows budget capacity before any upload without promising page counts", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = url => url.includes("capabilities") ? json({ ...capabilities, modelBudget: { limit: 400, unitCalls: 16, contextUnitCalls: 20 } }) : undefined;
  render(<App />); await connect(user);
  const budget = screen.getByText("调用预算 · 每任务 400 次").closest("details")!;
  expect(budget.open).toBe(false);
  await user.click(screen.getByText("调用预算 · 每任务 400 次"));
  expect(budget.open).toBe(true);
  expect(await screen.findByText(/普通单元最多 25 个.*带上下文的视觉单元最多 20 个/)).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it("resolves all retained copies when a reselected source receives the original receipt", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; throw new TypeError("lost reply"); } };
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), new File(["same"], "same.txt", { lastModified: 1 }));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试开始" });
  await user.upload(screen.getByLabelText("选择文档"), new File(["same"], "same.txt", { lastModified: 2 }));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByText(/任务已创建。/);
  expect(screen.queryByRole("button", { name: "重试开始" })).toBeNull();
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates).toHaveLength(2); expect(creates[0].body).toEqual(creates[1].body);
});

it("does not treat filename, size and timestamp as proof of identical source bytes", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; throw new TypeError("lost reply"); } };
  render(<App />); await connect(user);
  for (const bytes of ["old", "new"]) {
    await user.upload(screen.getByLabelText("选择文档"), new File([bytes], "same.txt", { lastModified: 1 }));
    await user.click(screen.getByRole("button", { name: "开始导入" }));
    if (bytes === "old") await screen.findByRole("button", { name: "重试开始" });
    else await screen.findByText(/任务已创建。/);
  }
  expect(screen.getByRole("button", { name: "重试开始" })).toBeTruthy();
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates).toHaveLength(2); expect(creates[0].body?.requestId).not.toEqual(creates[1].body?.requestId);
  expect(creates[0].body?.document).not.toEqual(creates[1].body?.document);
});

it("lets new files choose deduplication while an older uncertain retry keeps its original options", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; throw new TypeError("lost reply"); } };
  render(<App />); await connect(user);
  await user.upload(screen.getByLabelText("选择文档"), new File(["old"], "old.txt"));
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await screen.findByRole("button", { name: "重试开始" });
  await user.upload(screen.getByLabelText("选择文档"), new File(["new"], "new.txt"));
  await user.click(screen.getByRole("checkbox", { name: "自动去重" }));
  await user.click(screen.getByRole("button", { name: "重试开始" }));
  await screen.findByText(/任务已创建。/);
  await user.click(screen.getByRole("button", { name: "开始导入" }));
  await waitFor(() => expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(3));
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST");
  expect(creates[0].body).toEqual(creates[1].body);
  expect(creates[2].body).toHaveProperty("deduplicateQuestions", true);
});

it("keeps task deletion unconfirmed until an affirmative receipt arrives", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let invalid = true;
  http.server.intercept = (_url, init) => { if (init.method === "DELETE" && invalid) { invalid = false; return json({ deleted: false }); } };
  render(<App />); await connect(user); await user.click(screen.getByRole("link", { name: "导入记录" })); await user.click(await screen.findByRole("button", { name: "sample.docx" }));
  await user.click(await screen.findByText("其他任务操作"));
  await user.click(screen.getByRole("button", { name: "删除任务" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText(/删除回执无效，结果尚未确认/);
  expect(screen.queryByText("任务已删除。")).toBeNull();
  expect(screen.getByRole("group", { name: "删除任务确认" })).toBeTruthy();
  expect(http.records.has(taskId)).toBe(true);
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText("任务已删除。");
  expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(2);
});

it("sidebar navigation preserves selected files and settings drafts without starting work", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user);
  expect(screen.getByRole("link", { name: "开始导入" }).getAttribute("aria-current")).toBe("page");
  await user.upload(screen.getByLabelText("选择文档"), new File(["unchanged"], "pending.txt"));
  await user.click(screen.getByRole("link", { name: "设置" }));
  const concurrency = await screen.findByLabelText("腾讯识别并发上限"); await user.clear(concurrency); await user.type(concurrency, "3");
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  expect(await screen.findByRole("table", { name: "文档导入记录" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "待复核" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "文档导入记录" }).querySelectorAll("tbody .record-number")[1].textContent).toBe("待复核 2");
  await user.click(screen.getByRole("link", { name: "开始导入" }));
  expect(screen.getByText("pending.txt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "开始导入" })).toHaveProperty("disabled", false);
  await user.click(screen.getByRole("link", { name: "设置" }));
  expect(concurrency).toHaveProperty("value", "3");
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});

it.each(["task-detail", "task-list-heading"])("opens the records page for a direct #%s anchor", anchor => {
  window.history.replaceState(null, "", `/#${anchor}`);
  render(<App />);
  expect(screen.getByRole("heading", { name: "导入记录", level: 1 })).toBeTruthy();
  expect(screen.getByRole("link", { name: "导入记录" }).getAttribute("aria-current")).toBe("page");
});

it("keeps shared anchors on the current page and restores import for root history", async () => {
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("link", { name: "设置" }));
  await act(async () => { window.location.hash = "main-content"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(screen.getByRole("heading", { name: "设置", level: 1 })).toBeTruthy();
  await act(async () => { window.location.hash = ""; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(screen.getByRole("heading", { name: "开始导入", level: 1 })).toBeTruthy();
});


it("retains the last task list after a background read fails and recovers without mutations", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  render(<App />); await connect(user);
  await user.click(screen.getByRole("link", { name: "导入记录" }));
  await screen.findByRole("button", { name: "sample.docx" });
  http.server.intercept = url => url.startsWith("/api/document-tasks?") ? json({ detail: { code: "TASK_SERVICE_UNAVAILABLE" } }, 503) : undefined;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await screen.findByText("当前显示上次读取的记录。");
  expect(screen.getByRole("button", { name: "sample.docx" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "下一页任务" }).hasAttribute("disabled")).toBe(true);
  http.server.intercept = undefined;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.queryByText("当前显示上次读取的记录。")).toBeNull());
  expect(screen.getByRole("button", { name: "sample.docx" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "下一页任务" }).hasAttribute("disabled")).toBe(false);
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});
