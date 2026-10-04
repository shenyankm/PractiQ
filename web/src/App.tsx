import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Upload, Play, RefreshCw, Download, Trash2, LockKeyhole, Unplug, ChevronLeft, ChevronRight, FileText, LoaderCircle } from "lucide-react";
import logo from "./assets/octopus.png";
import { ApiError, Client, downloadBlob, fileFormat, MAX_FILES, sourceLimit, validateFiles, type Action, type Capabilities, type OfficeMode, type TaskList, type UploadStage } from "./api";
import type { DocumentTaskDetail, DocumentTaskReview, DocumentTaskSummary } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
const ResultReview = lazy(() => import("./ResultReview"));

type FileItem = { id: string; file: File; mode?: OfficeMode; state: "ready" | UploadStage | "created" | "failed"; threadId?: string; error?: string };
const stateLabels: Record<DocumentTaskSummary["state"], string> = { PENDING: "等待开始", RUNNING: "正在解析", PAUSING: "正在暂停", PAUSED: "已暂停", INTERRUPTED: "已中断", CANCELLED: "已取消", FAILED: "失败", WAITING_REVIEW: "等待复核", COMPLETED: "已完成", EXPIRED: "已过期" };
const actionLabels: Record<Action, string> = { pause: "暂停", interrupt: "中断", resume: "继续解析", retry_failed: "重试失败单元", accept_partial: "接受部分结果" };
const formatLabels: Record<Capabilities["sourceTypes"][number], string> = { pdf: "PDF", text: "TXT", csv: "CSV", image: "PNG/JPEG", doc: "Word (.doc)", docx: "Word (.docx)", xls: "Excel (.xls)", xlsx: "Excel (.xlsx)" };
const fileLabels: Record<FileItem["state"], string> = { ready: "尚未提交", hashing: "校验文件", uploading: "上传文件", starting: "创建任务", created: "任务已创建", failed: "提交失败" };
const errorText = (error: unknown) => error instanceof ApiError ? error.message : "读取或操作失败，请手动重试。";
const authFailure = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status);
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Progress({ task }: { task: DocumentTaskDetail }) {
  return <div className="progress-grid">{(["chunks", "visuals"] as const).map(kind => {
    const progress = task.progress[kind];
    return <section key={kind}><div className="flex justify-between"><strong>{kind === "chunks" ? "文本单元" : "视觉单元"}</strong><span>{progress.succeeded + progress.failed}/{progress.total}</span></div><progress aria-label={kind === "chunks" ? "文本单元进度" : "视觉单元进度"} value={progress.succeeded + progress.failed} max={Math.max(1, progress.total)} /><p className="text-sm text-muted-foreground">成功 {progress.succeeded} · 失败 {progress.failed} · 剩余 {progress.remaining}</p></section>;
  })}</div>;
}
function Usage({ task }: { task: DocumentTaskDetail }) {
  const input = task.usage.reduce((sum, call) => sum + call.inputTokens, 0);
  const output = task.usage.reduce((sum, call) => sum + call.outputTokens, 0);
  return <details className="resource-card"><summary>模型用量与任务诊断</summary><div className="space-y-3 pt-3"><p>已知用量：{task.usage.length} 次调用，输入 {input} tokens，输出 {output} tokens。</p><p>{task.unknownUsageCalls.length ? `有 ${task.unknownUsageCalls.length} 次调用未返回用量，实际总用量未知。` : "没有已记录的未知用量调用。"}</p><p>调用预算：已预留 {task.modelBudget.reserved}/{task.modelBudget.limit} 次。</p><dl className="metadata-grid"><dt>检查点</dt><dd>{task.checkpointId ?? "尚无（null）"}</dd><dt>运行 ID</dt><dd>{task.runId ?? "无（null）"}</dd><dt>父任务</dt><dd>{task.parentThreadId ?? "无（null）"}</dd><dt>到期时间</dt><dd>{task.expiresAt}</dd></dl><pre className="raw-data">{JSON.stringify({ usage: task.usage, unknownUsageCalls: task.unknownUsageCalls, processing: task.processing, blocking: task.blocking }, null, 2)}</pre></div></details>;
}

