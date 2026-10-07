import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import App from "./App";
import { capabilities, newTaskId, preview, runId, summary, task, taskId } from "./test-fixtures";
import type { DocumentTaskDetail } from "./contracts.generated";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
    if (path === "/api/document-tasks" && method === "GET") return json({ items: Array.from(records.values()).map(current => ({ ...summary, threadId: current.threadId, fileName: current.fileName, state: current.state, checkpointId: current.checkpointId, status: current.status })), hasMore: new URL(url, location.origin).searchParams.get("offset") === "0" });
    if (path === "/api/uploads") { document = { ...body, objectKey: `practiq-agent/sources/${body.sha256}/source.${body.sourceType === "text" ? "txt" : body.sourceType}` }; return json({ document, upload: { method: "PUT", url: "/api/uploads/content?" + new URLSearchParams(body), headers: { "Content-Type": body.mediaType } } }); }
    if (path === "/api/uploads/content") return json(document);
    if (path === "/api/document-tasks" && method === "POST") { records.set(newTaskId, { ...task, threadId: newTaskId, fileName: body.document.fileName }); return json({ threadId: newTaskId, requestId: body.requestId, runId, accepted: true }, 202); }
    const id = path.split("/")[3]; const current = records.get(id);
    if (path.endsWith("/preview")) return json({ ...preview, threadId: id, checkpointId: current?.checkpointId, state: current?.state });
    if (path.endsWith("/export")) return new Response("PKfake", { headers: { "Content-Type": "application/zip" } });
    if (path.endsWith("/control")) { records.set(id, { ...current!, state: body.action === "pause" ? "PAUSED" : "RUNNING", runId, allowedActions: body.action === "pause" ? ["resume"] : ["pause", "interrupt"] }); return json({ threadId: id, requestId: body.requestId, runId, accepted: true }, 202); }
    if (path.endsWith("/reparse")) { records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "reparsed.docx", parentThreadId: id, state: "PENDING", phase: "pending", checkpointId: null, result: null }); return json({ threadId: newTaskId, requestId: body.requestId, runId, accepted: true }, 202); }
    if (method === "DELETE") { records.delete(id); return json({ deleted: true }); }
    return json(current);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, records, server, fetcher };
}
async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("服务 Token"), "fake-service-token"); await user.click(screen.getByRole("button", { name: "连接服务" }));
  await screen.findByText("服务已连接");
}
async function openTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /sample.docx/ }));
  await screen.findByRole("heading", { name: "sample.docx", level: 2 });
  await screen.findByText("根据材料选择答案");
}

it("keeps Token in memory, clears it on disconnect, and performs no HTTP before connect", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); const persist = vi.spyOn(Storage.prototype, "setItem"); render(<App />);
  expect(http.calls).toHaveLength(0);
  await connect(user);
  expect(screen.getByText("服务支持：PDF、TXT、CSV、PNG/JPEG、Word (.doc)、Word (.docx)、Excel (.xls)、Excel (.xlsx)")).toBeTruthy();
  expect(screen.queryByLabelText("服务 Token")).toBeNull(); expect(persist).not.toHaveBeenCalled();
  expect(http.calls.every(call => call.auth === "Bearer fake-service-token" && !call.url.includes("fake-service-token") && call.method === "GET")).toBe(true);
  await user.click(screen.getByRole("button", { name: "断开连接" })); expect((screen.getByLabelText("服务 Token") as HTMLInputElement).value).toBe("");
  const count = http.calls.length; vi.useFakeTimers(); await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(http.calls).toHaveLength(count);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
