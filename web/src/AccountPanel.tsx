import { useEffect, useState } from "react";
import { Client, pointLabel, products } from "./api";
import type { ImportAccount, ImportProducts, PointLedger } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";

export default function AccountPanel({ client, revision, balance, onRecharge }: { client: Client | null; revision: number; balance?: number; onRecharge: () => void }) {
  const [account, setAccount] = useState<ImportAccount | null>(null);
  const [catalog, setCatalog] = useState<ImportProducts | null>(null);
  const [history, setHistory] = useState<PointLedger | null>(null);
  const [card, setCard] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setCard(""); setBusy(false); }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setAccount(null); setHistory(null);
    void products(controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(() => { if (!controller.signal.aborted) setError("商品暂不可用，请重试。"); });
    if (client) void client.account(controller.signal).then(value => { if (!controller.signal.aborted) setAccount(value); }).catch(() => { if (!controller.signal.aborted) setError("余额读取失败，请重试。"); });
    return () => controller.abort();
  }, [client, revision, balance, reload]);
  async function recharge() {
    if (!client || busy) return;
    setBusy(true); setError("");
    try { const value = await client.recharge(card.trim()); if (client.active) { setAccount(value); setCard(""); onRecharge(); } }
    catch { if (client.active) setError("兑换未确认，请使用同一卡密重试；不要重复购买。"); }
    finally { if (client.active) setBusy(false); }
  }
  async function ledger(before?: number) {
    if (!client || busy) return;
    setBusy(true); setError("");
    try { const value = await client.ledger(before); if (client.active) setHistory(previous => before && previous ? { ...value, items: [...previous.items, ...value.items] } : value); }
    catch { if (client.active) setError("积分明细读取失败，请重试。"); }
    finally { if (client.active) setBusy(false); }
  }
  return <Card className="mb-6"><CardHeader><CardTitle>导入积分</CardTitle></CardHeader><CardContent className="space-y-3">
    {account && <><p>{account.phone} · 可用积分：{pointLabel(account.balanceMicropoints)}</p>{account.usageUnknown ? <p role="status">有调用用量待核对，请联系客服。已完成内容仍可下载。</p> : account.balanceMicropoints <= 0 && <p role="status">积分不足，请兑换卡密后在任务中点击继续解析。充值先抵扣欠额。</p>}
      <form className="connection-form" onSubmit={event => { event.preventDefault(); void recharge(); }}><label className="flex-1"><span>追加卡密</span><Input type="password" autoComplete="off" maxLength={64} value={card} onChange={event => setCard(event.target.value)} /></label><Button disabled={busy || !card.trim()}>兑换积分</Button></form>
      <Button variant="outline" disabled={busy} onClick={() => void ledger()}>查看积分明细</Button>
      {history && <><ul>{history.items.map(item => <li key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.kind === "redeem" ? "卡密兑换" : "模型用量"} · {pointLabel(item.amountMicropoints)}</li>)}</ul>{history.nextBefore && <Button disabled={busy} variant="outline" onClick={() => void ledger(history.nextBefore!)}>更早明细</Button>}</>}
    </>}
    {catalog && !catalog.items.length && <p className="text-sm text-muted-foreground">暂未配置可购买商品，请联系服务提供方。</p>}
    {catalog?.items.map(item => <p key={item.productId}>{item.name} · {pointLabel(item.pointsMicropoints)} 积分 {/^https:\/\//.test(item.purchaseUrl) && <a href={item.purchaseUrl} target="_blank" rel="noopener noreferrer">前往链动小铺购买</a>}</p>)}
    {error && <p role="alert">{error}</p>}<Button variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新余额与商品</Button>
  </CardContent></Card>;
}
