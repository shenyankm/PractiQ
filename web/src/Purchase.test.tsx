import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import Purchase, { paymentProducts } from "./Purchase";
import { Client } from "./api";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const product = { productId: "pack", name: "导入额度包", priceCents: 900, pointsMicropoints: "1000000" };
const order = { ...product, orderId: "123456", status: "pending", createdAt: "2026-10-14T00:00:00Z", expiresAt: "2099-10-14T00:30:00Z", creditedMicropoints: "0" };
const balance = { phone: "+8613800138000", balanceMicropoints: "1000000", usageUnknown: false };
async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("手机号"), "13800138000");
  await user.type(screen.getByLabelText("账户令牌"), "account-token");
  await user.click(screen.getByRole("button", { name: "连接账户" }));
  await screen.findByRole("button", { name: "断开连接" });
}
function transport(extra?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init }); const value = extra?.(path, init); if (value) return value;
    if (path.endsWith("products")) return json({ items: [product] });
    if (path.endsWith("/account")) return json(balance);
    if (path.split("?")[0].endsWith("/orders") && init.method !== "POST") return json({ items: [order], hasMore: false });
    if (path.endsWith("/pay")) return json({ url: "https://openapi-sandbox.dl.alipaydev.com/gateway.do?method=alipay.trade.page.pay" });
    return json(order);
  })); return calls;
}
it("creates explicitly and confirms direct credit with private account headers", async () => {
  const user = userEvent.setup(); let credited = false;
  const calls = transport(path => path.endsWith("/123456") ? json(credited ? { ...order, status: "credited", creditedMicropoints: "1000000" } : order) : undefined);
  render(<Purchase />); await connect(user);
  await user.selectOptions(await screen.findByLabelText("额度包"), "pack");
  expect(calls.every(call => call.init.method !== "POST")).toBe(true);
  await user.click(screen.getByRole("button", { name: "创建充值订单" }));
  await user.click(await screen.findByRole("button", { name: "准备支付宝支付" }));
  expect((await screen.findByRole("link", { name: /打开支付宝付款/ })).getAttribute("rel")).toBe("noopener noreferrer");
  credited = true; await user.click(screen.getByRole("button", { name: "查询支付与到账" }));
  await screen.findByText(/本单已增加 1 额度/);
  expect(screen.queryByLabelText("已购卡密")).toBeNull();
  expect(calls.filter(call => call.init.method === "POST").map(call => call.path)).toEqual(["/api/payments/orders", "/api/payments/orders/123456/pay"]);
  for (const call of calls.filter(call => !call.path.endsWith("products"))) {
    expect(new Headers(call.init.headers).get("Authorization")).toBe("Account account-token");
    expect(call.path.includes("account-token")).toBe(false);
  }
  expect(localStorage.length + sessionStorage.length).toBe(0);
});
it("reuses request ID after an uncertain create without automatic retry", async () => {
  const user = userEvent.setup(), requests: string[] = [];
  transport((path, init) => {
    if (path.split("?")[0].endsWith("/orders") && init.method === "POST") {
      requests.push(init.body as string);
      if (requests.length === 1) return Promise.reject(new TypeError("offline"));
    } return undefined;
  });
  render(<Purchase />); await connect(user);
  await user.selectOptions(screen.getByLabelText("额度包"), "pack");
  await user.click(screen.getByRole("button", { name: "创建充值订单" }));
  await screen.findByRole("alert"); expect(requests).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "创建充值订单" }));
  await screen.findByText("等待付款确认"); expect(requests[0]).toBe(requests[1]);
});
it("restores order history using passive reads and clears credentials on disconnect", async () => {
  const user = userEvent.setup(), calls = transport(); render(<Purchase />); await connect(user);
  await user.click(screen.getByRole("button", { name: "查询订单" }));
  await screen.findByText("等待付款确认"); expect(calls.every(call => call.init.method !== "POST")).toBe(true);
  await user.click(screen.getByRole("button", { name: "断开连接" }));
  expect((screen.getByLabelText("账户令牌") as HTMLInputElement).value).toBe("");
});
it("keeps credentials when connection fails and never creates an order", async () => {
  const user = userEvent.setup(), calls = transport(path => path.endsWith("/account") ? new Response("", { status:401 }) : undefined);
  render(<Purchase />);
  await user.type(screen.getByLabelText("手机号"), "13800138000"); await user.type(screen.getByLabelText("账户令牌"), "account-token");
  await user.click(screen.getByRole("button", { name: "连接账户" })); await screen.findByRole("alert");
  expect((screen.getByLabelText("账户令牌") as HTMLInputElement).value).toBe("account-token");
  expect(calls.every(call => call.init.method !== "POST")).toBe(true);
});
it("shows failed and empty catalogs with explicit refresh", async () => {
  const user = userEvent.setup(); let fail = true;
  transport(path => path.endsWith("products") ? fail ? new Response("", { status:503 }) : json({ items:[] }) : undefined);
  render(<Purchase />); await screen.findByText(/商品暂不可用/); fail = false;
  await user.click(screen.getByRole("button", { name:"刷新商品" })); await connect(user); await screen.findByText(/暂无可购买商品/);
});
it.each(["https://evil.example/pay", "https://openapi.alipay.com/gateway.do?method=other"])("rejects unexpected checkout address %s", async url => {
  const user = userEvent.setup(); transport(path => path.endsWith("/pay") ? json({ url }) : undefined);
  render(<Purchase />); await connect(user); await user.selectOptions(screen.getByLabelText("额度包"), "pack");
  await user.click(screen.getByRole("button", { name: "创建充值订单" })); await user.click(await screen.findByRole("button", { name: "准备支付宝支付" }));
  await screen.findByText(/支付地址无效/); expect(screen.queryByRole("link", { name: /打开支付宝付款/ })).toBeNull();
});
it("rejects forbidden requests with credentials outside URLs", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("", { status:401 })); vi.stubGlobal("fetch", fetch);
  await expect(new Client("account-token","13800138000").paymentOrder("123456")).rejects.toThrow(/账户令牌不匹配/);
  expect(fetch.mock.calls[0][0]).toBe("/api/payments/orders/123456"); expect(fetch).toHaveBeenCalledOnce();
});
it("bounds catalog response before decoding JSON", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "Content-Length": String(2*1024*1024+1) } })));
  await expect(paymentProducts()).rejects.toThrow(/响应超过浏览器大小限制/);
});