it("selection is passive; explicit Start performs bounded SHA upload and task creation", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user);
  await user.selectOptions(screen.getByLabelText("Word / Excel 转换模式"), "text");
  await user.upload(screen.getByLabelText("选择文档"), new File(["office"], "document.docx"));
  expect(screen.getByText(/尚未提交/)).toBeTruthy(); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "开始导入" })); await screen.findByText(/任务已创建。页面/);
  const mutations = http.calls.filter(call => call.method !== "GET"); expect(mutations.map(call => call.method)).toEqual(["POST", "PUT", "POST"]);
  expect(mutations[0].body).toMatchObject({ sourceType: "docx", sizeBytes: 6 });
  expect(mutations[2].body).toMatchObject({ officeMode: "text", graphId: "document_parser" });
  expect(mutations[2].body?.requestId).toMatch(/^[a-f0-9-]{36}$/);
});
it("never automatically replays uncertain POST, and an explicit retry retains the request and Office mode", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let fail = true;
  http.server.intercept = (url, init) => { if (url === "/api/document-tasks" && init.method === "POST" && fail) { fail = false; throw new TypeError("lost reply"); } };
  render(<App />); await connect(user); await user.selectOptions(screen.getByLabelText("Word / Excel 转换模式"), "text"); await user.upload(screen.getByLabelText("选择文档"), new File(["office"], "document.docx"));
  await user.click(screen.getByRole("button", { name: "开始导入" })); const retry = await screen.findByRole("button", { name: "重试开始" });
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  expect((screen.getByLabelText("Word / Excel 转换模式") as HTMLSelectElement).disabled).toBe(true);
  await user.click(retry); await screen.findByText(/任务已创建。页面/);
  const creates = http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST"); expect(creates).toHaveLength(2); expect(creates[0].body).toEqual(creates[1].body);
});
it("uses service limits and configuration before starting, and keeps provider settings out of the browser", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); http.server.intercept = url => url.includes("capabilities") ? json({ ...capabilities, sourceMaxBytes: 1, modelConfigured: false, officeAvailable: false, officeModes: [], sourceTypes: ["text"] }) : undefined;
  render(<App />); await connect(user); expect(screen.getByText("服务支持：TXT。Office 转换当前不可用。")).toBeTruthy(); await user.upload(screen.getByLabelText("选择文档"), new File(["xx"], "large.txt")); expect(await screen.findByText(/为空或超过/)).toBeTruthy();
  await user.upload(screen.getByLabelText("选择文档"), new File(["x"], "small.txt")); expect((screen.getByRole("button", { name: "开始导入" }) as HTMLButtonElement).disabled).toBe(true);
  await openTask(user); expect((screen.getByRole("button", { name: "重新解析为新任务" }) as HTMLButtonElement).disabled).toBe(false); // Existing task exposes its own current configuration.
  expect(screen.queryByLabelText(/API Key|模型密钥/)).toBeNull(); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});
