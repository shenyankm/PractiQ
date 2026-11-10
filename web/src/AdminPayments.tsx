import { useEffect, useRef, useState } from "react";
import { accountRequest as request, storageKey } from "../../shared/cloud/accountClient";
import { AccountError, errorMessage, Field } from "../../shared/cloud/accountUI";
import type { AdministrationFilter, AdministrationPaymentOrder, PaymentRefund } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

import { FilterBar, query, type AdminNavigate } from "./adminTools";

type RefundIntent = { orderId: string; requestId: string; amount: string; reason: string };
const orderPattern = /^[a-f0-9]{32}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function pending(key: string): RefundIntent | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as RefundIntent;
  if (Object.keys(value).sort().join() !== "amount,orderId,reason,requestId" || !orderPattern.test(value.orderId) || !uuid.test(value.requestId) || !/^\d{1,9}(\.\d{1,2})?$/.test(value.amount) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 200) throw Error("退款恢复记录无法读取，请保留本机记录并联系管理员核实。");
  return value;
}
export function AdminPayments({ initial = {}, initialId = "", navigate }: { initial?: AdministrationFilter; initialId?: string; navigate?: AdminNavigate }) {
  const [filters, setFilters] = useState<AdministrationFilter>(initial);
  const selection = useRef(0);
  const key = storageKey("practiq-admin-refund-v1");
  const [orders, setOrders] = useState<AdministrationPaymentOrder[]>([]), [order, setOrder] = useState<AdministrationPaymentOrder | null>(null);
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [id, setId] = useState(""), [password, setPassword] = useState(""), [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [intent, setIntent] = useState<RefundIntent | null>(null), [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    try { const saved = pending(key); setIntent(saved); if (saved) setId(saved.orderId); }
    catch (e) { setBlocked(true); setError(errorMessage(e)); }
  }, [key]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void request<AdministrationPaymentOrder[]>(`/api/admin/payments?${query(filters, offset)}`, "GET", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setOrders(value); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, revision, filters]);
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController(), selected = ++selection.current;
    void request<AdministrationPaymentOrder>(`/api/admin/payments/${encodeURIComponent(initialId)}`, "GET", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted && selected === selection.current) { setOrder(value); setId(value.id); setAmount(value.amount); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [initialId]);
  async function act(job: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await job(); } catch (e) { setError(errorMessage(e)); }
    finally { setPassword(""); setBusy(false); }
  }
  function settle(receipt: PaymentRefund) {
    if (receipt.state === "SUCCESS") {
      const saved = pending(key);
      if (saved?.requestId === receipt.id) { localStorage.removeItem(key); setIntent(null); }
      else setIntent(saved);
    }
    setNotice(receipt.state === "SUCCESS" ? "原退款已确认成功。" : "退款结果待确认，权益保持冻结。请查询原退款，勿发起另一笔。");
  }
  async function refund() {
    if (!order || blocked) return;
    const saved = pending(key);
    if (saved && saved.requestId !== intent?.requestId) { setIntent(saved); throw Error("另一个窗口有未确认退款，请先核对保留的原请求。"); }
    if (!intent && !reason.trim()) throw Error("请填写退款原因。");
    const attempt = intent ?? { orderId: order.id, requestId: crypto.randomUUID(), amount, reason: reason.trim() };
    // Persist the identity before dispatch; uncertainty only permits the same request.
    const encoded = JSON.stringify(attempt);
    localStorage.setItem(key, encoded);
    if (localStorage.getItem(key) !== encoded) throw Error("退款恢复记录未保存，已停止提交。");
    setIntent(attempt);
    const currentPassword = password; setPassword("");
    try {
      settle(await request<PaymentRefund>(`/api/admin/payments/${attempt.orderId}/refunds`, "POST", { requestId: attempt.requestId, amount: attempt.amount, reason: attempt.reason, currentPassword }));
      setOrder(await request(`/api/admin/payments/${attempt.orderId}`)); setRevision(v => v + 1);
    } catch (e) {
      if (!intent && e instanceof Error && ["PASSWORD_REQUIRED", "CSRF_INVALID", "REFUND_AMOUNT_INVALID", "PLAN_REFUND_REQUIRES_UNUSED_FULL_ORDER", "REFUND_LIMIT_EXCEEDED"].includes(e.message) && localStorage.getItem(key) === encoded) { localStorage.removeItem(key); setIntent(null); }
      throw e;
    }
  }
  const selected = order && (!intent || intent.orderId === order.id);
  return <section>
    <h1>订单与退款</h1>
    <FilterBar kind="payments" initial={initial} apply={value => { selection.current++; setFilters(value); setOffset(0); setOrder(null); setPassword(""); }} />
    <p>查询和查看订单不会付款或调用模型。退款需要管理员当前密码；未知结果保留原请求，只查询或显式重试原退款。</p>
    {error && <AccountError error={error} />}{notice && <p role="status">{notice}</p>}
    <form className="account-form" onSubmit={e => { e.preventDefault(); void act(async () => { selection.current++; const value = await request<AdministrationPaymentOrder>(`/api/admin/payments/${id}`); setOrder(value); setAmount(value.amount); }); }}>
      <label className="account-field">订单编号<Input required pattern="[a-f0-9]{32}" value={id} onChange={e => setId(e.target.value)} disabled={busy} /></label>
      <Button variant="outline" disabled={busy}>读取原订单</Button>
    </form>
    {intent && <p role="status">保留的退款请求：{intent.requestId}，订单：{intent.orderId}，金额：¥{intent.amount}。请先读取此订单。</p>}
    {loading ? <p role="status">正在读取订单…</p> : !orders.length ? <p>暂无订单。</p> : <div className="account-table"><table><thead><tr><th>订单</th><th>用户</th><th>金额</th><th>环境 / 状态</th><th>操作</th></tr></thead><tbody>{orders.map(row => <tr key={row.id}><td>{row.subject}<br />{row.id}</td><td>{navigate ? <Button variant="link" onClick={() => navigate("users", {}, row.ownerId)}>{row.ownerId}</Button> : row.ownerId}</td><td>¥{row.amount}</td><td>{row.environment} / {row.state}</td><td><Button variant="outline" disabled={busy} onClick={() => { selection.current++; setOrder(row); setId(row.id); setAmount(row.amount); setReason(""); setPassword(""); }}>查看订单 {row.id}</Button></td></tr>)}</tbody></table></div>}
    <nav className="admin-pagination" aria-label="订单分页"><Button variant="outline" disabled={busy || !offset} onClick={() => setOffset(v => Math.max(0, v - 50))}>上一页</Button><Button variant="outline" disabled={busy || orders.length < 50} onClick={() => setOffset(v => v + 50)}>下一页</Button><Button variant="outline" disabled={busy} onClick={() => setRevision(v => v + 1)}>刷新订单</Button></nav>
    {order && <section className="settings-panel mt-6" aria-label="订单详情"><h2>{order.subject}</h2><p>订单 {order.id} · 用户 {order.ownerId} · ¥{order.amount} · {order.environment} / {order.state}</p>
      <p>{order.grant ? `权益 ${order.grant.state}，已用或预留 ${order.grant.usedPages} / ${order.grant.totalPages} 页，可用 ${order.grant.remainingPages} 页，到期 ${new Date(order.grant.expiresAt).toLocaleString()}` : "此订单没有正式页数权益。"}</p>
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => { setOrder(await request(`/api/admin/payments/${order.id}/query`, "POST")); setRevision(v => v + 1); })}>查询支付宝订单</Button>
      {order.refunds.map(receipt => <div key={receipt.id}><p>退款 {receipt.id} · ¥{receipt.amount} · {receipt.state}</p><Button variant="outline" disabled={busy || receipt.state === "SUCCESS" && intent?.requestId !== receipt.id} onClick={() => void act(async () => { const result = await request<PaymentRefund>(`/api/admin/payments/${order.id}/refunds/${receipt.id}/query`, "POST"); if (intent?.requestId === receipt.id) settle(result); setOrder(await request(`/api/admin/payments/${order.id}`)); })}>查询退款 {receipt.id}</Button></div>)}
      <form className="account-form" onSubmit={e => { e.preventDefault(); void act(refund); }}><fieldset disabled={busy || blocked || !selected || order.state !== "PAID" || order.providerClosed}>
        <legend>{intent ? "显式重试原退款" : "发起退款"}</legend><p>付费套餐仅支持未使用、未预留额度的整单退款。请核对买家实际付款金额；提交后先冻结权益。</p>
        <Field name="refund-password" label="管理员当前密码" type="password" value={password} onChange={setPassword} />
        <label className="account-field">退款金额（元）<Input required inputMode="decimal" pattern="[0-9]{1,9}(\.[0-9]{1,2})?" value={intent?.amount ?? amount} readOnly={!!intent} onChange={e => setAmount(e.target.value)} /></label>
        <label className="account-field">退款原因<Input required maxLength={200} value={intent?.reason ?? reason} readOnly={!!intent} onChange={e => setReason(e.target.value)} /></label>
        <Button disabled={busy || blocked || !selected || order.state !== "PAID" || order.providerClosed}>{intent ? "显式重试原退款" : "确认发起退款"}</Button>
      </fieldset></form>
    </section>}
  </section>;
}
