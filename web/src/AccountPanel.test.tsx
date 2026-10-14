import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import AccountPanel from "./AccountPanel";
import { Client } from "./api";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
it("reads updated balance and paged ledger without any model or recharge mutation", async () => {
  const user = userEvent.setup(), calls: RequestInit[] = []; let balance = "-5000";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push(init);
    if (url === "/api/products") return json({ items: [{ productId: "pack", name: "导入套餐", pointsMicropoints: "1000000", purchaseUrl: "https://checkout.example/purchase" }] });
    if (url.startsWith("/api/account/ledger")) return json({ items: [{ id: url.includes("before=") ? 1 : 2, amountMicropoints: "1000000", kind: url.includes("before=") ? "model" : "purchase", createdAt: "2026-10-13T01:00:00Z" }], nextBefore: url.includes("before=") ? null : 2 });
    return json({ phone: "+8613800138000", balanceMicropoints: balance, usageUnknown: false });
  }));
  render(<AccountPanel client={new Client("account-token", "13800138000")} revision={0} />);
  await screen.findByText(/充值先抵扣欠额/);
  expect(screen.getByRole("link", { name: "前往购买" }).getAttribute("href")).toBe("https://checkout.example/purchase");
  expect(screen.queryByLabelText("追加卡密")).toBeNull();
  balance = "995000"; await user.click(screen.getByRole("button", { name: "刷新余额与商品" }));
  await screen.findByText(/可用积分：0.995/);
  await user.click(screen.getByRole("button", { name: "查看积分明细" }));
  await screen.findByText(/支付到账/);
  await user.click(await screen.findByRole("button", { name: "更早明细" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  expect(calls.every(call => !call.method || call.method === "GET")).toBe(true);
});
it("keeps unknown usage blocked and allows manual retries after failed reads", async () => {
  const user = userEvent.setup(); let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/account/ledger")) throw new TypeError("offline");
    if (failed) throw new TypeError("offline");
    if (url === "/api/products") return json({ items: [] });
    return json({ phone: "+8613800138000", balanceMicropoints: "1000000", usageUnknown: true });
  }));
  render(<AccountPanel client={new Client("account-token", "13800138000")} revision={0} />);
  await screen.findByRole("alert"); failed = false;
  await user.click(screen.getByRole("button", { name: "刷新余额与商品" }));
  await screen.findByText(/有调用用量待核对/);
  await user.click(screen.getByRole("button", { name: "查看积分明细" }));
  await screen.findByText(/积分明细读取失败/);
});