it("displays the source-specific Office ceiling alongside the configured general ceiling", async () => {
  const user = userEvent.setup(); const http = fakeHTTP();
  http.server.intercept = url => url.includes("capabilities") ? json({ ...capabilities, sourceMaxBytes: 100 * 1024 * 1024, officeSourceMaxBytes: 25 * 1024 * 1024 }) : undefined;
  render(<App />); await connect(user);
  expect(screen.getByText(/每个不超过 100.0 MB，Word \/ Excel 不超过 25.0 MB/)).toBeTruthy();
  expect(http.calls.every(call => call.method === "GET")).toBe(true);
});
it("polling paused/partial checkpoints only reads; resume/retry/pause require explicit clicks", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "PAUSED", phase: "chunk_review", allowedActions: ["resume", "retry_failed", "accept_partial"] }); render(<App />); await connect(user); await openTask(user);
  expect(screen.getByRole("button", { name: "重试失败单元" })).toBeTruthy(); expect(screen.getByRole("button", { name: "接受部分结果" })).toBeTruthy();
  await user.click(screen.getByText("模型用量与任务诊断")); expect(screen.getByText(/实际总用量未知/)).toBeTruthy(); expect(screen.getByText(/输入 21 tokens，输出 8 tokens/)).toBeTruthy();
  vi.useFakeTimers(); await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(http.calls.every(call => call.method === "GET")).toBe(true); vi.useRealTimers();
  await user.click(screen.getByRole("button", { name: "继续解析" })); await screen.findByRole("button", { name: "暂停" });
  const resume = http.calls.find(call => call.url.endsWith("/control")); expect(resume?.body).toMatchObject({ action: "resume", runId: null, checkpointId: "checkpoint-one", units: [] });
  await user.click(screen.getByRole("button", { name: "暂停" })); await screen.findByRole("button", { name: "继续解析" });
  expect(http.calls.filter(call => call.url.endsWith("/control")).at(-1)?.body).toMatchObject({ action: "pause", runId, checkpointId: null });
});
it("recovers failed task/capability reads and ignores obsolete pages after a filter change", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); let failList = true, failCap = true;
  http.server.intercept = url => { if (url.includes("capabilities") && failCap) { failCap = false; return json({ detail: { code: "SERVICE_UNAVAILABLE" } }, 503); } if (url.startsWith("/api/document-tasks?") && failList) { failList = false; return json({ detail: { code: "TASK_SERVICE_UNAVAILABLE" } }, 503); } };
  render(<App />); await user.type(screen.getByLabelText("服务 Token"), "fake-service-token"); await user.click(screen.getByRole("button", { name: "连接服务" }));
  await screen.findByText("连接验证失败");
  expect(screen.queryByText("正在验证服务")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "重试读取服务能力" })); await screen.findByText("服务已连接");
  await user.click(await screen.findByRole("button", { name: "重试任务列表" })); await screen.findByRole("button", { name: /sample.docx/ });
  let release!: (response: Response) => void;
  http.server.intercept = url => { if (url.includes("offset=20")) return new Promise(resolve => { release = resolve; }); if (url.includes("state_filter=failed")) return json({ items: [{ ...summary, threadId: newTaskId, fileName: "current-failed.pdf" }], hasMore: false }); };
  await user.click(screen.getByRole("button", { name: "下一页任务" })); await waitFor(() => expect(release).toBeTypeOf("function"));
  await user.selectOptions(screen.getByLabelText("筛选任务状态"), "failed"); await screen.findByRole("button", { name: /current-failed.pdf/ });
  await act(async () => release(json({ items: [summary], hasMore: false }))); expect(screen.queryByRole("button", { name: /sample.docx/ })).toBeNull(); expect(http.calls.at(-1)?.url).toContain("offset=0&state_filter=failed");
  await user.click(screen.getByRole("button", { name: "刷新任务列表" })); await screen.findByRole("button", { name: /current-failed.pdf/ });
});
it("disables checkpoint actions when detail/preview reads fail or disagree, then recovers explicitly", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "PAUSED", allowedActions: ["resume"] }); let failDetail = true, failPreview = true;
  http.server.intercept = url => { if (url.endsWith(`/${taskId}`) && failDetail) { failDetail = false; return json({}, 503); } if (url.endsWith("/preview") && failPreview) { failPreview = false; return json({}, 503); } };
  render(<App />); await connect(user); await user.click(await screen.findByRole("button", { name: /sample.docx/ }));
  await screen.findByRole("button", { name: "重试任务详情" }); await screen.findByRole("button", { name: "重试检查点预览" });
  http.server.intercept = url => url.endsWith("/preview") ? json({ ...preview, checkpointId: "different-checkpoint" }) : undefined;
  await user.click(screen.getByRole("button", { name: "重试任务详情" })); await screen.findByRole("button", { name: "继续解析" }); expect((screen.getByRole("button", { name: "继续解析" }) as HTMLButtonElement).disabled).toBe(true);
  http.server.intercept = undefined; await user.click(screen.getByRole("button", { name: "刷新任务详情" })); await waitFor(() => expect((screen.getByRole("button", { name: "继续解析" }) as HTMLButtonElement).disabled).toBe(false));
  http.server.intercept = url => url.endsWith("/control") ? json({ detail: { code: "STALE_CHECKPOINT" } }, 409) : undefined;
  await user.click(screen.getByRole("button", { name: "继续解析" })); expect(await screen.findByText(/STALE_CHECKPOINT/)).toBeTruthy();
});
it("exports the current partial checkpoint via authenticated ZIP GET and never starts a model", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bank"); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<App />); await connect(user); await openTask(user);
  await user.click(screen.getByRole("button", { name: "下载题库 ZIP" })); await screen.findByText(/题库 ZIP 已下载/);
  expect(http.calls.find(call => call.url.includes("/export?"))).toMatchObject({ method: "GET", auth: "Bearer fake-service-token", url: `/api/document-tasks/${taskId}/export?checkpoint_id=checkpoint-one` });
  expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1); expect(http.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});
