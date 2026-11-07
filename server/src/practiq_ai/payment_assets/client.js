"use strict";
const message = document.querySelector("#message");
const list = document.querySelector("#orders");
const pay = document.querySelector("#pay");
let csrf = "";
let unsettled = false;
const requestId = crypto.randomUUID();
const states = { UNKNOWN: "结果待确认，请勿重复付款", PENDING_PAYMENT: "待付款", PAID: "已付款", CLOSED: "已关闭" };

async function api(path, method = "GET", body) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录后查看订单。");
    if (response.status === 503) throw new Error("支付服务暂不可用或结果待确认。请查询原订单，勿重复付款。");
    throw new Error("操作未完成。请刷新原订单；结果不明时请联系管理员。");
  }
  return response.json();
}

async function act(button, operation) {
  button.disabled = true;
  try { await operation(); } catch (error) { message.textContent = error.message; }
  finally { button.disabled = button === pay && unsettled; }
}

async function refresh() {
  const orders = await api("/api/me/payments");
  unsettled = orders.some(order => ["UNKNOWN", "PENDING_PAYMENT"].includes(order.state));
  pay.disabled = unsettled;
  list.replaceChildren();
  document.querySelector("#empty").textContent = orders.length ? "" : "暂无收款订单。";
  for (const order of orders) {
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = order.subject + " · ¥" + order.amount;
    const detail = document.createElement("p");
    detail.textContent = (order.environment === "sandbox" ? "沙箱 · " : "生产 · ") + states[order.state] + " · 订单 " + order.id;
    row.append(title, detail);
    for (const refund of order.refunds) {
      const text = document.createElement("p");
      text.textContent = "退款 ¥" + refund.amount + " · " + (refund.state === "SUCCESS" ? "已退款" : "待确认，请联系管理员查询原退款号");
      row.append(text);
    }
    const query = document.createElement("button");
    query.type = "button"; query.textContent = "查询支付结果";
    query.onclick = () => act(query, async () => { await api("/api/me/payments/" + order.id + "/query", "POST"); await refresh(); });
    row.append(query);
    if (["UNKNOWN", "PENDING_PAYMENT"].includes(order.state)) {
      const resume = document.createElement("button");
      resume.type = "button"; resume.textContent = "查询后继续原订单付款";
      resume.onclick = () => act(resume, async () => submitForm(await api("/api/me/payments/" + order.id + "/form", "POST")));
      row.append(resume);
    }
    if (order.state === "PENDING_PAYMENT") {
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "关闭未付款订单";
      close.onclick = () => act(close, async () => { await api("/api/me/payments/" + order.id + "/close", "POST"); await refresh(); });
      row.append(close);
    }
    list.append(row);
  }
}

function submitForm(result) {
  const parsed = new DOMParser().parseFromString(result.paymentHtml, "text/html");
  const source = parsed.querySelector("form");
  const action = new URL(source?.getAttribute("action") || "");
  if (source?.getAttribute("method")?.toLowerCase() !== "post" || !["https://openapi-sandbox.dl.alipaydev.com", "https://openapi.alipay.com"].includes(action.origin) || action.pathname !== "/gateway.do") throw new Error("付款表单校验失败，请查询原订单。");
  // Rebuild only the SDK's form fields; never execute HTML or model/document scripts.
  const form = document.createElement("form");
  form.method = "POST"; form.action = action.href;
  for (const field of source.querySelectorAll('input[type="hidden"]')) {
    const input = document.createElement("input");
    input.type = "hidden"; input.name = field.name; input.value = field.value; form.append(input);
  }
  document.body.append(form); form.submit();
}
pay.onclick = () => act(pay, async () => {
  // Keep this request ID on uncertain transport failure. No automatic mutation replay.
  const result = await api("/api/me/payments", "POST", { requestId });
  await refresh();
  submitForm(result);
});
document.querySelector("#refresh").onclick = (event) => act(event.target, refresh);
(async () => {
  try {
    const session = await api("/api/auth/session"); csrf = session.csrf;
    if (!session.user) { message.textContent = "请先登录账号，再查看订单或发起付款。"; return; }
    await refresh();
    const offer = await api("/api/me/payments/offer");
    document.querySelector("#offer-detail").textContent = (offer.environment === "sandbox" ? "沙箱体验，不涉及真实资金。" : "正式收款。") + " " + offer.subject + " · ¥" + offer.amount;
    document.querySelector("#offer").hidden = false;
    message.textContent = location.pathname.endsWith("/return") ? "已返回商户。请查询原订单确认支付结果，同步回跳不代表付款成功。" : "可在下方发起付款或查询自己的订单。";
  } catch (error) { message.textContent = error.message; }
})();
