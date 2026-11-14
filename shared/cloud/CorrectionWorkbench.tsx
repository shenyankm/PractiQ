import { t, useCloudLocale } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactReference, DocumentAnswerSource, DocumentCorrectionSave, DocumentCorrections, DocumentTaskDetail, DocumentTaskReview, ParsedQuestion, ReviewUnit } from "./contracts.generated";
import { nativeBridge } from "./transport";
import { ApiError, Client, downloadBlob } from "./api";
import { Button } from "./components/ui/button";
import { Blocks, Markdown, ReferenceAnswer } from "./ResultReview";
import QuestionCorrectionEditor, { answerText } from "./QuestionCorrectionEditor";
import { correctionDrafts, putCorrectionDraft, removeCorrectionDraft, type EditorDraft } from "./correctionDrafts";

function EvidencePane({ unit, original, question, client, threadId }: { unit?: ReviewUnit; original?: DocumentTaskReview["document"]; question: ParsedQuestion; client: Client; threadId: string }) {
  useCloudLocale();
  const reference = unit?.originalPageRef ?? unit?.sourceRef ?? (original?.sourceType === "image" ? original : undefined);
  const [evidence, setEvidence] = useState<{ url?: string; text?: string; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!reference) return;
    const controller = new AbortController();
    let url: string | undefined;
    async function read(ref: ArtifactReference) {
      try {
        if (ref.mediaType.startsWith("image/")) {
          const blob = await client.image(ref, threadId, controller.signal);
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob); setEvidence({ url });
        } else {
          const blob = await client.evidence(ref, threadId, controller.signal);
          const raw = await blob.text();
          if (controller.signal.aborted) return;
          let text = raw;
          if (ref.mediaType === "application/json") {
            const page = JSON.parse(raw) as { elements?: { text_info?: { content?: string } }[] };
            const paragraphs = page.elements?.map(e => e.text_info?.content).filter(v => typeof v === "string");
            if (paragraphs?.length) text = paragraphs.join("\n\n");
          }
          setEvidence({ text });
        }
      } catch { if (!controller.signal.aborted) setEvidence({ error: t("来源读取或校验失败，请重试。") }); }
    }
    void read(reference);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [reference, client, threadId, attempt]);
  const quote = question.sourceText?.trim();
  const match = quote && evidence.text ? evidence.text.indexOf(quote) : -1;
  return <section className="source-pane" aria-label={t("原文对照")}>
    <h4>{unit?.stage === "vision_parse" ? t("来源页 {0}", (unit.sourcePage ?? unit.index) + 1) : t("来源文本片段")}</h4>
    {reference?.mediaType === "application/json" && <p>{t("此处是已保存的识别证据，可能与原文件有差异，请核对原文件。")}</p>}
    {!reference && <p>{t("此题没有可定位的来源页。以下仅显示保存的来源原文，不推断页码。")}</p>}
    {reference && !evidence.url && evidence.text === undefined && !evidence.error && <p role="status">{t("正在校验来源…")}</p>}
    {evidence.url && <img src={evidence.url} alt={t("题目来源{0}", unit ? ` · 第 ${(unit.sourcePage ?? unit.index) + 1} 页` : "原图")} />}
    {evidence.text !== undefined && <pre className="source-text">{match >= 0 && quote ? <>{evidence.text.slice(0, match)}<mark>{quote}</mark>{evidence.text.slice(match + quote.length)}</> : evidence.text}</pre>}
    {!reference && <Markdown text={question.sourceText} />}
    {evidence.error && <><p role="alert">{evidence.error}</p><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>{t("重试读取来源")}</Button></>}
  </section>;
}

export type CorrectionLeaveGuard = (() => boolean) | null;

export type AnswerAssociation = { question: ParsedQuestion; source: DocumentAnswerSource };

