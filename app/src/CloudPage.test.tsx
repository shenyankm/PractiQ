// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloudPage } from "./CloudPage";
import { invoke } from "./transport";
import { setNativeBridge } from "../../shared/cloud/transport";
import { setAccount } from "../../shared/cloud/accountClient";
import { capabilities, task, preview, taskId, runId } from "../../shared/cloud/test-fixtures";

vi.mock("./transport", () => ({ invoke: vi.fn() }));
const email = "native@example.test", password = "native-test-password";
const user = { id: "native-owner", email, name: "", role: "user", enabled: true };
function fixture(options: { origin?: string | null; loggedIn?: boolean; registration?: boolean; rejectLogin?: boolean } = {}) {
  let origin = options.origin === undefined ? "http://127.0.0.1:8090" : options.origin;
  let generation = 1, current = options.loggedIn ? user : null;
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
        let status = 200, data: unknown;
        const path = String(request.path).split("?")[0], body = request.body as Record<string, unknown>;
        if (path === "/api/auth/session") data = { user: current, csrf: "", registrationEnabled: options.registration !== false };
        else if (path === "/api/auth/login" || path === "/api/auth/register") {
          if (options.rejectLogin) { status = 401; data = { detail: { code: "INVALID_CREDENTIALS" } }; }
          else { current = { ...user, email: String(body.email) }; ++generation; data = { user: current, csrf: "", registrationEnabled: true }; }
        } else if (path === "/api/auth/logout") { current = null; ++generation; data = { ok: true }; }
        else if (path === "/api/auth/reset-password") data = { ok: true };
        else if (path === "/api/import-capabilities") data = capabilities;
        else if (path === "/api/import-settings") data = { revision: taskId, settings: { tencentConcurrency: 5, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };
        else if (path === "/api/document-tasks" && request.method === "POST") data = { threadId: taskId, runId, requestId: body.requestId, accepted: true };
        else if (path === `/api/document-tasks/${taskId}`) data = task;
        else if (path === `/api/document-tasks/${taskId}/head`) data = task;
        else if (path === `/api/document-tasks/${taskId}/preview`) data = preview;
        else if (path.startsWith("/api/me/usage")) data = { limits: { freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 2 }, remainingPages: 50, usedPages: 0, daily: [], calls: [] };
        else data = { items: [], hasMore: false };
        value = { status, mediaType: "application/json", bytes: Buffer.from(JSON.stringify(data)).toString("base64") };
      } else if (request.type === "pick_sources") value = [{ nativeTicket: "opaque-native-file-ticket", name: "native-upload.txt", size: 4 }];
      else if (request.type === "upload") value = { sourceType: "text", mediaType: "text/plain", fileName: "native-upload.txt", sizeBytes: 4, sha256: "a".repeat(64), objectKey: `practiq-agent/sources/${"a".repeat(64)}/source.txt` };
      else if (request.type === "forget_session") { current = null; ++generation; value = null; }
      else throw new Error(`Unexpected native cloud command ${request.type}`);
    }
    return { value, generation } as never;
  });
  return { calls, native };
}
beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; HTMLElement.prototype.scrollIntoView = vi.fn(); localStorage.clear(); history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); setNativeBridge(null); setAccount(null); vi.clearAllMocks(); });

it("only reads native connection metadata before a service is explicitly configured", async () => {
  const { calls } = fixture({ origin: null }); render(<CloudPage />);
  await waitFor(() => expect(screen.getByLabelText("云端服务地址").hasAttribute("disabled")).toBe(false));
  expect(calls).toEqual([{ type: "status" }]);
  expect(screen.queryByLabelText("登录邮箱")).toBeNull();
});

it("registers through native IPC without browser fetch or persisted passwords", async () => {
  const { calls } = fixture(); const browserFetch = vi.spyOn(globalThis, "fetch"); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "注册账户" }));
  await events.type(screen.getByLabelText("登录邮箱"), email);
  await events.type(screen.getByLabelText("密码（至少 12 字符）"), password);
  await events.click(screen.getByRole("button", { name: "注册并登录" }));
  expect(await screen.findByText(email)).toBeTruthy();
  expect(calls.filter(c => c.path === "/api/auth/register")).toEqual([expect.objectContaining({ method: "POST", body: { email, password } })]);
  expect(browserFetch).not.toHaveBeenCalled();
  expect(JSON.stringify(localStorage)).not.toContain(password);
  expect(calls.some(c => c.type === "upload" || (c.path === "/api/document-tasks" && c.method === "POST"))).toBe(false);
  browserFetch.mockRestore();
});

