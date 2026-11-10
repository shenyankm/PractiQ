import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccountPortal from "../../shared/cloud/AccountPortal";
import { Banks, Usage } from "../../shared/cloud/CustomerViews";
import { setAccount } from "../../shared/cloud/accountClient";
import AdminPortal from "./AdminPortal";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); setAccount(null); vi.unstubAllGlobals(); });

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
