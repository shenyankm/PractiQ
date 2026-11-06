import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Image as ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";
import type { ArtifactReference, ContentBlock, DocumentCorrections, DocumentReparseSelection, DocumentTaskDetail, DocumentTaskReview, ParsedQuestion } from "./contracts.generated";
import { AnswerSheetMatcher } from "./AnswerSheetMatcher";
import { CorrectionDraftRecovery } from "./CorrectionDraftRecovery";
import CorrectionWorkbench, { type AnswerAssociation, type CorrectionLeaveGuard } from "./CorrectionWorkbench";
import { Select, SelectOption } from "./components/ui/select";
import { Client, downloadBlob } from "./api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";

export const Markdown = memo(function Markdown({ text }: { text: string | null | undefined }) {
  if (text == null) return <span className="text-muted-foreground">未提供（null）</span>;
  return <div className="document-content"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", throwOnError: false, maxExpand: 1000 }]]} components={{ img: ({ alt }) => <span>[图片：{alt || "请查看关联资源"}]</span>, a: ({ children }) => <span className="underline">{children}</span> }}>{text}</ReactMarkdown></div>;
});
const QuestionRecord = memo(function QuestionRecord({ question }: { question: ParsedQuestion }) {
  const [loaded, setLoaded] = useState(false);
  return <details onToggle={event => { if (event.currentTarget.open && !loaded) setLoaded(true); }}>
    <summary>完整结构化记录（只读）</summary>
    {loaded && <pre className="raw-data">{JSON.stringify(question, null, 2)}</pre>}
  </details>;
});
export function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return <div className="space-y-3">{blocks.map((block, index) => <div key={index}>
    {block.label && <p className="font-medium">{block.label}</p>}
    {block.role && <Badge variant="outline">{block.role}</Badge>}
    {block.partType === "html" ? [block.markdownValue, block.textValue].filter((value, index, values) => value && values.indexOf(value) === index).map((value, index) => <pre key={index} className="raw-data">{value}</pre>) : <>
      {block.latexValue && <Markdown text={`$$
${block.latexValue}
$$`} />}
      {block.markdownValue != null && <Markdown text={block.markdownValue} />}
      {block.textValue != null && block.textValue !== block.markdownValue && <Markdown text={block.textValue} />}
      {block.partType === "blank" && <span>空位 · {block.questionId || "未关联题目"}</span>}
    </>}
    {block.jsonValue && <pre className="raw-data">{JSON.stringify(block.jsonValue, null, 2)}</pre>}
  </div>)}</div>;
}
export function ImageArtifact({ reference, description, client, threadId }: { reference: ArtifactReference; description: string; client: Client; threadId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setUrl(null); setError(null); setLoading(false);
    return () => current.abort();
  }, [client, threadId, reference.objectKey, reference.sha256, reference.sizeBytes, reference.mediaType]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function load() {
    const signal = controller.current!.signal;
    setLoading(true); setError(null);
    try {
      const blob = await client.image(reference, threadId, signal);
      if (client.active && !signal.aborted) setUrl(URL.createObjectURL(blob));
    } catch { if (client.active && !signal.aborted) setError("图片无法读取或校验失败，请重试。"); }
    finally { if (client.active && !signal.aborted) setLoading(false); }
  }
  return <figure className="resource-card">
    <figcaption>{description}</figcaption>
    <details className="resource-details"><summary>图片校验信息</summary><p className="text-xs text-muted-foreground">SHA-256：{reference.sha256}</p></details>
    {url && <img src={url} alt={description} className="max-h-96 max-w-full object-contain" />}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button variant="outline" disabled={loading} onClick={() => void load()}><ImageIcon />{loading ? "正在校验图片…" : url ? "重新读取图片" : "查看图片"}</Button>
  </figure>;
}
function SourceEvidence({ reference, client, threadId }: { reference: ArtifactReference; client: Client; threadId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    setText(null); setError(false); setLoading(false);
    return () => current.abort();
  }, [client, threadId, reference.objectKey, reference.sha256, reference.sizeBytes, reference.mediaType]);
  async function load() {
    const signal = controller.current!.signal;
    setLoading(true); setError(false);
    try {
      const blob = await client.evidence(reference, threadId, signal);
      signal.throwIfAborted();
      const value = await blob.text();
      if (client.active && !signal.aborted) setText(value);
    } catch { if (client.active && !signal.aborted) setError(true); }
    finally { if (client.active && !signal.aborted) setLoading(false); }
  }
  return <section className="resource-card">
    <h5>来源证据（只读）</h5>
    <p>识别结果可能有误，请与原文件核对。</p>
    <details className="resource-details"><summary>来源校验信息</summary><p>SHA-256：{reference.sha256}</p></details>
    {text !== null && <pre className="raw-data">{text}</pre>}
    {error && <p role="alert">来源证据无法读取或校验失败，请重试。</p>}
    <Button variant="outline" disabled={loading} onClick={() => void load()}>{loading ? "正在校验来源…" : "查看来源证据"}</Button>
  </section>;
}
function OriginalSource({ document, client, threadId }: { document: NonNullable<DocumentTaskReview["document"]>; client: Client; threadId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  async function download() {
    setLoading(true); setError(false);
    try {
      const blob = await client.source(document, threadId);
      if (client.active) downloadBlob(blob, document.fileName || "source");
    } catch { if (client.active) setError(true); }
    finally { if (client.active) setLoading(false); }
  }
  return <section className="resource-card"><h4>原始文档</h4><p>{document.fileName || "原文件"}</p>
    <Button variant="outline" disabled={loading} onClick={() => void download()}>{loading ? "正在校验原文件…" : "下载原文件"}</Button>
    {error && <p role="alert">原文件无法读取或校验失败，请重试。</p>}
  </section>;
}
type Entry = { question: ParsedQuestion; stage: string; index: number; ordinal: number };
const questionTypes: Record<NonNullable<ParsedQuestion["answerMode"]>, string> = { choice: "选择题", true_false: "判断题", fill_blank: "填空题", short_answer: "简答题", ordering: "排序题", matching: "匹配题", reading: "阅读理解", word_bank: "选词填空", cloze: "完形填空", listening: "听力题", gap_fill: "语法填空" };
function relatedQuestion(entry: Entry, questions: Map<string, ParsedQuestion | null>, id?: string | null) {
  return id ? questions.get(JSON.stringify([entry.stage, entry.index, id])) || questions.get(JSON.stringify([id])) : undefined;
}
function answerItemContent(items: ParsedQuestion["items"], id: number | null | undefined) {
  if (id == null) return "未提供答案（null）";
  return items.find((item,index) => (item.id ?? index) === id)?.content ?? `未关联题项（${id}）`;
}
export function ReferenceAnswer({ question: q }: { question: ParsedQuestion }) {
  const answer: Record<string, unknown> | null = q.answerPayload;
  if (answer == null) return <p>未提供（null），不会补写答案</p>;
  if (Array.isArray(answer.correct) && answer.correct.every(value => value == null || typeof value === "string")) return <p>{answer.correct.map(value => value ?? "未提供答案（null）").join("、") || "参考答案为空"}</p>;
  if (typeof answer.value === "boolean") return <p>{answer.value ? "正确" : "错误"}</p>;
  if (Array.isArray(answer.answers) && answer.answers.every(value => value == null || typeof value === "string")) {
    if (!answer.answers.length) return <p>参考答案为空</p>;
    return <ol className="list-inside list-decimal space-y-2">{answer.answers.map((value, index) => <li key={index}><Markdown text={value ?? "该空未提供答案（null）"}/></li>)}</ol>;
  }
  if (typeof answer.text === "string") return <Markdown text={answer.text}/>;
  if (Array.isArray(answer.order) && answer.order.every(value => value == null || typeof value === "number")) {
    if (!answer.order.length) return <p>参考答案为空</p>;
    return <ol className="list-inside list-decimal space-y-2">{answer.order.map((id, index) => <li key={index}><Markdown text={answerItemContent(q.items,id)}/></li>)}</ol>;
  }
  if (Array.isArray(answer.matches) && answer.matches.every(pair => pair == null || (typeof pair === "object" && (pair.left == null || typeof pair.left === "number") && (pair.right == null || typeof pair.right === "number")))) {
    if (!answer.matches.length) return <p>参考答案为空</p>;
    const left=q.items.filter(item => item.side === "left"), right=q.items.filter(item => item.side === "right");
    return <ul className="space-y-2">{answer.matches.map((pair, index) => <li key={index}><Markdown text={pair == null ? "未提供答案（null）" : `${answerItemContent(left,pair.left)} → ${answerItemContent(right,pair.right)}`}/></li>)}</ul>;
  }
  return <p>答案结构需人工核对，请展开来源与技术详情。</p>;
}
const missingFieldNames: Record<string, string> = { stem:"题干", questionTypeId:"题型", answerMode:"作答方式", choiceVariant:"选择题类型", matchingVariant:"匹配方式", options:"选项", items:"题项", answerPayload:"参考答案", analysis:"解析", sourceText:"来源原文", media:"图片或音频", material:"材料" };
function QuestionCard({ entry, questions, sourcesById, onCompare }: { entry: Entry; questions: Map<string, ParsedQuestion | null>; sourcesById: Map<string, NonNullable<DocumentTaskReview>["questionSources"]>; onCompare: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const q = entry.question;
  const parent = relatedQuestion(entry, questions, q.parentId);
  const owner = relatedQuestion(entry, questions, q.optionSourceId);
  const sources = q.id ? sourcesById.get(q.id) || [] : [];
  return <details className="question-card" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className="font-medium">{q.stem?.slice(0, 160) || "题干未提供（null）"}</span><span className="flex flex-wrap gap-2"><Badge variant="outline">{q.answerMode ? questionTypes[q.answerMode] : "题型未知（null）"}</Badge>{q.needsReview && <Badge variant="secondary">需要复核</Badge>}</span></summary>
    {expanded && <div className="space-y-5 pt-4">
      {(q.needsReview || q.missingFields.length > 0) && <p className="notice">需要人工复核{q.missingFields.length > 0 ? `；缺失：${q.missingFields.map(field => missingFieldNames[field] || field).join("、")}` : "；请与原文件核对。"}</p>}
      <Button variant="outline" onClick={onCompare}>对照原文与校对</Button>
      <section><h4>完整题干</h4><Markdown text={q.stem} /><Markdown text={q.instructions} /><Blocks blocks={[...(q.passage || []), ...q.contentBlocks, ...(q.transcript || [])]} /></section>
      {parent && <section className="material-context"><h4>所属材料 · {parent.id}</h4><Markdown text={parent.stem} /><Markdown text={parent.instructions} /><Blocks blocks={[...(parent.passage || []), ...parent.contentBlocks]} /></section>}
      {(q.options.length > 0 || owner) && <section><h4>{owner ? `共享选项 · ${q.optionSourceId}` : "选项"}</h4>{(owner?.options || q.options).map((option, index) => <div key={index} className="option-row"><span>{option.label ?? "标签未提供（null）"}</span><Markdown text={option.content} /></div>)}</section>}
      {q.items.length > 0 && <section><h4>条目</h4>{q.items.map((item, index) => <div className="option-row" key={index}><span>{item.label ?? item.id ?? index + 1} {item.side}</span><Markdown text={item.content} /></div>)}</section>}
      <section><h4>文档提供的参考答案</h4><ReferenceAnswer question={q}/><h4>解析与评分依据</h4><Markdown text={q.analysis} /><Markdown text={q.scoringRubric} /></section>
      <section><h4>来源原文</h4><Markdown text={q.sourceText} /></section>
      <details className="review-technical"><summary>来源与技术详情</summary><dl className="metadata-grid"><dt>题目 ID</dt><dd>{q.id ?? "未提供（null）"}</dd><dt>所属材料</dt><dd>{q.parentId ?? "无（null）"}</dd><dt>共享选项来源</dt><dd>{q.optionSourceId ?? "无（null）"}</dd><dt>置信度</dt><dd>{q.confidence}</dd><dt>缺失字段</dt><dd>{q.missingFields.join("、") || "无"}</dd><dt>来源单元</dt><dd>{entry.stage} · {entry.index}{sources.map(source => <p key={`${source.stage}:${source.unitIndex}`}>{source.stage} · {source.unitIndex}</p>)}</dd></dl><QuestionRecord question={q}/></details>
    </div>}
  </details>;
}
export default function ResultReview({ task, preview, client, unavailable = false, onLeaveGuardChange, onReparse }: { task: DocumentTaskDetail; preview: DocumentTaskReview | null; client: Client; unavailable?: boolean; onLeaveGuardChange?: (guard: CorrectionLeaveGuard) => void; onReparse?: (selection: DocumentReparseSelection) => void }) {
  const listHeading = useRef<HTMLHeadingElement>(null);
  const compared = useRef(false);
  const [page, setPage] = useState(0);
  const [issueFilter, setIssueFilter] = useState("all");
  const [selectedEntry, setSelectedEntry] = useState<(Entry & { recoveryRequestId?: string | null; association?: AnswerAssociation; task: DocumentTaskDetail; preview: DocumentTaskReview | null; units: DocumentTaskReview["units"] }) | null>(null);
  useEffect(() => {
    if (selectedEntry) compared.current = true;
    else if (compared.current) { listHeading.current?.focus(); compared.current = false; }
  }, [selectedEntry]);
  const [chosen, setChosen] = useState<{ checkpoint: string | null; taskId: string; indexes: number[] }>({ checkpoint: task.checkpointId ?? null, taskId: task.threadId, indexes: [] });
  const selectedIndexes = chosen.checkpoint === task.checkpointId && chosen.taskId === task.threadId ? chosen.indexes : [];
  const [selectionError, setSelectionError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [matchingAnswers, setMatchingAnswers] = useState(false);
  const canSelect = task.state === "COMPLETED" && !!task.result && (!preview || preview.checkpointId === task.checkpointId);
  function choose(indexes: number[]) { const unique = [...new Set(indexes)]; if (unique.length > 2000) { setSelectionError("每次最多勾选 2000 条，请分批导出。"); return; } setSelectionError(""); setChosen({ checkpoint: task.checkpointId ?? null, taskId: task.threadId, indexes: unique }); }
  const [savedCorrections, setSavedCorrections] = useState<DocumentCorrections | null>(null);
  const corrections = savedCorrections?.checkpointId === task.checkpointId ? savedCorrections : preview?.checkpointId === task.checkpointId ? preview.corrections ?? null : null;
  const [tab, setTab] = useState<"questions" | "sources">("questions");
  const [resourcePage, setResourcePage] = useState(0);
  const [search, setSearch] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [qualityExpanded, setQualityExpanded] = useState(false);
  const quality = preview?.quality || task.processing?.quality;
  const qualityText = useMemo(() => tab === "sources" && qualityExpanded ? JSON.stringify(quality || {}, null, 2) : "", [quality, qualityExpanded, tab]);
  const {units, entries, visuals, groups, questions, sourcesById, sources} = useMemo(() => {
    const units = preview?.units || [];
    const result = (!preview || preview.checkpointId === task.checkpointId) && !units.some(unit => unit.stage === "result" || unit.questions.length) ? task.result : null;
    const originalEntries: Entry[] = result ? result.questions.map((question, ordinal) => ({question,stage:"result",index:0,ordinal})) : units.flatMap(unit => unit.questions.map((question, ordinal) => ({question,stage:unit.stage,index:unit.index,ordinal})));
    const revised = new Map(corrections?.edits?.map(edit => [edit.questionIndex, edit.question]));
    const entries = originalEntries.map(entry => entry.stage === "result" && revised.has(entry.ordinal) ? { ...entry, question: revised.get(entry.ordinal)! } : entry);
    const questions = new Map<string,ParsedQuestion | null>();
    for (const entry of entries) {
      if (!entry.question.id) continue;
      const idKey = JSON.stringify([entry.question.id]);
      questions.set(idKey, questions.has(idKey) ? null : entry.question);
      const unitKey = JSON.stringify([entry.stage,entry.index,entry.question.id]);
      if (!questions.has(unitKey)) questions.set(unitKey,entry.question);
    }
    const sources = preview?.questionSources || task.processing?.questionSources || [];
    const sourcesById = new Map<string, typeof sources>();
    for (const source of sources) { const values = sourcesById.get(source.questionId) || []; values.push(source); sourcesById.set(source.questionId,values); }
    return {units,entries,questions,sourcesById,sources,
      visuals:result?.visualElements || units.flatMap(unit => unit.visualElements || []),
      groups:result?.groups || units.flatMap(unit => unit.groups)};
  }, [preview, task.checkpointId, task.result, task.processing, corrections]);
  const filteredEntries = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    const optionMatches = new Map<ParsedQuestion["options"], boolean>();
    return entries.filter(entry => {
      const q = entry.question;
      if (reviewOnly && !q.needsReview) return false;
      if (issueFilter === "answer" && q.answerPayload != null && !q.missingFields.includes("answerPayload")) return false;
      if (issueFilter === "type" && q.answerMode && q.questionTypeId) return false;
      if (issueFilter === "relation" && !q.missingFields.includes("material") && !q.parentId && !q.optionSourceId) return false;
      if (issueFilter === "answer" && ["reading", "word_bank", "cloze", "listening", "gap_fill"].includes(q.answerMode || "")) return false;
      if (!keyword || [q.id, q.stem, q.sourceText].some(text => text?.toLocaleLowerCase().includes(keyword))) return true;
      const options = relatedQuestion(entry, questions, q.optionSourceId)?.options || q.options;
      if (!optionMatches.has(options)) optionMatches.set(options, options.some(option => option.content?.toLocaleLowerCase().includes(keyword)));
      return optionMatches.get(options)!;
    });
  }, [entries, questions, search, reviewOnly, issueFilter]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filteredEntries.length / 20) - 1));
  const resourceCount = Math.max(groups.length, visuals.length, units.length, sources.length);
  const currentResourcePage = Math.min(resourcePage, Math.max(0, Math.ceil(resourceCount / 20) - 1));
  const resourceStart = currentResourcePage * 20;
  if (selectedEntry) {
    const current = task.checkpointId === selectedEntry.task.checkpointId ? entries.find(entry => entry.stage === selectedEntry.stage && entry.index === selectedEntry.index && entry.ordinal === selectedEntry.ordinal) ?? selectedEntry : selectedEntry;
    if (current) {
      const associations = (selectedEntry.preview?.questionSources ?? selectedEntry.task.processing?.questionSources ?? []).filter(source => source.questionId === current.question.id);
      const relatedUnits = selectedEntry.units.filter(unit => unit.stage !== "result" && (unit.stage === current.stage && unit.index === current.index || associations.some(source => source.stage === unit.stage && source.unitIndex === unit.index)));
      const original = current.stage === "result" ? selectedEntry.task.result?.questions[current.ordinal] ?? selectedEntry.question : selectedEntry.question;
      return <CorrectionWorkbench key={`${selectedEntry.task.threadId}:${selectedEntry.task.checkpointId}:${current.ordinal}`} restoreRequestId={selectedEntry.recoveryRequestId} association={selectedEntry.association} task={selectedEntry.task} preview={selectedEntry.preview} question={current.question} original={original} questionIndex={current.ordinal} units={relatedUnits} corrections={savedCorrections?.checkpointId === selectedEntry.task.checkpointId ? savedCorrections : selectedEntry.preview?.corrections ?? null} client={client} unavailable={unavailable} onLeaveGuardChange={onLeaveGuardChange} onSaved={setSavedCorrections} onClose={() => setSelectedEntry(null)} />;
    }
  }
  return <section className="space-y-4" aria-label="解析结果检查">
    <div className="review-header"><h3 ref={listHeading} tabIndex={-1}>解析结果 · {entries.length} 条题目记录</h3><div className="flex gap-2"><Button aria-pressed={tab === "questions"} variant={tab === "questions" ? "default" : "outline"} onClick={() => setTab("questions")}>题目与材料</Button><Button aria-pressed={tab === "sources"} variant={tab === "sources" ? "default" : "outline"} onClick={() => setTab("sources")}>来源与资源</Button></div></div>
    <CorrectionDraftRecovery scope={client.storageScope} task={task} onOpen={draft => { const entry = entries.find(e => e.stage === "result" && e.ordinal === draft.questionIndex); if (entry) setSelectedEntry({ ...entry, task, preview, units, recoveryRequestId: draft.pending?.requestId ?? null }); }} />
    {(task.status === "PARTIAL" || !!task.result?.warnings.length || !!task.result?.missingFields?.length || preview?.quality.reviewRequired) && <section className="notice space-y-2" aria-label="结果提醒">
      {task.status === "PARTIAL" && <p>这是部分结果，失败单元、缺失字段与原始警告会随题库保留。</p>}
      {!!task.result?.warnings.length && <div><h4>结果警告</h4><ul>{task.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {!!task.result?.missingFields?.length && <p>文档缺失字段：{task.result.missingFields.join("、")}</p>}
      {preview?.quality.reviewRequired && <p>待人工复核 {preview.quality.reviewQuestionCount || 0} 题 · 导出保留复核标记</p>}
    </section>}
    {tab === "questions" ? <>
      {!!entries.length && <div className="review-filters"><label><span>搜索解析题目</span><Input type="search" value={search} placeholder="搜索题目 ID、题干、选项或来源原文" onChange={event => { setSearch(event.target.value); setPage(0); }}/></label><label><span>问题分类</span><Select value={issueFilter} onValueChange={value => { setIssueFilter(value); setPage(0); }}><SelectOption value="all">全部问题</SelectOption><SelectOption value="answer">缺少参考答案</SelectOption><SelectOption value="type">题型信息缺失</SelectOption><SelectOption value="relation">材料与关联核对</SelectOption></Select></label><label className="review-checkbox"><input type="checkbox" checked={reviewOnly} onChange={event => { setReviewOnly(event.target.checked); setPage(0); }}/>仅看需要复核</label>{(search || reviewOnly || issueFilter !== "all") && <Button variant="outline" onClick={() => { setSearch(""); setReviewOnly(false); setIssueFilter("all"); setPage(0); }}>清除结果筛选</Button>}<p role="status"><span>显示 {filteredEntries.length} / {entries.length} 条记录</span>{(search.trim() || reviewOnly || issueFilter !== "all") && <span className="block">筛选仅影响显示，导出仍包含全部已完成题目。</span>}</p></div>}
      {canSelect && <section className="space-y-2" aria-label="所选题目操作"><div className="task-actions"><Button variant="outline" onClick={() => choose([...selectedIndexes, ...filteredEntries.slice(currentPage * 20, currentPage * 20 + 20).filter(e => e.stage === "result").map(e => e.ordinal)])}>勾选本页</Button><Button variant="ghost" disabled={!selectedIndexes.length} onClick={() => choose([])}>清空勾选</Button><span>已勾选 {selectedIndexes.length} 条</span>
      <Button disabled={unavailable || exporting || !selectedIndexes.length} onClick={async () => { setExporting(true); setSelectionError(""); try { const result = await client.exportBank(task, corrections?.edits?.at(-1)?.requestId, selectedIndexes); if (client.active) downloadBlob(result.blob, result.name); } catch (e) { setSelectionError(e instanceof Error ? e.message : "所选题目导出失败。"); } finally { setExporting(false); } }}>{exporting ? "正在导出…" : "下载所选题目 ZIP"}</Button>
      {onReparse && <Button variant="outline" disabled={unavailable || !selectedIndexes.length || !task.checkpointId || !task.modelConfigured} onClick={() => { const selectedIds = new Set(selectedIndexes.map(index => task.result!.questions[index].id)); const sourceUnits = sources.filter(source => selectedIds.has(source.questionId)); const units = [...new Map(sourceUnits.map(source => [`${source.stage}:${source.unitIndex}`, { stage: source.stage, index: source.unitIndex }])).values()]; if (!units.length) { setSelectionError("所选题目没有可重解析的来源单元。"); return; } onReparse({ checkpointId: task.checkpointId!, units }); }}>重新解析所选题目的来源</Button>}
      <Button variant="outline" disabled={unavailable || !corrections} onClick={() => setMatchingAnswers(value => !value)}>关联答案卷</Button></div><p>导出会带上必要材料、共享选项和关联小题；重解析会创建新任务，可能同时包含同一来源单元中的其他题目，并产生 AI 整理费用。</p>{selectionError && <p role="alert">{selectionError}</p>}</section>}
      {matchingAnswers && canSelect && <AnswerSheetMatcher task={task} questions={entries.filter(e => e.stage === "result").map(e => e.question)} client={client} unavailable={unavailable} onAssociate={(questionIndex, association, corrections) => { setSavedCorrections(corrections); const entry = entries.find(e => e.stage === "result" && e.ordinal === questionIndex); if (entry) setSelectedEntry({ ...entry, task, preview, units, association }); }} />}
      {filteredEntries.length ? filteredEntries.slice(currentPage * 20, currentPage * 20 + 20).map(entry => <div key={JSON.stringify([entry.stage, entry.index, entry.question.id || entry.ordinal])}>{canSelect && entry.stage === "result" && <label className="review-checkbox"><input type="checkbox" checked={selectedIndexes.includes(entry.ordinal)} onChange={event => choose(event.target.checked ? [...selectedIndexes, entry.ordinal] : selectedIndexes.filter(i => i !== entry.ordinal))} />选择第 {entry.ordinal + 1} 题</label>}<QuestionCard entry={entry} questions={questions} sourcesById={sourcesById} onCompare={() => setSelectedEntry({ ...entry, task, preview, units })} /></div>) : <p className="text-muted-foreground">{entries.length ? "没有匹配题目，请调整或清除筛选。" : "尚无可查看的题目。"}</p>}
      {filteredEntries.length > 20 && <nav className="flex items-center justify-between" aria-label="结果分页"><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft />上一页题目</Button><span>第 {currentPage * 20 + 1}–{Math.min(filteredEntries.length, currentPage * 20 + 20)} 条，共 {filteredEntries.length} 条</span><Button variant="outline" disabled={(currentPage + 1) * 20 >= filteredEntries.length} onClick={() => setPage(currentPage + 1)}>下一页题目<ChevronRight /></Button></nav>}
    </> : <div className="space-y-4">
      <section><h4>文档分组</h4>{groups.length ? groups.slice(resourceStart,resourceStart+20).map((group, index) => <div key={index} className="resource-card"><strong>{group.title}</strong><Markdown text={group.instructions} /><p>题目关联：{"questionIds" in group ? group.questionIds.join("、") : group.questionIndexes.join("、")}</p></div>) : <p>无文档分组。</p>}</section>
      {preview?.document && <OriginalSource key={preview.document.sha256} document={preview.document} client={client} threadId={task.threadId} />}
      <section><h4>图片与来源单元</h4>{visuals.slice(resourceStart,resourceStart+20).map((visual, index) => <div key={index} className="resource-card"><p>{visual.label || visual.kind} · {visual.description}</p><Markdown text={visual.extractedText} /><p>题目关联：{"questionIds" in visual ? visual.questionIds?.join("、") || "未确定" : "questionIndexes" in visual ? visual.questionIndexes?.join("、") || "未确定" : "未确定"}</p>{visual.imageRef && <ImageArtifact key={`image:${visual.imageRef.sha256}`} reference={visual.imageRef} description={visual.description} client={client} threadId={task.threadId} />}{visual.sourceRef && ["image/png", "image/jpeg"].includes(visual.sourceRef.mediaType) && <ImageArtifact key={`source:${visual.sourceRef.sha256}`} reference={visual.sourceRef} description="完整来源页" client={client} threadId={task.threadId} />}</div>)}{units.slice(resourceStart,resourceStart+20).map(unit => unit.sourceRef && ["image/png", "image/jpeg"].includes(unit.sourceRef.mediaType) && <ImageArtifact key={`${unit.stage}:${unit.index}:${unit.sourceRef.sha256}`} reference={unit.sourceRef} description={`来源单元 ${unit.stage} · ${unit.index}`} client={client} threadId={task.threadId} />)}{units.slice(resourceStart,resourceStart+20).map(unit => unit.sourceRef && ["application/json", "text/plain", "text/markdown"].includes(unit.sourceRef.mediaType) && <SourceEvidence key={`evidence:${unit.stage}:${unit.index}:${unit.sourceRef.sha256}`} reference={unit.sourceRef} client={client} threadId={task.threadId} />)}{units.slice(resourceStart,resourceStart+20).map(unit => unit.evidenceRef && <SourceEvidence key={`ocr:${unit.stage}:${unit.index}:${unit.evidenceRef.sha256}`} reference={unit.evidenceRef} client={client} threadId={task.threadId} />)}{!visuals.length && !units.some(unit => unit.sourceRef || unit.evidenceRef) && <p>无关联图片。</p>}</section>
      <details className="review-technical" open={sourcesExpanded} onToggle={event => setSourcesExpanded(event.currentTarget.open)}><summary>题目来源关联</summary>{sourcesExpanded && <pre className="raw-data">{JSON.stringify(sources.slice(resourceStart,resourceStart+20), null, 2)}</pre>}</details>
      <details className="review-technical" open={qualityExpanded} onToggle={event => setQualityExpanded(event.currentTarget.open)}><summary>质量记录</summary>{qualityExpanded && <pre className="raw-data">{qualityText}</pre>}</details>
      {resourceCount > 20 && <nav className="flex items-center justify-between" aria-label="资源分页"><Button variant="outline" disabled={!currentResourcePage} onClick={() => setResourcePage(currentResourcePage - 1)}>上一页资源</Button><span>第 {resourceStart + 1}–{Math.min(resourceCount,resourceStart+20)} 项，共 {resourceCount} 项</span><Button variant="outline" disabled={resourceStart + 20 >= resourceCount} onClick={() => setResourcePage(currentResourcePage + 1)}>下一页资源</Button></nav>}
    </div>}
  </section>;
}
