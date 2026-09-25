import { date, t, useI18n } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "./notifications";
import { errorMessage, type Preview } from "./api";
import { ai, readReviewImage, type Task, type Summary, type Review, type PendingOperation, type Batch, type ImportTaskContext, type ImportOperation } from "./ai-api";
import { importTaskState } from "./import-task-state";
import { Badge } from "@/components/ui/badge";
import { QuestionPreview } from "./QuestionPreview";
import { Markdown } from "./Content";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

function retryableRead(error: unknown) {
  const { code, httpStatus } = (error ?? {}) as { code?: string; httpStatus?: number };
  if (code === "TASK_NOT_FOUND" || code === "TASK_EXPIRED") return false;
  return httpStatus == null || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

function actions(): Record<string, string> { return {
  pause: t("暂停"),
  resume: t("继续"),
  interrupt: t("中断"),
  retry_failed: t("重试失败项"),
  accept_partial: t("接受部分结果"),
}; }
function states(): Record<string, string> { return {
  PENDING: t("排队中"),
  RUNNING: t("解析中"),
  PAUSING: t("正在暂停"),
  PAUSED: t("已暂停"),
  INTERRUPTED: t("已中断"),
  FAILED: t("解析失败"),
  WAITING_REVIEW: t("待审核"),
  COMPLETED: t("已完成"),
  EXPIRED: t("已过期"),
  READY: t("待导入"),
  IMPORTING: t("导入中"),
  IMPORT_FAILED: t("导入失败"),
  IMPORTED: t("已导入"),
}; }
function phaseName(phase: string) {
  return ({ prepare: t("准备文档"), vision: t("识别图片"), chunk: t("提取题目"), document_parse: t("提取题目"), vision_parse: t("识别图片"), visual_crop: t("整理图片"), merge: t("整理题目"), result: t("检查结果"), review: t("审核内容"), vision_review: t("审核图片"), chunk_review: t("审核题目"), result_review: t("审核结果"), completed: t("已完成") } as Record<string, string>)[phase] || t("处理文档");
}
function failureMessage(code: string) {
  return code === "AI_PROVIDER_AUTH_ERROR" ? t("模型鉴权失败，请检查设置中的 API Key，再重试失败项。") : t("此项未能完成，请检查配置或重试（{0}）。", { 0: code });
}
const activeStates = new Set(["PENDING", "RUNNING", "PAUSING"]);
function ReadAsset({
  review,
  unit,
  visual,
  label,
}: {
  review: Review;
  unit: number;
  visual: number | null;
  label: string;
}) {
  useI18n();
  const [src, setSrc] = useState<{ mediaType: string; content: string }>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => {
    if (src?.mediaType.startsWith("image/")) URL.revokeObjectURL(src.content);
  }, [src]);
  const reference = (visual === null ? review.units[unit]?.sourceRef : (review.units[unit]?.visualElements?.[visual] as { imageRef?: unknown } | undefined)?.imageRef) as { mediaType?: string } | undefined;
  const mediaType = reference?.mediaType ?? "";
  return (
    <div>
      {src ? (
        src.mediaType.startsWith("text/") ? (
          <Markdown>{src.content}</Markdown>
        ) : (
          <img
            className="max-h-96 max-w-full object-contain"
            src={src.content}
            alt={label}
          />
        )
      ) : (
        <Button
          variant="outline"
          disabled={!review.checkpointId}
          onClick={() => {
            if (!review.checkpointId) return;
            const request = { id: review.threadId, checkpointId: review.checkpointId, unit, visual };
            void (mediaType.startsWith("image/")
              ? readReviewImage(request).then(bytes => ({ mediaType, content: URL.createObjectURL(new Blob([bytes], { type: mediaType })) }))
              : ai({ type: "review_asset", id: request.id, checkpoint_id: request.checkpointId, unit, visual }))
              .then(value => {
                if (mounted.current) setSrc(value);
                else if (value.mediaType.startsWith("image/")) URL.revokeObjectURL(value.content);
              })
              .catch((e) => toast.error(e));
          }}
        >
          {label}
        </Button>
      )}
    </div>
  );
}
export function AiTasks({
  busy,
  run,
  onPreview,
  modelsReady = true,
  children,
  onOpenBank,
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPreview: (p: Preview, context: ImportTaskContext) => void;
  children?: ReactNode;
  onOpenBank?: (bankId: string) => void;
  modelsReady?: boolean;
}) {
  useI18n();
  const [rows, setRows] = useState<Summary[]>([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [task, setTask] = useState<Task | null>(null),
    [error, setError] = useState<unknown>(null),
    [revision, setRevision] = useState(0);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [checked, setChecked] = useState<string[]>([]),
    [operations, setOperations] = useState<PendingOperation[]>([]),
    [batches, setBatches] = useState<Batch[]>([]),
    [confirmation, setConfirmation] = useState<Batch | null>(null),
    [running, setRunning] = useState<string | null>(null),
    [review, setReview] = useState<Review | null>(null);
  const [imports, setImports] = useState<Record<string, ImportOperation>>({});
  const [loading, setLoading] = useState(true);
  const batchWasRunning = useRef(false);
  const [batchOffset, setBatchOffset] = useState(0), [batchTotal, setBatchTotal] = useState(0);
  const [batchOperations, setBatchOperations] = useState<(ImportOperation & {threadId:string})[]>([]);
  const batchThreads = JSON.stringify([...new Set([...rows.map(row=>row.threadId), ...(selected ? [selected] : [])])]);
  function receiveBatches(page: Awaited<ReturnType<typeof readBatches>>) {
    setBatches(page.items); setBatchTotal(page.total); setBatchOffset(page.offset); setBatchOperations(page.operations);
  }
  const readBatches = useCallback(() => ai({type:"batches",offset:batchOffset,thread_ids:JSON.parse(batchThreads)}), [batchOffset, batchThreads]);
  async function localRefresh() {
    const [o, b] = await Promise.all([
      ai({ type: "operations" }),
      readBatches(),
    ]);
    setOperations(o);
    receiveBatches(b);
  }
  async function refreshList() {
    setRevision(n => n + 1);
  }
  async function refresh() {
    await refreshList();
    await localRefresh();
  }
  useEffect(() => {
    if (!modelsReady) { setLoading(false); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const r = await ai({ type: "list", offset });
        if (!active) return;
        setRows(r.items);
        setChecked(ids => ids.filter(id => r.items.some(row => row.threadId === id && ["READY", "IMPORT_FAILED"].includes(importTaskState(row)))));
        setMore(r.hasMore);
        setError(null);
        setLoading(false);
        failures = 0;
        if (r.items.some(row => activeStates.has(row.state)) || running)
          timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!active) return;
        setError(e);
        setLoading(false);
        if (retryableRead(e) && ++failures <= 3) timer = setTimeout(poll, 2000);
      }
    };
    setLoading(true);
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [offset, modelsReady, revision, running]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const [o, b] = await Promise.all([
          ai({ type: "operations" }),
          readBatches(),
        ]);
        if (active) {
          failures = 0;
          setOperations(o);
          receiveBatches(b);
          const batchIsRunning = b.items.some(value => value.status === "running");
          if (batchWasRunning.current && !batchIsRunning) setRevision(n => n + 1);
          batchWasRunning.current = batchIsRunning;
          if (running || b.items.some((v) => v.status === "running"))
            timer = setTimeout(poll, 1000);
        }
      } catch (e) {
        if (active) {
          setError(e);
          if (retryableRead(e) && ++failures <= 3) timer = setTimeout(poll, 2000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [running, readBatches]);
  const selectedExpired = rows.some(row => row.threadId === selected && row.state === "EXPIRED");
  useEffect(() => {
    if (!selected || !modelsReady || selectedExpired) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    setTask(null);
    setDetailError(null);
    const poll = async () => {
      try {
        const value = await ai({ type: "get", id: selected });
        if (active) {
          setTask(value);
          setDetailError(null);
          if (activeStates.has(value.state)) timer = setTimeout(poll, 2000);
          else setRevision(n => n + 1);
          failures = 0;
        }
      } catch (e) {
        if (active) {
          setDetailError(e);
          if (retryableRead(e) && ++failures <= 3) timer = setTimeout(poll, 2000);
          else {
            setTask(null);
            setRevision(n => n + 1);
          }
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected, detailRevision, modelsReady, selectedExpired]);
  async function control(action: string) {
    if (!task || task.threadId !== selected || !task.allowedActions.includes(action)) return;
    try {
      await ai({
        type: "control",
        id: task.threadId,
        action,
        run_id: ["pause", "interrupt"].includes(action) ? task.runId : null,
        checkpoint_id: ["pause", "interrupt"].includes(action)
          ? null
          : task.checkpointId,
        units: [],
      });
      setReview(null);
      setDetailRevision(n => n + 1);
      await refreshList();
    } finally {
      await localRefresh();
    }
  }
  async function startBatch(batch: Batch, titles: string[] | null) {
    setRunning(batch.id);
    setChecked([]);
    setConfirmation(null);
    try {
      await ai({ type: "run_batch", id: batch.id, titles });
      await refreshList();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(null);
      await localRefresh().catch((e) => setError(e));
    }
  }
  const operationIndex = useMemo(() => {
    const index = new Map<string, ImportOperation>();
    for (const operation of batchOperations) {
      const key = JSON.stringify([operation.threadId, operation.checkpointId]);
      if (!index.has(key)) index.set(key, operation);
    }
    return index;
  }, [batchOperations]);
  function importOperation(row: Pick<Summary, "threadId" | "checkpointId">): ImportOperation | undefined {
    const local = imports[row.threadId];
    return local?.checkpointId === row.checkpointId ? local : operationIndex.get(JSON.stringify([row.threadId,row.checkpointId]));
  }
  const eligibleChecked = checked.filter(id => rows.some(row => row.threadId === id && ["READY", "IMPORT_FAILED"].includes(importTaskState(row, importOperation(row)))));
  const selectedRow = rows.find(row => row.threadId === selected);
  const currentTask = task?.threadId === selected ? task : null;
  async function previewTask(value: Task) {
    const checkpointId = value.checkpointId;
    const threadId = value.threadId;
    const preview = await ai({ type: "preview", id: threadId });
    onPreview(preview, {
      threadId,
      onState: (state, error) => setImports(values => ({ ...values, [threadId]: { checkpointId, state, error } })),
      onImported: bankId => {
        setImports(values => { const next = { ...values }; delete next[threadId]; return next; });
        setRows(values => values.map(row => row.threadId === threadId && row.checkpointId === checkpointId ? { ...row, importedBankId: bankId } : row));
        setChecked(ids => ids.filter(id => id !== threadId));
        setRevision(n => n + 1);
      },
    });
  }
  return (
    <div className="space-y-6">
      <Card><CardContent className="space-y-5">
      {children}
      <p className="text-sm text-muted-foreground">{t("选择文件后会先确认文件与模型，点击“开始解析”才会发送解析内容，可能产生费用。审核和导入已有结果不会调用模型。")}</p>
      {modelsReady && <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              try {
                const created = await ai({
                  type: "pick_document",
                });
                if (created) {
                  setOffset(0);
                  setChecked([]);
                  await refreshList();
                  setSelected(created.threadId);
                }
              } finally {
                await localRefresh();
              }
            })
          }
        >{t("选择文档…")}</Button>
      </div>}
      </CardContent></Card>
      {(rows.length > 0 || loading || error != null || operations.length > 0 || offset > 0 || more) && <section aria-label={t("导入任务")} className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t("导入任务")}</h2>
          <div className="flex gap-2">
            {modelsReady && <Button variant="outline" disabled={busy || loading} onClick={() => run(refresh)}>{t("刷新任务")}</Button>}
        {!!eligibleChecked.length && <Button
          disabled={busy}
          onClick={() =>
            run(async () =>
              setConfirmation(
                await ai({ type: "prepare_batch", ids: eligibleChecked }),
              ),
            )
          }
        >{t("批量导入已选任务（{0}）", { 0: eligibleChecked.length })}</Button>}
          </div>
        </div>
      {error != null && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3"><p className="text-sm text-destructive">{errorMessage(error)}</p><Button variant="outline" disabled={busy} onClick={() => run(async () => { try { await (modelsReady ? refresh() : localRefresh()); setError(null); } catch (e) { setError(e); } })}>{t("重试")}</Button></div>}
      {operations.length > 0 && (
        <section className="space-y-2">
          <h2>{t("待确认操作")}</h2>
          <p className="text-sm">{t("服务可能已接收请求。重试会使用原请求编号，不会重复创建任务；不会自动重试。")}</p>
          {operations.map((o) => (
            <div key={o.id}>
              {actions()[o.label] || o.label}: {o.error && errorMessage(o.error)}
              <Button
                disabled={busy || !modelsReady}
                onClick={() =>
                  run(async () => {
                    try {
                      await ai({ type: "replay", request_id: o.id });
                      await refreshList();
                    } finally {
                      await localRefresh();
                    }
                  })
                }
              >{t("重试待确认操作")}</Button>
            </div>
          ))}
        </section>
      )}
      {loading && <p role="status">{t("加载中…")}</p>}
      {rows.length > 0 && <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-muted-foreground"><tr>
            <th className="w-10 p-3"><span className="sr-only">{t("选择")}</span></th>
            <th className="p-3">{t("文件名")}</th><th className="p-3">{t("任务状态")}</th>
            <th className="p-3">{t("题目 / 待复核")}</th><th className="p-3">{t("创建时间")}</th><th className="p-3">{t("操作")}</th>
          </tr></thead>
          <tbody>{rows.map(r => {
            const state = importTaskState(r, importOperation(r));
            return <tr key={r.threadId} className="border-t align-top">
              <td className="p-3"><Checkbox aria-label={t("选择 {0}", { 0: r.fileName })} disabled={busy || !modelsReady || !["READY", "IMPORT_FAILED"].includes(state)} checked={checked.includes(r.threadId)} onCheckedChange={value => setChecked(ids => value === true ? [...ids, r.threadId] : ids.filter(id => id !== r.threadId))} /></td>
              <td className="max-w-72 p-3"><Button className="h-auto max-w-full justify-start whitespace-normal break-all p-0 text-left" variant="link" onClick={() => { setTask(null); setSelected(r.threadId); }}>{r.fileName || r.threadId.slice(0, 8)}</Button></td>
              <td className="space-y-1 p-3"><Badge variant="secondary">{states()[state] || state}</Badge>
                {r.status === "PARTIAL" && <p className="text-xs text-muted-foreground">{t("部分结果")}</p>}
                {r.previouslyImported && !r.importedBankId && <p className="text-xs text-muted-foreground">{t("曾导入其他版本")}</p>}
                {state === "IMPORT_FAILED" && <p className="text-xs text-destructive">{errorMessage(importOperation(r)?.error)}</p>}
              </td>
              <td className="p-3 tabular-nums">{r.questionCount ?? 0} / {r.reviewCount ?? 0}</td>
              <td className="whitespace-nowrap p-3 text-muted-foreground">{r.createdAt ? date(Date.parse(r.createdAt)) : "—"}</td>
              <td className="p-3"><div className="flex gap-2"><Button variant="outline" onClick={() => { setTask(null); setSelected(r.threadId); }}>{t("查看详情")}</Button>{r.importedBankId && onOpenBank && <Button variant="outline" onClick={() => onOpenBank(r.importedBankId!)}>{t("查看题库")}</Button>}</div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
          {(offset > 0 || more) && <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={offset === 0 || busy}
              onClick={() => { setRows([]); setChecked([]); setOffset(Math.max(0, offset - 20)); }}
            >{t("上一页")}</Button>
            <Button
              variant="ghost"
              disabled={!more || busy}
              onClick={() => { setRows([]); setChecked([]); setOffset(offset + 20); }}
            >{t("下一页")}</Button>
          </div>}
      </section>}
      <Dialog open={selected !== null} onOpenChange={open => { if (!open) { setSelected(null); setTask(null); } }}>
        <DialogContent className="inset-y-0 right-0 left-auto flex h-full w-[min(40rem,100vw)] max-w-none translate-x-0 translate-y-0 flex-col overflow-y-auto rounded-none p-6 sm:max-w-none">
          <DialogHeader><DialogTitle>{selectedRow?.fileName || t("任务详情")}</DialogTitle><DialogDescription>{t("查看解析进度、审核内容和导入结果。")}</DialogDescription></DialogHeader>
          {selectedRow?.state === "EXPIRED" ? <p>{t("任务已过期，请重新选择文档。已有题库不受影响。")}</p> : !currentTask ? <p role="status">{detailError ? errorMessage(detailError) : t("加载中…")}</p> : null}
          {detailError != null && <Button variant="outline" disabled={busy || !modelsReady} onClick={() => setDetailRevision(n => n + 1)}>{t("重试")}</Button>}
          {selectedRow?.importedBankId && onOpenBank && <Button onClick={() => onOpenBank(selectedRow.importedBankId!)}>{t("查看题库")}</Button>}
        {task && currentTask && selectedRow?.state !== "EXPIRED" && (
            <div className="space-y-4">
              <h2 className="font-medium">
                {states()[importTaskState({ ...selectedRow, ...task, importedBankId: selectedRow?.checkpointId === task.checkpointId ? selectedRow.importedBankId : null }, importOperation(task))] || task.state}
              </h2>
              {importOperation(task)?.state === "failed" && <p role="alert" className="text-sm text-destructive">{errorMessage(importOperation(task)?.error)}</p>}
              <p className="text-sm">{task.state === "WAITING_REVIEW" ? t("部分内容需要确认，请先查看内容与审核。") : task.state === "FAILED" ? t("解析未完成；已保存的内容保留，可查看原因并重试失败项。") : task.state === "COMPLETED" ? (selectedRow?.checkpointId === task.checkpointId && selectedRow?.importedBankId ? t("已导入") : t("解析结果已保存，可预览并导入题库。")) : t("当前阶段：{0}", { 0: phaseName(task.phase) })}</p>
              {Object.entries(task.progress).map(([key, p]) => (
                <p className="text-sm" key={key}>{t("{0}：完成 {1}/{2}，失败 {3}", { 0: key === "visuals" ? t("图片") : t("文本"), 1: p.succeeded, 2: p.total, 3: p.failed })}</p>
              ))}
              <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("模型用量与技术详情")}</summary><p className="mt-2">{t("阶段：{0}", { 0: task.phase })}</p><p>{t("已记录 {0} 次调用；输入 {1} / 输出 {2} tokens；用量未知 {3} 次", { 0: task.usage.length, 1: task.usage.reduce((n, u) => n + (u.inputTokens || 0), 0), 2: task.usage.reduce((n, u) => n + (u.outputTokens || 0), 0), 3: task.unknownUsageCalls.length })}</p></details>
              {task.failures.map((f, i) => (
                <p className="text-sm text-destructive" key={i}>
                  {phaseName(f.stage)} #{f.index + 1}：{errorMessage({code:f.code, message:f.message || failureMessage(f.code)})}
                  {f.retryable ? t("（可重试）") : ""}
                </p>
              ))}
              {task.blocking.length > 0 && (
                <details className="text-sm"><summary className="cursor-pointer">{t("需要处理的问题（{0}）", { 0: task.blocking.length })}</summary><p>{t("请查看来源内容和质量提示，确认后接受部分结果或重试失败项。")}</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(task.blocking, null, 2)}</pre></details>
              )}
              <div className="flex flex-wrap gap-2">
                {task.allowedActions
                  .filter((a) => a !== "accept_partial")
                  .map((action) => (
                    <Button
                      key={action}
                      disabled={busy || !modelsReady || importOperation(task)?.state === "importing"}
                      variant="outline"
                      onClick={() => run(() => control(action))}
                    >
                      {actions()[action] || action}
                    </Button>
                  ))}
                {["COMPLETED", "WAITING_REVIEW"].includes(task.state) && (
                  <Button
                    variant="outline"
                    disabled={busy || !modelsReady || importOperation(task)?.state === "importing"}
                    onClick={() =>
                      run(async () =>
                        setReview(
                          await ai({
                            type: "review",
                            id: task.threadId,
                          }),
                        ),
                      )
                    }
                  >{t("查看内容与审核")}</Button>
                )}
                {task.state === "COMPLETED" && !(selectedRow?.checkpointId === task.checkpointId && selectedRow?.importedBankId) && (
                  <Button
                    disabled={busy || !modelsReady || importOperation(task)?.state === "importing"}
                    onClick={() =>
                      run(() => previewTask(task))
                    }
                  >{t("预览并导入题库")}</Button>
                )}
              </div>
            </div>
        )}
        </DialogContent>
      </Dialog>
      {batches.length > 0 && (
        <section className="space-y-3" aria-label={t("导入批次")}>
          <h2>{t("导入批次")}</h2>
          {batchTotal > 20 && <div className="flex gap-2">
            <Button variant="outline" disabled={batchOffset === 0} onClick={()=>setBatchOffset(n=>Math.max(0,n-20))}>{t("上一页")}</Button>
            <Button variant="outline" disabled={batchOffset+20 >= batchTotal} onClick={()=>setBatchOffset(n=>n+20)}>{t("下一页")}</Button>
          </div>}
          {batches.map((b) => (
            <Card key={b.id}>
              <CardContent className="space-y-2 pt-4">
                <p>{t("{0}/{1} 已导入 · {2}", { 0: b.items.filter((i) => i.status === "imported").length, 1: b.items.length, 2: b.status === "running"
                    ? t("进行中")
                    : b.status === "paused"
                      ? t("已暂停")
                      : b.status === "ready"
                        ? t("待确认")
                        : t("已处理") })}</p>
                {b.items.map((i) => (
                  <p className="text-sm" key={i.threadId}>
                    {i.title}：
                    {i.status === "imported"
                      ? t("已导入")
                      : i.status === "failed"
                        ? t("失败")
                        : t("待导入")}{" "}
                    {i.error && errorMessage(i.error)}
                  </p>
                ))}
                {b.status === "running" || running === b.id ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void ai({ type: "cancel_batch", id: b.id })
                        .then(localRefresh)
                        .catch((e) => setError(e));
                    }}
                  >{t("停止后续导入")}</Button>
                ) : (
                  b.items.some((i) => i.status !== "imported") && (
                    <Button
                      disabled={!!running || !modelsReady}
                      onClick={() =>
                        b.status === "ready"
                          ? setConfirmation(b)
                          : void startBatch(b, null)
                      }
                    >
                      {b.status === "ready" ? t("确认批次") : t("继续未成功项")}
                    </Button>
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </section>
      )}
      {confirmation && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setConfirmation(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>{t("批量导入确认")}</DialogTitle>
              <DialogDescription>{t("每个任务单独新建题库，串行导入；失败只影响该项。重复结果返回已有题库。")}</DialogDescription>
            </DialogHeader>
            {confirmation.items.map((item, index) => (
              <div className="space-y-2" key={item.threadId}>
                <Input
                  aria-label={t("题库名称 {0}", { 0: index + 1 })}
                  maxLength={200}
                  value={item.title}
                  disabled={item.status === "imported"}
                  onChange={(e) =>
                    setConfirmation({
                      ...confirmation,
                      items: confirmation.items.map((v, i) =>
                        i === index ? { ...v, title: e.target.value } : v,
                      ),
                    })
                  }
                />
                <p className="text-sm">{t("{0} 题 · {1} 待复核 {2} {3} {4}", { 0: item.questionCount, 1: item.reviewCount, 2: item.partial ? t("· 部分结果") : "", 3: item.status === "imported" ? t("· 已导入，将跳过") : "", 4: item.previousVersion ? t("· 新版本将单独建库，保留旧题库") : "" })}</p>
              </div>
            ))}
            <Button
              disabled={
                !!running || confirmation.items.some((i) => !i.title.trim())
              }
              onClick={() =>
                void startBatch(
                  confirmation,
                  confirmation.items.map((i) => i.title),
                )
              }
            >{t("确认逐项导入")}</Button>
          </DialogContent>
        </Dialog>
      )}
      {review && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setReview(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{t("只读内容审核")}</DialogTitle>
              <DialogDescription>{t("阶段：{0}。此预览不会接受结果或写入题库。", { 0: phaseName(review.phase) })}</DialogDescription>
            </DialogHeader>
            {review.failures.map((f, i) => (
              <p className="text-destructive" key={i}>
                {phaseName(f.stage)} #{f.index + 1}：{errorMessage({code:f.code, message:failureMessage(f.code)})}
              </p>
            ))}
            {review.units.map((unit, index) => (
              <section
                className="space-y-3"
                key={`${review.checkpointId}:${index}`}
              >
                <h3>
                  {phaseName(unit.stage)} #{unit.index + 1}
                </h3>
                {unit.sourceRef != null && (
                  <ReadAsset
                    review={review}
                    unit={index}
                    visual={null}
                    label={t("查看来源内容")}
                  />
                )}
                {unit.groups.map((g, i) => (
                  <div key={i}>
                    <Markdown>{g.title}</Markdown>
                    <Markdown>{g.instructions}</Markdown>
                  </div>
                ))}
                <QuestionPreview questions={unit.questions} groups={unit.groups} visuals={unit.visualElements} />
                {(unit.visualElements || []).map((v, i) => (
                  <div key={i}>
                    <Markdown>{v.description}</Markdown>
                    {v.imageRef != null && (
                      <ReadAsset
                        review={review}
                        unit={index}
                        visual={i}
                        label={t("查看关联图片 {0}", { 0: i + 1 })}
                      />
                    )}
                  </div>
                ))}
              </section>
            ))}
            <details>
              <summary>{t("来源和质量详情")}</summary>
              <pre className="whitespace-pre-wrap text-xs">
                {JSON.stringify(
                  { quality: review.quality, sources: review.questionSources },
                  null,
                  2,
                )}
              </pre>
            </details>
            {task?.threadId === review.threadId &&
              task.checkpointId === review.checkpointId &&
              task.allowedActions.includes("accept_partial") && (
                <Button
                  disabled={busy}
                  onClick={() => run(() => control("accept_partial"))}
                >{t("接受部分结果")}</Button>
              )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