export default function App() {
  const [draftToken, setDraftToken] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const [capRevision, setCapRevision] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [officeMode, setOfficeMode] = useState<OfficeMode>("pdf");
  const [tasks, setTasks] = useState<TaskList>({ items: [], hasMore: false });
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [offset, setOffset] = useState(0);
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
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ threadId: string; fileName: string } | null>(null);
  const job = useRef<symbol | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => client?.disconnect(), [client]);
  useEffect(() => {
    setCapabilities(null); setCapError(null);
    if (!client) return;
    const controller = new AbortController();
    void client.capabilities(controller.signal).then(result => { if (!controller.signal.aborted) { setCapabilities(result); setOfficeMode(mode => result.officeModes.includes(mode) ? mode : result.officeModes[0] || "pdf"); } }).catch(error => { if (!controller.signal.aborted) setCapError(errorText(error)); });
    return () => controller.abort();
  }, [client, capRevision]);
  useEffect(() => {
    setTasks({ items: [], hasMore: false }); setListError(null);
    if (!client) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let again = true;
      setListLoading(true);
      try {
        const result = await client!.list(offset, filter, controller.signal);
        if (!controller.signal.aborted) { setTasks(result); setListError(null); }
      } catch (error) {
        if (!controller.signal.aborted) { setTasks({ items: [], hasMore: false }); setListError(errorText(error)); }
        again = !authFailure(error);
      } finally {
        if (!controller.signal.aborted) { setListLoading(false); if (again) timer = setTimeout(() => void poll(), 3000); }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, offset, filter, listRevision]);
  useEffect(() => {
    setDetail(null); setPreview(null); setDetailError(null); setPreviewError(null); setDetailFresh(false);
    if (!client || !selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const [current, review] = await Promise.allSettled([client!.detail(selected!, controller.signal), client!.preview(selected!, controller.signal)]);
      if (controller.signal.aborted) return;
      if (current.status === "fulfilled") { setDetail(current.value); setDetailError(null); setDetailFresh(true); }
      else { setDetailError(errorText(current.reason)); setDetailFresh(false); }
      if (review.status === "fulfilled") { setPreview(review.value); setPreviewError(null); }
      else { setPreviewError(errorText(review.reason)); setPreview(null); }
      if (!((current.status === "rejected" && authFailure(current.reason)) || (review.status === "rejected" && authFailure(review.reason)))) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, selected, detailRevision]);
  function connect() {
    try { setClient(new Client(draftToken.trim())); setDraftToken(""); setOperationError(null); setNotice(null); }
    catch (error) { setCapError(errorText(error)); }
  }
  function disconnect() {
    client?.disconnect(); job.current = null; setClient(null); setDraftToken(""); setSelected(null); setDeleteTarget(null); setFiles([]); setBusy(false); setOperationError(null); setNotice(null); setFileError(null); setOffset(0); setFilter("");
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
    try { validateFiles(chosen, capabilities); setFiles(chosen.map(file => ({ file, id: crypto.randomUUID(), state: "ready" }))); }
    catch (error) { setFiles([]); setFileError(errorText(error)); }
    if (fileInput.current) fileInput.current.value = "";
  }
  async function start(items: FileItem[]) {
    if (!capabilities || !items.length) return;
    const before = selected;
    await run(async current => {
      let created: string | null = null;
      for (const item of items) {
        const mode = item.mode || officeMode;
        const update = (value: Partial<FileItem>) => { if (current.active) setFiles(previous => previous.map(file => file.id === item.id ? { ...file, ...value } : file)); };
        update({ mode, error: undefined });
        try {
          const receipt = await current.start(item.file, capabilities, item.id, mode, stage => update({ state: stage }));
          update({ state: "created", threadId: receipt.threadId }); created = receipt.threadId;
        } catch (error) { update({ state: "failed", error: errorText(error) }); }
        if (!current.active) return;
      }
      setListRevision(value => value + 1);
      if (created) { setSelected(value => value === before ? created : value); setNotice("任务已创建。页面只读取进度；继续或重试需要点击对应操作。"); }
    });
  }
  const matchingCheckpoint = detailFresh && !previewError && preview?.checkpointId === detail?.checkpointId;
  const canExport = !!detail && detail.state === "COMPLETED" && !!detail.result && !!detail.checkpointId && matchingCheckpoint;
  function act(action: Action) {
    if (!detail) return;
    void run(async current => { await current.control(detail, action); if (current.active) { setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("操作已提交，正在读取服务端最新状态。"); } });
  }
  return <div className="web-shell">
    <header className="web-header"><a href="/" className="brand"><img src={logo} alt="PractiQ 小章鱼" /><div><strong>PractiQ</strong><span>AI 文档导入</span></div></a><div className="flex items-center gap-3"><Badge variant="outline">{client ? capabilities ? "服务已连接" : "正在验证服务" : "尚未连接"}</Badge>{client && <Button variant="outline" onClick={disconnect}><Unplug />断开连接</Button>}</div></header>
    <main className="web-main"><div className="page-intro"><div><p className="eyebrow">文档 → 检查结果 → 导出题库</p><h1>把文档整理成可复核的题库</h1><p>上传、解析与结果检查在这里完成。下载题库 ZIP 后，在 PractiQ 应用的「设置 → 恢复备份」中追加题库并离线练习。</p></div></div>
      {!client ? <Card className="connection-card"><CardHeader><CardTitle className="flex items-center gap-2"><LockKeyhole />连接 AI 服务</CardTitle></CardHeader><CardContent className="space-y-4"><p>输入当前服务的访问 Token。它仅保存在本页内存中，刷新或断开后会清除。模型配置由服务端管理。</p><form onSubmit={event => { event.preventDefault(); connect(); }} className="flex items-end gap-3"><label className="flex-1 space-y-1"><span>服务 Token</span><Input type="password" autoComplete="off" spellCheck={false} value={draftToken} onChange={event => setDraftToken(event.target.value)} /></label><Button type="submit" disabled={!draftToken.trim()}>连接服务</Button></form>{capError && <p role="alert" className="text-destructive">{capError}</p>}</CardContent></Card> : <>
        {capError && <div className="error-banner" role="alert">{capError}<Button variant="outline" onClick={() => setCapRevision(value => value + 1)}>重试读取服务能力</Button></div>}
        {operationError && <div className="error-banner" role="alert">{operationError}</div>}{notice && <p className="notice" role="status">{notice}</p>}
        <div className="workspace-grid"><aside className="space-y-5">
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Upload />导入文档</CardTitle></CardHeader><CardContent className="space-y-4">
            {!capabilities ? <p>正在读取服务支持的格式与限制…</p> : <>
              <p className="text-sm text-muted-foreground">一次最多 {MAX_FILES} 个文件，每个不超过 {sizeLabel(sourceLimit(capabilities))}{capabilities.officeAvailable && sourceLimit(capabilities, "docx") < sourceLimit(capabilities) && `，Word / Excel 不超过 ${sizeLabel(sourceLimit(capabilities, "docx"))}`}。选择文件后不会上传，点击「开始导入」才会提交并调用模型。</p>
              <label className="file-picker"><FileText /><span>选择文档</span><Input ref={fileInput} type="file" multiple accept=".pdf,.txt,.csv,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx" disabled={busy} onChange={event => chooseFiles(Array.from(event.target.files || []))} /></label>
              <p className="text-xs text-muted-foreground">服务支持：{capabilities.sourceTypes.map(type => formatLabels[type]).join("、")}{!capabilities.officeAvailable && "。Office 转换当前不可用。"}</p>
              {capabilities.officeAvailable && <label className="space-y-1 block"><span>Word / Excel 转换模式</span><select aria-label="Word / Excel 转换模式" value={officeMode} disabled={busy || files.some(file => file.state !== "ready")} onChange={event => setOfficeMode(event.target.value as OfficeMode)}>{capabilities.officeModes.map(mode => <option key={mode} value={mode}>{mode === "pdf" ? "PDF（保留版面）" : "文本 / 每工作表 CSV"}</option>)}</select><p className="text-xs text-muted-foreground">转换在服务端完成；模式在开始导入后固定，重新解析沿用该模式。</p></label>}
              {!capabilities.modelConfigured && <p className="notice">服务端尚未配置模型，暂不能开始解析。</p>}
              {fileError && <p role="alert" className="text-destructive">{fileError}</p>}
              {!!files.length && <ul className="file-list">{files.map(item => <li key={item.id}><div><strong>{item.file.name}</strong><span>{sizeLabel(item.file.size)} · {fileLabels[item.state]} · {formatLabels[fileFormat(item.file).sourceType]}</span>{item.error && <p role="alert" className="text-destructive">{item.error}</p>}</div>{item.state === "failed" && <Button size="sm" variant="outline" disabled={busy || !capabilities.modelConfigured} onClick={() => void start([item])}>重试开始</Button>}</li>)}</ul>}
              <Button className="w-full" disabled={busy || !capabilities.modelConfigured || !files.some(file => file.state === "ready")} onClick={() => void start(files.filter(file => file.state === "ready"))}>{busy ? <LoaderCircle className="loading-icon" /> : <Play />}开始导入</Button>
              {files.some(file => file.state === "failed") && <p className="text-xs text-muted-foreground">失败不会自动再次提交。「重试开始」会复用原请求 ID 和转换模式，避免不确定响应产生重复任务。</p>}
            </>}
          </CardContent></Card>
          <Card><CardHeader><div className="flex items-center justify-between"><CardTitle>文档任务</CardTitle><Button variant="ghost" size="icon" aria-label="刷新任务列表" onClick={() => setListRevision(value => value + 1)}><RefreshCw /></Button></div></CardHeader><CardContent className="space-y-3">
            <label className="block"><span className="sr-only">筛选任务状态</span><select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}>{[["", "全部任务"], ["active", "正在处理"], ["paused", "已暂停"], ["review", "等待复核"], ["failed", "失败"], ["completed", "已完成"], ["interrupted", "已中断"], ["expired", "已过期"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {listError && <div role="alert" className="space-y-2"><p className="text-destructive">{listError}</p><Button variant="outline" onClick={() => setListRevision(value => value + 1)}>重试任务列表</Button></div>}
            {!tasks.items.length && !listError && <p className="text-muted-foreground">{listLoading ? "正在读取任务…" : "当前没有任务。"}</p>}
            <div className="task-list">{tasks.items.map(task => <div key={task.threadId} className="task-list-item"><button type="button" className="task-row" aria-pressed={selected === task.threadId} onClick={() => { setSelected(task.threadId); setDeleteTarget(null); }}><strong>{task.fileName}</strong><span><Badge variant="outline">{stateLabels[task.state]}</Badge>{task.status === "PARTIAL" && <Badge variant="secondary">部分结果</Badge>}</span><small>{task.questionCount} 条题目 · {task.reviewCount} 条待复核</small></button>{task.state === "EXPIRED" && <Button variant="destructive" size="sm" disabled={busy} aria-label={`删除已过期任务 ${task.fileName}`} onClick={() => setDeleteTarget({ threadId: task.threadId, fileName: task.fileName })}><Trash2 />删除已过期任务</Button>}</div>)}</div>
            <nav aria-label="任务列表分页" className="flex items-center justify-between"><Button variant="outline" size="icon" aria-label="上一页任务" disabled={!offset || listLoading} onClick={() => setOffset(value => Math.max(0, value - 20))}><ChevronLeft /></Button><span className="text-xs">第 {Math.floor(offset / 20) + 1} 页</span><Button variant="outline" size="icon" aria-label="下一页任务" disabled={!tasks.hasMore || listLoading} onClick={() => setOffset(value => value + 20)}><ChevronRight /></Button></nav>
          </CardContent></Card>
        </aside><section className="task-panel" aria-label="任务详情">
          {deleteTarget && <div className="notice" role="group" aria-label="删除任务确认"><p>确认删除「{deleteTarget.fileName}」及其检查点？已下载的题库不受影响。</p><div className="flex gap-2 mt-3"><Button variant="destructive" disabled={busy} onClick={() => void run(async current => { await current.delete(deleteTarget.threadId); if (current.active) { setSelected(value => value === deleteTarget.threadId ? null : value); setListRevision(value => value + 1); setDeleteTarget(null); setNotice("任务已删除。"); } })}>确认删除</Button><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>保留任务</Button></div></div>}
          {!selected ? <div className="empty-panel"><FileText /><h2>选择一个任务查看结果</h2><p>页面会自动读取进度。暂停、继续、重试和重新解析都需要明确点击。</p></div> : <>
            {detailError && <div className="error-banner" role="alert">{detailError}<Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试任务详情</Button></div>}
            {previewError && <div className="error-banner" role="alert">{previewError}<Button variant="outline" onClick={() => setDetailRevision(value => value + 1)}>重试检查点预览</Button></div>}
            {!detail && !detailError && <p>正在读取任务详情…</p>}
            {detail && <div className="space-y-6"><div className="task-title"><div><h2>{detail.fileName}</h2><p><Badge variant="outline">{stateLabels[detail.state]}</Badge><span>阶段：{detail.phase}</span>{detail.status && <Badge variant={detail.status === "PARTIAL" ? "secondary" : "outline"}>{detail.status === "PARTIAL" ? "部分结果" : "解析完成"}</Badge>}</p></div><Button variant="outline" aria-label="刷新任务详情" onClick={() => setDetailRevision(value => value + 1)}><RefreshCw /></Button></div>
              {!detailFresh && <p className="notice">当前显示上次成功读取的信息，任务操作已停用，请先刷新。</p>}
              {preview && preview.checkpointId !== detail.checkpointId && <p className="notice">任务检查点正在更新，读取一致后才能继续或导出。</p>}
              <Progress task={detail} />
              <div className="task-actions">{detail.allowedActions.map(action => <Button key={action} variant="outline" disabled={busy || !detailFresh || (!["pause", "interrupt"].includes(action) && !matchingCheckpoint) || (["resume", "retry_failed"].includes(action) && (!detail.modelConfigured || !detail.resumeCompatible))} onClick={() => act(action)}>{actionLabels[action]}</Button>)}<Button variant="outline" disabled={busy || !detailFresh || !detail.modelConfigured || detail.state === "EXPIRED"} onClick={() => void run(async current => { const receipt = await current.reparse(detail.threadId); if (current.active) { setSelected(value => value === detail.threadId ? receipt.threadId : value); setListRevision(value => value + 1); setDetailRevision(value => value + 1); setNotice("新解析任务已创建。"); } })}><RefreshCw />重新解析为新任务</Button><Button disabled={busy || !canExport} onClick={() => void run(async current => { const exported = await current.exportBank(detail); if (current.active) { downloadBlob(exported.blob, exported.name); setNotice("题库 ZIP 已下载。请在应用设置中追加导入。"); } })}><Download />下载题库 ZIP</Button><Button variant="destructive" disabled={busy || !detailFresh || ["RUNNING", "PENDING", "PAUSING"].includes(detail.state)} onClick={() => setDeleteTarget({ threadId: detail.threadId, fileName: detail.fileName })}><Trash2 />删除任务</Button></div>
              {!!detail.failures.length && <section className="notice"><h3>失败单元</h3><ul>{detail.failures.map(failure => <li key={`${failure.stage}:${failure.index}`}>{failure.stage} · {failure.index} · {failure.code} · {failure.retryable ? `可重试，剩余 ${failure.retriesRemaining ?? 0} 次` : "不可重试"}</li>)}</ul></section>}
              {(!detail.modelConfigured || !detail.resumeCompatible) && <p className="notice">{!detail.modelConfigured ? "服务端模型未配置。" : "当前模型配置与检查点不兼容。"}继续和重试暂不可用，现有结果仍可检查。</p>}
              <Usage task={detail} />
              <Suspense fallback={<p>正在加载结果检查视图…</p>}><ResultReview key={`${selected}:${detail.checkpointId}`} task={detail} preview={preview} client={client} /></Suspense>
            </div>}
          </>}
        </section></div>
      </>}
    </main><footer>PractiQ · 保留来源与不确定性，由你检查并决定下一步。</footer>
  </div>;
}
