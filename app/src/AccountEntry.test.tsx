// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import { invoke } from "./transport";
import { capabilities } from "../../shared/cloud/test-fixtures";
import { setNativeBridge } from "../../shared/cloud/transport";
import { setAccount } from "../../shared/cloud/accountClient";
import type { AccountUser } from "./contracts.generated";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
vi.mock("./transport", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
afterEach(() => { cleanup(); setNativeBridge(null); setAccount(null); vi.resetAllMocks(); vi.unstubAllEnvs(); });

function fixture(origin: string | null, user: AccountUser | null = null) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  vi.mocked(api).mockImplementation(async request => {
    if (request.type === "banks") return [] as never;
    if (["banks_page", "sessions_page"].includes(request.type)) return { items: [], total: 0, offset: 0 } as never;
    if (request.type === "info") return { version: "test", dataDirectory: "/mock" } as never;
    if (request.type === "unfinished_session") return null as never;
    if (request.type === "backup_status") return { lastBackupAt: null, newAttempts: 0, changedNotes: 0, due: false } as never;
    throw Error(`Unexpected local request ${request.type}`);
  });
  const state = { origin, generation: 1, user };
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const r = args!.request as Record<string, unknown>;
    if (r.type === "status") return { value: { origin: state.origin, generation: state.generation }, generation: state.generation } as never;
    if (r.type !== "fetch") throw Error(`Unexpected cloud request ${r.type}`);
    let data: unknown = [];
    if (r.path === "/api/auth/session") data = { user: state.user, csrf: "", registrationEnabled: true };
    if (r.path === "/api/auth/logout") { state.user = null; state.generation++; data = { ok: true }; }
    if (r.path === "/api/import-capabilities") data = capabilities;
    if (r.path === "/api/me/plans") data = { checkoutEnabled: false, environment: null, sandboxAmount: null, products: [], balance: { plan: "free", expiresAt: null, activeTasks: 1, freePages: 50, freeUsedPages: 13, freeRemainingPages: 37, remainingPages: 37, grants: [] } };
    if (r.path === "/api/import-settings") data = { revision: "preview", settings: { tencentConcurrency: 1, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };
    if (String(r.path).startsWith("/api/document-tasks")) data = { items: [], hasMore: false };
    return { value: { status: 200, mediaType: "application/json", bytes: Buffer.from(JSON.stringify(data)).toString("base64") }, generation: state.generation } as never;
  });
  return state;
}

it("opens allowance from Settings without exposing provider configuration or starting model work", async () => {
  vi.stubEnv("VITE_DEMO_MODE", "true");
  fixture("https://cloud.example.test", { id: "owner", name: "小章鱼", email: "owner@example.test", role: "user", enabled: true });
  render(<App />); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(await screen.findByRole("button", { name: "查看额度" }));
  expect(await screen.findByRole("heading", { name: "套餐与额度", level: 1 })).toBeTruthy();
  expect(await screen.findByText("可用识别额度")).toBeTruthy();
  expect(screen.getByText("可用识别额度").closest("div")?.textContent).toContain("37");
  expect(screen.queryByRole("navigation", { name: "个人导航" })).toBeNull();
  expect(screen.queryByRole("button", { name: "导入工作区" })).toBeNull();
  expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("cloud_request", expect.objectContaining({ request: expect.objectContaining({ path: "/api/import-settings" }) }));
  expect(invoke).not.toHaveBeenCalledWith("cloud_request", expect.objectContaining({ request: expect.objectContaining({ path: "/api/import-capabilities" }) }));
  await user.click(screen.getByRole("button", { name: "购买记录" }));
  expect(await screen.findByRole("heading", { name: "购买记录" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "查看套餐与额度" }));
  expect(await screen.findByText("可用识别额度")).toBeTruthy();
  expect(screen.queryByLabelText("模型 API 地址")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "ai_request")).toBe(false);
  await user.click(screen.getByRole("button", { name: "返回设置" }));
  expect(await screen.findByRole("button", { name: "导出备份" })).toBeTruthy();
});

it("hides only the personal-center sidebar entry in demo mode", async () => {
  vi.stubEnv("VITE_DEMO_MODE", "true");
  fixture(null); render(<App />);
  const user = userEvent.setup();
  expect(await screen.findByRole("button", {name:"从云端解析文档"})).toBeTruthy();
  expect(screen.queryByRole("button", {name:"个人中心"})).toBeNull();
  expect(screen.getByRole("button", {name:"设置"})).toBeTruthy();
  await user.click(screen.getByRole("button", {name:"文档导入"}));
  expect(await screen.findByRole("heading", {name:"文档导入",level:1})).toBeTruthy();
  expect(await screen.findByRole("heading", {name:"连接云端服务"})).toBeTruthy();
});

it("keeps local work available and offers a connection entry when no cloud service is configured", async () => {
  fixture(null); render(<App />); const user = userEvent.setup();
  const entry = screen.getByRole("button", { name: "个人中心" });
  await waitFor(() => expect(entry.getAttribute("aria-description")).toBe("未连接云端"));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("cloud_request", { request: { type: "status" }, context: null });
  await user.click(entry);
  await screen.findByRole("heading", { name: "个人中心", level: 1 });
  expect(await screen.findByRole("heading", { name: "连接云端服务", level: 2 })).toBeTruthy();
  expect(screen.getByLabelText("云端服务地址")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "我的题库" }));
  await screen.findByRole("heading", { name: "我的题库", level: 1 });
});

