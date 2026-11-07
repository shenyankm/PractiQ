import { readFile } from "node:fs/promises";
import { expect, test as runner, type Page } from "playwright/test";
import { withEvidence } from "../../shared/browser-evidence.mjs";

const test = withEvidence(runner);
const receipt = (state = "UNKNOWN", environment = "sandbox") => ({
  id: "a".repeat(32), requestId: "11111111-1111-4111-8111-111111111111",
  state, environment, amount: "1.00", subject: "测试收款", refunds: [],
});

async function paymentHTTP(page: Page) {
  const server = {
    environment: "sandbox", orders: [] as ReturnType<typeof receipt>[],
    requests: [] as string[], queryState: "PAID", loseResponse: false, offerUnavailable: false,
  };
  // Keep the same page instance after checkout; never submit to a real gateway.
  await page.addInitScript(() => { HTMLFormElement.prototype.submit = function () { this.remove(); }; });
  await page.route("**/payments{,/**}", async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === "/payments" || path === "/payments/return" ? "index.html" : path.split("/").at(-1)!;
    const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/html";
    await route.fulfill({ contentType, body: await readFile(new URL(`../../server/src/practiq_ai/payment_assets/${file}`, import.meta.url)) });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/session") return respond({ user: { id: "alice" }, csrf: "fixture-csrf" });
    if (path === "/api/me/payments/offer") return respond({ environment: server.environment, amount: "1.00", subject: "测试收款" }, server.offerUnavailable ? 503 : 200);
    if (path === "/api/me/payments" && request.method() === "GET") return respond(server.orders);
    if (path === "/api/me/payments") {
      const { requestId } = request.postDataJSON();
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      server.requests.push(requestId);
      let order = server.orders.find(item => item.requestId === requestId);
      if (!order) {
        order = { ...receipt("UNKNOWN", server.environment), id: server.requests.length.toString(16).padStart(32, "0"), requestId };
        server.orders.unshift(order);
      }
      if (server.loseResponse) {
        server.loseResponse = false;
        return respond({ code: "PAYMENT_RESULT_UNKNOWN" }, 503);
      }
      if (["PAID", "CLOSED"].includes(order.state)) return respond({ code: "PAYMENT_ALREADY_SETTLED" }, 409);
      order.state = "PENDING_PAYMENT";
      return respond({ order, paymentHtml: '<form method="post" action="https://openapi-sandbox.dl.alipaydev.com/gateway.do"><input type="hidden" name="test" value="fixture"></form>' });
    }
    const order = server.orders.find(item => path.includes(item.id));
    if (order && path.endsWith("/query")) { order.state = server.queryState; return respond(order); }
    if (order && path.endsWith("/close")) { order.state = "CLOSED"; return respond(order); }
    throw new Error(`Unexpected payment request: ${request.method()} ${path}`);
  });
  return server;
}

for (const terminal of ["PAID", "CLOSED"]) {
  test(`payment can start again in the same page after ${terminal}`, async ({ page }) => {
    const server = await paymentHTTP(page);
    await page.goto("/payments");
    const pay = page.getByRole("button", { name: "前往支付宝付款", exact: true });
    await expect(pay).toBeEnabled();
    await pay.click();
    await expect(pay).toBeDisabled();
    await page.getByRole("button", { name: terminal === "PAID" ? "查询支付结果" : "关闭未付款订单", exact: true }).click();
    await expect(page.getByText(terminal === "PAID" ? /沙箱 · 已付款/ : /沙箱 · 已关闭/)).toBeVisible();
    await expect(pay).toBeEnabled();
    await pay.click();
    await expect(pay).toBeDisabled();
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).not.toBe(server.requests[0]);
    expect(server.orders).toHaveLength(2);
  });
}

test("lost create response retains its request ID until that receipt is confirmed settled", async ({ page }) => {
  const server = await paymentHTTP(page);
  server.orders.push(receipt("PAID"));
  server.loseResponse = true;
  await page.goto("/payments");
  const pay = page.getByRole("button", { name: "前往支付宝付款", exact: true });
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(page.getByRole("status")).toContainText("结果待确认");
  await pay.click();
  await expect(pay).toBeDisabled();
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).toBe(server.requests[0]);
  await page.getByRole("button", { name: "查询支付结果", exact: true }).first().click();
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(pay).toBeDisabled();
  expect(server.requests[2]).not.toBe(server.requests[0]);
});

test("a lost create response can settle through query without replaying create", async ({ page }) => {
  const server = await paymentHTTP(page);
  server.loseResponse = true;
  await page.goto("/payments");
  const pay = page.getByRole("button", { name: "前往支付宝付款", exact: true });
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(page.getByRole("status")).toContainText("结果待确认");
  await page.getByRole("button", { name: "刷新订单", exact: true }).click();
  await expect(pay).toBeDisabled();
  await page.getByRole("button", { name: "查询支付结果", exact: true }).click();
  await expect(pay).toBeEnabled();
  await pay.click();
  await expect(pay).toBeDisabled();
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).not.toBe(server.requests[0]);
});

test("production payments ignore unresolved sandbox receipts but retain their history", async ({ page }) => {
  const server = await paymentHTTP(page);
  server.environment = "production";
  server.orders.push(receipt());
  await page.goto("/payments/return");
  await expect(page.getByText(/沙箱 · 结果待确认/)).toBeVisible();
  await expect(page.getByRole("status")).toContainText("同步回跳不代表付款成功");
  const pay = page.getByRole("button", { name: "前往支付宝付款", exact: true });
  await expect(pay).toBeEnabled();
  expect(server.requests).toHaveLength(0);
  await pay.click();
  await expect(pay).toBeDisabled();
  await expect(page.getByText(/生产 · 待付款/)).toBeVisible();
  await expect(page.getByText(/沙箱 · 结果待确认/)).toBeVisible();
  expect(server.requests).toHaveLength(1);
});

test("saved receipts remain visible when the current payment offer is unavailable", async ({ page }) => {
  const server = await paymentHTTP(page);
  server.offerUnavailable = true;
  server.orders.push(receipt("PAID"));
  await page.goto("/payments");
  await expect(page.getByText(/沙箱 · 已付款/)).toBeVisible();
  await expect(page.getByRole("status")).toContainText("支付服务暂不可用");
  await expect(page.getByRole("button", { name: "前往支付宝付款", exact: true })).toBeHidden();
  expect(server.requests).toHaveLength(0);
});
