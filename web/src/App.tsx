import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Select, SelectOption } from "./components/ui/select";
import { Upload, Play, RefreshCw, Download, Trash2, LockKeyhole, ChevronLeft, ChevronRight, FileText, LoaderCircle, History, Settings, Pause, Square } from "lucide-react";
import logo from "./assets/octopus.png";
import { ApiError, Client, downloadBlob, fileFormat, MAX_FILES, sourceLimit, validateFiles, type Action, type Capabilities, type TaskList, type UploadStage } from "./api";
import type { DocumentTaskCreate, DocumentTaskDetail, DocumentTaskReview, DocumentTaskSummary } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "./RenderFailure";
import { ImportSettingsPanel } from "./ImportSettingsPanel";
const ResultReview = lazy(() => import("./ResultReview"));

const sourceExtensions: Record<Capabilities["sourceTypes"][number], string> = { pdf: ".pdf", text: ".txt", markdown: ".md", ppt: ".ppt", pptx: ".pptx", image: ".png,.jpg,.jpeg", doc: ".doc", docx: ".docx", xls: ".xls", xlsx: ".xlsx" };
type FileItem = { id: string; file: File; requestId?: string; deduplicateQuestions?: boolean; state: "ready" | UploadStage | "created" | "failed"; error?: string };
const stateLabels: Record<DocumentTaskSummary["state"], string> = { PENDING: "等待开始", RUNNING: "正在解析", PAUSING: "正在暂停", PAUSED: "已暂停", INTERRUPTED: "已中断", CANCELLED: "已取消", FAILED: "失败", WAITING_REVIEW: "等待复核", COMPLETED: "已完成", EXPIRED: "已过期" };
const actionLabels: Record<Action, string> = { pause: "暂停", interrupt: "取消任务", resume: "继续解析", retry_failed: "重试失败单元", accept_partial: "接受部分结果" };
const formatLabels: Record<Capabilities["sourceTypes"][number], string> = { pdf: "PDF", text: "TXT", markdown: "Markdown", ppt: "PPT (.ppt)", pptx: "PPT (.pptx)", image: "PNG/JPEG", doc: "Word (.doc)", docx: "Word (.docx)", xls: "Excel (.xls)", xlsx: "Excel (.xlsx)" };
const fileLabels: Record<FileItem["state"], string> = { ready: "尚未提交", hashing: "校验文件", uploading: "上传文件", starting: "创建任务", created: "任务已创建", failed: "提交失败" };
const errorText = (error: unknown) => error instanceof ApiError ? error.message : "读取或操作失败，请手动重试。";
const authFailure = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
const pollRetryDelay = (failures: number) => Math.min(30_000, 3000 * 2 ** Math.min(failures - 1, 4)) * (0.8 + Math.random() * 0.2);
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

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
  const [loaded, setLoaded] = useState(false);
  const input = loaded ? task.usage.reduce((sum, call) => sum + call.inputTokens, 0) : 0;
  const output = loaded ? task.usage.reduce((sum, call) => sum + call.outputTokens, 0) : 0;
  return <details className="resource-card" onToggle={event => { if (event.currentTarget.open && !loaded) setLoaded(true); }}><summary>模型用量与任务诊断</summary>{loaded && <div className="space-y-3 pt-3"><p>已知用量：{task.usage.length} 次调用，输入 {input} tokens，输出 {output} tokens。</p><p>{task.unknownUsageCalls.length ? `有 ${task.unknownUsageCalls.length} 次调用未返回用量，实际总用量未知。` : "没有已记录的未知用量调用。"}</p><p>调用预算：已预留 {task.modelBudget.reserved}/{task.modelBudget.limit} 次。</p><dl className="metadata-grid"><dt>处理阶段</dt><dd>{task.phase}</dd><dt>检查点</dt><dd>{task.checkpointId ?? "尚无（null）"}</dd><dt>运行 ID</dt><dd>{task.runId ?? "无（null）"}</dd><dt>父任务</dt><dd>{task.parentThreadId ?? "无（null）"}</dd><dt>到期时间</dt><dd>{task.expiresAt}</dd></dl><pre className="raw-data">{JSON.stringify({ usage: task.usage, unknownUsageCalls: task.unknownUsageCalls, processing: task.processing, blocking: task.blocking, parserJobs: task.parserJobs || [] }, null, 2)}</pre></div>}</details>;
});

