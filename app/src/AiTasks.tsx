import { message, t, useI18n, locale } from "./i18n";
import { useEffect, useState } from "react";
import { toast } from "./notifications";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage, type Preview, type Question } from "./api";
import { QuestionPreview } from "./QuestionPreview";
import { Markdown } from "./Content";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
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

type Failure = {
  retryable: boolean;
  stage: string;
  index: number;
  code: string;
  message?: string;
};
type Task = {
  threadId: string;
  runId: string | null;
  checkpointId: string | null;
  state: string;
  phase: string;
  allowedActions: string[];
  blocking: unknown[];
  failures: Failure[];
  progress: Record<
    string,
    { total: number; succeeded: number; failed: number }
  >;
  usage: { inputTokens: number | null; outputTokens: number | null }[];
  unknownUsageCalls: string[];
};
type Summary = {
  threadId: string;
  fileName: string;
  state: string;
  status: string | null;
  questionCount: number;
  reviewCount: number;
  importedBankId?: string | null;
  previouslyImported?: boolean;
};
type Review = {
  threadId: string;
  checkpointId: string;
  phase: string;
  units: {
    stage: string;
    index: number;
    questions: Question[];
    groups: (import("./contracts.generated").DocumentGroup | import("./contracts.generated").ParsedGroup)[];
    sourceRef: unknown;
    visualElements: (import("./contracts.generated").DocumentVisual | import("./contracts.generated").VisualElement)[];
  }[];
  failures: Failure[];
  quality: unknown;
  questionSources: unknown[];
};
type PendingOperation = {
  id: string;
  label: string;
  error: { code?: string; message: string; params?: Record<string, unknown> } | null;
};
type Batch = {
  id: string;
  status: "ready" | "running" | "paused" | "completed";
  items: {
    threadId: string;
    title: string;
    questionCount: number;
    reviewCount: number;
    partial: boolean;
    previousVersion: boolean;
    status: string;
    bankId: string | null;
    error: { code?: string; message: string; params?: Record<string, unknown> } | null;
  }[];
};
type Request =
  | { type: "list"; offset: number }
  | { type: "get" | "preview" | "review"; id: string }
  | { type: "pick_document" | "operations" | "batches" }
  | {
      type: "control";
      id: string;
      action: string;
      run_id: string | null;
      checkpoint_id: string | null;
      units: unknown[];
    }
  | { type: "replay"; request_id: string }
  | { type: "prepare_batch"; ids: string[] }
  | { type: "run_batch"; id: string; titles: string[] | null }
  | { type: "cancel_batch"; id: string }
  | {
      type: "review_asset";
      id: string;
      checkpoint_id: string;
      unit: number;
      visual: number | null;
    };
