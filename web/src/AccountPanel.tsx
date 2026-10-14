import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Client, pointLabel, products } from "./api";
import type { ImportAccount, ImportProducts, PointLedger } from "./contracts.generated";
import { Button } from "./components/ui/button";

export default function AccountPanel({ client, revision, balance }: { client: Client | null; revision: number; balance?: string; }) {
  const [account, setAccount] = useState<ImportAccount | null>(null);
  const [catalog, setCatalog] = useState<ImportProducts | null>(null);
  const [history, setHistory] = useState<PointLedger | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setBusy(false); }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setAccount(null); setHistory(null);
    void products(controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(() => { if (!controller.signal.aborted) setError("商品暂不可用，请重试。"); });
    if (client) void client.account(controller.signal).then(value => { if (!controller.signal.aborted) setAccount(value); }).catch(() => { if (!controller.signal.aborted) setError("余额读取失败，请重试。"); });
    return () => controller.abort();
  }, [client, revision, balance, reload]);
  async function ledger(before?: number) {
    if (!client || busy) return;
    setBusy(true); setError("");
    try { const value = await client.ledger(before); if (client.active) setHistory(previous => before && previous ? { ...value, items: [...previous.items, ...value.items] } : value); }
    catch { if (client.active) setError("积分明细读取失败，请重试。"); }
    finally { if (client.active) setBusy(false); }
  }
  return <section className={`account-panel${client ? "" : " account-panel-disconnected"}`} aria-label="导入积分">
    {client && <div className="account-overview"><h2>导入积分</h2>{account ? <p><span>{account.phone}</span><strong>可用积分：{pointLabel(account.balanceMicropoints)}</strong></p> : <p className="text-muted-foreground">{error ? "余额暂不可用" : "正在读取余额…"}</p>}</div>}
    {account && (account.usageUnknown ? <p role="status" className="notice">有调用用量待核对，请联系客服。已完成内容仍可下载。</p> : BigInt(account.balanceMicropoints) <= 0n && <p role="status" className="notice">额度不足，请购买额度后在任务中点击继续解析。充值先抵扣欠额。</p>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <details className="account-controls"><summary>{client ? "充值与积分明细" : "购买导入积分"}<ChevronDown aria-hidden="true" /></summary><div className="account-content space-y-3">
    {account && <>
      <Button variant="outline" disabled={busy} onClick={() => void ledger()}>查看积分明细</Button>
      {history && <><ul>{history.items.map(item => <li key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.kind === "purchase" ? "支付到账" : item.kind === "model" ? "模型用量" : "历史额度调整"} · {pointLabel(item.amountMicropoints)}</li>)}</ul>{history.nextBefore && <Button disabled={busy} variant="outline" onClick={() => void ledger(history.nextBefore!)}>更早明细</Button>}</>}
    </>}
    {catalog && !catalog.items.length && <p className="text-sm text-muted-foreground">暂未配置可购买商品，请联系服务提供方。</p>}
    {catalog?.items.map(item => <p key={item.productId}>{item.name} · {pointLabel(item.pointsMicropoints)} 积分 {/^https:\/\//.test(item.purchaseUrl) && <a href={item.purchaseUrl} target="_blank" rel="noopener noreferrer">前往购买</a>}</p>)}
    <Button variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>刷新余额与商品</Button>
    </div></details>
  </section>;
}
