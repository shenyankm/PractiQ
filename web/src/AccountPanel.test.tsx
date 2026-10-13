import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import AccountPanel from "./AccountPanel";
import { Client } from "./api";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
it("redeems additional cards with the current credential and reads paged ledger without model mutations", async () => {
  const user = userEvent.setup(), onRecharge = vi.fn();
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/products") return json({ items: [{ productId: "pack", name: "导入套餐", pointsMicropoints: "1000000", purchaseUrl: "https://shop.example/pack" }] });
    if (url === "/api/cards/redeem") return json({ phone: "+8613800138000", balanceMicropoints: "995000", usageUnknown: false });
    if (url.startsWith("/api/account/ledger")) return json({ items: [{ id: url.includes("before=") ? 1 : 2, amountMicropoints: "-25000", kind: "model", createdAt: "2026-10-13T01:00:00Z" }], nextBefore: url.includes("before=") ? null : 2 });
    return json({ phone: "+8613800138000", balanceMicropoints: "-5000", usageUnknown: false });
  }));
  render(<AccountPanel client={new Client("bound-card", "13800138000")} revision={0} onRecharge={onRecharge} />);
  await screen.findByText(/充值先抵扣欠额/);
  expect(screen.getByRole("link", { name: "前往链动小铺购买" }).getAttribute("href")).toBe("https://shop.example/pack");
  await user.type(screen.getByLabelText("追加卡密"), "new-card");
  await user.click(screen.getByRole("button", { name: "兑换积分" }));
  await waitFor(() => expect(onRecharge).toHaveBeenCalledOnce());
  const request = calls.find(call => call.url === "/api/cards/redeem")!;
  expect(JSON.parse(request.init.body as string)).toEqual({ phone: "13800138000", card: "new-card", boundCard: "bound-card" });
  expect((screen.getByLabelText("追加卡密") as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "查看积分明细" }));
  await user.click(await screen.findByRole("button", { name: "更早明细" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  expect(calls.filter(call => call.init.method === "POST")).toHaveLength(1);
  expect(calls.every(call => !call.url.includes("card") || call.url === "/api/cards/redeem")).toBe(true);
});

it("keeps unknown usage blocked and offers explicit retries after uncertain redemption and failed reads", async () => {
  const user = userEvent.setup(); let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/cards/redeem" || url.startsWith("/api/account/ledger")) throw new TypeError("offline");
    if (failed) throw new TypeError("offline");
    if (url === "/api/products") return json({ items: [] });
    return json({ phone: "+8613800138000", balanceMicropoints: "1000000", usageUnknown: true });
  }));
  const onRecharge = vi.fn();
  render(<AccountPanel client={new Client("bound", "13800138000")} revision={0} onRecharge={onRecharge} />);
  await screen.findByRole("alert"); failed = false;
  await user.click(screen.getByRole("button", { name: "刷新余额与商品" }));
  await screen.findByText(/有调用用量待核对/);
  await user.type(screen.getByLabelText("追加卡密"), "new");
  await user.click(screen.getByRole("button", { name: "兑换积分" }));
  await screen.findByText(/兑换未确认/); expect(onRecharge).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看积分明细" }));
  await screen.findByText(/积分明细读取失败/);
});

it("clears an unredeemed draft card when switching phone credentials", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/products" ? { items: [] } : { phone: "+8613800138000", balanceMicropoints: "1000000", usageUnknown: false })));
  const first = new Client("first", "13800138000");
  const view = render(<AccountPanel client={first} revision={0} onRecharge={() => {}} />);
  await user.type(await screen.findByLabelText("追加卡密"), "private-unredeemed-card");
  first.disconnect();
  view.rerender(<AccountPanel client={new Client("second", "13900139000")} revision={0} onRecharge={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText("追加卡密") as HTMLInputElement).value).toBe(""));
});