type Props = { restoreRequestId?: string | null; association?: AnswerAssociation; task: DocumentTaskDetail; preview: DocumentTaskReview | null; question: ParsedQuestion; original: ParsedQuestion; questionIndex: number; units: ReviewUnit[]; corrections: DocumentCorrections | null; client: Client; onSaved: (value: DocumentCorrections) => void; onClose: () => void; unavailable?: boolean; onLeaveGuardChange?: (guard: CorrectionLeaveGuard) => void };
export default function CorrectionWorkbench({ restoreRequestId, association, task, preview, question, original, questionIndex, units, corrections, client, onSaved, onClose, unavailable = false, onLeaveGuardChange }: Props) {
  useCloudLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [restored, setRestored] = useState(() => correctionDrafts(client.storageScope).find(v => v.taskId === task.threadId && v.checkpointId === task.checkpointId && v.questionIndex === questionIndex && (restoreRequestId === undefined || (v.pending?.requestId ?? null) === restoreRequestId)));
  const [editing, setEditing] = useState(!!restored || !!association);
  const [answerSource, setAnswerSource] = useState(restored?.answerSource ?? restored?.pending?.answerSource ?? association?.source ?? null);
  const associationDraft = useRef<EditorDraft | undefined>(association ? { original: question, question: association.question, initialAnswer: answerText(question), answer: answerText(association.question) } : undefined);
  const editorDraft = useRef<EditorDraft | undefined>(restored?.editor ?? associationDraft.current);
  const [storageError, setStorageError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [reloading, setReloading] = useState(false);
  const pendingSave = useRef<DocumentCorrectionSave | null>(restored?.pending ?? null);
  const [draftRevision, setDraftRevision] = useState<string | null>(restored ? restored.revision : association ? corrections?.edits?.at(-1)?.requestId ?? null : null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(restored?.pending?.requestId ?? null);
  const canEdit = !unavailable && task.state === "COMPLETED" && !!task.result && !!task.checkpointId && !!corrections;
  const revision = corrections?.edits?.at(-1)?.requestId;
  const rebaseRequired = editing && !pendingRequestId && draftRevision !== (revision ?? null);
  const persistEditor = useCallback((editor: EditorDraft) => {
    editorDraft.current = editor;
    try {
      putCorrectionDraft({ version: 1, taskId: task.threadId, fileName: task.fileName, checkpointId: task.checkpointId!, questionIndex, revision: draftRevision, answerSource, editor, pending: pendingSave.current, updatedAt: new Date().toISOString() }, client.storageScope);
      setStorageError("");
    } catch (e) { setStorageError(e instanceof Error ? e.message : t("本机草稿保存失败，请保留页面后重试。")); }
  }, [client.storageScope, task.threadId, task.fileName, task.checkpointId, questionIndex, draftRevision, answerSource]);
  const discard = useCallback(() => {
    try {
      removeCorrectionDraft({ taskId: task.threadId, checkpointId: task.checkpointId!, questionIndex }, client.storageScope);
      setRestored(undefined); editorDraft.current = undefined; associationDraft.current = undefined; setAnswerSource(null); setEditing(false); setError(""); setStorageError(""); return true;
    } catch (e) { setStorageError(e instanceof Error ? e.message : t("无法清除本机草稿，请重试。")); return false; }
  }, [client.storageScope, task.threadId, task.checkpointId, questionIndex]);
  useEffect(() => {
    if (!editing && !saving && !reloading && !pendingRequestId) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, saving, reloading, pendingRequestId]);
  useLayoutEffect(() => {
    onLeaveGuardChange?.(() => {
      if (saving || reloading || pendingRequestId) {
        setError(t("保存或核对尚未完成，请先重新读取已保存修订，保留原请求后再切换任务。"));
        return false;
      }
      // Native confirm is asynchronous; require the explicit editor Save/Discard action.
      if (editing && nativeBridge()) { setError(t("请先保存修订或点击“放弃本次修改”，再切换。")); return false; }
      if (editing && !window.confirm(t("当前校对草稿尚未保存。确认放弃草稿并继续吗？"))) return false;
      return !editing || discard();
    });
    return () => onLeaveGuardChange?.(null);
  }, [editing, saving, reloading, pendingRequestId, onLeaveGuardChange, discard]);
  async function save(value: ParsedQuestion) {
    if (!task.checkpointId || !corrections) throw Error(t("请先重新读取已保存修订。"));
    setSaving(true); setError("");
    const wasUnconfirmed = !!pendingSave.current;
    try {
      const request = pendingSave.current ?? { checkpointId: task.checkpointId, expectedRevision: draftRevision, questionIndex, question: value, requestId: crypto.randomUUID(), ...(answerSource ? { answerSource } : {}) };
      if (!editorDraft.current) throw Error(t("校对草稿尚未保存，请稍后重试。"));
      putCorrectionDraft({ version: 1, taskId: task.threadId, fileName: task.fileName, checkpointId: task.checkpointId, questionIndex, revision: draftRevision, answerSource, editor: editorDraft.current, pending: request, updatedAt: new Date().toISOString() }, client.storageScope);
      pendingSave.current = request;
      setPendingRequestId(pendingSave.current.requestId);
      const saved = await client.saveCorrection(task.threadId, pendingSave.current);
      if (!client.active) return;
      removeCorrectionDraft({ taskId: task.threadId, checkpointId: task.checkpointId, questionIndex, requestId: pendingSave.current.requestId }, client.storageScope);
      pendingSave.current = null; setPendingRequestId(null); setRestored(undefined); associationDraft.current = undefined; setAnswerSource(null);
      onSaved(saved); setEditing(false); setNotice(nativeBridge() ? t("修订已保存。导入修订版会包含全部已保存修改，原始题库保留。") : t("修订已保存。下载修订版会包含全部已保存修改，原始题库保留。"));
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && (
        ["CORRECTION_CONFLICT", "CORRECTION_INVALID", "CORRECTION_PROTECTED_FIELD", "CORRECTION_HISTORY_LIMIT", "REQUEST_TOO_LARGE", "HTTP_422", "ANSWER_MATCH_INVALID", "ANSWER_SOURCE_STALE", "ANSWER_SOURCE_UNAVAILABLE", "ANSWER_REPLACEMENT_REQUIRED"].includes(e.code) ||
        (!wasUnconfirmed && ["CORRECTION_NOT_READY", "STALE_CHECKPOINT", "SERVICE_READ_ONLY"].includes(e.code))
      )) {
        const rejected = pendingSave.current;
        if (rejected) { try { removeCorrectionDraft({ taskId: task.threadId, checkpointId: task.checkpointId!, questionIndex, requestId: rejected.requestId }, client.storageScope); } catch (storage) { setStorageError(storage instanceof Error ? storage.message : t("本机请求记录清理失败。")); } }
        pendingSave.current = null; setPendingRequestId(null);
        if (editorDraft.current) persistEditor(editorDraft.current);
      }
      setError(t("保存未完成或回执未确认。草稿仍保留；请重新读取已保存修订，核对后再保存。"));
      throw e;
    } finally { setSaving(false); }
  }
  async function reload() {
    setReloading(true); setError("");
    try {
      const saved = await client.corrections(task.threadId);
      if (saved.checkpointId !== task.checkpointId) throw Error(t("任务检查点已变化，请刷新任务后再校对。"));
      onSaved(saved);
      if (pendingSave.current && saved.edits?.some(edit => edit.requestId === pendingSave.current!.requestId)) {
        removeCorrectionDraft({ taskId: task.threadId, checkpointId: task.checkpointId!, questionIndex, requestId: pendingSave.current.requestId }, client.storageScope);
        pendingSave.current = null; setPendingRequestId(null); setRestored(undefined); associationDraft.current = undefined; setAnswerSource(null); setEditing(false); setNotice(t("上次保存已确认，修订已经保留，无需重复提交。")); return;
      }
      setNotice(t("已重新读取修订。正在编辑的草稿保持不变，请核对修改历史后决定是否保存。"));
    } catch (e) { setError(e instanceof Error ? e.message : t("读取失败，请重试。")); }
    finally { setReloading(false); }
  }
  return <section className="correction-workbench" aria-label={t("对照与校对工作台")}>
    <div className="review-header"><h3 ref={heading} tabIndex={-1}>{t("对照与校对 · 第 ")}{questionIndex + 1}{t(" 条")}</h3><Button variant="outline" disabled={editing || saving || reloading || !!pendingRequestId} onClick={onClose}>{t("返回题目列表")}</Button></div>
    <p>{t("先核对来源，再修改题目。只保存人工修订，不重新解析文档。")}</p>
    <p>{t("校对草稿保存在此浏览器，刷新后可恢复；未确认请求不会自动重发。")}</p>
    {answerSource && <p>{t("已关联答案卷第 ")}{answerSource.questionIndex + 1}{t(" 条，保存时会保留来源证据。")}<Button variant="outline" disabled={saving || reloading || !!pendingRequestId} onClick={() => setAnswerSource(null)}>{t("改为人工编辑")}</Button></p>}
    {restored && <p role="status">{t("已恢复本机草稿")}{restored.pending ? t("及原保存请求，请显式读取修订或重试。") : t("，请核对后继续。")}</p>}
    {storageError && <div role="alert"><p>{storageError}</p><Button variant="outline" disabled={saving || reloading || !editorDraft.current} onClick={() => editorDraft.current && persistEditor(editorDraft.current)}>{t("重试保存本机草稿")}</Button></div>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{pendingRequestId && <p role="status">{t("保存请求 ID：")}{pendingRequestId} · {saving ? t("正在等待保存回执。") : t("结果尚未确认，先重新读取修订或使用原请求重试。")}</p>}
    <div className="correction-columns">
      <div>{units.length > 1 && <nav className="source-navigation" aria-label={t("关联来源")}>{units.map((unit,index) => <Button key={`${unit.stage}:${unit.index}`} variant={index === sourceIndex ? "default" : "outline"} onClick={() => setSourceIndex(index)}>{t("来源 ")}{index + 1}</Button>)}</nav>}<EvidencePane key={`${units[sourceIndex]?.stage}:${units[sourceIndex]?.index}`} unit={units[sourceIndex]} original={preview?.document} question={original} client={client} threadId={task.threadId} />
        {preview?.document && <Button variant="outline" onClick={async () => { try { const blob = await client.source(preview.document!, task.threadId); if (client.active) await downloadBlob(blob, preview.document!.fileName ?? "source"); } catch { setError(t("原文件读取或校验失败，请重试。")); } }}>{t("下载原文件核对")}</Button>}
      </div>
      <div className="correction-question">
        {editing ? <QuestionCorrectionEditor question={question} saving={saving} checking={reloading} unconfirmed={!!pendingRequestId} saveBlocked={rebaseRequired || !!storageError} restored={restored?.editor ?? associationDraft.current} onDraftChange={persistEditor} onSave={save} onCancel={discard} /> : <><h4>{t("当前题目")}</h4><Markdown text={question.stem} /><Blocks blocks={question.contentBlocks} /><p>{t("题型标签：")}{question.questionTypeId ?? t("未提供")}</p><div>{question.options.map((option,index) => <p key={index}>{option.label} · {option.content}</p>)}</div><h4>{t("当前参考答案")}</h4><ReferenceAnswer question={question} /><h4>{t("解析")}</h4><Markdown text={question.analysis} /><h4>{t("评分依据")}</h4><Markdown text={question.scoringRubric} /><Button disabled={!canEdit || saving || reloading || !!pendingRequestId} onClick={() => { setDraftRevision(revision ?? null); setEditing(true); }}>{t("人工校对")}</Button>{!canEdit && <p>{t("任务完成并读取一致的修订记录后，才能保存人工修改。")}</p>}</>}
        {rebaseRequired && <div role="status"><p>{t("其他修订已更新。请先核对修改历史；继续保存会将当前草稿应用到已读取的版本。")}</p><Button variant="outline" onClick={() => setDraftRevision(revision ?? null)}>{t("保留草稿，在已读取版本上继续")}</Button></div>}
        <details className="correction-history"><summary>{t("原始解析与修改历史")}</summary><h4>{t("原始解析（只读）")}</h4><Markdown text={original.stem} /><Blocks blocks={original.contentBlocks} /><p>{t("题型标签：")}{original.questionTypeId ?? t("未提供")}</p><ReferenceAnswer question={original} /><Markdown text={original.analysis} /><Markdown text={original.scoringRubric} />{corrections?.edits?.filter(edit => edit.questionIndex === questionIndex).map((edit,index) => <section key={edit.requestId}><h4>{t("第 ")}{index + 1}{t(" 次修改 · ")}<time dateTime={edit.savedAt}>{new Date(edit.savedAt).toLocaleString()}</time></h4><Markdown text={edit.question.stem} /><Blocks blocks={edit.question.contentBlocks} /><p>{t("题型标签：")}{edit.question.questionTypeId ?? t("未提供")}</p>{edit.question.options.map((option,i) => <p key={i}>{option.label} · {option.content}</p>)}<ReferenceAnswer question={edit.question} /><Markdown text={edit.question.analysis} /><Markdown text={edit.question.scoringRubric} />{edit.answerEvidence && <details><summary>{t("已确认的答案来源 · ")}{edit.answerEvidence.fileName ?? t("答案卷")}</summary><Markdown text={edit.answerEvidence.sourceText} /><p>SHA-256：{edit.answerEvidence.sourceSha256}</p><p>{t("来源任务：")}{edit.answerEvidence.selection.taskId}{t(" · 第 ")}{edit.answerEvidence.selection.questionIndex + 1}{t(" 条")}</p></details>}</section>)}</details>
        <div className="task-actions"><Button variant="outline" disabled={saving || reloading} onClick={() => void reload()}>{reloading ? t("正在读取…") : t("重新读取已保存修订")}</Button><Button disabled={!revision || editing || saving || reloading} onClick={async () => { if (saving || reloading) return; setSaving(true); setError(""); try { const exported = await client.exportBank(task, revision); if (client.active) await downloadBlob(exported.blob, exported.name); } catch (e) { setError(e instanceof Error ? e.message : t("修订版导出失败，请重试。")); } finally { setSaving(false); } }}>{nativeBridge() ? t("导入修订版题库") : t("下载修订版 ZIP")}</Button>{nativeBridge()?.documents && <Button variant="outline" disabled={!revision || editing || saving || reloading || !!pendingRequestId} onClick={async () => { setSaving(true); setError(""); try { const saved = await client.saveBankZip(task, revision); if (client.active) setNotice(saved ? t("题库 ZIP 已保存。") : t("已取消保存题库 ZIP。")); } catch (e) { setError(e instanceof Error ? e.message : t("修订版导出失败，请重试。")); } finally { setSaving(false); } }}>{t("导出修订版 ZIP")}</Button>}</div>
        <p>{nativeBridge() ? t("修订版包含全部已保存修改，保留来源与复核标记。任务上方的导入按钮使用原始解析结果。") : t("修订版包含本次解析结果全部已保存修改，保留原有来源与复核标记。任务上方的下载按钮导出原始解析结果。")}</p>
      </div>
    </div>
  </section>;
}
