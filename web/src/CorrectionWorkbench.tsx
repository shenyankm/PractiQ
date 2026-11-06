import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactReference, DocumentCorrectionSave, DocumentCorrections, DocumentTaskDetail, DocumentTaskReview, ParsedQuestion, ReviewUnit } from "./contracts.generated";
import { ApiError, Client, downloadBlob } from "./api";
import { Button } from "./components/ui/button";
import { Blocks, Markdown, ReferenceAnswer } from "./ResultReview";
import QuestionCorrectionEditor from "./QuestionCorrectionEditor";

function EvidencePane({ unit, original, question, client, threadId }: { unit?: ReviewUnit; original?: DocumentTaskReview["document"]; question: ParsedQuestion; client: Client; threadId: string }) {
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
      } catch { if (!controller.signal.aborted) setEvidence({ error: "来源读取或校验失败，请重试。" }); }
    }
    void read(reference);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [reference, client, threadId, attempt]);
  const quote = question.sourceText?.trim();
  const match = quote && evidence.text ? evidence.text.indexOf(quote) : -1;
  return <section className="source-pane" aria-label="原文对照">
    <h4>{unit?.stage === "vision_parse" ? `来源页 ${(unit.sourcePage ?? unit.index) + 1}` : "来源文本片段"}</h4>
    {reference?.mediaType === "application/json" && <p>此处是已保存的识别证据，可能与原文件有差异，请核对原文件。</p>}
    {!reference && <p>此题没有可定位的来源页。以下仅显示保存的来源原文，不推断页码。</p>}
    {reference && !evidence.url && evidence.text === undefined && !evidence.error && <p role="status">正在校验来源…</p>}
    {evidence.url && <img src={evidence.url} alt={`题目来源${unit ? ` · 第 ${(unit.sourcePage ?? unit.index) + 1} 页` : "原图"}`} />}
    {evidence.text !== undefined && <pre className="source-text">{match >= 0 && quote ? <>{evidence.text.slice(0, match)}<mark>{quote}</mark>{evidence.text.slice(match + quote.length)}</> : evidence.text}</pre>}
    {!reference && <Markdown text={question.sourceText} />}
    {evidence.error && <><p role="alert">{evidence.error}</p><Button variant="outline" onClick={() => setAttempt(v => v + 1)}>重试读取来源</Button></>}
  </section>;
}

export type CorrectionLeaveGuard = (() => boolean) | null;

