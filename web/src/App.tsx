import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { Select, SelectOption } from "./components/ui/select";
import { Upload, Play, RefreshCw, Download, Trash2, LockKeyhole, ChevronLeft, ChevronRight, FileText, LoaderCircle, Check } from "lucide-react";
import logo from "./assets/octopus.png";
import { ApiError, Client, downloadBlob, fileFormat, MAX_FILES, sourceLimit, validateFiles, type Action, type Capabilities, type TaskList, type UploadStage } from "./api";
import type { DocumentTaskDetail, DocumentTaskReview, DocumentTaskSummary } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
const ResultReview = lazy(() => import("./ResultReview"));

const sourceExtensions: Record<Capabilities["sourceTypes"][number], string> = { pdf: ".pdf", text: ".txt", markdown: ".md", ppt: ".ppt", pptx: ".pptx", image: ".png,.jpg,.jpeg", doc: ".doc", docx: ".docx", xls: ".xls", xlsx: ".xlsx" };
type FileItem = { id: string; file: File; requestId?: string; deduplicateQuestions?: boolean; state: "ready" | UploadStage | "created" | "failed"; error?: string };
const stateLabels: Record<DocumentTaskSummary["state"], string> = { PENDING: "等待开始", RUNNING: "正在解析", PAUSING: "正在暂停", PAUSED: "已暂停", INTERRUPTED: "已中断", CANCELLED: "已取消", FAILED: "失败", WAITING_REVIEW: "等待复核", COMPLETED: "已完成", EXPIRED: "已过期" };
const actionLabels: Record<Action, string> = { pause: "暂停", interrupt: "中断", resume: "继续解析", retry_failed: "重试失败单元", accept_partial: "接受部分结果" };
const formatLabels: Record<Capabilities["sourceTypes"][number], string> = { pdf: "PDF", text: "TXT", markdown: "Markdown", ppt: "PPT (.ppt)", pptx: "PPT (.pptx)", image: "PNG/JPEG", doc: "Word (.doc)", docx: "Word (.docx)", xls: "Excel (.xls)", xlsx: "Excel (.xlsx)" };
const fileLabels: Record<FileItem["state"], string> = { ready: "尚未提交", hashing: "校验文件", uploading: "上传文件", starting: "创建任务", created: "任务已创建", failed: "提交失败" };
const errorText = (error: unknown) => error instanceof ApiError ? error.message : "读取或操作失败，请手动重试。";
const authFailure = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
const pollRetryDelay = (failures: number) => Math.min(30_000, 3000 * 2 ** Math.min(failures - 1, 4)) * (0.8 + Math.random() * 0.2);
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Progress({ task }: { task: DocumentTaskDetail }) {
  const jobs = task.parserJobs || [];
  const active = ["RUNNING", "PENDING", "PAUSING"].includes(task.state);
  const uncertain = jobs.some(job => job.status === "Unknown" || (job.status === "SUBMITTING" && !job.taskId && !active));
  return <>{!!jobs.length && <section aria-label="腾讯文档识别"><p role="status">腾讯文档识别：已保存 {jobs.filter(job => job.resultSaved).length} 个任务结果 · 处理中 {jobs.filter(job => ["STAGING", "Created", "Processing"].includes(job.status) || (active && job.status === "SUBMITTING")).length} 个任务</p>
    {uncertain && <p className="notice" role="alert">上次腾讯提交结果尚未确认。请先核对腾讯云记录；重新解析会创建新任务并可能再次计费。任务 ID 与请求 ID 可在任务诊断中查看。</p>}
    {jobs.some(job => ["REJECTED", "Failed"].includes(job.status)) && <p className="notice">腾讯文档识别失败。请核对任务诊断，修正问题后再重新解析。</p>}
  </section>}<div className="progress-grid">{(["chunks", "visuals"] as const).map(kind => {
    const progress = task.progress[kind];
    return <section key={kind}><div className="flex justify-between"><strong>{kind === "chunks" ? "文本单元" : "视觉单元"}</strong><span>{progress.succeeded + progress.failed}/{progress.total}</span></div><progress aria-label={kind === "chunks" ? "文本单元进度" : "视觉单元进度"} value={progress.succeeded + progress.failed} max={Math.max(1, progress.total)} /><p className="text-sm text-muted-foreground">{progress.total ? `成功 ${progress.succeeded} · 失败 ${progress.failed} · 剩余 ${progress.remaining}` : "尚无处理单元"}</p></section>;
  })}</div></>;
}
const Usage = memo(function Usage({ task }: { task: DocumentTaskDetail }) {
  const input = task.usage.reduce((sum, call) => sum + call.inputTokens, 0);
  const output = task.usage.reduce((sum, call) => sum + call.outputTokens, 0);
  return <details className="resource-card"><summary>模型用量与任务诊断</summary><div className="space-y-3 pt-3"><p>已知用量：{task.usage.length} 次调用，输入 {input} tokens，输出 {output} tokens。</p><p>{task.unknownUsageCalls.length ? `有 ${task.unknownUsageCalls.length} 次调用未返回用量，实际总用量未知。` : "没有已记录的未知用量调用。"}</p><p>调用预算：已预留 {task.modelBudget.reserved}/{task.modelBudget.limit} 次。</p><dl className="metadata-grid"><dt>检查点</dt><dd>{task.checkpointId ?? "尚无（null）"}</dd><dt>运行 ID</dt><dd>{task.runId ?? "无（null）"}</dd><dt>父任务</dt><dd>{task.parentThreadId ?? "无（null）"}</dd><dt>到期时间</dt><dd>{task.expiresAt}</dd></dl><pre className="raw-data">{JSON.stringify({ usage: task.usage, unknownUsageCalls: task.unknownUsageCalls, processing: task.processing, blocking: task.blocking, parserJobs: task.parserJobs || [] }, null, 2)}</pre></div></details>;
});

