import { cloudLocale, t, useCloudLocale } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, FileStack, RefreshCw } from "lucide-react";
import { accountRequest, storageKey } from "./accountClient";
import { nativeBridge } from "./transport";
import type { AccountPlan, PaymentCreate, PaymentOrder } from "./contracts.generated";
import { Button } from "./components/ui/button";

type ProductId = NonNullable<PaymentCreate["productId"]>;
type Recovery = { requestId: string; productId: ProductId };
const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function recovery(raw: string | null): Recovery | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Recovery;
  if (!requestPattern.test(value.requestId) || !["plus", "pro", "pages50"].includes(value.productId)) throw new Error(t("付款恢复记录无法读取，请联系管理员核实原订单。"));
  return value;
}
const date = (value: string) => new Date(value).toLocaleString(cloudLocale(), { dateStyle: "medium", timeStyle: "short" });
const orderStates = { UNKNOWN: "结果待确认", PENDING_PAYMENT: "待付款", PAID: "已付款", CLOSED: "已关闭" };
const grantStates = { active: "可使用", expired: "已到期", refund_pending: "退款待确认，额度已冻结", refunded: "已退款" };
const issues: Record<string, string> = {
  PLAN_ALREADY_ACTIVE: "当前套餐尚未到期，可购买加量包；到期后再选择套餐。",
  PAYMENT_PENDING_EXISTS: "还有未确认订单，请先查询或继续原订单。",
  PAYMENT_PRODUCT_CHANGED: "购买内容与原请求不同，请继续原订单，勿重复付款。",
  PAYMENT_APPLICATION_CHANGED: "收款环境已变更，请联系管理员核实原订单。",
};

