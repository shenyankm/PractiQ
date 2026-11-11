// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloudPage } from "./CloudPage";
import { invoke } from "./transport";
import { setNativeBridge } from "../../shared/cloud/transport";
import { setCloudLocale } from "../../shared/cloud/i18n";
import { capabilities, task, preview, taskId, runId } from "../../shared/cloud/test-fixtures";

vi.mock("./transport", () => ({ invoke: vi.fn() }));
function fixture(options: { origin?: string | null; unavailableOrigin?: string } = {}) {
  let origin = options.origin === undefined ? "http://127.0.0.1:8090" : options.origin;
  let generation = 1;
  const calls: Record<string, unknown>[] = [];
  const native = vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const request = args!.request as Record<string, unknown>;
    const context = args!.context as { origin: string; generation: number } | null;
    calls.push(structuredClone(request));
    let value: unknown;
    if (request.type === "status") value = { origin, generation };
    else if (request.type === "configure") { origin = String(request.origin); ++generation; value = { origin, generation }; }
    else {
      expect(context?.origin).toBe(origin);
      if (request.type === "fetch") {
        if (origin === options.unavailableOrigin) throw { code: "CLOUD_RESULT_UNKNOWN" };
        const status = 200; let data: unknown;
        const path = String(request.path).split("?")[0], body = request.body as Record<string, unknown>;
        if (path === "/api/import-capabilities") data = capabilities;
        else if (path === "/api/import-settings") data = { revision: taskId, settings: { tencentConcurrency: 5, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };
        else if (path === "/api/document-tasks" && request.method === "POST") data = { threadId: taskId, runId, requestId: body.requestId, accepted: true };
        else if (path === `/api/document-tasks/${taskId}`) data = task;
        else if (path === `/api/document-tasks/${taskId}/head`) data = task;
        else if (path === `/api/document-tasks/${taskId}/preview`) data = preview;
        else data = { items: [], hasMore: false };
        value = { status, mediaType: "application/json", bytes: Buffer.from(JSON.stringify(data)).toString("base64") };
      } else if (request.type === "pick_sources") value = [{ nativeTicket: "opaque-native-file-ticket", name: "native-upload.txt", size: 4 }];
      else if (request.type === "upload") value = { sourceType: "text", mediaType: "text/plain", fileName: "native-upload.txt", sizeBytes: 4, sha256: "a".repeat(64), objectKey: `practiq-agent/sources/${"a".repeat(64)}/source.txt` };
      else throw new Error(`Unexpected native cloud command ${request.type}`);
    }
    return { value, generation } as never;
  });
  return { calls, native, setOrigin: (value: string) => { origin = value; } };
}
beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; HTMLElement.prototype.scrollIntoView = vi.fn(); localStorage.clear(); history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); setNativeBridge(null);  setCloudLocale("zh-CN"); vi.clearAllMocks(); });

it("localizes the import workspace tabs", async () => {
  fixture();
  setCloudLocale("en");
  render(<CloudPage />);
  expect(await screen.findByRole("link", { name: "Start import" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Import history" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
});

it("opens the workspace directly and keeps the backend address in import settings", async () => {
  const { calls } = fixture(); render(<CloudPage />);
  expect(await screen.findByRole("link", { name: "开始导入" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "连接云端服务" })).toBeNull();
  expect(calls.every(call => call.type === "status" || call.method === "GET")).toBe(true);
  await userEvent.click(screen.getByRole("link", { name: "设置" }));
  expect((screen.getByLabelText("导入服务地址") as HTMLInputElement).value).toBe("http://127.0.0.1:8090");
});

it("lets a user correct an unreachable saved backend in settings", async () => {
  const { calls } = fixture({ unavailableOrigin: "http://127.0.0.1:8090" }); render(<CloudPage />);
  const events = userEvent.setup();
  await events.click(await screen.findByRole("link", { name: "设置" }));
  const address = screen.getByLabelText("导入服务地址") as HTMLInputElement;
  await events.clear(address);
  await events.type(address, "https://cloud.example.test");
  await events.click(screen.getByRole("button", { name: "保存服务地址" }));
  await waitFor(() => expect(calls.some(call => call.type === "configure" && call.origin === "https://cloud.example.test")).toBe(true));
  expect(await screen.findByRole("link", { name: "开始导入" })).toBeTruthy();
  expect(calls.some(call => call.method === "POST")).toBe(false);
});

it("cancels an address draft without unmounting the import workspace", async () => {
  const { calls } = fixture(); const view = render(<CloudPage />);
  const events = userEvent.setup();
  await events.click(await screen.findByRole("link", { name: "设置" }));
  const workspace = view.container.querySelector(".web-shell");
  await events.clear(screen.getByLabelText("导入服务地址"));
  await events.type(screen.getByLabelText("导入服务地址"), "https://other.example.test");
  await events.click(screen.getByRole("button", { name: "取消" }));
  expect(view.container.querySelector(".web-shell")).toBe(workspace);
  expect((screen.getByLabelText("导入服务地址") as HTMLInputElement).value).toBe("http://127.0.0.1:8090");
  expect(calls.some(call => call.type === "configure")).toBe(false);
});

it("honors submission and correction leave guards before changing the backend", async () => {
  const { calls } = fixture(); const view = render(<CloudPage />);
  const events = userEvent.setup();
  await events.click(await screen.findByRole("link", { name: "设置" }));
  const workspace = view.container.querySelector(".web-shell");
  const address = screen.getByLabelText("导入服务地址");
  await events.clear(address); await events.type(address, "https://other.example.test");
  const guard = vi.fn((event: Event) => event.preventDefault());
  document.addEventListener("practiq-cloud-before-leave", guard);
  try {
    await events.click(screen.getByRole("button", { name: "保存服务地址" }));
    expect(guard).toHaveBeenCalledOnce();
    expect(calls.some(call => call.type === "configure")).toBe(false);
    expect(view.container.querySelector(".web-shell")).toBe(workspace);
    expect(address).toHaveProperty("value", "https://other.example.test");
  } finally { document.removeEventListener("practiq-cloud-before-leave", guard); }
});

it("native file selection stays passive and only Start uploads and creates a cloud task", async () => {
  const { calls } = fixture(); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "选择文档" }));
  expect(screen.queryByRole("navigation", {name:"个人导航"})).toBeNull();
  expect(screen.queryByRole("button", {name:"退出登录"})).toBeNull();
  expect(calls.some(call => String(call.path).startsWith("/api/auth/"))).toBe(false);
  await screen.findByText("native-upload.txt");
  expect(calls.some(c => c.type === "upload" || c.method === "POST")).toBe(false);
  await events.click(screen.getByRole("button", { name: "开始导入" }));
  await waitFor(() => expect(calls.filter(c => c.path === "/api/document-tasks" && c.method === "POST")).toHaveLength(1));
  expect(calls.filter(c => c.type === "upload")).toEqual([{ type: "upload", ticket: "opaque-native-file-ticket" }]);
  expect(calls.some(c => String(c.path).includes("uploads"))).toBe(false);
});