export default function App() {
  const [draftToken, setDraftToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const [capRevision, setCapRevision] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [deduplicateQuestions, setDeduplicateQuestions] = useState(false);
  const [tasks, setTasks] = useState<TaskList>({ items: [], hasMore: false });
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[offset / 20];
  const [filter, setFilter] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocumentTaskDetail | null>(null);
  const [preview, setPreview] = useState<DocumentTaskReview | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [detailFresh, setDetailFresh] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [accessInvalid, setAccessInvalid] = useState(false);
  const tokenField = useRef<HTMLInputElement>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloadedCheckpoint, setDownloadedCheckpoint] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ threadId: string; fileName: string } | null>(null);
  const operationNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (operationError) operationNotice.current?.scrollIntoView({ block: "nearest" }); }, [operationError]);
  const job = useRef<symbol | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const deletePrompt = useRef<HTMLDivElement>(null);
  const deleteCompleted = useRef(false);
  useEffect(() => { if (accessInvalid && !connecting) tokenField.current?.focus(); }, [accessInvalid, connecting]);
  useEffect(() => {
    if (!deleteTarget) return;
    deleteCompleted.current = false;
    const trigger = document.activeElement;
    deletePrompt.current?.focus();
    return () => {
      const target = deleteCompleted.current ? document.getElementById("task-list-heading") : trigger;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [deleteTarget]);
  useEffect(() => () => client?.disconnect(), [client]);
  useEffect(() => {
    setCapabilities(null); setCapError(null);
    if (!client) return;
    const controller = new AbortController();
    void client.capabilities(controller.signal).then(result => { if (!controller.signal.aborted) { setCapabilities(result); } }).catch(error => { if (!controller.signal.aborted) setCapError(errorText(error)); });
    return () => controller.abort();
  }, [client, capRevision]);
  useEffect(() => {
    setTasks({ items: [], hasMore: false }); setListError(null);
    if (!client) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reading = false, stopped = false, failures = 0;
    async function poll() {
      if (reading || stopped || document.hidden || controller.signal.aborted) return;
      reading = true; setListLoading(true);
      let delay = 3000;
      try {
        const result = await client!.list(offset, filter, controller.signal, cursor);
        failures = 0;
        if (!controller.signal.aborted) { setTasks(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result); setListError(null); }
        if (filter && filter !== "active" || result.items.length > 0 && result.items.every(item => !["PENDING", "RUNNING", "PAUSING"].includes(item.state))) delay = 30000;
      } catch (error) {
        delay = pollRetryDelay(++failures);
        if (!controller.signal.aborted) { setTasks({ items: [], hasMore: false }); setListError(errorText(error)); }
        stopped = authFailure(error);
      } finally {
        reading = false;
        if (!controller.signal.aborted) { setListLoading(false); if (!stopped) timer = setTimeout(() => void poll(), delay); }
      }
    }
    function wake() { clearTimeout(timer); void poll(); }
    document.addEventListener("visibilitychange", wake); window.addEventListener("focus", wake);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); };
  }, [client, offset, filter, listRevision, cursor]);
  useEffect(() => {
    setDetail(null); setPreview(null); setDetailError(null); setPreviewError(null); setDetailFresh(false);
    if (!client || !selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reading = false, stopped = false, failures = 0;
    let currentDetail: DocumentTaskDetail | null = null, currentPreview: DocumentTaskReview | null = null;
    async function poll(force = false) {
      if (reading || stopped || document.hidden || controller.signal.aborted) return;
      reading = true;
      let failed = false;
      try {
        if (!currentDetail) {
          const [current, review] = await Promise.allSettled([client!.detail(selected!, controller.signal), client!.preview(selected!, controller.signal)]);
          if (controller.signal.aborted) return;
          if (current.status === "fulfilled") { currentDetail = current.value; setDetail(current.value); setDetailError(null); setDetailFresh(true); }
          else { failed = true; setDetailError(errorText(current.reason)); setDetailFresh(false); stopped = authFailure(current.reason); }
          if (review.status === "fulfilled") { currentPreview = review.value; setPreview(review.value); setPreviewError(null); }
          else { failed = true; currentPreview = null; setPreview(null); setPreviewError(errorText(review.reason)); stopped ||= authFailure(review.reason); }
          return;
        }
        if (!force) {
          const head = await client!.head(selected!, controller.signal);
          if (controller.signal.aborted) return;
          if (head.checkpointId === currentDetail.checkpointId && head.runId === currentDetail.runId && head.state === currentDetail.state && head.updatedAt === currentDetail.updatedAt && head.modelConfigured === currentDetail.modelConfigured && head.resumeCompatible === currentDetail.resumeCompatible && currentPreview?.checkpointId === head.checkpointId && head.state === "COMPLETED") {
            setDetailFresh(true); setDetailError(null); return;
          }
        }
        const current = await client!.detail(selected!, controller.signal);
        if (controller.signal.aborted) return;
        currentDetail = current; setDetail(current); setDetailError(null); setDetailFresh(true);
        if (force || !currentPreview || currentPreview.checkpointId !== current.checkpointId || currentPreview.state !== current.state || ["PAUSED", "WAITING_REVIEW"].includes(current.state)) {
          try {
            const review = await client!.preview(selected!, controller.signal);
            if (controller.signal.aborted) return;
            currentPreview = review; setPreview(review); setPreviewError(null);
          } catch (error) {
            failed = true;
            if (!controller.signal.aborted) { currentPreview = null; setPreview(null); setPreviewError(errorText(error)); }
            stopped = authFailure(error);
          }
        }
      } catch (error) {
        failed = true;
        if (!controller.signal.aborted) { setDetailError(errorText(error)); setDetailFresh(false); }
        stopped = authFailure(error);
      } finally {
        reading = false;
        failures = failed ? failures + 1 : 0;
        if (!controller.signal.aborted && !stopped) timer = setTimeout(() => void poll(), failures ? pollRetryDelay(failures) : currentDetail && !["PENDING", "RUNNING", "PAUSING"].includes(currentDetail.state) ? 30000 : 3000);
      }
    }
    function wake() { clearTimeout(timer); void poll(true); }
    document.addEventListener("visibilitychange", wake); window.addEventListener("focus", wake);
    void poll(true);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); };
  }, [client, selected, detailRevision]);
  async function connect() {
    if (connecting) return;
    setConnecting(true); setCapError(null); setAccessInvalid(false);
    let current: Client | null = null;
    try {
      current = new Client(draftToken.trim());
      await current.capabilities();
      if (current.active) { setClient(current); setDraftToken(""); setOperationError(null); setNotice(null); }
    } catch (error) { current?.disconnect(); setCapError(errorText(error)); if (error instanceof ApiError && (error.code === "INVALID_SERVICE_TOKEN" || authFailure(error))) { setAccessInvalid(true); } }
    finally { setConnecting(false); }
  }

  async function run(perform: (current: Client) => Promise<void>) {
    if (!client || job.current) return;
    const id = Symbol(); job.current = id; setBusy(true); setOperationError(null); setNotice(null);
    try { await perform(client); }
    catch (error) { if (client.active && job.current === id) setOperationError(errorText(error)); }
    finally { if (job.current === id) { job.current = null; setBusy(false); } }
  }
  function chooseFiles(chosen: File[]) {
    setFileError(null);
    if (!capabilities) return;
    const pending = files.filter(item => item.state === "failed");
    try {
      validateFiles(chosen, capabilities);
      const additions = chosen;
      if (pending.length + additions.length > MAX_FILES) throw new ApiError("请先处理保留的失败提交；每次最多保留 10 个文件。", "FILE_COUNT_LIMIT");
      setFiles([...pending, ...additions.map(file => ({ file, id: crypto.randomUUID(), state: "ready" as const }))]);
    }
    catch (error) { setFiles(pending); setFileError(errorText(error)); }
    if (fileInput.current) fileInput.current.value = "";
  }
  async function start(items: FileItem[]) {
    if (!capabilities || !items.length) return;
    const before = selected;
    await run(async current => {
      let created: string | null = null;
      for (const item of items) {
        const deduplicate = item.deduplicateQuestions ?? deduplicateQuestions;
        const update = (value: Partial<FileItem>) => { if (current.active) setFiles(previous => previous.map(file => file.id === item.id ? { ...file, ...value } : file)); };
        update({ deduplicateQuestions: deduplicate, error: undefined });
        try {
          const receipt = await current.start(item.file, capabilities, item.requestId ?? item.id, (stage, requestId) => update({ state: stage, ...(requestId ? { requestId } : {}) }), deduplicate);
          if (current.active) setFiles(previous => previous.map(file => (file.requestId ?? file.id) === receipt.requestId ? { ...file, state: "created", error: undefined } : file));
          created = receipt.threadId;
        } catch (error) { update({ state: "failed", error: errorText(error) }); break; }
        if (!current.active) return;
      }
      setListRevision(value => value + 1);
      if (created) { setSelected(value => value === before ? created : value); setNotice("任务已创建。页面只读取进度；继续或重试需要点击对应操作。"); }
    });
  }
  const matchingCheckpoint = detailFresh && !previewError && preview?.checkpointId === detail?.checkpointId;
  const canExport = !!detail && (detail.canExportCompleted || detail.state === "COMPLETED" && !!detail.result) && !!detail.checkpointId && matchingCheckpoint;
  const importStep = !selected ? 1 : detail && downloadedCheckpoint === `${detail.threadId}:${detail.checkpointId}` ? 3 : 2;
  function act(action: Action) {
    if (!detail) return;
    void run(async current => { await current.control(detail, action); if (current.active) { setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("操作已提交，正在读取服务端最新状态。"); } });
  }
  return <div className="web-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="web-header"><a href="/" className="brand"><img src={logo} alt="PractiQ 小章鱼" /><div><strong>PractiQ</strong><span>AI 文档导入</span></div></a></header>
    <main id="main-content" tabIndex={-1} className="web-main"><div className="page-intro"><div><h1>把文档整理成可复核的题库</h1></div></div>
      <ol className="import-steps" aria-label="文档导入流程">{[
        ["选择并导入", !client ? "连接服务后选择文档" : importStep > 1 ? "文档任务已创建" : "选择文件，点击开始后解析"],
        ["检查解析结果", "核对题目、答案与质量提示"],
        ["导出并离线练习", importStep === 3 ? "ZIP 已下载 · App：设置 → 恢复备份" : "App：设置 → 恢复备份 → 导入题库 ZIP"],
      ].map(([title, description], index) => <li key={title} aria-current={importStep === index + 1 ? "step" : undefined} data-complete={importStep > index + 1}><span>{importStep > index + 1 ? <Check aria-hidden="true" /> : index + 1}</span><div><strong>{title}</strong><p>{description}</p></div></li>)}</ol>
      {!client ? <Card className="connection-card"><CardHeader><CardTitle role="heading" aria-level={2} className="flex items-center gap-2"><LockKeyhole />连接个人服务</CardTitle></CardHeader><CardContent className="space-y-4"><p id="service-help">使用自托管服务的 AI_SERVICE_TOKEN。令牌仅保存在本页内存，刷新后需重填。</p><form onSubmit={event => { event.preventDefault(); void connect(); }} className="connection-form"><label className="flex-1 space-y-1"><span>服务访问令牌</span><Input ref={tokenField} disabled={connecting} type="password" aria-invalid={accessInvalid || undefined} aria-describedby={accessInvalid ? "service-help access-error" : "service-help"} autoComplete="off" spellCheck={false} maxLength={4096} value={draftToken} onChange={event => setDraftToken(event.target.value)} /></label><Button type="submit" disabled={connecting || !draftToken.trim()}>连接服务</Button></form>{capError && <p id="access-error" role="alert" className="text-destructive">{capError}</p>}</CardContent></Card> : <>
        {capError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{capError}</span><Button variant="outline" onClick={() => setCapRevision(value => value + 1)}>重试读取服务能力</Button></div>}
{notice && <p className="notice" role="status">{notice}</p>}
        {busy && <p role="status" className="operation-status"><LoaderCircle className="loading-icon" aria-hidden="true" />正在处理当前操作，请勿重复提交。</p>}
        <nav className="workspace-shortcuts" aria-label="工作区导航"><a className="workspace-link" href="#import-heading">导入文档</a><a className="workspace-link" href="#task-list-heading">文档任务</a><a className="workspace-link" href="#task-detail">任务详情与结果</a></nav>
        <div className="workspace-grid"><aside className="space-y-5">
          <Card><CardHeader><CardTitle role="heading" aria-level={2} id="import-heading" tabIndex={-1} className="flex items-center gap-2"><Upload />导入文档</CardTitle></CardHeader><CardContent className="space-y-4">
            {!capabilities ? <p>正在读取服务支持的格式与限制…</p> : <>
              <p id="file-help" className="text-sm text-muted-foreground">最多 {MAX_FILES} 个文件 · 每个 ≤ {sizeLabel(sourceLimit(capabilities))}{capabilities.officeAvailable && sourceLimit(capabilities, "docx") < sourceLimit(capabilities) && ` · Word / Excel ≤ ${sizeLabel(sourceLimit(capabilities, "docx"))}`}</p>
              <label className="file-picker"><FileText /><span>选择文档</span><Input ref={fileInput} type="file" multiple aria-describedby="file-help" aria-invalid={!!fileError} accept={capabilities.sourceTypes.map(type => sourceExtensions[type]).join(",")} disabled={busy} onChange={event => chooseFiles(Array.from(event.target.files || []))} /></label>
              <p className="text-xs text-muted-foreground">服务支持：{capabilities.sourceTypes.map(type => formatLabels[type]).join("、")}{capabilities.parserConfigured === false && "。腾讯解析尚未配置，当前无法开始新的文档导入。"}</p>
              <div className="space-y-1"><label className="review-checkbox"><input type="checkbox" aria-describedby="dedup-help" checked={deduplicateQuestions} disabled={busy || !!files.length && !files.some(file => file.state === "ready")} onChange={event => setDeduplicateQuestions(event.target.checked)} />自动去重</label><p id="dedup-help" className="text-xs text-muted-foreground">仅去除完全相同的题目或整组复合题；关闭则全部保留。</p></div>
              <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">格式与导入规则</summary><div className="space-y-2 pt-2">
                <p>所有支持的格式统一使用腾讯异步解析，再由 AI 整理题库；不支持 CSV 导入。当前传输上限 {sizeLabel(capabilities.parserInputMaxBytes ?? 8 * 1024 * 1024)}，还受文件类型和部署限制；超限时由服务端切分，XLS 和大 Office 文件需要转换器。默认使用本地文件，服务端可主动开启私有 COS 中转。</p>
                <p>未启用去重时仍会提示重复候选。</p>
                <p>AI 复核会对照原文检查，最多修正一轮。</p>
                <p>下载的 ZIP 可在 App 的「设置 → 恢复备份 → 导入题库 ZIP」中追加。</p>
              </div></details>
              {!capabilities.modelConfigured && <p className="notice">服务端尚未配置模型，暂不能开始解析。</p>}
              {fileError && <p role="alert" className="text-destructive">{fileError}</p>}
              {!!files.length && <ul className="file-list">{files.map(item => <li key={item.id}><div><strong>{item.file.name}</strong><span>{sizeLabel(item.file.size)} · {fileLabels[item.state]} · {formatLabels[fileFormat(item.file).sourceType]} · 腾讯解析 → AI 整理</span>{item.error && <><p role="alert" className="text-destructive">{item.error}</p><small>原提交请求 ID：{item.requestId ?? item.id}</small></>}</div>{["ready", "failed"].includes(item.state) && <Button size="icon" variant="ghost" disabled={busy} aria-label={`移除文件 ${item.file.name}`} onClick={() => setFiles(previous => previous.filter(file => file.id !== item.id))}><Trash2 /></Button>}{item.state === "failed" && <Button size="sm" variant="outline" disabled={busy || capabilities.parserConfigured === false || !capabilities.modelConfigured} onClick={() => void start([item])}>重试开始</Button>}</li>)}</ul>}
              {capabilities.modelBudget && <p className="notice">每任务预算 {capabilities.modelBudget.limit} 次：按完整预留计算，普通单元最多 {Math.floor(capabilities.modelBudget.limit / capabilities.modelBudget.unitCalls)} 个，带上下文的视觉单元最多 {Math.floor(capabilities.modelBudget.limit / capabilities.modelBudget.contextUnitCalls)} 个。混合任务共享预算；单元数量不等于页数，重试仍占用预算，剩余预算不足时可能仅有部分结果。</p>}
              <p className="text-xs text-muted-foreground">点击「开始导入」后上传并调用模型。启用 AI 复核会增加调用与费用，结果仍需人工核对。</p>
              <Button className="w-full" disabled={busy || capabilities.parserConfigured === false || !capabilities.modelConfigured || !files.some(file => file.state === "ready")} onClick={() => void start(files.filter(file => file.state === "ready"))}>{busy ? <LoaderCircle className="loading-icon" /> : <Play />}开始导入</Button>
              {files.some(file => file.state === "failed") && <p className="text-xs text-muted-foreground">本批次已停止，剩余文件尚未提交。失败提交的原文件、请求 ID 和参数已保留，重新选文件不会覆盖。请先刷新任务列表核对结果，再手动“重试开始”沿用原请求；移除文件只清理本页队列，不会取消服务端任务。刷新或关闭页面会丢失此记录。</p>}
            </>}
          </CardContent></Card>
          <Card><CardHeader><div className="flex items-center justify-between"><CardTitle role="heading" aria-level={2} id="task-list-heading" tabIndex={-1}>文档任务</CardTitle><Button variant="ghost" size="icon" aria-label="刷新任务列表" onClick={() => setListRevision(value => value + 1)}><RefreshCw /></Button></div></CardHeader><CardContent className="space-y-3">
            <label className="block space-y-2"><span className="text-sm font-medium">筛选任务状态</span><Select className="w-full" value={filter} onValueChange={value => { setFilter(value); setOffset(0); setCursors([undefined]); }}>{[["", "全部任务"], ["active", "正在处理"], ["paused", "已暂停"], ["review", "等待复核"], ["failed", "失败"], ["completed", "已完成"], ["interrupted", "已中断"], ["expired", "已过期"]].map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</Select></label>
            {listError && <div role="alert" className="space-y-2"><p className="text-destructive">{listError}</p><Button variant="outline" onClick={() => setListRevision(value => value + 1)}>重试任务列表</Button></div>}
            {!tasks.items.length && !listError && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{listLoading ? "正在读取任务…" : filter ? "没有符合此状态的任务。" : "当前没有任务。"}</p>{!listLoading && (filter ? <Button variant="outline" onClick={() => { setFilter(""); setOffset(0); setCursors([undefined]); }}>查看全部任务</Button> : capabilities && <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.focus()}>选择第一份文档</Button>)}</div>}
            <div className="task-list">{tasks.items.map(task => <div key={task.threadId} className="task-list-item"><button type="button" className="task-row" aria-pressed={selected === task.threadId} onClick={() => { setSelected(task.threadId); setDeleteTarget(null); }}><strong>{task.fileName}</strong><span><Badge variant="outline">{stateLabels[task.state]}</Badge>{task.status === "PARTIAL" && <Badge variant="secondary">部分结果</Badge>}</span><small>{task.questionCount} 条题目 · {task.reviewCount} 条待复核</small></button>{selected === task.threadId && <a className="workspace-link" href="#task-detail">查看当前任务详情</a>}{task.state === "EXPIRED" && <Button variant="destructive" size="sm" disabled={busy} aria-label={`删除已过期任务 ${task.fileName}`} onClick={() => setDeleteTarget({ threadId: task.threadId, fileName: task.fileName })}><Trash2 />删除已过期任务</Button>}</div>)}</div>
            <nav aria-label="任务列表分页" className="flex items-center justify-between"><Button variant="outline" size="icon" aria-label="上一页任务" disabled={!offset || listLoading} onClick={() => setOffset(value => Math.max(0, value - 20))}><ChevronLeft /></Button><span className="text-xs">第 {Math.floor(offset / 20) + 1} 页</span><Button variant="outline" size="icon" aria-label="下一页任务" disabled={!tasks.hasMore || listLoading} onClick={() => { setCursors(previous => [...previous.slice(0, offset / 20 + 1), tasks.nextCursor ?? undefined]); setOffset(value => value + 20); }}><ChevronRight /></Button></nav>
          </CardContent></Card>
        </aside><section id="task-detail" tabIndex={-1} className="task-panel" aria-label="任务详情">
          <a className="workspace-link" href="#task-list-heading">返回任务列表</a>
          {operationError && <div ref={operationNotice} className="error-banner" role="alert"><span className="min-w-0 flex-1">{operationError}</span></div>}
          {deleteTarget && <div ref={deletePrompt} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape" && !busy) setDeleteTarget(null); }} className="notice delete-confirmation" role="group" aria-label="删除任务确认"><p>确认删除「{deleteTarget.fileName}」及其检查点？已下载的题库不受影响。</p><div className="flex gap-2 mt-3"><Button variant="destructive" disabled={busy} onClick={() => void run(async current => { await current.delete(deleteTarget.threadId); if (current.active) { deleteCompleted.current = true; setSelected(value => value === deleteTarget.threadId ? null : value); setListRevision(value => value + 1); setDeleteTarget(null); setNotice("任务已删除。"); } })}>确认删除</Button><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>保留任务</Button></div></div>}
          {!selected ? <div className="empty-panel"><FileText /><h2>选择一个任务查看结果</h2></div> : <>
            {detailError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{detailError}</span><Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试任务详情</Button></div>}
            {previewError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{previewError}</span><Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试检查点预览</Button></div>}
            {!detail && !detailError && <p>正在读取任务详情…</p>}
            {detail && <div className="space-y-6"><div className="task-title"><div><h2>{detail.fileName}</h2><p><Badge variant="outline">{stateLabels[detail.state]}</Badge><span>阶段：{detail.phase}</span>{detail.status && <Badge variant={detail.status === "PARTIAL" ? "secondary" : "outline"}>{detail.status === "PARTIAL" ? "部分结果" : "解析完成"}</Badge>}</p></div><Button variant="outline" aria-label="刷新任务详情" onClick={() => setDetailRevision(value => value + 1)}><RefreshCw /></Button></div>
              {!detailFresh && <p className="notice">当前显示上次成功读取的信息，任务操作已停用，请先刷新。</p>}
              {preview && preview.checkpointId !== detail.checkpointId && <p className="notice">任务检查点正在更新，读取一致后才能继续或导出。</p>}
              <Progress task={detail} />
              <div className="task-actions" aria-label="当前任务操作">{detail.allowedActions.map(action => <Button key={action} variant="outline" disabled={busy || !detailFresh || (!["pause", "interrupt"].includes(action) && !matchingCheckpoint) || (["resume", "retry_failed"].includes(action) && (!detail.modelConfigured || !detail.resumeCompatible))} onClick={() => act(action)}>{actionLabels[action]}</Button>)}<Button disabled={busy || !canExport} onClick={() => void run(async current => { const exported = await current.exportBank(detail); if (current.active) { downloadBlob(exported.blob, exported.name); setDownloadedCheckpoint(`${detail.threadId}:${detail.checkpointId}`); setNotice("题库 ZIP 已下载。每次导出包含当前全部已完成内容，重复导入会创建独立题库。请在应用设置中追加导入。"); } })}><Download />下载题库 ZIP</Button></div>
              {detail.state !== "COMPLETED" && <p className="text-sm text-muted-foreground">暂停后可下载已完成题目，需有可用题目且检查点一致。</p>}
              <details className="task-secondary-actions"><summary>其他任务操作</summary><p className="text-sm text-muted-foreground">重新解析会重新提交腾讯识别并创建新的 AI 整理请求，可能再次计费；删除会移除此任务和检查点。已下载的题库不受影响。</p><div className="task-actions"><Button variant="outline" disabled={busy || !detailFresh || !detail.modelConfigured || detail.state === "EXPIRED"} onClick={() => void run(async current => { const receipt = await current.reparse(detail.threadId); if (current.active) { setSelected(value => value === detail.threadId ? receipt.threadId : value); setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("新解析任务已创建。"); } })}><RefreshCw />重新解析为新任务</Button><Button variant="destructive" disabled={busy || !detailFresh || ["RUNNING", "PENDING", "PAUSING"].includes(detail.state)} onClick={() => setDeleteTarget({ threadId: detail.threadId, fileName: detail.fileName })}><Trash2 />删除任务</Button></div></details>
              {!!detail.failures.length && <section className="notice"><h3>失败单元</h3><ul>{detail.failures.map(failure => <li key={`${failure.stage}:${failure.index}`}>{failure.stage} · {failure.index} · {failure.code} · {failure.retryable ? `可重试，剩余 ${failure.retriesRemaining ?? 0} 次` : "不可重试"}</li>)}</ul></section>}
              {(!detail.modelConfigured || !detail.resumeCompatible) && <p className="notice">{!detail.modelConfigured ? "服务端模型未配置。" : "当前模型配置与检查点不兼容。"}继续和重试暂不可用，现有结果仍可检查。</p>}
              <ErrorBoundary key={`${selected}:${detail.checkpointId}`} fallback={<RenderFailure />}><Suspense fallback={<p>正在加载结果检查视图…</p>}><ResultReview task={detail} preview={preview} client={client} /></Suspense></ErrorBoundary>
              <Usage task={detail} />
            </div>}
          </>}
        </section></div>
      </>}
    </main><footer>PractiQ · 保留来源与不确定性，由你检查并决定下一步。</footer>
  </div>;
}