it("creates a reparse task only on explicit action and confirms deletion before HTTP", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user); await openTask(user);
  await user.click(screen.getByRole("button", { name: "删除任务" })); expect(http.calls.some(call => call.method === "DELETE")).toBe(false); await user.click(screen.getByRole("button", { name: "保留任务" }));
  await user.click(screen.getByRole("button", { name: "重新解析为新任务" })); await screen.findByRole("heading", { name: "reparsed.docx", level: 2 }); expect(http.calls.filter(call => call.url.endsWith("/reparse"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: /sample.docx/ })); await screen.findByRole("heading", { name: "sample.docx", level: 2 });
  await user.click(screen.getByRole("button", { name: "删除任务" })); await user.click(screen.getByRole("button", { name: "确认删除" })); await screen.findByText("任务已删除。"); expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

it("deletes an expired row despite 410 detail reads only after confirmation, retaining failed attempts", async () => {
  const user = userEvent.setup(); const http = fakeHTTP({ ...task, state: "EXPIRED", allowedActions: [] }); let failDelete = true;
  http.server.intercept = (url, init) => {
    if (init.method === "DELETE" && failDelete) { failDelete = false; return json({ detail: { code: "DELETE_UNAVAILABLE" } }, 503); }
    if (init.method !== "DELETE" && [ `/api/document-tasks/${taskId}`, `/api/document-tasks/${taskId}/preview` ].includes(url)) return json({ detail: { code: "TASK_EXPIRED" } }, 410);
  };
  render(<App />); await connect(user);
  await user.click(await screen.findByRole("button", { name: /sample.docx.*已过期/ }));
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


it("uses lightweight completed heads, skips unchanged previews and refreshes on focus", async () => {
  const user = userEvent.setup(); const http = fakeHTTP(); render(<App />); await connect(user); await openTask(user);
  const reads = () => ({detail:http.calls.filter(c=>c.url.endsWith(`/${taskId}`)).length,preview:http.calls.filter(c=>c.url.endsWith("/preview")).length,head:http.calls.filter(c=>c.url.endsWith("/head")).length});
  expect(reads()).toEqual({detail:1,preview:1,head:0});
  vi.useFakeTimers(); await act(async()=>{window.dispatchEvent(new Event("focus"));});
  expect(reads()).toEqual({detail:2,preview:2,head:0});
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
  expect(reads()).toEqual({detail:2,preview:2,head:1});
  await act(async()=>{ window.dispatchEvent(new Event("focus")); });
  expect(reads()).toEqual({detail:3,preview:3,head:1}); vi.useRealTimers();
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
  render(<App/>); await connect(user); await screen.findByRole("button",{name:/sample.docx/});
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
  expect(screen.getByRole("list", { name: "文档导入流程" }).children).toHaveLength(3);
  await connect(user);
  await user.click(await screen.findByRole("button", { name: "选择第一份文档" }));
  expect(document.activeElement).toBe(screen.getByLabelText("选择文档"));
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
  await screen.findByText(/任务已创建。页面/);
  expect(http.calls.filter(call => call.url === "/api/document-tasks" && call.method === "POST")).toHaveLength(1);
  expect(screen.queryByRole("button",{name:"移除文件 second.txt"})).toBeNull();
});
