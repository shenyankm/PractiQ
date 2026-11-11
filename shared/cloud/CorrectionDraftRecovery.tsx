import { t, useCloudLocale } from "./i18n";
import { nativeBridge } from "./transport";
import { storageScope } from "./serviceStorage";
import { useEffect, useState } from "react";
import { correctionDrafts, removeCorrectionDraft, type CorrectionDraft } from "./correctionDrafts";
import { downloadBlob } from "./api";
import { Button } from "./components/ui/button";

type Props = { scope?: string; excludeTaskId?: string | null; task?: { threadId: string; checkpointId?: string | null }; onOpen: (draft: CorrectionDraft) => void };
export function CorrectionDraftRecovery({ task, excludeTaskId, onOpen, scope = storageScope() }: Props) {
  useCloudLocale();
  const [deleting, setDeleting] = useState(false);
  const [state, setState] = useState<{ drafts: CorrectionDraft[]; error?: string }>({ drafts: [] });
  useEffect(() => {
    const read = () => { try { setState({ drafts: correctionDrafts(scope) }); } catch (e) { setState({ drafts: [], error: e instanceof Error ? e.message : t("本机草稿读取失败。") }); } };
    read(); window.addEventListener("storage", read); window.addEventListener("correction-drafts-change", read);
    return () => { window.removeEventListener("storage", read); window.removeEventListener("correction-drafts-change", read); };
  }, [scope]);
  const drafts = state.drafts.filter(d => d.taskId !== excludeTaskId && (!task || d.taskId === task.threadId));
  if (!drafts.length && !state.error) return null;
  return <section className="notice space-y-2" aria-label={t("本机校对草稿")}>
    <h4>{t("本机校对草稿")}</h4><p>{t("草稿仅保存在此浏览器；同一道题请使用一个窗口编辑。恢复不会发送模型请求；未确认保存必须先核对回执。")}</p>
    {state.error && <p role="alert">{state.error}</p>}
    {drafts.map(d => <div key={JSON.stringify([d.taskId, d.checkpointId, d.questionIndex, d.pending?.requestId])}>
      <p>{d.fileName}{t(" · 第 ")}{d.questionIndex + 1}{t(" 题")}{d.pending ? t(" · 未确认请求 {0}", d.pending.requestId) : ""}</p>
      {task && task.checkpointId !== d.checkpointId && <p>{t("来源检查点已变化，旧草稿保留供导出核对，不会应用到新结果。")}</p>}
      <div className="task-actions"><Button variant="outline" disabled={!!task && task.checkpointId !== d.checkpointId} onClick={() => onOpen(d)}>{task ? t("恢复第 {0} 题草稿", d.questionIndex + 1) : t("打开草稿任务 {0}", d.fileName)}</Button>
      <Button variant="outline" onClick={() => void downloadBlob(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }), `practiq-draft-${d.taskId}-${d.questionIndex + 1}.json`).catch(e => setState(v => ({...v, error: e instanceof Error ? e.message : t("草稿导出失败。")})))}>{t("导出草稿备份")}</Button>
      <Button variant="ghost" disabled={deleting} onClick={async () => {
        if (deleting) return;
        setDeleting(true);
        const native = nativeBridge();
        try {
          const message = d.pending ? t("此请求结果未知。请先导出草稿备份并保留请求 ID {0}。仍要仅移除此浏览器的记录吗？这不表示服务端未保存。", d.pending.requestId) : t("确认删除此浏览器中的校对草稿吗？");
          const confirmed = native ? await native.confirm(message) : window.confirm(message);
          if (confirmed !== true || native !== nativeBridge()) return;
          removeCorrectionDraft({ ...d, requestId: d.pending?.requestId }, scope);
        } catch (e) { setState(v => ({ ...v, error: e instanceof Error ? e.message : t("清除失败，请重试。") })); }
        finally { setDeleting(false); }
      }}>{t("删除本机草稿")}</Button></div>
    </div>)}
  </section>;
}
