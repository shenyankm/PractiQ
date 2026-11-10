import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setAccount } from "../../shared/cloud/accountClient";
import { AdminUserDetails } from "./AdminUserDetails";
import { AdminAudit, AdminOperations, AdminUsage } from "./AdminReports";
import { FilterBar } from "./adminTools";
import { adminUserDetail } from "./test-fixtures";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); setAccount(null); vi.unstubAllGlobals(); });
it("previews an allowance change and sends its reason and expected original total only on explicit submit", async () => {
  let detail = adminUserDetail(); const writes: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); detail = { ...detail, balance: { ...detail.balance, freePages: 75, freeRemainingPages: 68, remainingPages: 68 } }; }
    return response(detail);
  }); vi.stubGlobal("fetch", fetcher);
  render(<AdminUserDetails id="alice" navigate={vi.fn()} changed={vi.fn()} />); const user = userEvent.setup();
  await screen.findByText(/alice@example.test/); expect(writes).toEqual([]);
  await user.type(screen.getByLabelText("新的免费总额度（页）"), "75");
  await user.type(screen.getByLabelText("调整原因"), "Platform fault compensation");
  await user.type(screen.getByLabelText("管理员当前密码"), "synthetic-password");
  expect(screen.getByText(/全部可用页数 68 页/)).toBeTruthy(); expect(writes).toEqual([]);
  await user.click(screen.getByRole("button", { name: "确认调整总额度" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body).toMatchObject({ freePages: 75, expectedFreePages: 50, reason: "Platform fault compensation" });
  await waitFor(() => expect(screen.getByLabelText("管理员当前密码")).toHaveProperty("value", ""));
});
it("keeps a rejected allowance draft without replaying it and clears its password", async () => {
  let writes = 0; vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; return response({ detail: { code: "ALLOWANCE_CHANGED" } }, 409); }
    return response(adminUserDetail());
  }); render(<AdminUserDetails id="alice" navigate={vi.fn()} changed={vi.fn()} />); const user = userEvent.setup();
  await screen.findByText(/alice@example.test/);
  await user.type(screen.getByLabelText("新的免费总额度（页）"), "75"); await user.type(screen.getByLabelText("调整原因"), "Support correction"); await user.type(screen.getByLabelText("管理员当前密码"), "synthetic-password"); await user.click(screen.getByRole("button", { name: "确认调整总额度" }));
  await screen.findByRole("alert"); expect(writes).toBe(1); expect(screen.getByLabelText("新的免费总额度（页）")).toHaveProperty("value", "75"); expect(screen.getByLabelText("管理员当前密码")).toHaveProperty("value", "");
});
it("opens credential metadata passively and requires confirmation before targeted revocation", async () => {
  const writes: string[] = []; const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true); vi.stubGlobal("confirm", confirm);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") { writes.push(path); return response({ ok: true }); }
    if (path.includes("/sessions?")) return response([{ id: "derived-session-id", createdAt: "2026-11-09T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z", lastSeen: "2026-11-09T00:01:00Z" }]);
    if (path.includes("/tokens?")) return response([]);
    return response(adminUserDetail());
  }); render(<AdminUserDetails id="alice" navigate={vi.fn()} changed={vi.fn()} />); const user = userEvent.setup();
  await screen.findByText(/alice@example.test/); await user.click(screen.getByRole("button", { name: "管理该用户会话与令牌" })); await screen.findByText("derived-session-id"); expect(writes).toEqual([]);
  await user.type(screen.getByLabelText("管理员当前密码", { selector: "#sessions-password" }), "synthetic-password"); await user.type(screen.getAllByLabelText("撤销原因")[0], "Lost device");
  await user.click(screen.getByRole("button", { name: "撤销此凭证" })); expect(writes).toEqual([]);
  await user.click(screen.getByRole("button", { name: "撤销此凭证" })); await waitFor(() => expect(writes).toEqual(["/api/admin/users/alice/sessions/derived-session-id"]));
});
it("renders usage totals and associates a call with its task without writing", async () => {
  const navigate = vi.fn(); const fetcher = vi.fn(async (path: string) => response(path.includes("/summary?") ? { totals: { calls: 1, failedCalls: 0, unknownCalls: 1, pendingCalls: 0, pages: 7, inputTokens: 0, outputTokens: 0, unknownTokenCalls: 1 }, items: [], hasMore: false } : [{ call_key: "call-id", user_id: "alice", email: "alice@example.test", scope: "task:task-id", provider: "test-model", state: "unknown", status: "failed", record: {} }])); vi.stubGlobal("fetch", fetcher);
  render(<AdminUsage initial={{ userId: "alice", state: "unknown" }} navigate={navigate} />); const user = userEvent.setup();
  await screen.findByText("1 次调用"); await user.click(await screen.findByRole("button", { name: "task:task-id" })); expect(navigate).toHaveBeenCalledWith("tasks", {}, "task-id"); expect(fetcher.mock.calls.every(([path]) => path.includes("userId=alice") && path.includes("state=unknown"))).toBe(true);
});
it("shows audit before/after values and searches the same object", async () => {
  const fetcher = vi.fn(async () => response([{ id: 1, actor: "admin", action: "allowance_update", target: "alice", created_at: "2026-11-09T00:00:00Z", detail: { reason: "Support adjustment", before: { freePages: 50 }, after: { freePages: 75 } } }])); vi.stubGlobal("fetch", fetcher);
  render(<AdminAudit navigate={vi.fn()} />); const user = userEvent.setup(); await user.click(await screen.findByText("查看变更前后")); expect(screen.getByText("50")).toBeTruthy(); expect(screen.getByText("75")).toBeTruthy(); await user.click(screen.getByRole("button", { name: "同一对象记录" })); await waitFor(() => expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining("target=alice"), expect.anything()));
});
it("does not treat missing monitoring evidence as healthy and exposes exception links", async () => {
  vi.stubGlobal("fetch", async () => response({ observedAt: "2026-11-09T00:00:00Z", codeVersion: "test", schemaVersion: 8, maintenance: false, readOnly: false, accepting: true, broker: { publisher: true, consumer: false }, runs: { pending: 2, running: 1 }, outboxPending: 2, oldestPendingSeconds: 12, queueCapacity: 300, workersAvailable: 7, storageHealthy: null, storageFreeBytes: null, modelId: "test-model", parserConfigured: true, costCurrency: "CNY", dailyCostLimitMicros: null, dailyReservedMicros: 0, taskCostLimitMicros: null, monitoringState: "not_configured", monitoring: null })); const navigate = vi.fn(); render(<AdminOperations navigate={navigate} />); const user = userEvent.setup();
  await screen.findByText("未接入外部状态"); expect(screen.getByText(/缺少证据时不视为健康/)).toBeTruthy(); await user.click(screen.getByRole("button", { name: "退款未确认或权益冻结" })); expect(navigate).toHaveBeenCalledWith("payments", { issue: "refund" });
});
it("applies filters explicitly and clears them with one action", async () => {
  const apply = vi.fn(); render(<FilterBar kind="users" apply={apply} />); const user = userEvent.setup(); await user.type(screen.getByLabelText("搜索邮箱、昵称或用户编号"), "alice"); expect(apply).not.toHaveBeenCalled(); await user.selectOptions(screen.getByLabelText("账户状态"), "false"); await user.click(screen.getByRole("button", { name: "应用筛选" })); expect(apply).toHaveBeenCalledWith(expect.objectContaining({ q: "alice", enabled: false, offset: 0 })); await user.click(screen.getByRole("button", { name: "清除筛选" })); expect(apply).toHaveBeenLastCalledWith({});
});

it("distinguishes loading, no tasks and filtered empty results without starting work", async () => {
  const { AdminTasks } = await import("./AdminViews");
  let finish!: (value: Response) => void;
  const first = new Promise<Response>(resolve => { finish = resolve; });
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => fetcher.mock.calls.length === 1 ? first : response({ items: [], hasMore: false }));
  vi.stubGlobal("fetch", fetcher); render(<AdminTasks navigate={vi.fn()} />); const user = userEvent.setup();
  expect(screen.getByText("正在读取任务…")).toBeTruthy(); expect(screen.queryByText(/暂无导入任务/)).toBeNull();
  finish(response({ items: [], hasMore: false })); await screen.findByText("暂无导入任务。任务创建后将在这里显示。");
  await user.type(screen.getByLabelText("搜索邮箱、文件名或任务编号"), "missing");
  await user.click(screen.getByRole("button", { name: "应用筛选" }));
  await screen.findByText("没有匹配的任务，请调整或清除上方筛选。");
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  await screen.findByText("暂无导入任务。任务创建后将在这里显示。");
  expect(fetcher.mock.calls).toHaveLength(3);
  expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
});