type Page = "import" | "records" | "settings";
const pages = [{ id: "import", label: "开始导入", icon: Upload }, { id: "records", label: "导入记录", icon: History }, { id: "settings", label: "设置", icon: Settings }] as const;
function pageFromHash(): Page | undefined {
  const hash = window.location.hash;
  if (!hash) return "import";
  if (["#task-detail", "#task-list-heading"].includes(hash)) return "records";
  return pages.find(item => `#${item.id}` === hash)?.id;
}
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const dateLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "时间未知" : dateFormatter.format(date); };

export default function App() {
  const [page, setPage] = useState<Page>(() => pageFromHash() ?? "import");
  // Wake the existing pollers on workspace changes without discarding their caches.
  const recordsVisible = useRef(page === "records");
  const listWake = useRef<(() => void) | null>(null);
  const detailWake = useRef<(() => void) | null>(null);
  const previousPage = useRef(page);
  useLayoutEffect(() => { if (previousPage.current !== page) { previousPage.current = page; document.getElementById("page-heading")?.focus(); } }, [page]);
  function navigate(value: Page) { setPage(value); setDeleteTarget(null); window.location.hash = value; }
  useEffect(() => { const change = () => { const next = pageFromHash(); if (next) setPage(next); }; window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
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
  function focusTask() {
    const panel = document.getElementById("task-detail");
    if (panel && !panel.closest("[hidden]")) { panel.focus(); panel.scrollIntoView({ block: "start" }); }
  }
  useLayoutEffect(() => { if (selected) focusTask(); }, [selected]);
  function selectTask(id: string) { setSelected(id); setDeleteTarget(null); if (id === selected) focusTask(); }
  const [detail, setDetail] = useState<DocumentTaskDetail | null>(null);
  useLayoutEffect(() => {
    const panel = document.getElementById("task-detail");
    if (detail?.threadId && panel === document.activeElement) panel?.scrollIntoView({ block: "start" });
  }, [detail?.threadId]);
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
  const [pendingImports, setPendingImports] = useState<DocumentTaskCreate[]>([]);
  useEffect(() => {
    if (!client || busy) return;
    try { setPendingImports(client.pendingImports()); }
    catch (error) { setOperationError(errorText(error)); }
  }, [client, busy]);

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
      if (reading || stopped || !recordsVisible.current || document.hidden || controller.signal.aborted) return;
      reading = true; setListLoading(true);
      let delay = 3000;
      try {
        const result = await client!.list(offset, filter, controller.signal, cursor);
        if (!recordsVisible.current || document.hidden) return;
        failures = 0;
        if (!controller.signal.aborted) { setTasks(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result); setListError(null); }
        if (filter && filter !== "active" || result.items.length > 0 && result.items.every(item => !["PENDING", "RUNNING", "PAUSING"].includes(item.state))) delay = 30000;
      } catch (error) {
        delay = pollRetryDelay(++failures);
        if (!controller.signal.aborted) setListError(errorText(error));
        stopped = authFailure(error);
      } finally {
        reading = false;
        if (!controller.signal.aborted) { setListLoading(false); if (!stopped && recordsVisible.current && !document.hidden) timer = setTimeout(() => void poll(), delay); }
      }
    }
    function wake() { clearTimeout(timer); void poll(); }
    listWake.current = wake;
    document.addEventListener("visibilitychange", wake); window.addEventListener("focus", wake);
    void poll();
    return () => { listWake.current = null; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); };
  }, [client, offset, filter, listRevision, cursor]);
  useEffect(() => {
    setDetail(null); setPreview(null); setDetailError(null); setPreviewError(null); setDetailFresh(false);
    if (!client || !selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reading = false, stopped = false, failures = 0;
    let currentDetail: DocumentTaskDetail | null = null, currentPreview: DocumentTaskReview | null = null;
    let wakePending = false;
    async function poll(force = false) {
      if (reading || stopped || !recordsVisible.current || document.hidden || controller.signal.aborted) return;
      reading = true;
      let failed = false;
      try {
        if (!currentDetail) {
          const [current, review] = await Promise.allSettled([client!.detail(selected!, controller.signal), client!.preview(selected!, controller.signal, false)]);
          if (controller.signal.aborted || !recordsVisible.current || document.hidden) return;
          if (current.status === "fulfilled") { currentDetail = current.value; setDetail(current.value); setDetailError(null); setDetailFresh(true); }
          else { failed = true; setDetailError(errorText(current.reason)); setDetailFresh(false); stopped = authFailure(current.reason); }
          if (review.status === "fulfilled") { currentPreview = review.value; setPreview(review.value); setPreviewError(null); }
          else { failed = true; currentPreview = null; setPreview(null); setPreviewError(errorText(review.reason)); stopped ||= authFailure(review.reason); }
          return;
        }
        if (!force && currentDetail.state === "COMPLETED") {
          const head = await client!.head(selected!, controller.signal);
          if (controller.signal.aborted || !recordsVisible.current || document.hidden) return;
          if (head.checkpointId === currentDetail.checkpointId && head.runId === currentDetail.runId && head.state === currentDetail.state && head.updatedAt === currentDetail.updatedAt && head.modelConfigured === currentDetail.modelConfigured && head.resumeCompatible === currentDetail.resumeCompatible && currentPreview?.checkpointId === head.checkpointId && head.state === "COMPLETED") {
            setDetailFresh(true); setDetailError(null); return;
          }
        }
        const current = await client!.detail(selected!, controller.signal);
        if (controller.signal.aborted || !recordsVisible.current || document.hidden) return;
        currentDetail = current; setDetail(current); setDetailError(null); setDetailFresh(true);
        if (force || !currentPreview || currentPreview.checkpointId !== current.checkpointId || currentPreview.state !== current.state || ["PAUSED", "WAITING_REVIEW"].includes(current.state)) {
          try {
            const review = await client!.preview(selected!, controller.signal, false);
            if (controller.signal.aborted || !recordsVisible.current || document.hidden) return;
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
        if (!controller.signal.aborted && !stopped && recordsVisible.current && !document.hidden) {
          if (wakePending) { wakePending = false; void poll(); }
          else timer = setTimeout(() => void poll(), failures ? pollRetryDelay(failures) : currentDetail && !["PENDING", "RUNNING", "PAUSING"].includes(currentDetail.state) ? 30000 : 3000);
        }
      }
    }
    function wake() {
      clearTimeout(timer);
      if (!recordsVisible.current || document.hidden) { wakePending = false; setDetailFresh(false); return; }
      if (reading) { wakePending = true; return; }
      void poll();
    }
    detailWake.current = wake;
    document.addEventListener("visibilitychange", wake); window.addEventListener("focus", wake);
    void poll(true);
    return () => { detailWake.current = null; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); };
  }, [client, selected, detailRevision]);
  useEffect(() => {
    recordsVisible.current = page === "records";
    listWake.current?.(); detailWake.current?.();
  }, [page]);
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
      let created: string | null = null; let failed = false; const resolved = new Set<string>();
      for (const item of items) {
        const deduplicate = item.deduplicateQuestions ?? deduplicateQuestions;
        const update = (value: Partial<FileItem>) => { if (current.active) setFiles(previous => previous.map(file => file.id === item.id ? { ...file, ...value } : file)); };
        update({ deduplicateQuestions: deduplicate, error: undefined });
        try {
          const receipt = await current.start(item.file, capabilities, item.requestId ?? item.id, (stage, requestId) => update({ state: stage, ...(requestId ? { requestId } : {}) }), deduplicate);
          if (current.active) setFiles(previous => previous.map(file => (file.requestId ?? file.id) === receipt.requestId ? { ...file, state: "created", error: undefined } : file));
          created = receipt.threadId; resolved.add(receipt.requestId);
        } catch (error) { failed = true; update({ state: "failed", error: errorText(error) }); break; }
        if (!current.active) return;
      }
      setListRevision(value => value + 1);
      if (created) { if (!failed && !files.some(file => !items.some(item => item.id === file.id) && ["failed", "ready"].includes(file.state) && !resolved.has(file.requestId ?? file.id))) navigate("records"); setSelected(value => value === before ? created : value); setNotice("任务已创建。"); }
    });
  }
  const matchingCheckpoint = detailFresh && !previewError && preview?.checkpointId === detail?.checkpointId;
  const canExport = !!detail && (detail.canExportCompleted || detail.state === "COMPLETED" && !!detail.result) && !!detail.checkpointId && matchingCheckpoint;
  function act(action: Action) {
    if (!detail) return;
    void run(async current => { await current.control(detail, action); if (current.active) { setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("操作已提交，正在读取服务端最新状态。"); } });
  }
  const importContent = (<div className="import-workspace"><Card><CardHeader><CardTitle role="heading" aria-level={2} id="import-heading" tabIndex={-1}>导入文档</CardTitle></CardHeader><CardContent className="space-y-4">
            {!capabilities ? <p>正在读取服务支持的格式与限制…</p> : <>
              <p id="file-help" className="text-sm text-muted-foreground">最多 {MAX_FILES} 个文件 · 每个 ≤ {sizeLabel(sourceLimit(capabilities))}{capabilities.officeAvailable && sourceLimit(capabilities, "docx") < sourceLimit(capabilities) && ` · Word / Excel ≤ ${sizeLabel(sourceLimit(capabilities, "docx"))}`}</p>
              <label className="file-picker"><FileText /><span>选择文档</span><span className="file-picker-action">选择文件</span><Input className="sr-only" ref={fileInput} type="file" multiple aria-label="选择文档" aria-describedby="file-help" aria-invalid={!!fileError} accept={capabilities.sourceTypes.map(type => sourceExtensions[type]).join(",")} disabled={busy} onChange={event => chooseFiles(Array.from(event.target.files || []))} /></label>
              <p className="supported-formats">服务支持：{capabilities.sourceTypes.map(type => formatLabels[type]).join("、")}</p>
              {capabilities.parserConfigured === false && <p className="notice">腾讯文档识别尚未配置，当前无法开始新的文档导入。</p>}
              {!capabilities.modelConfigured && <p className="notice">服务端尚未配置模型，暂不能开始解析。</p>}
              {fileError && <p role="alert" className="text-destructive">{fileError}</p>}
              {!!files.length && <ul className="file-list">{files.map(item => <li key={item.id}><div><strong>{item.file.name}</strong><span>{sizeLabel(item.file.size)} · {fileLabels[item.state]} · {formatLabels[fileFormat(item.file).sourceType]}</span>{item.error && <><p role="alert" className="text-destructive">{item.error}</p><small>原提交请求 ID：{item.requestId ?? item.id}</small></>}</div>{["ready", "failed"].includes(item.state) && <Button size="icon" variant="ghost" disabled={busy} aria-label={`移除文件 ${item.file.name}`} onClick={() => setFiles(previous => previous.filter(file => file.id !== item.id))}><Trash2 /></Button>}{item.state === "failed" && <Button size="sm" variant="outline" disabled={busy || capabilities.parserConfigured === false || !capabilities.modelConfigured} onClick={() => void start([item])}>重试开始</Button>}</li>)}</ul>}
              <div className="import-options"><label className="review-checkbox"><input type="checkbox" aria-describedby="dedup-help" checked={deduplicateQuestions} disabled={busy || !!files.length && !files.some(file => file.state === "ready")} onChange={event => setDeduplicateQuestions(event.target.checked)} />自动去重</label><p id="dedup-help">仅合并完全相同的题目或题组</p></div>
              <div className="import-submit"><p>开始后将调用 AI，可能产生费用；结果需人工核对。</p><Button disabled={busy || capabilities.parserConfigured === false || !capabilities.modelConfigured || !files.some(file => file.state === "ready")} onClick={() => void start(files.filter(file => file.state === "ready"))}>{busy ? <LoaderCircle className="loading-icon" /> : <Play />}开始导入</Button></div>
              {files.some(file => file.state === "failed") && <p className="notice">本批次已停止，剩余文件尚未提交。请先刷新任务列表核对结果，再手动“重试开始”沿用原请求；移除文件只清理本页队列，不会取消服务端任务。已发起的创建请求会保留本机恢复记录；尚未上传的文件需重新选择。</p>}
            </>}
          </CardContent></Card>
          {capabilities && <aside className="import-guide" aria-label="导入说明">
            <details><summary>格式与导入规则</summary><div>
              <p>腾讯文档识别后，由 AI 整理题库。超限文件由服务端切分；XLS 和大 Office 文件需要转换器。</p>
              <p>未启用去重时保留全部题目，并提示重复候选。AI 复核最多修正一轮，会增加调用与费用。</p>
              <p>下载的 ZIP 可在应用的“设置 → 导入与恢复 → 导入题库 ZIP”中追加。</p>
            </div></details>
            {capabilities.modelBudget && <details><summary>调用预算 · 每任务 {capabilities.modelBudget.limit} 次</summary><p>按完整预留计算，普通单元最多 {Math.floor(capabilities.modelBudget.limit / capabilities.modelBudget.unitCalls)} 个，带上下文的视觉单元最多 {Math.floor(capabilities.modelBudget.limit / capabilities.modelBudget.contextUnitCalls)} 个。混合任务共享预算；单元数量不等于页数，重试仍占用预算，剩余预算不足时可能仅有部分结果。</p></details>}
          </aside>}
        </div>);
  const recordsContent = (<section className="records-panel" aria-labelledby="task-list-heading">
  <div className="section-heading"><div><h2 id="task-list-heading" tabIndex={-1}>导入任务</h2></div><Button variant="outline" aria-label="刷新任务列表" onClick={() => setListRevision(value => value + 1)}><RefreshCw />刷新</Button></div>
  <div className="records-toolbar"><label><span>筛选任务状态</span><Select value={filter} onValueChange={value => { setFilter(value); setOffset(0); setCursors([undefined]); }}>{[["", "全部任务"], ["active", "正在处理"], ["paused", "已暂停"], ["review", "等待复核"], ["failed", "失败"], ["completed", "已完成"], ["interrupted", "已中断"], ["expired", "已过期"]].map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</Select></label><span aria-live="polite">本页 {tasks.items.length} 条记录</span></div>
  {listError && <div role="alert" className="error-banner"><div><p>{listError}</p>{!!tasks.items.length && <p>当前显示上次读取的记录。</p>}</div><Button variant="outline" onClick={() => setListRevision(value => value + 1)}>重试任务列表</Button></div>}
  {!tasks.items.length && !listError && <div className="records-empty"><History /><p role="status">{listLoading ? "正在读取任务…" : filter ? "没有符合此状态的任务。" : "当前没有任务。"}</p>{!listLoading && (filter ? <Button variant="outline" onClick={() => { setFilter(""); setOffset(0); setCursors([undefined]); }}>查看全部任务</Button> : capabilities && <Button variant="outline" disabled={busy} onClick={() => { navigate("import"); requestAnimationFrame(() => fileInput.current?.focus()); }}>选择第一份文档</Button>)}</div>}
  {!!tasks.items.length && <div className="records-table-scroll"><table className="records-table"><caption className="sr-only">文档导入记录</caption><thead><tr><th scope="col">文档</th><th scope="col">状态</th><th scope="col" className="record-number">题目</th><th scope="col" className="record-number">待复核</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead><tbody>{tasks.items.map(task => <tr key={task.threadId} data-selected={selected === task.threadId}>
    <td><button type="button" className="record-name" aria-pressed={selected === task.threadId} onClick={() => selectTask(task.threadId)}>{task.fileName}</button></td>
    <td><Badge variant="outline">{stateLabels[task.state]}</Badge>{task.status === "PARTIAL" && <Badge variant="secondary">部分结果</Badge>}</td>
    <td className="record-number"><span className="mobile-label">题目 </span>{task.questionCount}</td><td className="record-number"><span className="mobile-label">待复核 </span>{task.reviewCount > 0 ? <Badge variant="secondary">{task.reviewCount}</Badge> : 0}</td><td><time dateTime={task.createdAt}>{dateLabel(task.createdAt)}</time></td>
    <td>{task.state === "EXPIRED" ? <Button variant="destructive" size="sm" disabled={busy} aria-label={`删除已过期任务 ${task.fileName}`} onClick={() => setDeleteTarget({ threadId: task.threadId, fileName: task.fileName })}><Trash2 />删除</Button> : selected === task.threadId ? <a className="workspace-link" href="#task-detail">查看当前任务详情</a> : <Button variant="ghost" size="sm" onClick={() => selectTask(task.threadId)}>管理任务</Button>}</td>
  </tr>)}</tbody></table></div>}
  <nav aria-label="任务列表分页" className="records-pagination"><Button variant="outline" size="icon" aria-label="上一页任务" disabled={!offset || listLoading || !!listError} onClick={() => setOffset(value => Math.max(0, value - 20))}><ChevronLeft /></Button><span>第 {Math.floor(offset / 20) + 1} 页</span><Button variant="outline" size="icon" aria-label="下一页任务" disabled={!tasks.hasMore || listLoading || !!listError} onClick={() => { setCursors(previous => [...previous.slice(0, offset / 20 + 1), tasks.nextCursor ?? undefined]); setOffset(value => value + 20); }}><ChevronRight /></Button></nav>
</section>);
  const detailContent = client && (<section id="task-detail" tabIndex={-1} className="task-panel" aria-label="任务详情">
          {selected && <a className="workspace-link" href="#task-list-heading">返回任务列表</a>}

          {deleteTarget && <div ref={deletePrompt} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape" && !busy) setDeleteTarget(null); }} className="notice delete-confirmation" role="group" aria-label="删除任务确认"><p>确认删除“{deleteTarget.fileName}”及其检查点？已下载的题库不受影响。</p><div className="flex gap-2 mt-3"><Button variant="destructive" disabled={busy} onClick={() => void run(async current => { await current.delete(deleteTarget.threadId); if (current.active) { deleteCompleted.current = true; setSelected(value => value === deleteTarget.threadId ? null : value); setListRevision(value => value + 1); setDeleteTarget(null); setNotice("任务已删除。"); } })}>确认删除</Button><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>保留任务</Button></div></div>}
          {!selected ? <div className="records-hint"><FileText aria-hidden="true" /><p>选择一个任务查看结果</p></div> : <>
            {detailError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{detailError}</span><Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试任务详情</Button></div>}
            {previewError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{previewError}</span><Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试检查点预览</Button></div>}
            {!detail && !detailError && <p>正在读取任务详情…</p>}
            {detail && <div className="space-y-6"><div className="task-title"><div><h2>{detail.fileName}</h2><p><Badge variant="outline">{stateLabels[detail.state]}</Badge>{detail.status === "PARTIAL" && <Badge variant="secondary">部分结果</Badge>}</p></div><Button variant="outline" aria-label="刷新任务详情" onClick={() => setDetailRevision(value => value + 1)}><RefreshCw /></Button></div>
              {!detailFresh && <p className="notice">当前显示上次成功读取的信息，任务操作已停用，请先刷新。</p>}
              {preview && preview.checkpointId !== detail.checkpointId && <p className="notice">任务检查点正在更新，读取一致后才能继续或导出。</p>}
              <Progress task={detail} />
              {(detail.blocking.includes("MODEL_RESULT_UNKNOWN") || detail.unknownUsageCalls.length > 0) && <div className="notice" role="alert"><p>模型请求已发送，但结果尚未确认。已保存的题目、检查点和用量记录仍保留。</p><p>请先核对模型供应商的调用记录；继续解析或重试可能再次计费，不会自动重试未知调用。</p></div>}
              {detail.blocking.includes("RUN_DEADLINE_EXCEEDED") && <p className="notice" role="alert">本轮解析已达到运行时限，已保存的进度仍保留。可按可用操作继续解析，后续模型调用可能计费。</p>}
              <div className="task-actions" aria-label="当前任务操作">{detail.allowedActions.map(action => <Button key={action} variant="outline" disabled={busy || !detailFresh || (!["pause", "interrupt"].includes(action) && !matchingCheckpoint) || (!["pause", "interrupt"].includes(action) && (!detail.modelConfigured || !detail.resumeCompatible))} onClick={() => act(action)}>{action === "pause" ? <Pause /> : action === "interrupt" ? <Square /> : action === "resume" ? <Play /> : <RefreshCw />}{actionLabels[action]}</Button>)}<Button disabled={busy || !canExport} onClick={() => void run(async current => { const exported = await current.exportBank(detail); if (current.active) { downloadBlob(exported.blob, exported.name); setNotice("题库 ZIP 已下载。每次导出包含当前全部已完成内容，重复导入会创建独立题库。请在应用设置中追加导入。"); } })}><Download />下载题库 ZIP</Button></div>
              {detail.state !== "COMPLETED" && <p className="text-sm text-muted-foreground">暂停后可下载已完成题目，需有可用题目且检查点一致。</p>}
              <details className="task-secondary-actions"><summary>其他任务操作</summary><p className="text-sm text-muted-foreground">重新解析会重新提交腾讯识别并创建新的 AI 整理请求，可能再次计费；删除会移除此任务和检查点。已下载的题库不受影响。</p><div className="task-actions"><Button variant="outline" disabled={busy || !detailFresh || !detail.modelConfigured || detail.state === "EXPIRED"} onClick={() => void run(async current => { const receipt = await current.reparse(detail.threadId); if (current.active) { setSelected(value => value === detail.threadId ? receipt.threadId : value); setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("新解析任务已创建。"); } })}><RefreshCw />重新解析为新任务</Button><Button variant="destructive" disabled={busy || !detailFresh || ["RUNNING", "PENDING", "PAUSING"].includes(detail.state)} onClick={() => setDeleteTarget({ threadId: detail.threadId, fileName: detail.fileName })}><Trash2 />删除任务</Button></div></details>
              {!!detail.failures.length && <section className="notice"><h3>失败单元</h3><ul>{detail.failures.map(failure => <li key={`${failure.stage}:${failure.index}`}>{failure.stage} · {failure.index} · {failure.code} · {failure.retryable ? `可重试，剩余 ${failure.retriesRemaining ?? 0} 次` : "不可重试"}</li>)}</ul></section>}
              {(!detail.modelConfigured || !detail.resumeCompatible) && <p className="notice">{!detail.modelConfigured ? "服务端模型未配置。" : "当前模型配置与检查点不兼容。"}继续、重试和接受部分结果暂不可用，现有结果仍可检查。</p>}
              <ErrorBoundary key={selected} fallback={<RenderFailure />}><Suspense fallback={<p>正在加载结果检查视图…</p>}><ResultReview task={detail} preview={preview} client={client} /></Suspense></ErrorBoundary>
              <Usage task={detail} />
            </div>}
          </>}
        </section>);
  return <div className="web-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <aside className="web-sidebar" aria-label="导入管理侧边栏">
      <a href="#import" className="brand" onClick={() => navigate("import")}><img src={logo} alt="PractiQ 小章鱼" /><div><strong>PractiQ</strong><span>AI 文档导入</span></div></a>
      <nav aria-label="工作区导航">{pages.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)}><Icon aria-hidden="true" />{label}</a>)}</nav>
      <div className="sidebar-connection"><LockKeyhole aria-hidden="true" /><strong>{client ? "服务已连接" : "尚未连接服务"}</strong></div>
    </aside>
    <div className="web-body"><main id="main-content" tabIndex={-1} className="web-main">
      <header className="page-intro"><h1 id="page-heading" tabIndex={-1}>{pages.find(item => item.id === page)!.label}</h1></header>
      {!client ? <Card className="connection-card"><CardHeader><CardTitle role="heading" aria-level={2} className="flex items-center gap-2"><LockKeyhole />连接个人服务</CardTitle></CardHeader><CardContent className="space-y-4"><p id="service-help">使用自托管服务的 AI_SERVICE_TOKEN。令牌仅保存在本页内存，刷新后需重填。</p><form onSubmit={event => { event.preventDefault(); void connect(); }} className="connection-form"><label className="flex-1 space-y-1"><span>服务访问令牌</span><Input ref={tokenField} disabled={connecting} type="password" aria-invalid={accessInvalid || undefined} aria-describedby={accessInvalid ? "service-help access-error" : "service-help"} autoComplete="off" spellCheck={false} maxLength={4096} value={draftToken} onChange={event => setDraftToken(event.target.value)} /></label><Button type="submit" disabled={connecting || !draftToken.trim()}>连接服务</Button></form>{capError && <p id="access-error" role="alert" className="text-destructive">{capError}</p>}</CardContent></Card> : <>
        {capError && <div className="error-banner" role="alert"><span className="min-w-0 flex-1">{capError}</span><Button variant="outline" onClick={() => setCapRevision(value => value + 1)}>重试读取服务能力</Button></div>}
        {notice && <p className="notice operation-notice" role="status">{notice}</p>}
        {operationError && <div ref={operationNotice} className="error-banner" role="alert"><span className="min-w-0 flex-1">{operationError}</span></div>}
        {!!pendingImports.length && <section className="notice" aria-label="未确认的导入提交"><h2>未确认的导入提交</h2><p>原请求 ID 与文件引用已保存在本机，不含令牌或文件内容。请先查看导入记录；重试沿用原请求和参数，已有任务会返回原回执，尚未创建则会开始解析并可能计费。</p><p>清除本机恢复记录不会取消服务端任务；之后再次导入会视为新提交，可能重复计费。</p><ul>{pendingImports.map(request => <li key={request.requestId}><p>{request.document.fileName} · 自动去重：{request.deduplicateQuestions ? "开启" : "关闭"}</p><small>原提交请求 ID：{request.requestId}</small><div className="task-actions"><Button variant="outline" disabled={busy || !capabilities?.modelConfigured || capabilities.parserConfigured === false} onClick={() => void run(async current => { const receipt = await current.retryImport(request.requestId); if (current.active) { navigate("records"); setSelected(receipt.threadId); setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("原提交已确认，正在读取服务端任务。"); } })}>重试原提交</Button><Button variant="ghost" disabled={busy} onClick={() => void run(async current => { current.forgetImport(request.requestId); setNotice("本机恢复记录已清除，服务端任务不受影响。"); })}>已核对，清除恢复记录</Button></div></li>)}</ul></section>}
        {busy && <p role="status" className="operation-status"><LoaderCircle className="loading-icon" aria-hidden="true" />正在处理当前操作，请勿重复提交。</p>}
        <div hidden={page !== "import"} className="import-page">
          {importContent}
        </div>
        <div hidden={page !== "records"} className="records-page">{recordsContent}{detailContent}</div>
        <div hidden={page !== "settings"} className="settings-page"><ImportSettingsPanel client={client} /></div>
      </>}
    </main></div>
  </div>;
}
