import { useEffect, useState } from "react";
import { Trash2, RefreshCw } from "lucide-react";
import type { DesktopMaintenancePreview, DesktopMaintenanceRequest, DesktopDocumentReply } from "./contracts.generated";
import { desktopAiRequest } from "./desktop-cloud";
import { nativeBridge } from "../../shared/cloud/transport";
import { Button } from "@/components/ui/button";
import { errorMessage } from "./api";
import { t } from "./i18n";

export function DesktopTaskMaintenance({ disabled }: { disabled: boolean }) {
  const [preview, setPreview] = useState<DesktopMaintenancePreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    if (!busy) return;
    const guard = (event: Event) => event.preventDefault(); document.addEventListener("practiq-cloud-before-leave", guard); document.addEventListener("practiq-before-window-close", guard);
    return () => { document.removeEventListener("practiq-cloud-before-leave", guard); document.removeEventListener("practiq-before-window-close", guard); };
  }, [busy]);
  async function inspect() {
    if (busy || disabled) return; setBusy(true); setError(""); setNotice(""); setPreview(null);
    try {
      const reply = await desktopAiRequest<DesktopDocumentReply>({ type: "document_request", request: { type: "maintenance_preview", revision: nativeBridge()?.revision } });
      if (reply.type !== "maintenance_preview") throw Error(); setPreview(reply.value);
    } catch (cause) { setError(errorMessage(cause, false)); } finally { setBusy(false); }
  }
  async function clean(value: DesktopMaintenanceRequest) {
    if (busy || disabled) return; setBusy(true); setError(""); setNotice("");
    try {
      const reply = await desktopAiRequest<DesktopDocumentReply>({ type: "document_request", request: { type: "cleanup_state", revision: nativeBridge()?.revision, value } });
      if (reply.type !== "cleanup_state" || reply.value.requestId !== value.requestId || reply.value.previewId !== value.previewId || !Number.isSafeInteger(reply.value.cleaned) || reply.value.cleaned < 0 || reply.value.cleaned > 100) throw Error();
      setPreview(null); setNotice(t("已清理 {0} 项任务状态。原文、题库、练习数据和调用记录均保留。", { 0: reply.value.cleaned }));
    } catch (cause) { setPreview(null); setError(errorMessage(cause, false)); } finally { setBusy(false); }
  }
  return <section className="settings-panel mt-6" aria-labelledby="desktop-maintenance-heading">
    <h2 id="desktop-maintenance-heading">{t("AI 任务清理")}</h2>
    <p className="my-3 text-sm text-muted-foreground">{t("检查已过期且停止的任务、未完成删除和孤立检查点。仅清理 AI 任务状态，保留原文、题库、练习数据及全部调用记录。")}</p>
    <Button variant="outline" disabled={busy || disabled} onClick={() => void inspect()}><RefreshCw />{busy ? t("正在处理…") : t("检查可清理任务")}</Button>
    {preview && <div className="mt-4 space-y-3">
      <p>{t("本批可清理 {0} 项。", { 0: preview.candidates.length })}{preview.hasMore && t("仍有更多候选项，完成本批后请重新检查。")}</p>
      {!!preview.skipped && <p>{t("已跳过 {0} 项无法安全识别的记录，保留原状。", { 0: preview.skipped })}</p>}
      {!preview.canClean && <p role="alert">{t("请先停止 AI 任务，并等待导出和原文修复结束，再重新检查。")}</p>}
      {!!preview.candidates.length && <><ul className="max-h-60 overflow-auto text-sm">{preview.candidates.map(candidate => <li key={candidate.threadId}>{candidate.fileName ?? candidate.threadId} · {candidate.kind === "expired" ? t("已过期任务") : candidate.kind === "deletion" ? t("未完成删除") : t("孤立任务状态")}</li>)}</ul><p className="text-sm">{t("确认后将删除以上任务状态和检查点，此操作无法撤销。")}</p><Button variant="destructive" disabled={busy || disabled || !preview.canClean || preview.pending.length > 0} onClick={() => void clean({ requestId: crypto.randomUUID(), previewId: preview.previewId })}><Trash2 />{t("确认清理本批任务状态")}</Button></>}
      {preview.pending.map(batch => <div key={batch.requestId}><p>{t("未完成的清理：已完成 {0}/{1} 项。", { 0: batch.completed, 1: batch.total })}</p><Button variant="outline" disabled={busy || disabled || !preview.canClean} onClick={() => void clean({ requestId: batch.requestId, previewId: batch.previewId })}>{t("继续未完成清理")}</Button></div>)}
      <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>{t("关闭清理预览")}</Button>
    </div>}
    {notice && <p className="mt-3" role="status">{notice}</p>}{error && <p className="mt-3 text-destructive" role="alert">{error}<span className="block">{t("清理结果可能尚未确认。请重新检查，未完成批次只会在明确点击继续后执行。")}</span></p>}
  </section>;
}