it("respects disabled public registration and never submits a rejected login twice", async () => {
  const { calls } = fixture({ registration: false, rejectLogin: true }); render(<CloudPage />); const events = userEvent.setup();
  await events.type(await screen.findByLabelText("登录邮箱"), email);
  expect(screen.queryByRole("button", { name: "注册账户" })).toBeNull();
  await events.type(screen.getByLabelText("密码"), password); await events.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "邮箱或密码错误，或账户已停用。");
  expect(calls.filter(c => c.path === "/api/auth/login")).toHaveLength(1);
});

it("accepts an administrator-issued reset code entirely inside the app", async () => {
  const { calls } = fixture(); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "重置密码" }));
  await events.type(screen.getByLabelText("管理员提供的一次性重置码"), "one-time-reset-code");
  await events.type(screen.getByLabelText("密码（至少 12 字符）"), password);
  await events.click(screen.getByRole("button", { name: "设置新密码" }));
  await screen.findByRole("heading", { name: "登录 PractiQ" });
  expect(calls.filter(c => c.path === "/api/auth/reset-password")).toEqual([expect.objectContaining({ body: { token: "one-time-reset-code", password } })]);
  expect(location.hash).toBe("");
});

it("native file selection stays passive and only Start uploads and creates a cloud task", async () => {
  const { calls } = fixture({ loggedIn: true }); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "选择云端导入文件" }));
  await screen.findByText("native-upload.txt");
  expect(calls.some(c => c.type === "upload" || c.method === "POST")).toBe(false);
  await events.click(screen.getByRole("button", { name: "开始导入" }));
  await waitFor(() => expect(calls.filter(c => c.path === "/api/document-tasks" && c.method === "POST")).toHaveLength(1));
  expect(calls.filter(c => c.type === "upload")).toEqual([{ type: "upload", ticket: "opaque-native-file-ticket" }]);
  expect(calls.some(c => String(c.path).includes("uploads"))).toBe(false);
});

it("displays the lifetime 50-page allowance without starting paid work", async () => {
  const { calls } = fixture({ loggedIn: true }); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "用量" }));
  expect(await screen.findByText(/可用识别额度：50 页/)).toBeTruthy();
  expect(calls.some(c => c.method === "POST" || c.type === "upload")).toBe(false);
});

it("logs out explicitly while keeping offline access and the selected cloud origin", async () => {
  const { calls } = fixture({ loggedIn: true }); render(<CloudPage />); const events = userEvent.setup();
  await events.click(await screen.findByRole("button", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "登录 PractiQ" });
  expect(calls.filter(c => c.path === "/api/auth/logout")).toHaveLength(1);
  expect((screen.getByLabelText("云端服务地址") as HTMLInputElement).value).toBe("http://127.0.0.1:8090");
  expect(screen.getByText(/离线练习和题库导入无需登录/)).toBeTruthy();
});

it("connects a service only on explicit native configuration and then reads its login policy", async () => {
  const { calls } = fixture({origin:null}); render(<CloudPage />); const events=userEvent.setup();
  const input = await screen.findByLabelText("云端服务地址");
  await waitFor(()=>expect(input.hasAttribute("disabled")).toBe(false));
  await events.type(input,"http://127.0.0.1:8100");
  expect(calls).toEqual([{type:"status"}]);
  await events.click(screen.getByRole("button",{name:"连接云端服务"}));
  await screen.findByRole("heading",{name:"登录 PractiQ"});
  expect(calls.filter(c=>c.type==="configure")).toEqual([{type:"configure",origin:"http://127.0.0.1:8100"}]);
  expect(calls.some(c=>c.method==="POST")).toBe(false);
});
it("forgets only this device's account session without implying server revocation",async()=>{
  const {calls}=fixture({loggedIn:true});render(<CloudPage />);const events=userEvent.setup();
  await screen.findByRole("button",{name:"退出登录"});
  await events.click(screen.getByText("云端连接设置"));
  await events.click(screen.getByRole("button",{name:"清除本机登录状态"}));
  await screen.findByRole("heading",{name:"登录 PractiQ"});
  expect(calls.filter(c=>c.type==="forget_session")).toHaveLength(1);
  expect(calls.some(c=>c.path==="/api/auth/logout"||c.type==="configure")).toBe(false);
});