export function Payments({ view = "plans", onNavigate }: { view?: "plans" | "orders"; onNavigate?: (page: "plans" | "payments") => void }) {
  useCloudLocale();
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [data, setData] = useState<AccountPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Recovery | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [notice, setNotice] = useState("");
  const key = storageKey("practiq-plan-request-v1");
  const legacyKey = storageKey("practiq-payment-request-v1");
  const read = useCallback(async () => {
    const [next, receipts] = await Promise.all([
      accountRequest<AccountPlan>("/api/me/plans"), accountRequest<PaymentOrder[]>("/api/me/payments"),
    ]);
    setData(next); setOrders(receipts);
    setRecoveryBlocked(false);
    const terminal = receipts.filter(order => ["PAID", "CLOSED"].includes(order.state));
    for (const order of terminal) {
      for (const oldKey of [legacyKey, `${legacyKey}.${order.environment}`]) {
        if (localStorage.getItem(oldKey) === order.requestId) localStorage.removeItem(oldKey);
      }
    }
    try {
      const currentKey = `${key}.${next.environment}`;
      let pending = next.environment ? recovery(localStorage.getItem(currentKey)) : null;
      if (pending && terminal.some(order => order.environment === next.environment && order.requestId === pending!.requestId)) {
        localStorage.removeItem(currentKey); pending = null;
      }
      setSaved(pending);
      const legacy = localStorage.getItem(legacyKey);
      const scoped = next.environment ? localStorage.getItem(`${legacyKey}.${next.environment}`) : null;
      if ((legacy && !receipts.some(order => order.requestId === legacy)) || (scoped && !receipts.some(order => order.requestId === scoped))) {
        setRecoveryBlocked(true); setError(t("检测到旧版未确认付款请求，请联系管理员核实原请求，不要重新下单。"));
      }
    } catch {
      setRecoveryBlocked(true); setError(t("付款恢复记录无法读取，已暂停新购买。请联系管理员核实原订单。"));
    }
  }, [key, legacyKey]);
  useEffect(() => {
    let active = true;
    void read().catch(() => { if (active) setError(t("套餐与订单读取失败，请手动刷新。")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [read]);
  async function act(job: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await job(); }
    catch (value) { setError(t(issues[value instanceof Error ? value.message : ""] || "") || t("操作未确认。请查询或继续原订单，不要重复付款。")); }
    finally {
      try { await read(); } catch { setData(null); setError(t("套餐与订单读取失败，请手动刷新原订单。")); }
      setBusy(false);
    }
  }
  async function checkout(productId: ProductId) {
    if (!data?.checkoutEnabled || !data.environment || !nativeBridge() || recoveryBlocked) throw new Error("PAYMENTS_DISABLED");
    const currentKey = `${key}.${data.environment}`;
    const pending = recovery(localStorage.getItem(currentKey));
    if (pending && pending.productId !== productId) throw new Error("PAYMENT_PRODUCT_CHANGED");
    const attempt = pending || { requestId: crypto.randomUUID(), productId };
    localStorage.setItem(currentKey, JSON.stringify(attempt));
    if (localStorage.getItem(currentKey) !== JSON.stringify(attempt)) throw new Error("Payment recovery unavailable");
    setSaved(attempt);
    await nativeBridge()!.checkout(attempt.requestId, undefined, attempt.productId);
    setNotice(t("支付宝收银台已打开。付款后回到这里，查询原订单确认到账与额度。"));
  }
  const pending = orders.some(order => order.environment === data?.environment && ["UNKNOWN", "PENDING_PAYMENT"].includes(order.state));
  const blocked = busy || loading || !data?.checkoutEnabled || !nativeBridge() || pending || recoveryBlocked || !!saved;
  const balance = data?.balance;
  return <section className="plans-page">
    <header className="plans-heading"><div><h1>{view === "plans" ? t("套餐与额度") : t("订单与付款")}</h1><p>{view === "plans" ? t("按需整理文档，安心离线练习。") : t("付款由支付宝完成，到账以服务端查单或验签通知为准。")}</p></div><Button variant="outline" disabled={busy || loading} onClick={() => void act(async () => {})}><RefreshCw size={16} aria-hidden="true" />{view === "plans" ? t("刷新额度") : t("刷新订单")}</Button></header>
    {loading && <p role="status">{t("正在读取套餐与订单…")}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {data && !data.checkoutEnabled && <p className="notice" role="status">{t("支付当前未开通。可以查看套餐与现有权益，暂时无法购买；离线练习照常使用。")}</p>}
    {data?.environment === "sandbox" && <p className="notice" role="status">{t("沙箱测试：收银台测试金额为 ¥")}{data.sandboxAmount}{t("，下列价格为正式售价。测试订单不会发放正式套餐或页数。")}</p>}
    {saved && <div className="plan-recovery"><p>{t("有一笔 ")}{saved.productId === "pages50" ? t("加量包") : saved.productId === "plus" ? "Plus" : "Pro"}{t(" 购买尚未确认。请继续同一请求。")}</p><Button variant="outline" disabled={busy || !data?.checkoutEnabled || !nativeBridge() || pending || recoveryBlocked} onClick={() => void act(() => checkout(saved.productId))}>{t("继续确认原购买")}</Button></div>}
    {pending && view === "plans" && onNavigate && <p className="plan-recovery">{t("有未确认订单，先核实原订单再购买。")}<Button variant="outline" onClick={() => onNavigate("payments")}>{t("查看订单并确认")}</Button></p>}
    {view === "orders" && onNavigate && <p><Button variant="outline" onClick={() => onNavigate("plans")}>{t("查看套餐与额度")}</Button></p>}
    {view === "plans" && balance && <>
      <section className="plan-balance" aria-labelledby="current-plan-title"><div><h2 id="current-plan-title">{t("当前套餐 · ")}{balance.plan === "free" ? "Free" : balance.plan === "plus" ? "Plus" : "Pro"}</h2><p>{balance.expiresAt ? t("有效至 {0}，不自动续费", date(balance.expiresAt)) : t("离线功能长期免费，赠送页数不按月恢复")}</p></div><dl><div><dt>{t("可用识别额度")}</dt><dd>{balance.remainingPages}<span>{t(" 页")}</span></dd></div><div><dt>{t("其中免费额度")}</dt><dd>{balance.freeRemainingPages}<span> / {balance.freePages}{t(" 页")}</span></dd></div><div><dt>{t("同时处理任务")}</dt><dd>{balance.activeTasks}<span>{t(" 个")}</span></dd></div></dl></section>
      <div className="plan-options" aria-label={t("套餐对比")}>{data.products.filter(item => item.id !== "pages50").map(item => <article key={item.id} className={`plan-option${item.id === "plus" ? " plan-recommended" : ""}`}>
        <div className="plan-option-title"><h2>{item.name}</h2>{item.id === "plus" && <span className="plan-tag">{t("日常备考推荐")}</span>}</div>
        <p>{item.id === "free" ? t("先体验文档导入，完整使用离线练习。") : item.id === "plus" ? t("持续整理试卷，建立自己的题库。") : t("集中整理多科资料，减少排队等待。")}</p>
        <p className="plan-price">¥{Number(item.amount).toFixed(0)}<span>{item.durationDays ? t(" / {0} 天", item.durationDays) : ""}</span></p>
        <ul><li><FileStack size={17} aria-hidden="true" />{item.pages}{t(" 页")}{item.id === "free" ? t("注册赠送，共计一次") : t("云端导入额度")}</li><li><Clock3 size={17} aria-hidden="true" />{item.durationDays ? t("{0} 天有效 · 手动购买", item.durationDays) : t("未用免费页数长期保留")}</li><li><Check size={17} aria-hidden="true" />{t("同时处理 ")}{item.activeTasks}{t(" 个任务")}{item.priority ? t(" · 优先队列") : ""}</li></ul>
        <Button variant={item.id === "plus" ? "default" : "outline"} disabled={item.id === "free" || blocked || balance.plan !== "free"} onClick={() => void act(() => checkout(item.id as ProductId))}>{item.id === balance.plan ? t("当前套餐") : item.id === "free" ? t("免费离线使用") : balance.plan !== "free" ? t("当前套餐到期后可购买") : t("购买 {0}", item.name)}</Button>
      </article>)}</div>
      {data.products.filter(item => item.id === "pages50").map(item => <section className="plan-topup" key={item.id}><div><h2>{t("临时不够用？加 ")}{item.pages}{t(" 页")}</h2><p>¥{item.amount}，{item.durationDays}{t(" 天有效。各档均可购买，不改变当前套餐与队列优先级。")}</p></div><Button variant="outline" disabled={blocked} onClick={() => void act(() => checkout("pages50"))}>{t("购买 ")}{item.pages}{t(" 页加量包")}</Button></section>)}
      <section className="plan-included"><h2>{t("所有套餐，都完整保留你的学习能力")}</h2><p>{t("本地题库、练习、模考、错题、统计、备份与题库 ZIP 导入导出均开放，无需登录即可离线使用。云端各档使用相同识别能力，支持的格式、复核和 ZIP 导出不分档。")}</p><p>{t("云端额度包含文档识别、题目结构化及原文已有答案和解析的提取。套餐暂不包含托管 AI 批改或额外答案生成的服务承诺；自带 API Key 的直连批改各档均可使用，费用由模型供应商收取。")}</p></section>
      <section className="plan-ledger"><h2>{t("额度明细")}</h2><div className="account-table"><table><thead><tr><th scope="col">{t("来源")}</th><th scope="col">{t("总页数")}</th><th scope="col">{t("已用 / 预留")}</th><th scope="col">{t("可用")}</th><th scope="col">{t("到期时间")}</th><th scope="col">{t("状态")}</th></tr></thead><tbody><tr><td>{t("免费额度")}</td><td>{balance.freePages}</td><td>{balance.freeUsedPages}</td><td>{balance.freeRemainingPages}</td><td>{t("长期保留")}</td><td>{t("累计使用")}</td></tr>{balance.grants.map(grant => <tr key={grant.orderId}><td>{grant.productId === "pages50" ? t("50 页加量包") : grant.productId === "plus" ? "Plus" : "Pro"}</td><td>{grant.totalPages}</td><td>{grant.usedPages}</td><td>{grant.remainingPages}</td><td>{date(grant.expiresAt)}</td><td>{t(grantStates[grant.state])}</td></tr>)}</tbody></table></div></section>
      <details className="plan-rules"><summary>{t("页数、到期和退款如何计算？")}</summary><ul><li>{t("优先使用最早到期的付费额度，再使用免费页数。付费额度到期不结转；免费 50 页不重复赠送。")}</li><li>{t("按实际提交识别的页数计量，图片切片可能产生多页。Office、文本等未知页数按剩余额度限制处理；结果页码筛选不减少识别提交页数。")}</li><li>{t("查看、复核、下载已有结果不重复扣页。明确重新识别会消耗额度；结果未知时保留预占，核实后结算，勿重复提交。")}</li><li>{t("各档云端结果均保留 180 天。套餐到期不影响已下载题库和本地练习数据。")}</li><li>{t("当前付费商品仅支持未使用、未预留额度的整单退款，请联系管理员。退款待确认时冻结该笔权益，已确认退款后收回，不删除本地题库。")}</li><li>{t("平台故障可联系管理员核实并补偿额度。优先队列不抢占执行中的任务，也不承诺固定完成时长。")}</li></ul></details>
    </>}
    {view === "orders" && <><h2>{t("购买记录")}</h2>{!loading && !orders.length && <p>{t("暂无订单。可在“套餐与额度”中选择所需套餐。")}</p>}<ul className="plan-orders">{orders.map(order => <li className="account-bank" key={order.id}><div><h3>{order.subject} · ¥{order.amount}</h3><p>{order.environment === "sandbox" ? t("沙箱") : t("正式收款")} · {order.providerClosed ? t("支付宝交易已关闭，权益已停止") : t(orderStates[order.state])}{order.productId && !order.providerClosed && order.state === "PAID" ? order.environment === "sandbox" ? t(" · 测试订单不发放正式权益") : t(" · 权益见套餐与额度") : ""}</p><small>{t("订单 ")}{order.id}</small>{order.refunds.map(refund => <p key={refund.id}>{t("退款 ¥")}{refund.amount} · {refund.state === "SUCCESS" ? t("已退款") : t("结果待确认，请联系管理员")}</p>)}</div><div className="task-actions"><Button variant="outline" disabled={busy || !data?.checkoutEnabled || order.environment !== data.environment} onClick={() => void act(() => accountRequest(`/api/me/payments/${order.id}/query`, "POST"))}>{t("查询支付结果")}</Button>{!order.providerClosed && ["UNKNOWN", "PENDING_PAYMENT"].includes(order.state) && <Button variant="outline" disabled={busy || !data?.checkoutEnabled || order.environment !== data.environment || !nativeBridge()} onClick={() => void act(() => nativeBridge()!.checkout(order.requestId, order.id))}>{t("继续原订单付款")}</Button>}{!order.providerClosed && order.state === "PENDING_PAYMENT" && <Button variant="outline" disabled={busy || !data?.checkoutEnabled || order.environment !== data.environment} onClick={() => void act(() => accountRequest(`/api/me/payments/${order.id}/close`, "POST"))}>{t("关闭未付款订单")}</Button>}</div></li>)}</ul></>}
  </section>;
}
