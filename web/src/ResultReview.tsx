import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Image as ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";
import type { ArtifactReference, ContentBlock, DocumentTaskDetail, DocumentTaskReview, ParsedQuestion } from "./contracts.generated";
import { Client } from "./api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";

export function Markdown({ text }: { text: string | null | undefined }) {
  if (text == null) return <span className="text-muted-foreground">未提供（null）</span>;
  return <div className="document-content"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", throwOnError: false, maxExpand: 1000 }]]} components={{ img: ({ alt }) => <span>[图片：{alt || "请查看关联资源"}]</span>, a: ({ children }) => <span className="underline">{children}</span> }}>{text}</ReactMarkdown></div>;
}
function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return <div className="space-y-3">{blocks.map((block, index) => <div key={index}>
    {block.label && <p className="font-medium">{block.label}</p>}
    {block.role && <Badge variant="outline">{block.role}</Badge>}
    {block.partType === "html" ? <pre className="raw-data">{block.textValue || block.markdownValue || "未提供（null）"}</pre> : <>
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
export function ImageArtifact({ reference, description, client }: { reference: ArtifactReference; description: string; client: Client }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function load() {
    setLoading(true); setError(null);
    try {
      const blob = await client.image(reference);
      if (client.active && mounted.current) setUrl(URL.createObjectURL(blob));
    } catch { if (client.active && mounted.current) setError("图片无法读取或校验失败，请重试。"); }
    finally { if (client.active && mounted.current) setLoading(false); }
  }
  return <figure className="resource-card">
    <figcaption>{description}</figcaption>
    <p className="text-xs text-muted-foreground">SHA-256：{reference.sha256}</p>
    {url && <img src={url} alt={description} className="max-h-96 max-w-full object-contain" />}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button variant="outline" disabled={loading} onClick={() => void load()}><ImageIcon />{loading ? "正在校验图片…" : url ? "重新读取图片" : "查看图片"}</Button>
  </figure>;
}
type Entry = { question: ParsedQuestion; stage: string; index: number };
function QuestionCard({ entry, questions, sourcesById }: { entry: Entry; questions: Map<string, ParsedQuestion | null>; sourcesById: Map<string, NonNullable<DocumentTaskReview>["questionSources"]> }) {
  const [expanded, setExpanded] = useState(false);
  const q = entry.question;
  const related = (id?: string | null) => id ? questions.get(JSON.stringify([entry.stage,entry.index,id])) || questions.get(JSON.stringify([id])) : undefined;
  const parent = q.parentId ? related(q.parentId) : undefined;
  const owner = q.optionSourceId ? related(q.optionSourceId) : undefined;
  const sources = q.id ? sourcesById.get(q.id) || [] : [];
  return <details className="question-card" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className="font-medium">{q.stem?.slice(0, 160) || "题干未提供（null）"}</span><span className="flex flex-wrap gap-2"><Badge variant="outline">{q.answerMode || "题型未知（null）"}</Badge>{q.needsReview && <Badge variant="secondary">需要复核</Badge>}</span></summary>
    {expanded && <div className="space-y-5 pt-4">
      <dl className="metadata-grid"><dt>题目 ID</dt><dd>{q.id ?? "未提供（null）"}</dd><dt>所属材料</dt><dd>{q.parentId ?? "无（null）"}</dd><dt>共享选项来源</dt><dd>{q.optionSourceId ?? "无（null）"}</dd><dt>置信度</dt><dd>{q.confidence}</dd><dt>缺失字段</dt><dd>{q.missingFields.join("、") || "无"}</dd><dt>来源单元</dt><dd>{entry.stage} · {entry.index}{sources.map(source => <p key={`${source.stage}:${source.unitIndex}`}>{source.stage} · {source.unitIndex}</p>)}</dd></dl>
      <section><h4>完整题干</h4><Markdown text={q.stem} /><Markdown text={q.instructions} /><Blocks blocks={[...(q.passage || []), ...q.contentBlocks, ...(q.transcript || [])]} /></section>
      {parent && <section className="material-context"><h4>所属材料 · {parent.id}</h4><Markdown text={parent.stem} /><Markdown text={parent.instructions} /><Blocks blocks={[...(parent.passage || []), ...parent.contentBlocks]} /></section>}
      {(q.options.length > 0 || owner) && <section><h4>{owner ? `共享选项 · ${q.optionSourceId}` : "选项"}</h4>{(owner?.options || q.options).map((option, index) => <div key={index} className="option-row"><span>{option.label ?? "标签未提供（null）"}</span><Markdown text={option.content} /></div>)}</section>}
      {q.items.length > 0 && <section><h4>条目</h4>{q.items.map((item, index) => <div className="option-row" key={index}><span>{item.label ?? item.id ?? index + 1} {item.side}</span><Markdown text={item.content} /></div>)}</section>}
      <section><h4>文档提供的参考答案</h4><pre className="raw-data">{q.answerPayload == null ? "未提供（null），不会补写答案" : JSON.stringify(q.answerPayload, null, 2)}</pre><h4>解析与评分依据</h4><Markdown text={q.analysis} /><Markdown text={q.scoringRubric} /></section>
      <section><h4>来源原文</h4><Markdown text={q.sourceText} /></section>
      <details><summary>完整结构化记录（只读）</summary><pre className="raw-data">{JSON.stringify(q, null, 2)}</pre></details>
    </div>}
  </details>;
}
export default function ResultReview({ task, preview, client }: { task: DocumentTaskDetail; preview: DocumentTaskReview | null; client: Client }) {
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"questions" | "sources">("questions");
  const [resourcePage, setResourcePage] = useState(0);
  const {units, entries, visuals, groups, questions, sourcesById, sources} = useMemo(() => {
    const units = preview?.units || [];
    const entries: Entry[] = units.length ? units.flatMap(unit => unit.questions.map(question => ({question,stage:unit.stage,index:unit.index}))) : (task.result?.questions || []).map(question => ({question,stage:"result",index:0}));
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
      visuals:units.length ? units.flatMap(unit => unit.visualElements || []) : task.result?.visualElements || [],
      groups:units.length ? units.flatMap(unit => unit.groups) : task.result?.groups || []};
  }, [preview, task.result, task.processing]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / 20) - 1));
  const resourceCount = Math.max(groups.length, visuals.length, units.length, sources.length);
  const currentResourcePage = Math.min(resourcePage, Math.max(0, Math.ceil(resourceCount / 20) - 1));
  const resourceStart = currentResourcePage * 20;
  return <section className="space-y-4" aria-label="解析结果检查">
    <div className="flex items-center justify-between gap-3"><h3>解析结果 · {entries.length} 条题目记录</h3><div className="flex gap-2"><Button variant={tab === "questions" ? "default" : "outline"} onClick={() => setTab("questions")}>题目与材料</Button><Button variant={tab === "sources" ? "default" : "outline"} onClick={() => setTab("sources")}>来源与资源</Button></div></div>
    {task.status === "PARTIAL" && <p className="notice">这是部分结果，失败单元、缺失字段与原始警告会随题库保留。</p>}
    {!!task.result?.warnings.length && <div className="notice"><h4>结果警告</h4><ul>{task.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    {!!task.result?.missingFields?.length && <p className="notice">文档缺失字段：{task.result.missingFields.join("、")}</p>}
    {preview?.quality.reviewRequired && <p className="notice">需要人工复核 · {preview.quality.reviewQuestionCount || 0} 条题目。复核标记不会在导出时自动清除。</p>}
    {tab === "questions" ? <>
      {entries.length ? entries.slice(currentPage * 20, currentPage * 20 + 20).map((entry, index) => <QuestionCard key={`${entry.stage}:${entry.index}:${entry.question.id || currentPage * 20 + index}`} entry={entry} questions={questions} sourcesById={sourcesById} />) : <p className="text-muted-foreground">当前检查点尚无可查看的题目，空结果不会补写内容。</p>}
      {entries.length > 20 && <nav className="flex items-center justify-between" aria-label="结果分页"><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft />上一页题目</Button><span>第 {currentPage * 20 + 1}–{Math.min(entries.length, currentPage * 20 + 20)} 条，共 {entries.length} 条</span><Button variant="outline" disabled={(currentPage + 1) * 20 >= entries.length} onClick={() => setPage(currentPage + 1)}>下一页题目<ChevronRight /></Button></nav>}
    </> : <div className="space-y-4">
      <section><h4>文档分组</h4>{groups.length ? groups.slice(resourceStart,resourceStart+20).map((group, index) => <div key={index} className="resource-card"><strong>{group.title}</strong><Markdown text={group.instructions} /><p>题目关联：{"questionIds" in group ? group.questionIds.join("、") : group.questionIndexes.join("、")}</p></div>) : <p>无文档分组。</p>}</section>
      <section><h4>题目来源关联</h4><pre className="raw-data">{JSON.stringify(sources.slice(resourceStart,resourceStart+20), null, 2)}</pre></section>
      <section><h4>质量记录</h4><pre className="raw-data">{JSON.stringify(preview?.quality || task.processing?.quality || {}, null, 2)}</pre></section>
      <section><h4>图片与来源单元</h4>{visuals.slice(resourceStart,resourceStart+20).map((visual, index) => <div key={index} className="resource-card"><p>{visual.label || visual.kind} · {visual.description}</p><Markdown text={visual.extractedText} /><p>题目关联：{"questionIds" in visual ? visual.questionIds?.join("、") || "未确定" : "questionIndexes" in visual ? visual.questionIndexes?.join("、") || "未确定" : "未确定"}</p>{visual.imageRef && <ImageArtifact key={visual.imageRef.sha256} reference={visual.imageRef} description={visual.description} client={client} />}{visual.sourceRef && ["image/png", "image/jpeg"].includes(visual.sourceRef.mediaType) && <ImageArtifact key={visual.sourceRef.sha256} reference={visual.sourceRef} description="完整来源页" client={client} />}</div>)}{units.slice(resourceStart,resourceStart+20).map(unit => unit.sourceRef && ["image/png", "image/jpeg"].includes(unit.sourceRef.mediaType) && <ImageArtifact key={`${unit.stage}:${unit.index}:${unit.sourceRef.sha256}`} reference={unit.sourceRef} description={`来源单元 ${unit.stage} · ${unit.index}`} client={client} />)}{!visuals.length && !units.some(unit => unit.sourceRef) && <p>无关联图片。</p>}</section>
      {resourceCount > 20 && <nav className="flex items-center justify-between" aria-label="资源分页"><Button variant="outline" disabled={!currentResourcePage} onClick={() => setResourcePage(currentResourcePage - 1)}>上一页资源</Button><span>第 {resourceStart + 1}–{Math.min(resourceCount,resourceStart+20)} 项，共 {resourceCount} 项</span><Button variant="outline" disabled={resourceStart + 20 >= resourceCount} onClick={() => setResourcePage(currentResourcePage + 1)}>下一页资源</Button></nav>}
    </div>}
  </section>;
}
