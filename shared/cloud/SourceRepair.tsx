import { useState } from "react";
import type { DesktopSourceStatus } from "./contracts.generated";
import { Client, type SourceRepairIntent } from "./api";
import { Button } from "./components/ui/button";
import { t } from "./i18n";

export function SourceRepair({ client, threadId, busy, run }: { client: Client; threadId: string; busy: boolean; run: (perform: (current: Client) => Promise<void>, changesTask?: boolean) => Promise<void> }) {
  const [status, setStatus] = useState<DesktopSourceStatus | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ intent: SourceRepairIntent | null; invalid: boolean }>(() => {
    try { return { intent: client.pendingSourceRepairs().find(record => record.threadId === threadId) ?? null, invalid: false }; } catch { return { intent: null, invalid: true }; }
  });
  const refresh = () => setPending({ intent: client.pendingSourceRepairs().find(record => record.threadId === threadId) ?? null, invalid: false });
  const repair = () => void run(async current => {
    setNotice(null);
    try {
      const result = pending.intent ? await current.retrySourceRepair(pending.intent.requestId) : await current.repairSource(status!);
      if (current.active) { setNotice(result.status === "cancelled" ? t("已取消选择，原文未修改。") : result.status === "repaired" ? t("原文已修复，损坏副本及修复清单已保留。") : t("原文校验通过，无需修复。")); setStatus(await current.sourceStatus(threadId)); }
    } finally { if (current.active) refresh(); }
  });
  return <section className="resource-card space-y-3" aria-label={t("原文校验与修复")}>
    <h3>{t("原文校验与修复")}</h3><p className="text-sm text-muted-foreground">{t("修复仅替换为大小和 SHA-256 与最初导入完全一致的文件；不会重新解析或调用模型。")}</p>
    {notice && <p role="status">{notice}</p>}
    {status && <p>{status.status === "verified" ? t("原文校验通过，无需修复。") : status.status === "missing" ? t("保存的原文已丢失。") : t("保存的原文校验失败。")}{status.status !== "verified" && !status.canRepair && t("请先停止所有 AI 任务，再重新校验原文。")}</p>}
    {pending.invalid && <p role="alert">{t("无法读取原文修复恢复记录，请核对任务后再操作。")}</p>}
    {pending.intent && <p className="notice">{t("有一笔原文修复尚未确认。重试沿用原请求，不会启动 AI；修复记录和损坏副本会保留。")}</p>}
    <div className="task-actions">
      <Button variant="outline" disabled={busy} onClick={() => void run(async current => { const value = await current.sourceStatus(threadId); if (current.active) { setStatus(value); refresh(); } }, false)}>{t("校验原文")}</Button>
      {pending.intent ? <><Button variant="outline" disabled={busy || pending.invalid} onClick={repair}>{t("重试原修复请求")}</Button><Button variant="outline" disabled={busy} onClick={() => void run(async current => { current.forgetSourceRepair(pending.intent!.requestId); refresh(); }, false)}>{t("移除本机恢复提示")}</Button></> : status?.canRepair && <Button variant="outline" disabled={busy || pending.invalid} onClick={repair}>{t("选择原文件并修复")}</Button>}
    </div>
  </section>;
}
