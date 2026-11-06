import { useEffect, useRef, useState } from "react";
import type { DocumentAnswerMatches, DocumentCorrections, DocumentTaskDetail, DocumentTaskSummary, ParsedQuestion } from "./contracts.generated";
import type { AnswerAssociation } from "./CorrectionWorkbench";
import { Client } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectOption } from "./components/ui/select";
import { Markdown, ReferenceAnswer } from "./ResultReview";

type Props = { task: DocumentTaskDetail; questions: ParsedQuestion[]; client: Client; unavailable: boolean; onAssociate: (index: number, association: AnswerAssociation, corrections: DocumentCorrections) => void };
const statusText = { unique: "题号有唯一候选，请核对", ambiguous: "存在同号记录，请手动选择", unmatched: "无明确候选，可手动选择", has_answer: "已有参考答案，默认保留" };
export function AnswerSheetMatcher({ task, questions, client, unavailable, onAssociate }: Props) {
  const [records, setRecords] = useState<DocumentTaskSummary[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [source, setSource] = useState<DocumentTaskDetail | null>(null);
  const [matches, setMatches] = useState<DocumentAnswerMatches | null>(null);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [replace, setReplace] = useState<Record<number, boolean>>({});
  const [file, setFile] = useState<File | null>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generationRef = generation;
    client.list(0, "completed", controller.signal).then(value => { if (!controller.signal.aborted) { setRecords(value.items); setHasMore(value.hasMore); setCursor(value.nextCursor); } }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "读取答案任务失败。"); });
    return () => { controller.abort(); generationRef.current++; };
  }, [client, task.threadId]);
  async function upload(retry = false) {
    if (busy || unavailable || (!retry && !file)) return;
    setBusy(true); setError("");
    const attempt = ++generation.current;
    try {
      const receipt = retry && pendingImport ? await client.retryImport(pendingImport) : await client.start(file!, await client.capabilities(), crypto.randomUUID(), (stage, requestId) => { if (stage === "starting" && requestId) setPendingImport(requestId); }, false, false, null, "answers");
      if (!client.active || attempt !== generation.current) return;
      setPendingImport(null); setSourceId(receipt.threadId); setSource(null); setMatches(null);
      setNotice("答案卷任务已创建。可在导入记录查看进度，完成后读取匹配建议；此处不会自动保存答案。");
    } catch (e) { if (attempt === generation.current) setError(e instanceof Error ? e.message : "答案卷导入失败，原请求仍保留。"); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  async function readMatches() {
    if (!sourceId || busy || unavailable) return;
    setBusy(true); setError(""); setMatches(null); setChoices({}); setReplace({});
    const attempt = ++generation.current;
    try {
      const detail = await client.detail(sourceId);
      const matched = await client.answerMatches(task, sourceId);
      if (!client.active || attempt !== generation.current) return;
      if (matched.checkpointId !== task.checkpointId || matched.answerTaskId !== sourceId || matched.answerCheckpointId !== detail.checkpointId || !detail.result) throw Error("答案或题目检查点已变化，请重新读取。");
      setSource(detail); setMatches(matched); setPage(0);
      setChoices(Object.fromEntries(matched.matches.filter(m => m.status === "unique" && m.candidates?.length === 1).map(m => [m.questionIndex, String(m.candidates![0] + 1)])));
    } catch (e) { if (attempt === generation.current) setError(e instanceof Error ? e.message : "读取匹配建议失败。"); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  async function associate(index: number, answerIndex: number) {
    if (busy || unavailable || !source?.checkpointId || !matches) return;
    setBusy(true); setError("");
    const attempt = ++generation.current;
    const selected = { taskId: source.threadId, checkpointId: source.checkpointId, questionIndex: answerIndex, replaceExisting: !!replace[index] };
    try {
      const proposal = await client.answerProposal(task, index, selected);
      if (!client.active || attempt !== generation.current) return;
      if (proposal.checkpointId !== task.checkpointId || proposal.corrections.checkpointId !== task.checkpointId || proposal.answerSource.taskId !== selected.taskId || proposal.answerSource.checkpointId !== selected.checkpointId || proposal.answerSource.questionIndex !== selected.questionIndex || !!proposal.answerSource.replaceExisting !== selected.replaceExisting) throw Error("答案候选检查点已变化，请重新读取。");
      onAssociate(index, { question: proposal.question, source: proposal.answerSource }, proposal.corrections);
    } catch (e) { if (attempt === generation.current) setError(e instanceof Error ? e.message : "读取答案候选失败。"); }
    finally { if (attempt === generation.current) setBusy(false); }
  }
  return <section className="space-y-3" aria-label="关联答案卷">
    <h4>关联答案卷</h4><p>分别导入题目和答案卷，按印刷题号提出候选。重号、缺号和格式冲突需人工核对；采用后仍需在校对编辑器保存。</p>
    <label className="grid gap-1.5">选择答案卷文件<Input type="file" disabled={busy || unavailable || !!pendingImport} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
    <Button variant="outline" disabled={busy || unavailable || !file || !!pendingImport} onClick={() => void upload()}>导入答案卷（将调用 AI）</Button>
    {pendingImport && <p>未确认导入请求：{pendingImport} <Button variant="outline" disabled={busy || unavailable} onClick={() => void upload(true)}>沿用原请求恢复答案卷导入</Button></p>}
    <label className="grid gap-1.5">已完成的答案卷任务<Select value={sourceId} disabled={busy || unavailable} onValueChange={value => { generation.current++; setSourceId(value); setSource(null); setMatches(null); }}><SelectOption value="">请选择以答案卷用途导入的文件</SelectOption>{records.filter(record => record.threadId !== task.threadId && record.documentRole === "answers").map(record => <SelectOption key={record.threadId} value={record.threadId}>{record.fileName}</SelectOption>)}{sourceId && !records.some(r => r.threadId === sourceId) && <SelectOption value={sourceId}>新导入的答案卷</SelectOption>}</Select></label>
    <div className="task-actions"><Button variant="outline" disabled={busy || unavailable || !sourceId} onClick={() => void readMatches()}>读取匹配建议（不调用模型）</Button>{hasMore && <Button variant="outline" disabled={busy || unavailable} onClick={async () => { setBusy(true); try { const value = await client.list(records.length, "completed", undefined, cursor ?? undefined); setRecords(old => [...old, ...value.items.filter(item => !old.some(v => v.threadId === item.threadId))]); setCursor(value.nextCursor); setHasMore(value.hasMore); } catch (e) { setError(e instanceof Error ? e.message : "读取更多任务失败。"); } finally { setBusy(false); } }}>更多答案任务</Button>}</div>
    {busy && <p role="status">正在读取或提交，请勿重复操作。</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {matches && source?.result && <>
      <p>答案卷：{source.fileName} · {source.result.questions.length} 条记录。下方序号是答案卷记录的位置，可手动调整。</p>
      {matches.matches.slice(page * 20, page * 20 + 20).map(match => {
        const target = questions[match.questionIndex];
        const value = choices[match.questionIndex] ?? "";
        const selected = value.trim() ? Number(value) - 1 : -1;
        const supplied = Number.isSafeInteger(selected) && selected >= 0 ? source.result!.questions[selected] : undefined;
        const locked = target?.answerPayload != null && !replace[match.questionIndex];
        return <section key={match.questionIndex} className="resource-card"><h5>题目 {match.questionIndex + 1} · {statusText[match.status]}</h5><Markdown text={target?.stem} />
          <label className="grid gap-1.5">第 {match.questionIndex + 1} 题对应答案卷记录序号<Input type="number" disabled={busy || unavailable} min={1} max={source.result!.questions.length} value={value} onChange={event => setChoices(old => ({ ...old, [match.questionIndex]: event.target.value }))} /></label>
          {target?.answerPayload != null && <label className="review-checkbox"><input type="checkbox" disabled={busy || unavailable} checked={!!replace[match.questionIndex]} onChange={event => setReplace(old => ({ ...old, [match.questionIndex]: event.target.checked }))} />明确替换已有参考答案（原答案保留在历史中）</label>}
          {supplied && <><h6>候选参考答案</h6><ReferenceAnswer question={supplied} /><h6>答案来源原文</h6><Markdown text={supplied.sourceText} /></>}
          <Button disabled={busy || unavailable || locked || !supplied?.answerPayload} onClick={() => void associate(match.questionIndex, selected)}>采用此答案并进入校对 · 第 {match.questionIndex + 1} 题</Button>
        </section>;
      })}
      {matches.matches.length > 20 && <nav className="task-actions" aria-label="答案匹配分页"><Button variant="outline" disabled={!page} onClick={() => setPage(p => p - 1)}>上一页匹配</Button><span>{page + 1} / {Math.ceil(matches.matches.length / 20)}</span><Button variant="outline" disabled={(page + 1) * 20 >= matches.matches.length} onClick={() => setPage(p => p + 1)}>下一页匹配</Button></nav>}
    </>}
  </section>;
}
