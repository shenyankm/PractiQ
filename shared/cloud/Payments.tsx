import { useCallback, useEffect, useState } from "react";
import { accountRequest, storageKey } from "./accountClient";
import { nativeBridge } from "./transport";
import type { PaymentOffer, PaymentOrder } from "./contracts.generated";
import { Button } from "./components/ui/button";

export function Payments() {
  const [orders, setOrders] = useState<PaymentOrder[]>([]), [offer, setOffer] = useState<PaymentOffer | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const key = storageKey("practiq-payment-request-v1");
  const read = useCallback(async () => {
    const saved = await accountRequest<PaymentOrder[]>("/api/me/payments");
    setOrders(saved);
    for (const order of saved.filter(order => ["PAID", "CLOSED"].includes(order.state))) {
      for (const recoveryKey of [key, `${key}.${order.environment}`]) {
        if (localStorage.getItem(recoveryKey) === order.requestId) localStorage.removeItem(recoveryKey);
      }
    }
    try { setOffer(await accountRequest<PaymentOffer>("/api/me/payments/offer")); }
    catch { setOffer(null); setError("支付当前未开通或配置不可用，已保存订单仍可查看。"); }
  }, [key]);
  async function checkout() {
    if (!offer) throw new Error("Payment offer unavailable");
    const recoveryKey = `${key}.${offer.environment}`;
    const legacy = localStorage.getItem(key);
    const legacyOrder = legacy ? orders.find(order => order.requestId === legacy) : undefined;
    const current = localStorage.getItem(recoveryKey);
    if (!current && legacy && !legacyOrder) throw new Error("Unknown legacy payment environment");
    const saved = current || (legacyOrder?.environment === offer.environment ? legacy : null);
    if (saved && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(saved)) throw new Error("Invalid payment recovery record");
    const id = saved || crypto.randomUUID();
    localStorage.setItem(recoveryKey, id);
    if (localStorage.getItem(recoveryKey) !== id) throw new Error("Payment request was not saved");
    await nativeBridge()!.checkout(id);
  }
  useEffect(() => { let active = true; void read().catch(() => { if (active) setError("订单读取失败，请手动刷新。"); }); return () => { active = false; }; }, [read]);
  async function act(job: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await job(); }
    catch { setError("操作未确认。请查询原订单，不要重复付款。支付不会自动增加文档额度。"); }
    finally { try { await read(); } catch { setError("订单读取失败，请稍后手动刷新原订单。"); } setBusy(false); }
  }
  const pending = orders.some(order => order.environment === offer?.environment && ["UNKNOWN", "PENDING_PAYMENT"].includes(order.state));
  const names = { UNKNOWN: "结果待确认", PENDING_PAYMENT: "待付款", PAID: "已付款", CLOSED: "已关闭" };
  return <section className="account-content"><h1>订单与付款</h1><p>付款由支付宝收银台完成。返回 App 后查询原订单确认结果；付款不自动增加文档识别额度。</p>
    {error && <p role="alert">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void act(async () => {})}>刷新订单</Button>
    {offer && <section className="account-bank"><div><h2>{offer.subject}</h2><p>{offer.environment === "sandbox" ? "沙箱体验，不涉及真实资金" : "正式收款"} · ¥{offer.amount}</p></div><Button disabled={busy || pending || !nativeBridge()} onClick={() => void act(checkout)}>前往支付宝付款</Button></section>}
    {!orders.length && <p>暂无收款订单。</p>}
    <ul>{orders.map(order => <li className="account-bank" key={order.id}><div><strong>{order.subject} · ¥{order.amount}</strong><p>{order.environment === "sandbox" ? "沙箱" : "生产"} · {names[order.state]}</p><small>订单 {order.id}</small>{order.refunds.map(refund => <p key={refund.id}>退款 ¥{refund.amount} · {refund.state === "SUCCESS" ? "已退款" : "结果待确认，请联系管理员"}</p>)}</div><div className="task-actions">
      <Button variant="outline" disabled={busy || order.environment !== offer?.environment} onClick={() => void act(() => accountRequest(`/api/me/payments/${order.id}/query`, "POST"))}>查询支付结果</Button>
      {["UNKNOWN", "PENDING_PAYMENT"].includes(order.state) && <Button variant="outline" disabled={busy || order.environment !== offer?.environment || !nativeBridge()} onClick={() => void act(() => nativeBridge()!.checkout(order.requestId, order.id))}>继续原订单付款</Button>}
      {order.state === "PENDING_PAYMENT" && <Button variant="outline" disabled={busy || order.environment !== offer?.environment} onClick={() => void act(() => accountRequest(`/api/me/payments/${order.id}/close`, "POST"))}>关闭未付款订单</Button>}
    </div></li>)}</ul>
  </section>;
}
