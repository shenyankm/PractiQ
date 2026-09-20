import { useEffect, useState } from "react";
import { toast } from "sonner";
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
    groups: { title?: string; instructions?: string }[];
    sourceRef: unknown;
    visualElements: { description: string; imageRef: unknown }[];
  }[];
  failures: Failure[];
  quality: unknown;
  questionSources: unknown[];
};
type PendingOperation = {
  id: string;
  label: string;
  error: { message: string } | null;
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
    error: { message: string } | null;
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
  return invoke("ai_request", { request });
}
const actions: Record<string, string> = {
  pause: "暂停",
  resume: "继续",
  interrupt: "中断",
  retry_failed: "重试失败项",
  accept_partial: "接受部分结果",
};
const states: Record<string, string> = {
  PENDING: "排队中",
  RUNNING: "解析中",
  PAUSING: "正在暂停",
  PAUSED: "已暂停",
  INTERRUPTED: "已中断",
  FAILED: "失败",
  WAITING_REVIEW: "等待审核",
  COMPLETED: "已完成",
  EXPIRED: "已过期",
};
function phaseName(phase: string) {
  return ({ prepare: "准备文档", vision: "识别图片", chunk: "提取题目", document_parse: "提取题目", vision_parse: "识别图片", visual_crop: "整理图片", merge: "整理题目", result: "检查结果", review: "审核内容", vision_review: "审核图片", chunk_review: "审核题目", result_review: "审核结果", completed: "已完成" } as Record<string, string>)[phase] || "处理文档";
}
function failureMessage(code: string) {
  return code === "AI_PROVIDER_AUTH_ERROR" ? "模型鉴权失败，请检查设置中的 API Key，再重试失败项。" : `此项未能完成，请检查配置或重试（${code}）。`;
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
              .catch((e) => toast.error(errorMessage(e)));
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
  const [rows, setRows] = useState<Summary[]>([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [task, setTask] = useState<Task | null>(null),
    [error, setError] = useState(""),
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
    setError("");
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
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [offset, modelsReady]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [o, b] = await Promise.all([
          ai<PendingOperation[]>({ type: "operations" }),
          ai<Batch[]>({ type: "batches" }),
        ]);
        if (active) {
          setOperations(o);
          setBatches(b);
          if (running || b.some((v) => v.status === "running"))
            timer = setTimeout(poll, 1000);
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
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
    setTask(null);
    const poll = async () => {
      try {
        const value = await ai<Task>({ type: "get", id: selected });
        if (active) {
          setTask(value);
          setError("");
          if (activeStates.has(value.state)) timer = setTimeout(poll, 2000);
          else {
            const listing = await ai<{ items: Summary[]; hasMore: boolean }>({
              type: "list",
              offset,
            });
            if (active) {
              setRows(listing.items);
              setMore(listing.hasMore);
            }
          }
        }
      } catch (e) {
        if (active) setError(errorMessage(e));
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
      setError(errorMessage(e));
    } finally {
      setRunning(null);
      await localRefresh().catch((e) => setError(errorMessage(e)));
    }
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        选择文件后会先确认文件与模型，点击“开始解析”才会发送解析内容，可能产生费用。审核和导入已有结果不会调用模型。
      </p>
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
        >
          选择文档…
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => run(refresh)}>
          刷新任务
        </Button>
        {!!checked.length && <Button
          disabled={busy}
          onClick={() =>
            run(async () =>
              setConfirmation(
                await ai<Batch>({ type: "prepare_batch", ids: checked }),
              ),
            )
          }
        >
          批量导入已选任务（{checked.length}）
        </Button>}
      </div>}
      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3"><p className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={busy} onClick={() => run(async () => { try { await (modelsReady ? refresh() : localRefresh()); setError(""); } catch (e) { setError(errorMessage(e)); } })}>重试</Button></div>}
      {operations.length > 0 && (
        <section className="space-y-2">
          <h2>待确认操作</h2>
          <p className="text-sm">
            服务可能已接收请求。重试会使用原请求编号，不会重复创建任务；不会自动重试。
          </p>
          {operations.map((o) => (
            <div key={o.id}>
              {o.label}：{o.error?.message}
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
              >
                重试待确认操作
              </Button>
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
                  aria-label={`选择 ${r.fileName}`}
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
              <p className="text-xs">
                {states[r.state] || r.state} · {r.questionCount ?? 0} 题 ·{" "}
                {r.reviewCount ?? 0} 待复核{" "}
                {r.status === "PARTIAL" ? "· 部分结果" : ""}{" "}
                {r.importedBankId
                  ? "· 已导入"
                  : r.previouslyImported
                    ? "· 曾导入其他版本"
                    : ""}
              </p>
            </div>
          ))}
          {modelsReady && !rows.length && !error && <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无解析任务</EmptyTitle>
              <EmptyDescription>选择文档并开始解析后，可在这里查看任务进度。</EmptyDescription>
            </EmptyHeader>
          </Empty>}
          {(offset > 0 || more) && <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </Button>
            <Button
              variant="ghost"
              disabled={!more || busy}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </Button>
          </div>}
        </div>
        {task && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <h2 className="font-medium">
                {states[task.state] || task.state}
              </h2>
              <p className="text-sm">{task.state === "WAITING_REVIEW" ? "部分内容需要确认，请先查看内容与审核。" : task.state === "FAILED" ? "解析未完成；已保存的内容保留，可查看原因并重试失败项。" : task.state === "COMPLETED" ? "解析结果已保存，可预览并导入题库。" : `当前阶段：${phaseName(task.phase)}`}</p>
              {Object.entries(task.progress).map(([key, p]) => (
                <p className="text-sm" key={key}>
                  {key === "visuals" ? "图片" : "文本"}：完成 {p.succeeded}/
                  {p.total}，失败 {p.failed}
                </p>
              ))}
              <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">模型用量与技术详情</summary><p className="mt-2">阶段：{task.phase}</p><p>
                已记录 {task.usage.length} 次调用；输入{" "}
                {task.usage.reduce((n, u) => n + (u.inputTokens || 0), 0)} /
                输出 {task.usage.reduce((n, u) => n + (u.outputTokens || 0), 0)}{" "}
                tokens；用量未知 {task.unknownUsageCalls.length} 次
              </p></details>
              {task.failures.map((f, i) => (
                <p className="text-sm text-destructive" key={i}>
                  {phaseName(f.stage)} #{f.index + 1}：{f.message || failureMessage(f.code)}
                  {f.retryable ? "（可重试）" : ""}
                </p>
              ))}
              {task.blocking.length > 0 && (
                <details className="text-sm"><summary className="cursor-pointer">需要处理的问题（{task.blocking.length}）</summary><p>请查看来源内容和质量提示，确认后接受部分结果或重试失败项。</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(task.blocking, null, 2)}</pre></details>
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
                      {actions[action] || action}
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
                  >
                    查看内容与审核
                  </Button>
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
                  >
                    预览并导入题库
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      {batches.length > 0 && (
        <section className="space-y-3">
          <h2>导入批次</h2>
          {batches.map((b) => (
            <Card key={b.id}>
              <CardContent className="space-y-2 pt-4">
                <p>
                  {b.items.filter((i) => i.status === "imported").length}/
                  {b.items.length} 已导入 ·{" "}
                  {b.status === "running"
                    ? "进行中"
                    : b.status === "paused"
                      ? "已暂停"
                      : b.status === "ready"
                        ? "待确认"
                        : "已处理"}
                </p>
                {b.items.map((i) => (
                  <p className="text-sm" key={i.threadId}>
                    {i.title}：
                    {i.status === "imported"
                      ? "已导入"
                      : i.status === "failed"
                        ? "失败"
                        : "待导入"}{" "}
                    {i.error?.message}
                  </p>
                ))}
                {b.status === "running" || running === b.id ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void ai({ type: "cancel_batch", id: b.id })
                        .then(localRefresh)
                        .catch((e) => setError(errorMessage(e)));
                    }}
                  >
                    停止后续导入
                  </Button>
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
                      {b.status === "ready" ? "确认批次" : "继续未成功项"}
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
              <DialogTitle>批量导入确认</DialogTitle>
              <DialogDescription>
                每个任务单独新建题库，串行导入；失败只影响该项。重复结果返回已有题库。
              </DialogDescription>
            </DialogHeader>
            {confirmation.items.map((item, index) => (
              <div className="space-y-2" key={item.threadId}>
                <Input
                  aria-label={`题库名称 ${index + 1}`}
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
                <p className="text-sm">
                  {item.questionCount} 题 · {item.reviewCount} 待复核{" "}
                  {item.partial ? "· 部分结果" : ""}{" "}
                  {item.status === "imported" ? "· 已导入，将跳过" : ""}{" "}
                  {item.previousVersion ? "· 新版本将单独建库，保留旧题库" : ""}
                </p>
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
            >
              确认逐项导入
            </Button>
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
              <DialogTitle>只读内容审核</DialogTitle>
              <DialogDescription>
                阶段：{phaseName(review.phase)}。此预览不会接受结果或写入题库。
              </DialogDescription>
            </DialogHeader>
            {review.failures.map((f, i) => (
              <p className="text-destructive" key={i}>
                {phaseName(f.stage)} #{f.index + 1}：{f.message || failureMessage(f.code)}
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
                    label="查看来源内容"
                  />
                )}
                {unit.groups.map((g, i) => (
                  <div key={i}>
                    <Markdown>{g.title}</Markdown>
                    <Markdown>{g.instructions}</Markdown>
                  </div>
                ))}
                <QuestionPreview questions={unit.questions} />
                {unit.visualElements.map((v, i) => (
                  <div key={i}>
                    <Markdown>{v.description}</Markdown>
                    {v.imageRef != null && (
                      <ReadAsset
                        review={review}
                        unit={index}
                        visual={i}
                        label={`查看关联图片 ${i + 1}`}
                      />
                    )}
                  </div>
                ))}
              </section>
            ))}
            <details>
              <summary>来源和质量详情</summary>
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
                >
                  接受部分结果
                </Button>
              )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
