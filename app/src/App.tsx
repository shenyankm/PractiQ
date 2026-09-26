import { questionKinds } from "./english";
import type { ImportTaskContext } from "./ai-api";
import { date, duration, message, renderMessage, type Message, t, useI18n } from "./i18n";
import { useTheme } from "./theme";
import logo from "../src-tauri/icons/icon.png";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Tooltip } from "radix-ui";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen,
  Upload,
  Plus,
  Star,
  History,
  Settings,
  Languages,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  CircleAlert,
  Search,
  ArrowLeft,
  Play,
  Trash2,
  Pencil,
  ChevronRight,
  BookmarkX,
} from "lucide-react";
import { toast } from "./notifications";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  api,
  blankQuestion,
  errorMessage,
  modeNames,
  type BankChoice,
  type SessionPage,
  type Preview,
  type Question,
  type QuestionRow,
  type Session,
} from "./api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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

const QuestionPreview = lazy(() => import("./QuestionPreview").then(module => ({default:module.QuestionPreview})));
const StudySetup = lazy(() => import("./StudySetup").then(module => ({default:module.StudySetup})));
const ImportPage = lazy(() => import("./ImportPage").then(module => ({default:module.ImportPage})));
const Content = lazy(() => import("./Content").then(module => ({default:module.Content})));
const AnswerDisplay = lazy(() => import("./AnswerInput").then(module => ({default:module.AnswerDisplay})));
const AnswerInput = lazy(() => import("./AnswerInput").then(module => ({default:module.AnswerInput})));
const QuestionEditor = lazy(() => import("./QuestionEditor").then(module => ({default:module.QuestionEditor})));
const Practice = lazy(() => import("./Practice").then(module => ({default:module.Practice})));
const ConnectionSettingsPanel = lazy(() => import("./ConnectionSettings").then(module => ({default:module.ConnectionSettingsPanel})));
const ImportBankDialog = lazy(() => import("./ImportBankDialog").then(module => ({default:module.ImportBankDialog})));
const SettingsPage = lazy(() => import("./SettingsPage").then(module => ({default:module.SettingsPage})));
const BankList = lazy(() => import("./BankList").then(module => ({default:module.BankList})));

type Page =
  | "banks"
  | "questions"
  | "wrong"
  | "favorite"
  | "history"
  | "import"
  | "settings"
  | "model-settings"
  | "practice";
