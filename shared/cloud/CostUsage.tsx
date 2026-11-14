import { useEffect, useRef, useState } from "react";
import type { DesktopCostReport } from "../../app/src/contracts.generated";
import { formatMicros } from "../cost";
import { ApiError, Client } from "./api";
import { nativeBridge } from "./transport";
import { Button } from "./components/ui/button";
import { t, useCloudLocale } from "./i18n";

export function CostUsage({ threadId, disabled = false }: { threadId?: string; disabled?: boolean }) {
  useCloudLocale(); const active = useRef<Client | null>(null), [report, setReport] = useState<DesktopCostReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => () => { active.current?.disconnect(); active.current = null; }, []);
  if (!nativeBridge()?.documents) return null;
  async function read() {
    if (busy || disabled || active.current) return; const client = new Client(); active.current = client; setBusy(true); setError(""); setReport(null);
    try { const value = await client.costReport(threadId); if (client.active) setReport(value); }
    catch (cause) { if (client.active) setError(cause instanceof ApiError ? cause.message : t("无法读取费用预留，请手动重试。")); }
    finally { if (client.active) setBusy(false); client.disconnect(); active.current = null; }
  }
  return <section className="settings-panel resource-card mt-4" aria-label={t("费用预留记录")}>
    <Button variant="outline" disabled={busy || disabled} onClick={() => void read()}>{busy ? t("正在读取费用预留…") : t("读取费用预留")}</Button>
    {error && <p role="alert">{error}</p>}
    {report && <div className="mt-3 space-y-2"><p>{report.enabled ? t("已启用费用预留限制") : t("当前未启用费用预留限制")}</p><p>{t("UTC 日期：{0}", report.utcDay)}</p>
      <p>{report.day ? t("当日已预留：{0} {1}", report.day.currency, formatMicros(report.day.reservedMicros)) : t("当日没有费用预留记录。")}</p>
      {threadId && <p>{report.task ? t("本任务已预留：{0} {1}", report.task.currency, formatMicros(report.task.reservedMicros)) : t("本任务没有费用预留记录。")}</p>}
      <p>{t("单任务限额：{0}；每日限额：{1}", report.taskLimitMicros === null ? t("未设置") : `${report.currency} ${formatMicros(report.taskLimitMicros)}`, report.dailyLimitMicros === null ? t("未设置") : `${report.currency} ${formatMicros(report.dailyLimitMicros)}`)}</p>
      <p className="text-sm text-muted-foreground">{t("预留是保守估算，不是实际账单；失败和未知结果均保留预留，未启用时的历史调用不补算。")}</p>
      {!!report.recent.length && <details><summary>{t("最近费用预留")}</summary><ul>{report.recent.map((item, index) => <li key={`${item.scope}:${item.targetHash}:${index}`}>{item.day} · {item.scope} · {item.kind} · {item.currency} {formatMicros(item.reservedMicros)}</li>)}</ul></details>}
    </div>}
  </section>;
}