export function ai<T>(request: Request): Promise<T> {
  return invoke("ai_request", { request, locale: locale() });
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
  FAILED: t("失败"),
  WAITING_REVIEW: t("等待审核"),
  COMPLETED: t("已完成"),
  EXPIRED: t("已过期"),
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
          onClick={() => {
            void ai<{ mediaType: string; content: string }>({
              type: "review_asset",
              id: review.threadId,
              checkpoint_id: review.checkpointId,
              unit,
              visual,
            })
              .then(setSrc)
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
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPreview: (p: Preview) => void;
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
  const [checked, setChecked] = useState<string[]>([]),
    [operations, setOperations] = useState<PendingOperation[]>([]),
    [batches, setBatches] = useState<Batch[]>([]),
    [confirmation, setConfirmation] = useState<Batch | null>(null),
    [running, setRunning] = useState<string | null>(null),
    [review, setReview] = useState<Review | null>(null);
  async function localRefresh() {
    const [o, b] = await Promise.all([
      ai<PendingOperation[]>({ type: "operations" }),
      ai<Batch[]>({ type: "batches" }),
    ]);
    setOperations(o);
    setBatches(b);
  }
  async function refresh() {
    const r = await ai<{ items: Summary[]; hasMore: boolean }>({
      type: "list",
      offset,
    });
    setRows(r.items);
    setMore(r.hasMore);
    setError(null);
    setRevision((n) => n + 1);
    await localRefresh();
  }
  useEffect(() => {
    if (!modelsReady) return;
    let active = true;
    void ai<{ items: Summary[]; hasMore: boolean }>({ type: "list", offset })
      .then((r) => {
        if (active) {
          setRows(r.items);
          setMore(r.hasMore);
          setError(null);
        }
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
    };
  }, [offset, modelsReady]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const [o, b] = await Promise.all([
          ai<PendingOperation[]>({ type: "operations" }),
          ai<Batch[]>({ type: "batches" }),
        ]);
        if (active) {
          failures = 0;
          setOperations(o);
          setBatches(b);
          if (running || b.some((v) => v.status === "running"))
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
  }, [running]);
  useEffect(() => {
    if (!selected || !modelsReady) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    setTask(null);
    const poll = async () => {
      try {
        const value = await ai<Task>({ type: "get", id: selected });
        if (active) {
          setTask(value);
          setError(null);
          if (activeStates.has(value.state)) timer = setTimeout(poll, 2000);
          else {
            // Membership refresh must not invalidate a successfully read task.
            void ai<{ items: Summary[]; hasMore: boolean }>({ type: "list", offset })
              .then((listing) => {
                if (active) {
                  setRows(listing.items);
                  setMore(listing.hasMore);
                }
              })
              .catch((e) => { if (active) setError(e); });
          }
          failures = 0;
        }
      } catch (e) {
        if (active) {
          setError(e);
          if (retryableRead(e) && ++failures <= 3) timer = setTimeout(poll, 2000);
          else {
            setTask(null);
            // Refresh membership once; never retry a removed/expired task indefinitely.
            void ai<{ items: Summary[]; hasMore: boolean }>({ type: "list", offset })
              .then((listing) => {
                if (active) {
                  setRows(listing.items);
                  setMore(listing.hasMore);
                }
              })
              .catch(() => {});
          }
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected, revision, offset, modelsReady]);
  async function control(action: string) {
    if (!task) return;
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
      await refresh();
    } finally {
      await localRefresh();
    }
  }
  async function startBatch(batch: Batch, titles: string[] | null) {
    setRunning(batch.id);
    setConfirmation(null);
    try {
      await ai<Batch>({ type: "run_batch", id: batch.id, titles });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(null);
      await localRefresh().catch((e) => setError(e));
    }
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{t("选择文件后会先确认文件与模型，点击“开始解析”才会发送解析内容，可能产生费用。审核和导入已有结果不会调用模型。")}</p>
      {modelsReady && <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              try {
                const created = await ai<{ threadId: string } | null>({
                  type: "pick_document",
                });
                if (created) {
                  await refresh();
                  setSelected(created.threadId);
                }
              } finally {
                await localRefresh();
              }
            })
          }
        >{t("选择文档…")}</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(refresh)}>{t("刷新任务")}</Button>
        {!!checked.length && <Button
          disabled={busy}
          onClick={() =>
            run(async () =>
              setConfirmation(
                await ai<Batch>({ type: "prepare_batch", ids: checked }),
              ),
            )
          }
        >{t("批量导入已选任务（{0}）", { 0: checked.length })}</Button>}
      </div>}
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
                      await refresh();
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
      <div className="grid grid-cols-[280px_1fr] gap-5">
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.threadId} className="rounded border p-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  aria-label={t("选择 {0}", { 0: r.fileName })}
                  disabled={busy || r.state !== "COMPLETED"}
                  checked={checked.includes(r.threadId)}
                  onCheckedChange={(checked) =>
                    setChecked((v) =>
                      checked === true
                        ? [...v, r.threadId]
                        : v.filter((id) => id !== r.threadId),
                    )
                  }
                />
                <Button
                  className="min-w-0 flex-1 justify-start truncate"
                  variant={selected === r.threadId ? "secondary" : "ghost"}
                  onClick={() => setSelected(r.threadId)}
                >
                  {r.fileName || r.threadId.slice(0, 8)}
                </Button>
              </div>
              <p className="text-xs">{t("{0} · {1} 题 · {2} 待复核 {3} {4}", { 0: states()[r.state] || r.state, 1: r.questionCount ?? 0, 2: r.reviewCount ?? 0, 3: r.status === "PARTIAL" ? t("· 部分结果") : "", 4: r.importedBankId
                  ? t("· 已导入")
                  : r.previouslyImported
                    ? t("· 曾导入其他版本")
                    : "" })}</p>
            </div>
          ))}
          {modelsReady && !rows.length && error == null && <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("暂无解析任务")}</EmptyTitle>
              <EmptyDescription>{t("选择文档并开始解析后，可在这里查看任务进度。")}</EmptyDescription>
            </EmptyHeader>
          </Empty>}
          {(offset > 0 || more) && <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >{t("上一页")}</Button>
            <Button
              variant="ghost"
              disabled={!more || busy}
              onClick={() => setOffset(offset + 20)}
            >{t("下一页")}</Button>
          </div>}
        </div>
        {task && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <h2 className="font-medium">
                {states()[task.state] || task.state}
              </h2>
              <p className="text-sm">{task.state === "WAITING_REVIEW" ? t("部分内容需要确认，请先查看内容与审核。") : task.state === "FAILED" ? t("解析未完成；已保存的内容保留，可查看原因并重试失败项。") : task.state === "COMPLETED" ? t("解析结果已保存，可预览并导入题库。") : t("当前阶段：{0}", { 0: phaseName(task.phase) })}</p>
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
                      disabled={busy}
                      variant="outline"
                      onClick={() => run(() => control(action))}
                    >
                      {actions()[action] || action}
                    </Button>
                  ))}
                {["COMPLETED", "WAITING_REVIEW"].includes(task.state) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setReview(
                          await ai<Review>({
                            type: "review",
                            id: task.threadId,
                          }),
                        ),
                      )
                    }
                  >{t("查看内容与审核")}</Button>
                )}
                {task.state === "COMPLETED" && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        onPreview(
                          await ai<Preview>({
                            type: "preview",
                            id: task.threadId,
                          }),
                        ),
                      )
                    }
                  >{t("预览并导入题库")}</Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      {batches.length > 0 && (
        <section className="space-y-3">
          <h2>{t("导入批次")}</h2>
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
                {phaseName(f.stage)} #{f.index + 1}：{errorMessage({code:f.code, message:f.message || failureMessage(f.code)})}
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
                {unit.visualElements.map((v, i) => (
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
