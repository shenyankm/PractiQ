import { accountStorageScope } from "./accountClient";
import { useEffect, useState } from "react";
import { correctionDrafts, removeCorrectionDraft, type CorrectionDraft } from "./correctionDrafts";
import { downloadBlob } from "./api";
import { Button } from "./components/ui/button";

type Props = { scope?: string; excludeTaskId?: string | null; task?: { threadId: string; checkpointId?: string | null }; onOpen: (draft: CorrectionDraft) => void };
export function CorrectionDraftRecovery({ task, excludeTaskId, onOpen, scope = accountStorageScope() }: Props) {
  const [state, setState] = useState<{ drafts: CorrectionDraft[]; error?: string }>({ drafts: [] });
  useEffect(() => {
    const read = () => { try { setState({ drafts: correctionDrafts(scope) }); } catch (e) { setState({ drafts: [], error: e instanceof Error ? e.message : "本机草稿读取失败。" }); } };
    read(); window.addEventListener("storage", read); window.addEventListener("correction-drafts-change", read);
    return () => { window.removeEventListener("storage", read); window.removeEventListener("correction-drafts-change", read); };
  }, [scope]);
  const drafts = state.drafts.filter(d => d.taskId !== excludeTaskId && (!task || d.taskId === task.threadId));
  if (!drafts.length && !state.error) return null;
  return <section className="notice space-y-2" aria-label="本机校对草稿">
    <h4>本机校对草稿</h4><p>草稿仅保存在此浏览器；同一道题请使用一个窗口编辑。恢复不会发送模型请求；未确认保存必须先核对回执。</p>
    {state.error && <p role="alert">{state.error}</p>}
    {drafts.map(d => <div key={JSON.stringify([d.taskId, d.checkpointId, d.questionIndex, d.pending?.requestId])}>
      <p>{d.fileName} · 第 {d.questionIndex + 1} 题{d.pending ? ` · 未确认请求 ${d.pending.requestId}` : ""}</p>
      {task && task.checkpointId !== d.checkpointId && <p>来源检查点已变化，旧草稿保留供导出核对，不会应用到新结果。</p>}
      <div className="task-actions"><Button variant="outline" disabled={!!task && task.checkpointId !== d.checkpointId} onClick={() => onOpen(d)}>{task ? `恢复第 ${d.questionIndex + 1} 题草稿` : `打开草稿任务 ${d.fileName}`}</Button>
      <Button variant="outline" onClick={() => downloadBlob(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }), `practiq-draft-${d.taskId}-${d.questionIndex + 1}.json`)}>导出草稿备份</Button>
      <Button variant="ghost" onClick={() => { if (window.confirm(d.pending ? `此请求结果未知。请先导出草稿备份并保留请求 ID ${d.pending.requestId}。仍要仅移除此浏览器的记录吗？这不表示服务端未保存。` : "确认删除此浏览器中的校对草稿吗？")) { try { removeCorrectionDraft({ ...d, requestId: d.pending?.requestId }, scope); } catch (e) { setState(v => ({ ...v, error: e instanceof Error ? e.message : "清除失败，请重试。" })); } } }}>删除本机草稿</Button></div>
    </div>)}
  </section>;
}
