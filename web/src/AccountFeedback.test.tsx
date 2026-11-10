import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccountPortal from "../../shared/cloud/AccountPortal";
import { Banks, Usage } from "../../shared/cloud/CustomerViews";
import { setAccount } from "../../shared/cloud/accountClient";
import AdminPortal from "./AdminPortal";
import { Records } from "../../shared/cloud/accountUI";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); setAccount(null); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

it.each([0, 1])("hides record pagination when the first page contains %i records", async count => {
  const rows = Array.from({ length: count }, () => ({ id: "one", email: "one@example.test" }));
  vi.stubGlobal("fetch", async () => response(rows));
  render(<Records path="/api/admin/users" paginated />);
  await waitFor(() => expect(screen.queryByText("正在读取记录…")).toBeNull());
  expect(screen.queryByText("one@example.test") !== null).toBe(count === 1);
  expect(screen.queryByRole("navigation", { name: "记录分页" })).toBeNull();
});

it("shows allowance numbers directly while keeping every explicit override", async () => {
  vi.stubGlobal("fetch", async () => response([{ id: "one", limits: { freePages: 50, modelCalls: 20, tencentCalls: 5, activeTasks: 2 } }, { id: "two", limits: {} }]));
  render(<Records path="/api/admin/users" />);
  await screen.findByText("50 页"); expect(screen.getByText("每日模型调用数：20")).toBeTruthy(); expect(screen.getByText("每日腾讯提交数：5")).toBeTruthy(); expect(screen.getByText("进行中任务数：2")).toBeTruthy();
  expect(screen.queryByText("查看详情")).toBeNull(); expect(screen.getByText("—")).toBeTruthy();
});

it("keeps the administrator signed in after cancelling logout and sends one confirmed request", async () => {
  let signedIn = true; const writes: string[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(path); signedIn = false; }
    return response(path === "/api/auth/session" ? { user: signedIn ? { id: "admin", email: "admin@example.test", name: "", role: "admin", enabled: true } : null, csrf: "fixture", registrationEnabled: true } : []);
  });
  render(<AdminPortal />); const user = userEvent.setup();
  const logout = await screen.findByRole("button", { name: "退出登录" }); await user.click(logout);
  let dialog = await screen.findByRole("alertdialog", { name: "确认退出登录？" }); expect(writes).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "取消" })); expect(writes).toEqual([]);
  await user.click(logout); await user.keyboard("{Escape}"); expect(writes).toEqual([]); expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(logout); dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "确认退出" }));
  await screen.findByRole("heading", { name: "登录管理后台" }); await waitFor(() => expect(writes).toEqual(["/api/auth/logout"]));
});

it.each([AdminPortal, AccountPortal])("recovers a failed session read explicitly without replaying login", async Portal => {
  let reads = 0;
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => ++reads === 1 ? response({ detail: { code: "SERVICE_UNAVAILABLE" } }, 503) : response({ user: null, csrf: "fixture", registrationEnabled: true }));
  vi.stubGlobal("fetch", fetcher); render(<Portal />); const user = userEvent.setup();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("请求未完成，请核对状态后再决定是否重试。");
  expect(alert.closest(".account-card")).toBeTruthy();
  expect(within(alert).getByText("SERVICE_UNAVAILABLE").closest("details")).toHaveProperty("open", false);
  expect(screen.queryByLabelText("登录邮箱")).toBeNull();
  await user.click(screen.getByRole("button", { name: "重新读取登录状态" }));
  await screen.findByLabelText("登录邮箱"); expect(screen.queryByRole("alert")).toBeNull();
  expect(reads).toBe(2);
  expect(fetcher.mock.calls).toEqual([
    ["/api/auth/session", expect.objectContaining({ method: "GET" })],
    ["/api/auth/session", expect.objectContaining({ method: "GET" })],
  ]);
});

it.each([
  { Component: Banks, value: { items: [], hasMore: false }, result: "尚无已保存结果，请先导入文档。" },
  { Component: Usage, value: { remainingPages: 50, usedPages: 0, limits: { modelCalls: 1000, tencentCalls: 50, activeTasks: 1 }, daily: [], calls: [] }, result: "可用识别额度：50 页，累计已使用或预留 0 页。" },
])("retries a failed customer read and removes its stale error", async ({ Component, value, result }) => {
  let reads = 0;
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => ++reads === 1 ? response({ detail: { code: "SERVICE_UNAVAILABLE" } }, 503) : response(value));
  vi.stubGlobal("fetch", fetcher); render(<Component open={vi.fn()} />); const user = userEvent.setup();
  await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "重试读取" }));
  await screen.findByText(result); expect(screen.queryByRole("alert")).toBeNull();
  expect(reads).toBe(2);
  expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
});
