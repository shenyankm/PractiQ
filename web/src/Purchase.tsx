import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, Unplug } from "lucide-react";
import logo from "./assets/octopus.png";
import { Client, pointLabel, readBytes } from "./api";
import type { ImportAccount, PaymentOrder, PaymentOrders, PaymentProducts } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

const statusLabels = { pending: "等待付款确认", paid: "已付款，额度待到账", credited: "额度已到账", closed: "交易已关闭" };
export async function paymentProducts(signal?: AbortSignal): Promise<PaymentProducts> {
  const response = await fetch("/api/payments/products", { cache: "no-store", credentials: "omit", redirect: "error", signal });
  if (!response.ok) throw new Error("商品暂不可用，请刷新重试。");
  return JSON.parse(new TextDecoder().decode(await readBytes(response, 2 * 1024 * 1024))) as PaymentProducts;
}
export default function Purchase() {
  const [catalog, setCatalog] = useState<PaymentProducts | null>(null);
  const [productId, setProductId] = useState(new URLSearchParams(location.search).get("product") ?? "");
  const [phone, setPhone] = useState("");
  const [credential, setCredential] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [account, setAccount] = useState<ImportAccount | null>(null);
  const [history, setHistory] = useState<PaymentOrders | null>(null);
  const [offset, setOffset] = useState(0);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [paymentUrl, setPaymentUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => () => client?.disconnect(), [client]);
  useEffect(() => {
    const controller = new AbortController();
    void paymentProducts(controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "商品读取失败。"); });
    return () => controller.abort();
  }, [revision]);
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未确认，请重试查询。"); }
    finally { setBusy(false); }
  }
  function connect() {
    void action(async () => {
      const current = new Client(credential.trim(), phone.trim());
      try {
        const value = await current.paymentAccount();
        const orders = await current.paymentOrders();
        if (current.active) { setAccount(value); setHistory(orders); setClient(current); setCredential(""); setPhone(""); }
      } catch (cause) { current.disconnect(); throw cause; }
    });
  }
  function disconnect() {
    client?.disconnect(); setClient(null); setAccount(null); setHistory(null); setOrder(null); setPaymentUrl(""); setCredential(""); setPhone(""); setOffset(0); setError("");
  }
  function create() {
    if (!client) return;
    void action(async () => { const value = await client.createPayment(productId); if (client.active) { setOrder(value); setPaymentUrl(""); if (!offset) setHistory(previous => ({ items: [value, ...(previous?.items.filter(item => item.orderId !== value.orderId) ?? [])].slice(0, 20), hasMore: previous?.hasMore || (previous?.items.length ?? 0) >= 20 })); } });
  }
  function refresh(id: string) {
    if (!client) return;
    void action(async () => { const value = await client.paymentOrder(id); const balance = await client.paymentAccount(); if (client.active) { setOrder(value); setAccount(balance); setPaymentUrl(""); setHistory(previous => previous ? { ...previous, items: previous.items.map(item => item.orderId === value.orderId ? value : item) } : previous); } });
  }
  function orders(nextOffset = offset) {
    if (!client) return;
    void action(async () => { const value = await client.paymentOrders(nextOffset); const balance = await client.paymentAccount(); if (client.active) { setHistory(value); setAccount(balance); setOffset(nextOffset); } });
  }
  function pay() {
    if (!client || !order) return;
    void action(async () => {
      const result = await client.paymentLink(order.orderId);
      const url = new URL(result.url);
      if (!["https://openapi.alipay.com/gateway.do", "https://openapi-sandbox.dl.alipaydev.com/gateway.do"].includes(url.origin + url.pathname) || url.username || url.password || url.hash || url.searchParams.get("method") !== "alipay.trade.page.pay") throw new Error("支付地址无效，请重试查询。");
      if (client.active) setPaymentUrl(url.href);
    });
  }
  return <main className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8 sm:px-8">
    <header className="flex items-center gap-4"><img src={logo} alt="PractiQ" className="h-14 w-14 object-contain" /><div><h1 className="text-3xl font-semibold">购买导入额度</h1><p className="mt-1 text-muted-foreground">支付确认后，额度直接进入当前账户。</p></div></header>
    {!client ? <section className="space-y-4"><h2 className="text-xl font-semibold">连接已有账户</h2><p className="text-sm text-muted-foreground">使用运营签发的账户令牌。凭据只保存在本页内存，刷新后重新连接即可查询订单。</p><form className="space-y-3" onSubmit={event => { event.preventDefault(); connect(); }}><label className="block space-y-2"><span>手机号</span><Input type="tel" autoComplete="off" maxLength={16} value={phone} onChange={event => setPhone(event.target.value)} disabled={busy} /></label><label className="block space-y-2"><span>账户令牌</span><Input type="password" autoComplete="off" maxLength={64} value={credential} onChange={event => setCredential(event.target.value)} disabled={busy} /></label><Button disabled={busy || !phone.trim() || !credential.trim()}>连接账户</Button></form></section> : <>
      <section className="flex flex-wrap items-center justify-between gap-3"><p>{account?.phone} · 可用额度：{account ? pointLabel(account.balanceMicropoints) : "读取中"}</p><Button variant="outline" disabled={busy} onClick={disconnect}><Unplug />断开连接</Button></section>
      {!order ? <section className="space-y-4"><h2 className="text-xl font-semibold">选择额度包</h2>{!catalog ? <p role="status">正在读取商品…</p> : !catalog.items.length ? <p>暂无可购买商品，请联系服务提供方。</p> : <><label className="block space-y-2"><span>额度包</span><select className="w-full rounded-md border bg-background p-3" value={productId} onChange={event => setProductId(event.target.value)} disabled={busy}><option value="">请选择</option>{catalog.items.map(product => <option key={product.productId} value={product.productId}>{product.name} · ¥{(product.priceCents / 100).toFixed(2)} · {pointLabel(product.pointsMicropoints)} 额度</option>)}</select></label><Button disabled={busy || !catalog.items.some(item => item.productId === productId)} onClick={create}>创建充值订单</Button></>}</section> : <section className="space-y-4"><h2 className="text-xl font-semibold">{order.name}</h2><p className="tabular-nums">¥{(order.priceCents / 100).toFixed(2)} · {pointLabel(order.pointsMicropoints)} 额度</p><p role="status">{statusLabels[order.status]}</p><p className="break-all text-sm text-muted-foreground">订单号：{order.orderId}</p>
        <div className="flex flex-wrap gap-3">{order.status === "pending" && <Button disabled={busy || Date.now() >= Date.parse(order.expiresAt)} onClick={pay}><ArrowUpRight />准备支付宝支付</Button>}{paymentUrl && order.status === "pending" && <a className="inline-flex min-h-12 items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground" href={paymentUrl} target="_blank" rel="noopener noreferrer">打开支付宝付款<ArrowUpRight /></a>}<Button variant="outline" disabled={busy} onClick={() => refresh(order.orderId)}><RefreshCw />查询支付与到账</Button><Button variant="outline" disabled={busy} onClick={() => { setOrder(null); setPaymentUrl(""); }}>返回商品</Button></div>
        {order.status === "credited" ? <p>本单已增加 {pointLabel(order.creditedMicropoints)} 额度。充值不会自动继续解析，请回到任务中手动继续。</p> : <p className="text-sm text-muted-foreground">付款后请查询确认。支付入口有效期 30 分钟；结果不明时查询原订单，不要重复付款。</p>}
      </section>}
      <section className="space-y-4 border-t pt-6"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">我的订单</h2><Button variant="outline" disabled={busy} onClick={() => orders()}><RefreshCw />刷新订单与余额</Button></div>{history?.items.length ? <ul className="space-y-3">{history.items.map(item => <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4" key={item.orderId}><div><p>{item.name} · ¥{(item.priceCents / 100).toFixed(2)}</p><p className="text-sm text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · {statusLabels[item.status]}</p></div><Button variant="outline" disabled={busy} onClick={() => refresh(item.orderId)}>查询订单</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">暂无订单。创建充值订单后可在这里恢复查询。</p>}<div className="flex gap-3">{offset > 0 && <Button variant="outline" disabled={busy} onClick={() => orders(offset - 20)}>上一页</Button>}{history?.hasMore && <Button variant="outline" disabled={busy} onClick={() => orders(offset + 20)}>下一页</Button>}</div></section>
    </>}
    <Button variant="outline" disabled={busy} onClick={() => { setError(""); setCatalog(null); setRevision(value => value + 1); }}>刷新商品</Button>
    {error && <p role="alert" className="text-destructive">{error} 结果不明时，请查询已有订单，不要重复购买。</p>}
  </main>;
}