type Props = { task: DocumentTaskDetail; preview: DocumentTaskReview | null; question: ParsedQuestion; original: ParsedQuestion; questionIndex: number; units: ReviewUnit[]; corrections: DocumentCorrections | null; client: Client; onSaved: (value: DocumentCorrections) => void; onClose: () => void; unavailable?: boolean; onLeaveGuardChange?: (guard: CorrectionLeaveGuard) => void };
export default function CorrectionWorkbench({ task, preview, question, original, questionIndex, units, corrections, client, onSaved, onClose, unavailable = false, onLeaveGuardChange }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [reloading, setReloading] = useState(false);
  const pendingSave = useRef<{ fingerprint: string; request: DocumentCorrectionSave } | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const canEdit = !unavailable && task.state === "COMPLETED" && !!task.result && !!task.checkpointId && !!corrections;
  const revision = corrections?.edits?.at(-1)?.requestId;
  useEffect(() => {
    if (!editing && !saving && !reloading && !pendingRequestId) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, saving, reloading, pendingRequestId]);
  useLayoutEffect(() => {
    onLeaveGuardChange?.(() => {
      if (saving || reloading || pendingRequestId) {
        setError("保存或核对尚未完成，请先重新读取已保存修订，保留原请求后再切换任务。");
        return false;
      }
      if (editing && !window.confirm("当前校对草稿尚未保存。确认放弃草稿并继续吗？")) return false;
      if (editing) setEditing(false);
      return true;
    });
    return () => onLeaveGuardChange?.(null);
  }, [editing, saving, reloading, pendingRequestId, onLeaveGuardChange]);
  async function save(value: ParsedQuestion) {
    if (!task.checkpointId || !corrections) throw Error("请先重新读取已保存修订。");
    setSaving(true); setError("");
    const wasUnconfirmed = !!pendingSave.current;
    try {
      const body = { checkpointId: task.checkpointId, expectedRevision: revision ?? null, questionIndex, question: value };
      const fingerprint = JSON.stringify(body);
      if (pendingSave.current?.fingerprint !== fingerprint) pendingSave.current = { fingerprint, request: { ...body, requestId: crypto.randomUUID() } };
      setPendingRequestId(pendingSave.current.request.requestId);
      const saved = await client.saveCorrection(task.threadId, pendingSave.current.request);
      if (!client.active) return;
      pendingSave.current = null; setPendingRequestId(null);
      onSaved(saved); setEditing(false); setNotice("修订已保存。下载修订版会包含全部已保存修改，原始题库保留。");
    } catch (e) {
      if (!wasUnconfirmed && e instanceof ApiError && e.status >= 400 && e.status < 500 && ["CORRECTION_CONFLICT", "CORRECTION_INVALID", "CORRECTION_PROTECTED_FIELD", "CORRECTION_HISTORY_LIMIT", "CORRECTION_NOT_READY", "STALE_CHECKPOINT", "SERVICE_READ_ONLY", "HTTP_422"].includes(e.code)) {
        pendingSave.current = null; setPendingRequestId(null);
      }
      setError("保存未完成或回执未确认。草稿仍保留；请重新读取已保存修订，核对后再保存。");
      throw e;
    } finally { setSaving(false); }
  }
  async function reload() {
    setReloading(true); setError("");
    try {
      const saved = await client.corrections(task.threadId);
      if (saved.checkpointId !== task.checkpointId) throw Error("任务检查点已变化，请刷新任务后再校对。");
      onSaved(saved);
      if (pendingSave.current && saved.edits?.some(edit => edit.requestId === pendingSave.current!.request.requestId)) {
        pendingSave.current = null; setPendingRequestId(null); setEditing(false); setNotice("上次保存已确认，修订已经保留，无需重复提交。"); return;
      }
      setNotice("已重新读取修订。正在编辑的草稿保持不变，请核对修改历史后决定是否保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败，请重试。"); }
    finally { setReloading(false); }
  }
  return <section className="correction-workbench" aria-label="对照与校对工作台">
    <div className="review-header"><h3 ref={heading} tabIndex={-1}>对照与校对 · 第 {questionIndex + 1} 条</h3><Button variant="outline" disabled={editing || saving || reloading || !!pendingRequestId} onClick={onClose}>返回题目列表</Button></div>
    <p>先核对来源，再修改题目。只保存人工修订，不重新解析文档。</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{pendingRequestId && <p role="status">保存请求 ID：{pendingRequestId} · {saving ? "正在等待保存回执。" : "结果尚未确认，先重新读取修订或使用原请求重试。"}</p>}
    <div className="correction-columns">
      <div>{units.length > 1 && <nav className="source-navigation" aria-label="关联来源">{units.map((unit,index) => <Button key={`${unit.stage}:${unit.index}`} variant={index === sourceIndex ? "default" : "outline"} onClick={() => setSourceIndex(index)}>来源 {index + 1}</Button>)}</nav>}<EvidencePane key={`${units[sourceIndex]?.stage}:${units[sourceIndex]?.index}`} unit={units[sourceIndex]} original={preview?.document} question={original} client={client} threadId={task.threadId} />
        {preview?.document && <Button variant="outline" onClick={async () => { try { const blob = await client.source(preview.document!, task.threadId); if (client.active) downloadBlob(blob, preview.document!.fileName ?? "source"); } catch { setError("原文件读取或校验失败，请重试。"); } }}>下载原文件核对</Button>}
      </div>
      <div className="correction-question">
        {editing ? <QuestionCorrectionEditor question={question} saving={saving} checking={reloading} unconfirmed={!!pendingRequestId} onSave={save} onCancel={() => { setEditing(false); setError(""); }} /> : <><h4>当前题目</h4><Markdown text={question.stem} /><Blocks blocks={question.contentBlocks} /><p>题型标签：{question.questionTypeId ?? "未提供"}</p><div>{question.options.map((option,index) => <p key={index}>{option.label} · {option.content}</p>)}</div><h4>当前参考答案</h4><ReferenceAnswer question={question} /><h4>解析</h4><Markdown text={question.analysis} /><h4>评分依据</h4><Markdown text={question.scoringRubric} /><Button disabled={!canEdit || reloading || !!pendingRequestId} onClick={() => setEditing(true)}>人工校对</Button>{!canEdit && <p>任务完成并读取一致的修订记录后，才能保存人工修改。</p>}</>}
        <details className="correction-history"><summary>原始解析与修改历史</summary><h4>原始解析（只读）</h4><Markdown text={original.stem} /><Blocks blocks={original.contentBlocks} /><p>题型标签：{original.questionTypeId ?? "未提供"}</p><ReferenceAnswer question={original} /><Markdown text={original.analysis} /><Markdown text={original.scoringRubric} />{corrections?.edits?.filter(edit => edit.questionIndex === questionIndex).map((edit,index) => <section key={edit.requestId}><h4>第 {index + 1} 次修改 · <time dateTime={edit.savedAt}>{new Date(edit.savedAt).toLocaleString()}</time></h4><Markdown text={edit.question.stem} /><Blocks blocks={edit.question.contentBlocks} /><p>题型标签：{edit.question.questionTypeId ?? "未提供"}</p>{edit.question.options.map((option,i) => <p key={i}>{option.label} · {option.content}</p>)}<ReferenceAnswer question={edit.question} /><Markdown text={edit.question.analysis} /><Markdown text={edit.question.scoringRubric} /></section>)}</details>
        <div className="task-actions"><Button variant="outline" disabled={saving || reloading} onClick={() => void reload()}>{reloading ? "正在读取…" : "重新读取已保存修订"}</Button><Button disabled={!revision || editing || saving} onClick={async () => { try { const exported = await client.exportBank(task, revision); if (client.active) downloadBlob(exported.blob, exported.name); } catch (e) { setError(e instanceof Error ? e.message : "修订版导出失败，请重试。"); } }}>下载修订版 ZIP</Button></div>
        <p>修订版包含本次解析结果全部已保存修改，保留原有来源与复核标记。任务上方的下载按钮导出原始解析结果。</p>
      </div>
    </div>
  </section>;
}