function SidebarButton({ collapsed, label, children, className = "", ...props }: ComponentProps<typeof Button> & { collapsed: boolean; label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button variant="ghost" aria-label={label} className={`w-full justify-start gap-3 overflow-hidden px-3.5 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary ${className}`} {...props}>
          {children}<span aria-hidden={collapsed} className="sidebar-label shrink-0">{label}</span>
        </Button>
      </Tooltip.Trigger>
      {collapsed && <Tooltip.Portal><Tooltip.Content side="right" sideOffset={8} className="z-50 rounded-md bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md ring-1 ring-border">{label}</Tooltip.Content></Tooltip.Portal>}
    </Tooltip.Root>
  );
}
export default function App() {
  const language = useI18n();
  const theme = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const themeTrigger = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageTrigger = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<Page>("banks");
  const [banks, setBanks] = useState<BankChoice[]>([]);
  const [bank, setBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [questionTotal, setQuestionTotal] = useState(0);
  const [sessionPage, setSessionPage] = useState<SessionPage>({ items: [], total: 0, offset: 0 });
  const [bankOffset, setBankOffset] = useState(0);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importPreview, setImportPreview] = useState<{ preview: Preview; initialBank: string; task?: ImportTaskContext } | null>(null);
  const [bankEditor, setBankEditor] = useState<{
    id: string | null;
    title: string;
    description: string;
  } | null>(null);
  const [editor, setEditor] = useState<{
    id: string | null;
    question: Question;
    children?: Question[];
  } | null>(null);
  const [detail, setDetail] = useState<QuestionRow | null>(null);
  const [confirm, setConfirm] = useState<{
    title: Message;
    description: Message;
    action: () => Promise<void>;
  } | null>(null);
  const [practiceSetup, setPracticeSetup] = useState<{ bank: string | null } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const mergeTrigger = useRef<HTMLButtonElement>(null);
  function closeMerge() {
    setMergeOpen(false);
    setMergeSelection([]);
    setMergeTitle("");
  }
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
        toast.error(e);
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }, []);
  const reloadBanks = async () => {
    setBanks(await api({ type: "banks" }));
    setListRevision(v => v + 1);
  };
  useEffect(() => {
    run(async () => {
      await Promise.all([
        api({ type: "banks" }).then(setBanks),
        api({ type: "info" }).then(setInfo),
      ]);
    });
  }, [run]);
  useEffect(() => {
    if (page !== "history") return;
    let active = true;
    setSummaryLoading(true);
    setSummaryError(null);
    const request = api({ type: "sessions_page", limit: 30, offset: sessionOffset })
      .then(result => { if (active) { setSessionPage(result); setSessionOffset(result.offset); } });
    void request.catch(error => { if (active) setSummaryError(error); })
      .finally(() => { if (active) setSummaryLoading(false); });
    return () => { active = false; };
  }, [page, sessionOffset, listRevision]);
  useEffect(() => { setOffset(0); }, [page, bank, search, mode]);
  useEffect(() => {
    if (!["questions", "wrong", "favorite"].includes(page)) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api({ type: "questions_page", bank_id: page === "questions" ? bank : null, search, mode, filter, limit: 30, offset })
        .then((rows) => {
          if (active) { setQuestions(rows.items); setQuestionTotal(rows.total); setOffset(rows.offset); }
        })
        .catch((e) => {
          if (active) {
            toast.error(e);
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
  }, [page, bank, search, mode, filter, offset]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (lock.current) {
          toast.info(message("请等待当前操作完成后关闭"));
          return;
        }
        try {
          await flushRef.current();
          await getCurrentWindow().destroy();
        } catch (e) {
          toast.error(e);
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
      if (next !== "model-settings") setSettingsReturn(null);
      setPage(next);
      setBank(bankId);
      setDetail(null);
      setSearch("");
      setMode("");
      if (next === "banks" || next === "history") setListRevision(v => v + 1);
    });
  }
  function openSession(id: string) {
    run(async () => {
      await flushRef.current();
      setSession(await api({ type: "session", id }));
      setPage("practice");
    });
  }
  async function refreshQuestions() {
    const result = await api({ type: "questions_page", ...query, limit: 30, offset });
    setQuestions(result.items); setQuestionTotal(result.total); setOffset(result.offset);
  }
  async function pickImport() {
    const p = await api({ type: "pick_import" });
    if (p) setImportPreview({ preview: p, initialBank: "new" });
  }
  const heading =
    page === "import" ? t("导入题库") : page === "banks"
      ? t("我的题库")
      : page === "questions"
        ? currentBank?.title || t("题库")
        : page === "wrong"
          ? t("错题本")
          : page === "favorite"
            ? t("收藏夹")
            : page === "history"
              ? t("练习记录")
              : page === "practice"
                ? t("专注练习")
                : page === "model-settings" ? t("AI 模型") : t("设置");
  const loadingView = <p role="status" className="p-4 text-sm text-muted-foreground">{t("加载中…")}</p>;
  const listPage = ["questions", "wrong", "favorite"].includes(page);
  const languageError = language.error != null && <div role="alert" className="text-xs text-destructive"><p>{t(language.error.key)}</p><p>{errorMessage(language.error.cause)}</p><Button size="sm" variant="outline" onClick={() => void language.reload()}>{t("重试")}</Button></div>;
  return (
    <div className="flex h-screen min-w-[960px] overflow-hidden bg-background text-foreground">
      <Tooltip.Provider delayDuration={200}>
      <aside id="app-sidebar" className={`flex shrink-0 flex-col border-r bg-muted/25 px-2 py-4 transition-[width] duration-200 ease-in-out motion-reduce:transition-none ${sidebarCollapsed ? "w-16" : "w-44"}`}>
        <div className="mb-4 flex items-center gap-2 overflow-hidden px-1 pt-3">
          <Button variant="ghost" size="icon" className="group relative size-10 shrink-0 rounded-xl" aria-label={sidebarCollapsed ? t("展开侧边栏") : t("收起侧边栏")} aria-expanded={!sidebarCollapsed} aria-controls="app-sidebar" onClick={() => setSidebarCollapsed(value => !value)}>
            <img src={logo} alt="" className="size-10 rounded-xl object-contain group-hover:opacity-0 group-focus-visible:opacity-0" />
            <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</span>
          </Button>
          <div aria-hidden={sidebarCollapsed} className="sidebar-label shrink-0">
            <div className="text-lg font-semibold tracking-tight">PractiQ</div>
          </div>
        </div>
        <nav aria-label={t("主导航")} className="space-y-2">
          {(
            [
              { id: "banks", label: t("我的题库"), icon: BookOpen },
              { id: "import", label: t("导入题库"), icon: Upload },
              { id: "wrong", label: t("错题本"), icon: BookmarkX },
              { id: "favorite", label: t("收藏夹"), icon: Star },
              { id: "history", label: t("练习记录"), icon: History },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <SidebarButton
              key={id}
              collapsed={sidebarCollapsed}
              label={label}
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
            </SidebarButton>
          ))}
        </nav>
        <div className="mt-auto space-y-4">
          <div className="space-y-2">
            <DropdownMenu open={themeOpen} onOpenChange={setThemeOpen}>
              <DropdownMenuTrigger asChild>
                <SidebarButton ref={themeTrigger} collapsed={sidebarCollapsed} label={t("主题")} className={theme.error ? "text-destructive" : ""}>
                  {theme.error ? <CircleAlert /> : <Palette />}
                </SidebarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-40" aria-label={t("主题")} onCloseAutoFocus={event => { event.preventDefault(); themeTrigger.current?.focus(); }}>
                <DropdownMenuRadioGroup value={theme.theme}>
                  {([{ value: "system", label: "跟随系统" }, { value: "light", label: "白天" }, { value: "dark", label: "黑夜" }] as const).map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value} onSelect={event => { event.preventDefault(); if (theme.change(value)) setThemeOpen(false); }}>{t(label)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {theme.error != null && <div role="alert" className="p-2 text-xs text-destructive"><p>{t("主题设置失败，请重试")}</p><p>{errorMessage(theme.error)}</p></div>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="space-y-2">
            <DropdownMenu open={languageOpen} onOpenChange={open => { if (!language.saving) setLanguageOpen(open); }}>
              <DropdownMenuTrigger asChild>
                <SidebarButton ref={languageTrigger} collapsed={sidebarCollapsed} label={t("语言")} className={language.error ? "text-destructive" : ""}>
                  {language.error ? <CircleAlert /> : <Languages />}
                </SidebarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-40" aria-label={t("语言")} onCloseAutoFocus={event => { event.preventDefault(); languageTrigger.current?.focus(); }}>
                <DropdownMenuRadioGroup value={language.locale}>
                  {(["zh-CN", "en"] as const).map(value => <DropdownMenuRadioItem key={value} value={value} disabled={!language.ready || language.saving || busy} onSelect={event => { event.preventDefault(); void language.change(value).then(saved => { if (saved) setLanguageOpen(false); }); }}>{value === "zh-CN" ? "简体中文" : "English"}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {languageError}
              </DropdownMenuContent>
            </DropdownMenu>
            {!languageOpen && (sidebarCollapsed ? language.error && <p role="alert" className="sr-only">{t(language.error.key)}</p> : languageError)}
          </div>
          <SidebarButton
            collapsed={sidebarCollapsed}
            label={t("设置")}
            variant={page === "settings" || page === "model-settings" ? "secondary" : "ghost"}
            aria-current={page === "settings" || page === "model-settings" ? "page" : undefined}
            disabled={busy}
            onClick={() => { setSettingsReturn(null); navigate("settings"); }}
          >
            <Settings /></SidebarButton>
        </div>
      </aside>
      </Tooltip.Provider>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-24 shrink-0 items-center justify-between gap-4 border-b px-8">
          <div className="flex items-center gap-3">
            {page === "questions" && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("返回题库")}
                disabled={busy}
                onClick={() => navigate("banks")}
              >
                <ArrowLeft />
              </Button>
            )}
            {page === "model-settings" && (
              <Button size="icon" variant="ghost" disabled={busy} aria-label={settingsReturn ? t("返回导入") : t("返回设置")} onClick={() => navigate(settingsReturn ? "import" : "settings", settingsReturn?.bank ?? null)}>
                <ArrowLeft />
              </Button>
            )}
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {heading}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {page === "banks"
                  ? t("{0} 个题库 · {1} 道题目", { 0: banks.length, 1: banks.reduce((n, b) => n + b.count, 0) })
                  : listPage
                    ? t("{0} 道题目{1}", { 0: questionTotal, 1: loading ? t(" · 加载中…") : "" })
                    : page === "import"
                      ? t("将文档解析为题目")
                    : page === "history"
                      ? t("回顾每一次作答与进步")
                      : page === "settings"
                        ? t("管理模型配置与本地学习数据")
                        : page === "model-settings"
                          ? t("用于文档解析与主观题评分")
                        : t("循序渐进，保持专注")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy && (
              <span role="status" className="text-sm text-muted-foreground">{t("处理中…")}</span>
            )}

            {page === "banks" && banks.length > 1 && (
              <Button ref={mergeTrigger} variant="outline" disabled={busy} onClick={() => setMergeOpen(true)}>{t("合并题库")}</Button>
            )}
            {listPage && (
              <>
                {page !== "favorite" && <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => navigate("import", page === "questions" ? bank : null)}
                >
                  <Upload />{t("导入")}</Button>}
                {page === "questions" && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setEditor({ id: null, question: blankQuestion() })
                    }
                  >
                    <Plus />{t("新增题目")}</Button>
                )}
                <Button
                  disabled={busy || !questions.length || loading}
                  onClick={() => {
                    setPracticeSetup({ bank: page === "questions" ? bank : null });
                  }}
                >
                  <Play />{t("开始练习")}</Button>
              </>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-8">
          <Suspense fallback={loadingView}>
          {page === "history" && (summaryLoading || summaryError != null) && (
            <div className="mb-5 space-y-3" aria-busy={summaryLoading}>
              {summaryLoading && <p role="status">{t("加载中…")}</p>}
              {summaryError != null && <div role="alert"><p>{errorMessage(summaryError)}</p><Button variant="outline" onClick={() => setListRevision(v => v + 1)}>{t("重试")}</Button></div>}
            </div>
          )}
          {page === "banks" && <BankList
            offset={bankOffset}
            onOffsetChange={setBankOffset}
            revision={listRevision}
            busy={busy}
            ready={!!info}
            run={run}
            onAddExample={() => run(async () => { await api({ type: "add_example_bank" }); await reloadBanks(); })}
            onOpenSession={openSession}
            onImport={bankId => navigate("import", bankId)}
            onOpenQuestions={bankId => navigate("questions", bankId)}
            onPractice={bankId => setPracticeSetup({ bank: bankId })}
            onEdit={bankItem => setBankEditor({ id: bankItem.id, title: bankItem.title, description: bankItem.description })}
            onDelete={bankItem => setConfirm({
              title: message("删除“{0}”？", { 0: bankItem.title }),
              description: message("题库及其中题目将被删除，已有练习记录和内容快照会保留。"),
              action: async () => {
                await api({ type: "delete_bank", id: bankItem.id });
                await reloadBanks();
              },
            })}
          />}
          {listPage && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <InputGroup className="flex-1">
                  <InputGroupAddon><Search /></InputGroupAddon>
                  <InputGroupInput
                    aria-label={t("搜索题目")}
                    placeholder={t("搜索题干、选项或内容…")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </InputGroup>
                <NativeSelect
                  className="w-40"
                  aria-label={t("筛选题型")}
                  value={mode}
                  onChange={(event) => setMode(event.target.value)}
                >
                  <NativeSelectOption value="">{t("全部题型")}</NativeSelectOption>
                  <NativeSelectOption value="single">{t("单选题")}</NativeSelectOption>
                  <NativeSelectOption value="multiple">{t("多选题")}</NativeSelectOption>
                  {Object.entries({...modeNames(),...questionKinds()}).filter(([key])=>key!=="gap_fill").map(([v, label]) => (
                    <NativeSelectOption key={v} value={v}>{label}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {questions.length ? (
                <>
                  <div className="divide-y rounded-xl border">
                    {questions.map((row, i) => (
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
                              {modeNames()[row.question.answerMode || ""] ||
                                t("未知题型")}
                            </Badge>
                            {row.question.needsReview && (
                              <CircleAlert className="size-4 text-amber-600 dark:text-amber-400" role="img" aria-label={t("待复核")} />
                            )}
                            {row.latestResult === false && (
                              <Badge variant="destructive">{t("错题")}</Badge>
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
                              t("题干缺失")}
                          </p>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={row.favorite ? t("取消收藏") : t("收藏题目")}
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
                          aria-label={t("编辑题目")}
                          disabled={busy}
                          onClick={() => {
                            setBank(row.bankId);
                            setEditor({ id: row.id, question: row.question, children: (row.children || []).map(c=>({...c.question, options:c.question.optionSourceId ? [] : c.question.options})) });
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("删除题目")}
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              title: message("删除这道题目？"),
                              description: message("历史练习与作答快照仍会保留。"),
                              action: async () => {
                                await api({
                                  type: "delete_question",
                                  id: row.id,
                                });
                                await refreshQuestions();
                                await reloadBanks();
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {questionTotal > 30 && <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>{t("第 {0}–{1} 题", { 0: offset + 1, 1: Math.min(offset + 30, questionTotal) })}</span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={loading || busy || offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 30))}
                      >{t("上一页")}</Button>
                      <Button
                        variant="outline"
                        disabled={loading || busy || offset + 30 >= questionTotal}
                        onClick={() => setOffset(offset + 30)}
                      >{t("下一页")}</Button>
                    </div>
                  </div>}
                </>
              ) : (
                !loading && (
                  <Empty className="min-h-96 border border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">{page === "favorite" ? <Star /> : <BookOpen />}</EmptyMedia>
                      <EmptyTitle>{page === "wrong" ? t("暂时没有错题") : page === "favorite" ? t("还没有收藏题目") : t("没有找到题目")}</EmptyTitle>
                      <EmptyDescription>{page === "wrong" ? t("已判定为错误的题目会出现在这里，再次答对后自动移出。") : t("尝试调整筛选，或导入新的题目。")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )
              )}
            </div>
          )}
          {page === "history" && !summaryLoading && !summaryError &&
            (sessionPage.items.length ? (
              <div className="space-y-3">
                {sessionPage.items.map((s) => (
                  <Card key={s.id} className="py-3">
                    <CardContent className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <h2 className="min-w-0 break-words font-medium">{s.title}</h2>
                          <Badge variant="secondary">
                            {s.finishedAt ? t("已结束") : s.submittedAt ? t("待核对") : t("进行中")}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {date(s.createdAt)} · {duration(s.elapsedMs)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-sm tabular-nums">
                          <span>{t("已提交 {0}/{1} 题", { 0: s.answered, 1: s.count })}</span>
                          {!!(s.finishedAt || s.submittedAt) && (s.kind && s.kind !== "practice" ? <>
                            <Badge variant="secondary">{t("{0} {1} / {2} 分", { 0: s.pendingGrades ? t("暂定成绩") : t("成绩"), 1: (s.earnedCents || 0) / 100, 2: (s.totalCents || 0) / 100 })}</Badge>
                            {!!s.pendingGrades && <Badge variant="outline">{t("待评分 {0} 题", { 0: s.pendingGrades })}</Badge>}
                          </> : <span>{t("正确率 {0}", { 0: s.graded ? `${Math.round((s.correct / s.graded) * 100)}%（${s.correct}/${s.graded}）` : t("暂无已判定题目") })}</span>)}
                        </div>
                        {!!(s.answered || s.finishedAt || s.submittedAt) && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("判定详情")}</summary><p className="mt-2">{t("自动判定 {0} · 自评 {1} · 跳过 {2} · 未判定 {3}", { 0: s.autoGraded, 1: s.selfGraded, 2: s.skipped, 3: s.kind && s.kind !== "practice" ? s.pendingGrades : s.answered - s.graded - s.skipped })}</p></details>}
                      </div>
                      <Button
                        className="shrink-0"
                        variant="outline"
                        disabled={busy}
                        onClick={() => openSession(s.id)}
                      >
                        {s.finishedAt ? t("查看记录") : s.submittedAt ? t("核对评分") : t("继续练习")}
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
                  <EmptyTitle>{t("还没有练习记录")}</EmptyTitle>
                  <EmptyDescription>{t("完成一次练习后，即可在这里回顾答案、用时与正确率。")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ))}
          {page === "history" && <div className="mt-5 flex items-center justify-end gap-3">
            {sessionPage.total > 30 && (
              <nav aria-label={t("练习记录分页")} className="flex flex-1 items-center justify-between gap-3">
                <span role="status" className="text-sm text-muted-foreground">{!summaryLoading && !summaryError && t("{0}–{1} / {2} 条", {0: sessionPage.total ? sessionPage.offset + 1 : 0, 1: sessionPage.offset + sessionPage.items.length, 2: sessionPage.total})}</span>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={busy || summaryLoading || !!summaryError || sessionPage.offset === 0} onClick={() => setSessionOffset(Math.max(0, sessionPage.offset - 30))}>{t("上一页")}</Button>
                  <Button variant="outline" disabled={busy || summaryLoading || !!summaryError || sessionPage.offset + 30 >= sessionPage.total} onClick={() => setSessionOffset(sessionPage.offset + 30)}>{t("下一页")}</Button>
                </div>
              </nav>
            )}
            <Button variant="outline" disabled={busy || summaryLoading} onClick={() => setListRevision(v => v + 1)}>{t("刷新")}</Button>
          </div>}
          {page === "practice" && session && (
            <Practice
              key={session.id}
              session={session}
              onSession={(s) => {
                setSession(s);
                if (s.id !== session.id) setSessionOffset(0);
                if (s.finishedAt && !session.finishedAt)
                  toast.success(message("练习已结束，记录已保存"));
              }}
              run={run}
              flushRef={flushRef}
            />
          )}
          {page === "import" && <ImportPage busy={busy} run={run} onPreview={(p, task)=>setImportPreview({ preview: p, initialBank: bank || "new", task })} onOpenBank={id => navigate("questions", id)} onConfigure={() => { setSettingsReturn({ bank }); navigate("model-settings"); }} />}
          {page === "model-settings" && (
            <div className="max-w-3xl space-y-6">
              <ConnectionSettingsPanel
                key={settingsRevision}
                busy={busy}
                run={run}
                flushRef={flushRef}
              />
            </div>
          )}
          {page === "settings" && (
            <SettingsPage busy={busy} run={run} flushRef={flushRef} revision={settingsRevision} version={info?.version}
              onConfigure={() => navigate("model-settings")}
              onPickImport={pickImport}
              onRestore={() => setConfirm({
                title: message("用备份替换当前数据？"),
                description: message("恢复会替换全部本地题库和练习记录。应用将先校验备份，并自动保存当前数据的恢复副本。"),
                action: async () => {
                  const result = await api({ type: "restore" });
                  if (result) {
                    await language.reload();
                    setSettingsRevision(v => v + 1);
                    setSession(null);
                    setDetail(null);
                    setBank(null);
                    await reloadBanks();
                    toast.success(message("恢复完成。原数据副本：{0}", { 0: result.recoveryPath }));
                  }
                },
              })} />
          )}
          </Suspense>
        </div>
      </main>
      <Dialog open={mergeOpen} onOpenChange={(open) => { if (!busy && !open) closeMerge(); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); mergeTrigger.current?.focus(); }} className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("合并题库")}</DialogTitle>
            <DialogDescription>{t("选择至少两个题库，复制合并为新题库。保留原库和重复题，不继承作答历史。")}</DialogDescription>
          </DialogHeader>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">{t("选择题库")}</legend>
              <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto">
                {banks.map((b) => (
                  <label key={b.id} className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                    <Checkbox disabled={busy} className="mt-0.5" checked={mergeSelection.includes(b.id)} onCheckedChange={(checked) => setMergeSelection(checked === true ? [...mergeSelection, b.id] : mergeSelection.filter(id => id !== b.id))} />
                    <span className="min-w-0 break-words">{t("{0}（{1} 题）", { 0: b.title, 1: b.count })}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="merge-title">{t("新题库名称")}</Label>
              <Input id="merge-title" aria-label={t("合并后的题库名称")} placeholder={t("输入新题库名称")} value={mergeTitle} onChange={(e) => setMergeTitle(e.target.value)} />
            </div>
            <p className="text-sm text-muted-foreground" role="status">{t("已选 {0} 个题库，共 {1} 题；原库保留。", { 0: mergeSelection.length, 1: banks.filter(b => mergeSelection.includes(b.id)).reduce((n, b) => n + b.count, 0) })}</p>
          </fieldset>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={closeMerge}>{t("取消")}</Button>
            <Button disabled={busy || mergeSelection.length < 2 || !mergeTitle.trim()} onClick={() => run(async () => {
              await api({ type: "merge_banks", bank_ids: mergeSelection, title: mergeTitle.trim() });
              closeMerge();
              await reloadBanks();
              toast.success(message("合并完成"));
            })}>{t("确认合并")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {importPreview && <Suspense fallback={loadingView}><ImportBankDialog
        key={importPreview.preview.ticket}
        preview={importPreview.preview}
        banks={banks}
        initialBank={importPreview.initialBank}
        busy={busy}
        run={run}
        onState={importPreview.task?.onState}
        onClose={() => setImportPreview(null)}
        onImported={async bankId => {
          importPreview.task?.onImported(bankId);
          await reloadBanks();
          if (importPreview.task) return;
          setBank(bankId);
          setSearch("");
          setMode("");
          setPage("questions");
          setOffset(0);
          setQuestions([]);
          setQuestionTotal(0);
        }}
      /></Suspense>}
      {bankEditor && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v && !busy) setBankEditor(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("编辑题库")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Label htmlFor="bankTitle">{t("题库名称")}</Label>
              <Input
                id="bankTitle"
                value={bankEditor.title}
                onChange={(e) =>
                  setBankEditor({ ...bankEditor, title: e.target.value })
                }
              />
              <Label htmlFor="description">{t("说明")}</Label>
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
                    await reloadBanks();
                  })
                }
              >{t("保存题库")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {editor && bank && (
        <Suspense fallback={loadingView}><QuestionEditor
          initial={editor.question}
          initialChildren={editor.children}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={(q, children) =>
            run(async () => {
              await api({
                type: "save_question_tree",
                root_id: editor.id,
                bank_id: bank,
                questions: [q,...children],
              });
              setEditor(null);
              await refreshQuestions();
              await reloadBanks();
              toast.success(message("题目已保存，历史练习不受影响"));
            })
          }
        /></Suspense>
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
              <DialogTitle>{t("题目详情")}</DialogTitle>
            </DialogHeader>
            <Suspense fallback={loadingView}>
            {!!detail.children?.length && <QuestionPreview questions={[detail.question,...detail.children.map(c=>c.question)]} groups={Array.from(new Map([detail,...detail.children].flatMap(r=>r.groups).map(g=>[g.id,g])).values())} visuals={Array.from(new Map([detail,...detail.children].flatMap(r=>r.visuals).map(v=>[v.id,v])).values())}/>}
            {!detail.children?.length && <Content snapshot={detail} source />}
            <AnswerInput
              question={detail.question}
              value={detail.question.answerPayload}
              onChange={() => {}}
              disabled
              prefix="detail-answer"
            />
            <div className="mt-4 space-y-4 border-t pt-4">
              <h3 className="font-medium">{t("参考答案")}</h3>
              <AnswerDisplay
                answer={detail.question.answerPayload}
                question={detail.question}
              />
              <h3 className="font-medium">{t("解析")}</h3>
              <p className="whitespace-pre-wrap text-sm">
                {detail.question.analysis || t("原文未提供解析。")}
              </p>
            </div>
            </Suspense>
          </DialogContent>
        </Dialog>
      )}
      {practiceSetup && <Suspense fallback={loadingView}><StudySetup banks={banks} initialBank={practiceSetup.bank} initialFilter={filter} initialMode={mode} initialSearch={search} busy={busy} run={run} onClose={()=>setPracticeSetup(null)} onStart={async s=>{await flushRef.current();setSession(s);setSessionOffset(0);setPracticeSetup(null);setPage("practice");}}/></Suspense>}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm && renderMessage(confirm.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && renderMessage(confirm.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) {
                  const action = confirm.action;
                  setConfirm(null);
                  run(action);
                }
              }}
            >{t("确认")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Toaster theme={theme.dark ? "dark" : "light"} position="bottom-right" richColors />
    </div>
  );
}
