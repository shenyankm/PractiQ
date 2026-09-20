import { QuestionPreview } from "./QuestionPreview";
import { StudySetup } from "./StudySetup";
import { ImportPage } from "./ImportPage";
import logo from "../../server/assets/logo/practiq-octopus-a5.png";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen,
  Upload,
  Plus,
  Star,
  History,
  Settings,
  Search,
  ArrowLeft,
  Play,
  Trash2,
  Pencil,
  ChevronRight,
  BookmarkX,
  EllipsisVertical,
} from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  api,
  date,
  duration,
  errorMessage,
  modeNames,
  type Bank,
  type Preview,
  type Question,
  type QuestionRow,
  type Session,
  type SessionSummary,
} from "./api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Toaster } from "@/components/ui/sonner";
import { Content } from "./Content";
import { AnswerDisplay, AnswerInput } from "./AnswerInput";
import { QuestionEditor, blankQuestion } from "./QuestionEditor";
import { Practice } from "./Practice";
import { ConnectionSettingsPanel } from "./ConnectionSettings";

type Page =
  | "banks"
  | "questions"
  | "wrong"
  | "favorite"
  | "history"
  | "import"
  | "settings"
  | "practice";
export default function App() {
  const [page, setPage] = useState<Page>("banks");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bank, setBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importTitle, setImportTitle] = useState("");
  const [importBank, setImportBank] = useState("new");
  const [bankEditor, setBankEditor] = useState<{
    id: string | null;
    title: string;
    description: string;
  } | null>(null);
  const [editor, setEditor] = useState<{
    id: string | null;
    question: Question;
  } | null>(null);
  const [detail, setDetail] = useState<QuestionRow | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
  } | null>(null);
  const [practiceSetup, setPracticeSetup] = useState<{ bank: string | null } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [mergeTitle,setMergeTitle]=useState("");
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [settingsReturn, setSettingsReturn] = useState<{ bank: string | null } | null>(null);
  const [info, setInfo] = useState<{
    dataDirectory: string;
    version: string;
  } | null>(null);
  const [offset, setOffset] = useState(0);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const lock = useRef(false);
  const filter =
    page === "wrong" ? "wrong" : page === "favorite" ? "favorite" : "";
  const query = {
    bank_id: page === "questions" ? bank : null,
    search,
    mode,
    filter,
  };
  const currentBank = banks.find((b) => b.id === bank);
  const run = useCallback((job: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    void job()
      .catch((e) => {
        const message = errorMessage(e);
        toast.error(message, { id: message });
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }, []);
  const reload = async () => {
    setBanks(await api<Bank[]>({ type: "banks" }));
    setSessions(await api<SessionSummary[]>({ type: "sessions" }));
  };
  useEffect(() => {
    run(async () => {
      await reload();
      setInfo(await api({ type: "info" }));
    });
  }, [run]);
  useEffect(() => {
    if (!["questions", "wrong", "favorite"].includes(page)) return;
    let active = true;
    setLoading(true);
    setOffset(0);
    const timer = setTimeout(() => {
      void api<QuestionRow[]>({ type: "questions", ...query })
        .then((rows) => {
          if (active) setQuestions(rows);
        })
        .catch((e) => {
          if (active) {
            const message = errorMessage(e);
            toast.error(message, { id: message });
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [page, bank, search, mode]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (lock.current) {
          toast.info("请等待当前操作完成后关闭");
          return;
        }
        try {
          await flushRef.current();
          await getCurrentWindow().destroy();
        } catch (e) {
          toast.error(errorMessage(e));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  function navigate(next: Page, bankId: string | null = null) {
    run(async () => {
      await flushRef.current();
      flushRef.current = async () => {};
      if (next !== "settings") setSettingsReturn(null);
      setPage(next);
      setBank(bankId);
      setDetail(null);
      setSearch("");
      setMode("");
      await reload();
    });
  }
  function openSession(id: string) {
    run(async () => {
      await flushRef.current();
      setSession(await api<Session>({ type: "session", id }));
      setPage("practice");
    });
  }
  const unfinished = sessions.find(s => !s.finishedAt && !s.submittedAt);
  async function refreshQuestions() {
    setQuestions(await api<QuestionRow[]>({ type: "questions", ...query }));
    await reload();
  }
  async function pickImport() {
    const p = await api<Preview | null>({ type: "pick_import" });
    if (p) {
      setPreview(p);
      setImportTitle(p.title);
      setImportBank(bank || "new");
    }
  }
  const heading =
    page === "import" ? "导入题库" : page === "banks"
      ? "我的题库"
      : page === "questions"
        ? currentBank?.title || "题库"
        : page === "wrong"
          ? "错题本"
          : page === "favorite"
            ? "收藏夹"
            : page === "history"
              ? "练习记录"
              : page === "practice"
                ? "专注练习"
                : "设置";
  const listPage = ["questions", "wrong", "favorite"].includes(page);
  return (
    <div className="flex h-screen min-w-[960px] overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/25 p-4">
        <div className="mb-10 flex items-center gap-3 px-3 pt-3">
          <img
            src={logo}
            alt="PractiQ 小章鱼"
            className="size-10 shrink-0 rounded-xl object-contain"
          />
          <div>
            <div className="text-lg font-semibold tracking-tight">PractiQ</div>
            <div className="text-xs text-muted-foreground">
              一点练习，每天进步
            </div>
          </div>
        </div>
        <nav aria-label="主导航" className="space-y-2">
          {(
            [
              { id: "banks", label: "我的题库", icon: BookOpen },
              { id: "import", label: "导入题库", icon: Upload },
              { id: "wrong", label: "错题本", icon: BookmarkX },
              { id: "favorite", label: "收藏夹", icon: Star },
              { id: "history", label: "练习记录", icon: History },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              className="w-full justify-start gap-3 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary"
              variant={
                page === id || (id === "banks" && page === "questions")
                  ? "secondary"
                  : "ghost"
              }
              aria-current={page === id || (id === "banks" && page === "questions") ? "page" : undefined}
              disabled={busy}
              onClick={() => navigate(id)}
            >
              <Icon />
              {label}
            </Button>
          ))}
        </nav>
        <div className="mt-auto space-y-4">
          <Button
            className="w-full justify-start gap-3 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary"
            variant={page === "settings" ? "secondary" : "ghost"}
            aria-current={page === "settings" ? "page" : undefined}
            disabled={busy}
            onClick={() => { setSettingsReturn(null); navigate("settings"); }}
          >
            <Settings />
            设置
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-24 shrink-0 items-center justify-between gap-4 border-b px-8">
          <div className="flex items-center gap-3">
            {page === "questions" && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="返回题库"
                disabled={busy}
                onClick={() => navigate("banks")}
              >
                <ArrowLeft />
              </Button>
            )}
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {heading}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {page === "banks"
                  ? `${banks.length} 个题库 · ${banks.reduce((n, b) => n + b.count, 0)} 道题目`
                  : listPage
                    ? `${questions.length} 道题目${loading ? " · 加载中…" : ""}`
                    : page === "import"
                      ? "导入已有题库，或将文档解析为题目"
                    : page === "history"
                      ? "回顾每一次作答与进步"
                      : page === "settings"
                        ? "管理本地数据，保存你的练习成果"
                        : "循序渐进，保持专注"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy && (
              <span role="status" className="text-sm text-muted-foreground">
                处理中…
              </span>
            )}

            {page === "banks" && banks.length > 1 && (
              <Button variant="outline" disabled={busy} onClick={() => setMergeOpen(true)}>
                合并题库
              </Button>
            )}
            {listPage && (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => navigate("import", page === "questions" ? bank : null)}
                >
                  <Upload />
                  导入
                </Button>
                {page === "questions" && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setEditor({ id: null, question: blankQuestion() })
                    }
                  >
                    <Plus />
                    新增题目
                  </Button>
                )}
                <Button
                  disabled={busy || !questions.length || loading}
                  onClick={() => {
                    setPracticeSetup({ bank: page === "questions" ? bank : null });
                  }}
                >
                  <Play />
                  开始练习
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-8">
          {page === "banks" && (
            <div className="space-y-5">
              {unfinished && <Card className="border-primary/30 bg-primary/5"><CardContent className="flex items-center justify-between gap-4"><div className="min-w-0"><h2 className="font-semibold">继续未完成的练习</h2><p className="mt-1 break-words text-sm text-muted-foreground">{unfinished.title} · 已提交 {unfinished.answered}/{unfinished.count} 题</p></div><Button disabled={busy} onClick={() => openSession(unfinished.id)}><Play />继续练习</Button></CardContent></Card>}
              {!banks.length && !busy && info && <Empty className="min-h-96 border border-dashed"><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>从第一份题库开始</EmptyTitle><EmptyDescription>已有 PractiQ JSON 可离线导入；PDF、文本或图片可通过 AI 解析为题目。</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => navigate("import")}><Upload />导入第一份题库</Button></EmptyContent></Empty>}
              <div className="grid grid-cols-2 gap-5 xl:grid-cols-3">
              {banks.map((b) => (
                <Card key={b.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="min-w-0 break-words pt-1">{b.title}</CardTitle>
                      <div className="flex shrink-0 items-center gap-1">
                        <Badge variant="secondary">{b.count} 题</Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" aria-label={`题库操作 ${b.title}`} disabled={busy}>
                              <EllipsisVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setBankEditor({ id: b.id, title: b.title, description: b.description })}>
                              <Pencil className="size-4" />编辑题库
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({
                              title: `删除“${b.title}”？`,
                              description: "题库及其中题目将被删除，已有练习记录和内容快照会保留。",
                              action: async () => {
                                await api({ type: "delete_bank", id: b.id });
                                await reload();
                              },
                            })}>
                              <Trash2 className="size-4" />删除题库
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <CardDescription className="line-clamp-2 min-h-10">
                      {b.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto grid grid-cols-2 gap-2">
                    <Button variant="outline" disabled={busy} onClick={() => navigate("questions", b.id)}>
                      查看题目
                      <ChevronRight />
                    </Button>
                    {b.count ? <Button disabled={busy} onClick={() => setPracticeSetup({ bank: b.id })}><Play />开始练习</Button>
                      : <Button disabled={busy} onClick={() => navigate("import", b.id)}><Upload />导入题目</Button>}
                  </CardContent>
                </Card>
              ))}
              </div>
            </div>
          )}
          {listPage && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <InputGroup className="flex-1">
                  <InputGroupAddon><Search /></InputGroupAddon>
                  <InputGroupInput
                    aria-label="搜索题目"
                    placeholder="搜索题干、选项或内容…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </InputGroup>
                <Select
                  value={mode || "all"}
                  onValueChange={(v) => setMode(v === "all" ? "" : v)}
                >
                  <SelectTrigger className="w-40" aria-label="筛选题型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部题型</SelectItem>
                    <SelectItem value="single">单选题</SelectItem>
                    <SelectItem value="multiple">多选题</SelectItem>
                    {Object.entries(modeNames).map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {questions.length ? (
                <>
                  <div className="divide-y rounded-xl border">
                    {questions.slice(offset, offset + 30).map((row, i) => (
                      <div key={row.id} className="flex min-h-20 items-center gap-4 p-4">
                        <span className="w-8 shrink-0 text-sm text-muted-foreground">
                          {offset + i + 1}
                        </span>
                        <button
                          className="grid min-w-0 flex-1 grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => setDetail(row)}
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {modeNames[row.question.answerMode || ""] ||
                                "未知题型"}
                            </Badge>
                            {row.question.needsReview && (
                              <Badge variant="secondary">待复核</Badge>
                            )}
                            {row.latestResult === false && (
                              <Badge variant="destructive">错题</Badge>
                            )}
                            {page !== "questions" && (
                              <span className="w-full truncate text-xs text-muted-foreground" title={row.bankTitle}>
                                {row.bankTitle}
                              </span>
                            )}
                          </div>
                          <p className="line-clamp-2 min-w-0 text-sm leading-6 wrap-anywhere">
                            {row.question.stem ||
                              row.question.sourceText ||
                              "题干缺失"}
                          </p>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={row.favorite ? "取消收藏" : "收藏题目"}
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api({
                                type: "favorite",
                                id: row.id,
                                value: !row.favorite,
                              });
                              await refreshQuestions();
                            })
                          }
                        >
                          <Star
                            className={row.favorite ? "fill-current" : ""}
                          />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="编辑题目"
                          disabled={busy}
                          onClick={() => {
                            setBank(row.bankId);
                            setEditor({ id: row.id, question: row.question });
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="删除题目"
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              title: "删除这道题目？",
                              description: "历史练习与作答快照仍会保留。",
                              action: async () => {
                                await api({
                                  type: "delete_question",
                                  id: row.id,
                                });
                                await refreshQuestions();
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      第 {offset + 1}–{Math.min(offset + 30, questions.length)}{" "}
                      题
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 30))}
                      >
                        上一页
                      </Button>
                      <Button
                        variant="outline"
                        disabled={offset + 30 >= questions.length}
                        onClick={() => setOffset(offset + 30)}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                !loading && (
                  <Empty className="min-h-96 border border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">{page === "favorite" ? <Star /> : <BookOpen />}</EmptyMedia>
                      <EmptyTitle>{page === "wrong" ? "暂时没有错题" : page === "favorite" ? "还没有收藏题目" : "没有找到题目"}</EmptyTitle>
                      <EmptyDescription>{page === "wrong" ? "已判定为错误的题目会出现在这里，再次答对后自动移出。" : "尝试调整筛选，或导入新的题目。"}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )
              )}
            </div>
          )}
          {page === "history" &&
            (sessions.length ? (
              <div className="space-y-3">
                {sessions.map((s) => (
                  <Card key={s.id} className="py-3">
                    <CardContent className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h2 className="min-w-0 break-words font-medium">{s.title}</h2>
                          <Badge variant="secondary">
                            {s.finishedAt ? "已结束" : s.submittedAt ? "待核对" : "进行中"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {date(s.createdAt)} · {duration(s.elapsedMs)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-sm tabular-nums">
                          <span>已提交 {s.answered}/{s.count} 题</span>
                          {!!(s.finishedAt || s.submittedAt) && (s.kind && s.kind !== "practice" ? <>
                            <Badge variant="secondary">{s.pendingGrades ? "暂定成绩" : "成绩"} {(s.earnedCents || 0) / 100} / {(s.totalCents || 0) / 100} 分</Badge>
                            {!!s.pendingGrades && <Badge variant="outline">待评分 {s.pendingGrades} 题</Badge>}
                          </> : <span>正确率 {s.graded ? `${Math.round((s.correct / s.graded) * 100)}%（${s.correct}/${s.graded}）` : "暂无已判定题目"}</span>)}
                        </div>
                        {!!(s.answered || s.finishedAt || s.submittedAt) && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">判定详情</summary><p className="mt-2">自动判定 {s.autoGraded} · 自评 {s.selfGraded} · 跳过 {s.skipped} · 未判定 {s.kind && s.kind !== "practice" ? s.pendingGrades : s.answered - s.graded - s.skipped}</p></details>}
                      </div>
                      <Button
                        className="shrink-0"
                        variant="outline"
                        disabled={busy}
                        onClick={() => openSession(s.id)}
                      >
                        {s.finishedAt ? "查看记录" : s.submittedAt ? "核对评分" : "继续练习"}
                        <ChevronRight />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Empty className="min-h-96 border border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><History /></EmptyMedia>
                  <EmptyTitle>还没有练习记录</EmptyTitle>
                  <EmptyDescription>完成一次练习后，即可在这里回顾答案、用时与正确率。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ))}
          {page === "practice" && session && (
            <Practice
              key={`${session.id}-${session.position}`}
              session={session}
              onSession={(s) => {
                setSession(s);
                if (s.finishedAt && !session.finishedAt)
                  toast.success("练习已结束，记录已保存");
              }}
              run={run}
              flushRef={flushRef}
            />
          )}
          {page === "import" && <ImportPage busy={busy} run={run} onPickJson={pickImport} onPreview={p=>{setPreview(p);setImportTitle(p.title);setImportBank(bank || "new");}} onConfigure={() => { setSettingsReturn({ bank }); navigate("settings"); }} />}
          {page === "settings" && (
            <div className="max-w-3xl space-y-6">
              <ConnectionSettingsPanel
                key={settingsRevision}
                busy={busy}
                run={run}
                returnToImport={!!settingsReturn}
                onSaved={async () => {
                  if (settingsReturn) {
                    await reload();
                    setBank(settingsReturn.bank);
                    setSettingsReturn(null);
                    setPage("import");
                  }
                }}
              />
              <Card>
                <CardHeader>
                  <CardTitle>学习数据备份</CardTitle>
                  <CardDescription>
                    包含题库、图片、收藏、作答和评分记录。不包含原始文档、AI 任务及 API Key；在其他设备恢复后需重新配置密钥。请定期保存到其他位置。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex gap-3">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const result = await api<{ path: string } | null>({
                          type: "backup",
                        });
                        if (result) toast.success(`备份已保存：${result.path}`);
                      })
                    }
                  >
                    <Upload />
                    导出备份
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        title: "用备份替换当前数据？",
                        description:
                          "恢复会替换全部本地题库和练习记录。应用将先校验备份，并自动保存当前数据的恢复副本。",
                        action: async () => {
                          const result = await api<{
                            recoveryPath: string;
                          } | null>({ type: "restore" });
                          if (result) {
                            setSettingsRevision((v) => v + 1);
                            setSession(null);
                            setDetail(null);
                            setBank(null);
                            await reload();
                            toast.success(
                              `恢复完成。原数据副本：${result.recoveryPath}`,
                            );
                          }
                        },
                      })
                    }
                  >
                    恢复备份
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>本地数据</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p>版本：{info?.version || "—"}</p>
                  <p className="break-all">
                    保存位置：{info?.dataDirectory || "—"}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </main>
      <Dialog open={mergeOpen} onOpenChange={(open) => { if (!busy) setMergeOpen(open); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>合并题库</DialogTitle>
            <DialogDescription>选择至少两个题库，复制合并为新题库。保留原库和重复题，不继承作答历史。</DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">选择题库</legend>
              <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto">
                {banks.map((b) => (
                  <label key={b.id} className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                    <Checkbox disabled={busy} className="mt-0.5" checked={mergeSelection.includes(b.id)} onCheckedChange={(checked) => setMergeSelection(checked === true ? [...mergeSelection, b.id] : mergeSelection.filter(id => id !== b.id))} />
                    <span className="min-w-0 break-words">{b.title}（{b.count} 题）</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="merge-title">新题库名称</Label>
              <Input id="merge-title" aria-label="合并后的题库名称" placeholder="输入新题库名称" value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} />
            </div>
            <p className="text-sm text-muted-foreground" role="status">已选 {mergeSelection.length} 个题库，共 {banks.filter(b => mergeSelection.includes(b.id)).reduce((n, b) => n + b.count, 0)} 题；原库保留。</p>
          </fieldset>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setMergeOpen(false)}>取消</Button>
            <Button disabled={busy || mergeSelection.length < 2 || !mergeTitle.trim()} onClick={() => run(async () => {
              await api({ type: "merge_banks", bank_ids: mergeSelection, title: mergeTitle.trim() });
              setMergeSelection([]);
              setMergeTitle("");
              setMergeOpen(false);
              await reload();
              toast.success("合并完成");
            })}>确认合并</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {preview && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v && !busy) setPreview(null);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>导入题库</DialogTitle>
              <DialogDescription>
                已识别 {preview.count} 道题目，其中 {preview.reviewCount}{" "}
                道待复核，仍可直接练习。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <QuestionPreview questions={preview.questions ?? []} />
              <Label htmlFor="import-bank">导入到</Label>
              <Select value={importBank} onValueChange={setImportBank}>
                <SelectTrigger id="import-bank" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">新建题库</SelectItem>
                  {banks.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {importBank === "new" && (
                <Input
                  aria-label="题库名称"
                  value={importTitle}
                  onChange={(e) => setImportTitle(e.target.value)}
                />
              )}
              <div className="rounded-lg border p-4 text-sm">
                <p>
                  已加载 {preview.assetCount} 张图片，缺失{" "}
                  {preview.missingAssets.length} 个资源。
                </p>
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const p = await api<Preview | null>({
                        type: "pick_resources",
                      });
                      if (p) setPreview(p);
                    })
                  }
                >
                  选择图片资源根目录
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  选择包含 practiq-agent
                  文件夹的目录。未提供图片也可导入，练习时会提示缺失。
                </p>
              </div>
              {preview.status === "PARTIAL" && (
                <p className="text-sm">
                  这是部分解析结果，可能未包含原文的全部题目。
                </p>
              )}
              {preview.warnings.map((w, i) => (
                <p key={i} className="text-sm text-muted-foreground">
                  {w}
                </p>
              ))}
              {preview.missingAssets.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary>缺失资源详情</summary>
                  {preview.missingAssets.map((m, i) => (
                    <p className="mt-2 break-all" key={i}>
                      {m}
                    </p>
                  ))}
                </details>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                取消
              </Button>
              <Button
                disabled={busy || !importTitle.trim()}
                onClick={() =>
                  run(async () => {
                    const result = await api<{
                      duplicate: boolean;
                      bankId: string;
                      count: number;
                    }>({
                      type: "import",
                      ticket: preview.ticket,
                      bank_id: importBank === "new" ? null : importBank,
                      title: importTitle,
                    });
                    setPreview(null);
                    await reload();
                    setBank(result.bankId);
                    setSearch("");
                    setMode("");
                    setPage("questions");
                    setQuestions(
                      await api({
                        type: "questions",
                        bank_id: result.bankId,
                        search: "",
                        mode: "",
                        filter: "",
                      }),
                    );
                    toast.success(
                      result.duplicate
                        ? "此题库已导入相同内容，本次已跳过"
                        : `已导入 ${result.count} 道题目`,
                    );
                  })
                }
              >
                确认导入
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {bankEditor && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v && !busy) setBankEditor(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑题库</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Label htmlFor="bankTitle">题库名称</Label>
              <Input
                id="bankTitle"
                value={bankEditor.title}
                onChange={(e) =>
                  setBankEditor({ ...bankEditor, title: e.target.value })
                }
              />
              <Label htmlFor="description">说明</Label>
              <Textarea
                id="description"
                value={bankEditor.description}
                onChange={(e) =>
                  setBankEditor({ ...bankEditor, description: e.target.value })
                }
              />
            </div>
            <DialogFooter>
              <Button
                disabled={busy || !bankEditor.title.trim()}
                onClick={() =>
                  run(async () => {
                    await api({ type: "save_bank", ...bankEditor });
                    setBankEditor(null);
                    await reload();
                  })
                }
              >
                保存题库
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {editor && bank && (
        <QuestionEditor
          initial={editor.question}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={(q) =>
            run(async () => {
              await api({
                type: "save_question",
                id: editor.id,
                bank_id: bank,
                question: q,
              });
              setEditor(null);
              await refreshQuestions();
              toast.success("题目已保存，历史练习不受影响");
            })
          }
        />
      )}
      {detail && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setDetail(null);
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>题目详情</DialogTitle>
            </DialogHeader>
            <Content snapshot={detail} source />
            <AnswerInput
              question={detail.question}
              value={detail.question.answerPayload}
              onChange={() => {}}
              disabled
              prefix="detail-answer"
            />
            <div className="mt-4 space-y-4 border-t pt-4">
              <h3 className="font-medium">参考答案</h3>
              <AnswerDisplay
                answer={detail.question.answerPayload}
                question={detail.question}
              />
              <h3 className="font-medium">解析</h3>
              <p className="whitespace-pre-wrap text-sm">
                {detail.question.analysis || "原文未提供解析。"}
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {practiceSetup && <StudySetup banks={banks} initialBank={practiceSetup.bank} initialFilter={filter} initialMode={mode} initialSearch={search} busy={busy} run={run} onClose={()=>setPracticeSetup(null)} onStart={async s=>{await flushRef.current();setSession(s);setPracticeSetup(null);setPage("practice");}}/>}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) {
                  const action = confirm.action;
                  setConfirm(null);
                  run(action);
                }
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