it("shows the signed-in identity globally, opens personal information directly and updates after logout", async () => {
  fixture("https://cloud.example.test", { id: "owner", name: "小章鱼", email: "owner@example.test", role: "user", enabled: true });
  render(<App />); const user = userEvent.setup();
  const entry = screen.getByRole("button", { name: "个人中心" });
  await waitFor(() => expect(entry.getAttribute("aria-description")).toBe("小章鱼"));
  await user.click(entry);
  const profile = await screen.findByRole("region", { name: "个人信息" });
  expect(within(profile).getByText("owner@example.test")).toBeTruthy();
  expect(within(profile).getByText("普通用户")).toBeTruthy();
  expect(within(profile).getByText("正常")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "登录 PractiQ" });
  await waitFor(() => expect(entry.getAttribute("aria-description")).toBe("未登录"));
  const mutations = vi.mocked(invoke).mock.calls.map(([,a]) => a!.request as Record<string, unknown>).filter(r => r.type === "fetch" && r.method !== "GET");
  expect(mutations).toEqual([{ type: "fetch", path: "/api/auth/logout", method: "POST", body: null }]);
});

it("fences delayed account metadata after an origin change and clears identity on session expiry", async () => {
  const state = fixture("https://old.example.test");
  const original = vi.mocked(invoke).getMockImplementation()!;
  let complete!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(original).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockImplementation(original);
  render(<App />);
  await waitFor(() => expect(complete).toBeDefined());
  state.origin = "https://new.example.test"; state.generation++;
  state.user = { id: "new-owner", name: "New account", email: "new@example.test", role: "user", enabled: true };
  await act(async () => { window.dispatchEvent(new Event("practiq-cloud-account-changed")); });
  const entry = screen.getByRole("button", { name: "个人中心" });
  await waitFor(() => expect(entry.getAttribute("aria-description")).toBe("New account"));
  await act(async () => complete({ value: { status: 200, mediaType: "application/json", bytes: Buffer.from(JSON.stringify({ user: { ...state.user, name: "Old account" } })).toString("base64") }, generation: 1 }));
  expect(entry.getAttribute("aria-description")).toBe("New account");
  await act(async () => { window.dispatchEvent(new Event("practiq-session-expired")); });
  expect(entry.getAttribute("aria-description")).toBe("未登录");
});

it("keeps offline navigation available when the configured account cannot be read", async () => {
  fixture("https://cloud.example.test"); vi.mocked(invoke).mockRejectedValue(new Error("Service unavailable"));
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "个人中心" }).getAttribute("aria-description")).toBe("账户状态暂不可用"));
  expect(screen.getByRole("heading", { name: "我的题库", level: 1 })).toBeTruthy();
  expect(screen.getByRole("button", { name: "个人中心" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "我的题库" }).hasAttribute("disabled")).toBe(false);
});


it.each([401, 403])("treats rejected account access as signed out without automatically retrying (%s)", async status => {
  fixture("https://cloud.example.test");
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if ((args!.request as { type: string }).type === "fetch") return { value: { status, mediaType: "application/json", bytes: Buffer.from("{}").toString("base64") }, generation: 1 } as never;
    return original(command, args);
  });
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "个人中心" }).getAttribute("aria-description")).toBe("未登录"));
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("keeps login usable after logout when anonymous session reads rotate the native generation", async () => {
  const account = { id: "owner", name: "原生账户", email: "owner@example.test", role: "user" as const, enabled: true };
  const state = fixture("https://cloud.example.test", account);
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const request = args!.request as { type: string; path?: string };
    const context = args!.context as { generation: number } | null;
    if (request.type === "fetch") {
      if (request.path === "/api/auth/session") { if (!state.user) state.generation++; }
      else if (context?.generation !== state.generation) throw { code: "CLOUD_ACCOUNT_CHANGED" };
      if (request.path === "/api/auth/login") {
        state.user = account; state.generation++;
        return { value: { status: 200, mediaType: "application/json", bytes: Buffer.from(JSON.stringify({ user: account, csrf: "", registrationEnabled: true })).toString("base64") }, generation: state.generation } as never;
      }
    }
    return original(command, args);
  });
  render(<App />); const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "个人中心" }).getAttribute("aria-description")).toBe(account.name));
  await user.click(screen.getByRole("button", { name: "个人中心" }));
  await user.click(await screen.findByRole("button", { name: "退出登录" }));
  await screen.findByRole("heading", { name: "登录 PractiQ" });
  await waitFor(() => expect(screen.getByRole("button", { name: "个人中心" }).getAttribute("aria-description")).toBe("未登录"));
  await act(async () => { window.dispatchEvent(new Event("practiq-cloud-account-changed")); });
  await waitFor(() => expect(screen.getByRole("button", { name: "个人中心" }).getAttribute("aria-description")).toBe("未登录"));
  await user.type(screen.getByLabelText("登录邮箱"), account.email);
  await user.type(screen.getByLabelText("密码", { exact: true }), "native-test-password");
  await user.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("region", { name: "个人信息" })).toBeTruthy();
  expect(screen.queryByText("云端连接或账号已变化，请重新读取登录状态。")).toBeNull();
});
