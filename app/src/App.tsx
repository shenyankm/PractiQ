import { message, renderMessage, type Message, t, useI18n } from "./i18n";
import { useTheme, type ThemeState } from "./theme";
import { HistoryPage, useHistoryPage } from "./HistoryPage";
import { QuestionListPage, useQuestionListPage } from "./QuestionListPage";
import logo from "../src-tauri/icons/icon.png";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Tooltip } from "radix-ui";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen,
  Menu,
  MoreHorizontal,
  Upload,
  Plus,
  Star,
  History,
  Settings,
  Languages,
  Palette,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  CircleAlert,
  ArrowLeft,
  Play,
  BookmarkX,
} from "lucide-react";
import { toast } from "./notifications";
import { canCloseWindow, useUnsavedChanges } from "./useUnsavedChanges";
import type { GradingDraft } from "./ExamResults";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  api,
  type BankChoice,
  type Preview,
  type Question,
  type QuestionRow,
  type Session,
} from "./api";
import { Button } from "@/components/ui/button";
import { ErrorNotice, OperationFailure, OperationFeedback } from "./OperationFeedback";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure, RenderFailureDialog } from "./RenderFailure";
import { BankEditor, type BankDraft } from "./BankEditor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  | "settings"
  | "service-settings"
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
const compactNavigationQuery = "(max-width: 767px)";
function subscribeCompactNavigation(listener: () => void) {
  const queries = [compactNavigationQuery, "(max-width: 1023px)"].map(query => window.matchMedia(query));
  queries.forEach(media => media.addEventListener("change", listener));
  return () => queries.forEach(media => media.removeEventListener("change", listener));
}
function navigationLayout() {
  return window.matchMedia(compactNavigationQuery).matches ? "compact" : window.matchMedia("(max-width: 1023px)").matches ? "narrow" : "wide";
}
function desktopNavigation() { return "wide"; }
export default function App({ initialTheme }: { initialTheme?: ThemeState } = {}) {
  const language = useI18n();
  const theme = useTheme(initialTheme);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeTrigger = useRef<HTMLButtonElement>(null);
  const layout = useSyncExternalStore(subscribeCompactNavigation, navigationLayout, desktopNavigation);
  const compact = layout === "compact";
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [desktopSidebarCollapsed, setSidebarCollapsed] = useState<boolean | null>(null);
  const sidebarCollapsed = !compact && (desktopSidebarCollapsed ?? layout === "narrow");
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageTrigger = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<Page>("banks");
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef<Page>(page);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [banks, setBanks] = useState<BankChoice[]>([]);
  const [banksReady, setBanksReady] = useState(false);
  const [bankListLoading, setBankListLoading] = useState(true);
  const [bankError, setBankError] = useState<unknown>(null);
  const [infoError, setInfoError] = useState<unknown>(null);
  const [bank, setBank] = useState<string | null>(null);
  const [bankOffset, setBankOffset] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const history = useHistoryPage(page === "history", listRevision);
  const { setSessionOffset } = history;
  const questionList = useQuestionListPage(page, bank);
  const { questions, questionTotal, questionError, search, mode, loading, filter, refresh: refreshQuestions, reset: resetQuestions } = questionList;
  const [session, setSession] = useState<Session | null>(null);
  const [gradingDrafts, setGradingDrafts] = useState<Record<string, GradingDraft>>({});
  const [gradingReturn, setGradingReturn] = useState<string | null>(null);
  useUnsavedChanges(Object.keys(gradingDrafts).length > 0);
  const [busy, setBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<{ preview: Preview; initialBank: string } | null>(null);
  const [bankEditor, setBankEditor] = useState<BankDraft | null>(null);
  const bankEditorTrigger = useRef<HTMLElement | null>(null);
  const questionEditorTrigger = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<{
    id: string | null;
    question: Question;
    children?: Question[];
    images?: {hash:string;label:string}[];
  } | null>(null);
  const [detail, setDetail] = useState<QuestionRow | null>(null);
  const [confirm, setConfirm] = useState<{
    title: Message;
    description: Message;
    label: Message;
    action: () => Promise<void>;
  } | null>(null);
  const confirmTrigger = useRef<HTMLElement | null>(null);
  const openConfirm = useCallback((value: NonNullable<typeof confirm>, trigger: HTMLElement | null = document.activeElement as HTMLElement) => {
    confirmTrigger.current = trigger;
    setOperationError(null);
    setConfirm(value);
  }, []);
  const [operationError, setOperationError] = useState<{ error: unknown } | null>(null);
  const operationNotice = useRef<HTMLDivElement>(null);
  const [practiceSetup, setPracticeSetup] = useState<{ bank: string | null; bankIds?: string[]; filter?: string } | null>(null);
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
  const [info, setInfo] = useState<{
    dataDirectory: string;
    version: string;
  } | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const lock = useRef(false);
  const currentBank = banks.find((b) => b.id === bank);
  const run = useCallback((job: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setOperationError(null);
    void job()
      .catch((e) => {
        setOperationError({ error: e });
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }, []);
  const sessionId = session?.id;
  const sessionFinishedAt = session?.finishedAt;
  const onPracticeSession = useCallback((next: Session) => {
    setSession(next);
    if (next.id !== sessionId) setSessionOffset(0);
    if (next.finishedAt && !sessionFinishedAt)
      toast.success(message("练习已结束，记录已保存。"));
  }, [sessionId, sessionFinishedAt, setSessionOffset]);
  const reloadBanks = useCallback(async () => {
    try {
      setBanks(await api({ type: "banks" }));
      setBanksReady(true);
      setBankError(null);
    } catch (error) { setBankError(error); }
    // A read failure must not disguise a previously committed mutation as failed.
    setListRevision(v => v + 1);
  }, []);
  const reloadOverview = useCallback(async () => {
    await Promise.all([
      reloadBanks(),
      api({ type: "info" }).then(result => { setInfo(result); setInfoError(null); }).catch(setInfoError),
    ]);
  }, [reloadBanks]);
  useEffect(() => { run(reloadOverview); }, [run, reloadOverview]);
  const bankActionsUnavailable = busy || !banksReady || bankError != null;
  useEffect(() => {
    if (previousPage.current !== page) pageHeading.current?.focus();
    previousPage.current = page;
  }, [page]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (lock.current) {
          toast.info(message("请等待当前操作完成后关闭。"));
          return;
        }
        try {
          if (!canCloseWindow()) {
            openConfirm({
              title: message("放弃未保存的更改并退出？"),
              label: message("放弃更改并退出"),
              description: message("未保存的编辑和人工评分草稿将丢失。取消后可继续编辑；已保存的数据不受影响。"),
              action: async () => { await flushRef.current(); await getCurrentWindow().destroy(); },
            });
            return;
          }
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
  }, [openConfirm]);
  function navigate(next: Page, bankId: string | null = null, showRestore = false) {
    setOperationError(null);
    run(async () => {
      await flushRef.current();
      flushRef.current = async () => {};
      setPage(next);
      setGradingReturn(null);
      setNavigationOpen(false);
      setRestoreOpen(showRestore);
      setBank(bankId);
      setDetail(null);
      resetQuestions();
      if (next === "banks" || next === "history") setListRevision(v => v + 1);
    });
  }
  function openSession(id: string) {
    run(async () => {
      await flushRef.current();
      setSession(await api({ type: "session", id }));
      setGradingReturn(null);
      setPage("practice");
    });
  }
  async function pickImport() {
    const p = await api({ type: "pick_import" });
    if (p) setImportPreview({ preview: p, initialBank: "new" });
  }
  const heading =
    page === "banks"
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
                ? t(session && (session.finishedAt != null || (session.kind && session.kind !== "practice" && session.submittedAt != null)) ? "练习回顾" : "专注练习")
                : page === "service-settings" ? t("AI 服务") : t("设置");
  const loadingView = <p role="status" className="p-4 text-sm text-muted-foreground">{t("加载中…")}</p>;
  const listPage = ["questions", "wrong", "favorite"].includes(page);
  const languageError = language.error != null && <div role="alert" className="text-xs text-destructive"><p>{t(language.error.key)}</p><ErrorNotice error={language.error.cause} /><Button size="sm" variant="outline" disabled={language.saving || busy} onClick={() => {
    if (language.error?.key === "保存语言设置失败") void language.change(language.error.locale).then(saved => { if (saved) setLanguageOpen(false); });
    else void language.reload();
  }}>{t("重试")}</Button></div>;
  const navigationContent = <>
        <div className="mb-4 flex items-center gap-2 overflow-hidden px-1 pt-3">
          {compact ? <img src={logo} alt="" className="size-10 shrink-0 object-contain" /> : <Button variant="ghost" size="icon" className="group relative size-10 shrink-0 rounded-xl border-0 aria-expanded:bg-transparent" aria-label={sidebarCollapsed ? t("展开侧边栏") : t("收起侧边栏")} aria-expanded={!sidebarCollapsed} aria-controls="app-sidebar" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
            <img src={logo} alt="" className="size-10 shrink-0 object-contain group-hover:opacity-0 group-focus-visible:opacity-0" />
            <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</span>
          </Button>}
          <div aria-hidden={sidebarCollapsed} className="sidebar-label shrink-0">
            <div className="text-lg font-semibold tracking-tight">PractiQ</div>
          </div>
        </div>
        <nav aria-label={t("主导航")} className="space-y-2">
          {(
            [
              { id: "banks", label: t("我的题库"), icon: BookOpen },
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
        <div className="mt-auto space-y-4 pt-6">
          <div className="space-y-2">
            <DropdownMenu open={themeOpen} onOpenChange={setThemeOpen}>
              <DropdownMenuTrigger asChild>
                <SidebarButton ref={themeTrigger} collapsed={sidebarCollapsed} label={t("主题")} className={theme.error ? "text-destructive" : ""}>
                  {theme.error ? <CircleAlert /> : <Palette />}
                </SidebarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-40" aria-label={t("主题")} onCloseAutoFocus={event => { event.preventDefault(); themeTrigger.current?.focus(); theme.applyPending(); }}>
                <DropdownMenuRadioGroup value={theme.theme}>
                  {([{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }] as const).map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value} onSelect={event => { event.preventDefault(); if (theme.change(value, true)) setThemeOpen(false); }}>{t(label)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {theme.error != null && <div role="alert" className="p-2 text-xs text-destructive"><p>{t("主题设置失败，请重试。")}</p><ErrorNotice error={theme.error} /></div>}
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
                  {(["zh-CN", "zh-TW", "en"] as const).map(value => <DropdownMenuRadioItem key={value} value={value} disabled={!language.ready || language.saving || busy} onSelect={event => { event.preventDefault(); void language.change(value).then(saved => { if (saved) setLanguageOpen(false); }); }}>{value === "zh-CN" ? "简体中文" : value === "zh-TW" ? "繁體中文" : "English"}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                {languageError}
              </DropdownMenuContent>
            </DropdownMenu>
            {!languageOpen && (sidebarCollapsed ? language.error && <p role="alert" className="sr-only">{t(language.error.key)}</p> : languageError)}
          </div>
          <SidebarButton
            collapsed={sidebarCollapsed}
            label={t("设置")}
            variant={page === "settings" || page === "service-settings" ? "secondary" : "ghost"}
            aria-current={page === "settings" || page === "service-settings" ? "page" : undefined}
            disabled={busy}
            onClick={() => navigate("settings")}
          >
            <Settings /></SidebarButton>
        </div>
  </>;
  const dialogOpen = !!(confirm || bankEditor || editor || importPreview || practiceSetup || detail || mergeOpen || navigationOpen);
  useEffect(() => {
    if (operationError && !dialogOpen) operationNotice.current?.scrollIntoView({ block: "nearest" });
  }, [operationError, dialogOpen]);
  return (
    <OperationFailure.Provider value={operationError ? { error: operationError.error, dialogOpen, dismiss: () => setOperationError(null) } : null}>
    <div className="app-shell flex overflow-hidden bg-background text-foreground">
      <Tooltip.Provider delayDuration={200}>
      {compact ? <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
        <DialogContent className="navigation-drawer" aria-describedby={undefined}>
          <DialogHeader className="sr-only"><DialogTitle>{t("主导航")}</DialogTitle></DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">{navigationContent}</div>
        </DialogContent>
      </Dialog> : <aside id="app-sidebar" className={`flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2 py-4 text-sidebar-foreground transition-[width] duration-200 ease-in-out motion-reduce:transition-none ${sidebarCollapsed ? "w-16" : "w-52"}`}>{navigationContent}</aside>}
      </Tooltip.Provider>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="app-header flex shrink-0 flex-wrap items-center justify-between gap-4 border-b">
          <div className="flex min-w-0 items-center gap-3">
            {compact && !["questions", "practice", "service-settings"].includes(page) && <Button size="icon" variant="ghost" aria-label={t("打开主导航")} aria-expanded={navigationOpen} disabled={busy} onClick={() => setNavigationOpen(true)}><Menu /></Button>}
            {page === "practice" && <Button size="icon" variant="ghost" aria-label={t("返回练习记录")} disabled={busy} onClick={() => navigate("history")}><ArrowLeft /></Button>}
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
            {page === "service-settings" && (
              <Button size={gradingReturn ? "default" : "icon"} variant="ghost" disabled={busy} aria-label={gradingReturn ? t("返回评分") : t("返回设置")} onClick={() => gradingReturn ? openSession(gradingReturn) : navigate("settings")}>
                <ArrowLeft />{gradingReturn && t("返回评分")}
              </Button>
            )}
            <div className="min-w-0">
              <h1 ref={pageHeading} tabIndex={-1} className="break-words text-xl font-semibold tracking-tight outline-none md:text-2xl">
                {heading}
              </h1>
              {(page === "banks" || listPage) && <p className="mt-1 text-sm text-muted-foreground">
                {page === "banks"
                  ? bankError != null ? t("题库概览读取失败") : !banksReady ? t("加载中…") : t("{0} 个题库 · {1} 道题目", { 0: banks.length, 1: banks.reduce((n, b) => n + b.count, 0) })
                  : questionError != null ? t("加载题目失败") : loading ? t("加载中…") : page === "questions" && banksReady && bankError == null ? t("题库共 {0} 小题 · 当前匹配 {1} 项", {0:banks.find(b => b.id === bank)?.count ?? 0,1:questionTotal}) : t("当前匹配 {0} 项", {0:questionTotal})}
              </p>}
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {busy && (
              <span role="status" className="text-sm text-muted-foreground">{t("处理中…")}</span>
            )}

            {page === "banks" && (
              <><Button variant="outline" size={compact ? "icon" : "default"} aria-label={t("刷新")} title={t("刷新")} disabled={busy || bankListLoading} onClick={() => setListRevision(value => value + 1)}>{compact ? <RefreshCw /> : t("刷新")}</Button><Button variant="outline" disabled={bankActionsUnavailable} onClick={event => { bankEditorTrigger.current = event.currentTarget; setOperationError(null); setBankEditor({ id: null, title: "", description: "" }); }}><Plus />{t("新建题库")}</Button><Button variant="outline" disabled={bankActionsUnavailable} onClick={() => navigate("settings", null, true)}><Upload />{t("导入")}</Button></>
            )}
            {page === "banks" && banks.length > 1 && (
              compact ? <DropdownMenu><DropdownMenuTrigger asChild><Button ref={mergeTrigger} size="icon" variant="outline" disabled={bankActionsUnavailable} aria-label={t("更多题库操作")}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setMergeOpen(true)}>{t("合并题库")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : <Button ref={mergeTrigger} variant="outline" disabled={bankActionsUnavailable} onClick={() => setMergeOpen(true)}>{t("合并题库")}</Button>
            )}
            {(page === "wrong" || page === "favorite") && (
              <Button
                disabled={bankActionsUnavailable || !questions.length || loading || questionError != null}
                onClick={() => setPracticeSetup({ bank: null })}
              >
                <Play />{t("开始练习")}</Button>
            )}
          </div>
        </header>
        <div className={`app-content min-h-0 flex-1 overflow-y-auto ${page === "practice" ? "practice-app-content" : ""}`}>
          <div className={`page-workspace ${page === "practice" ? "practice-workspace" : ""}`}>
          <div className="workspace-notices">
          {operationError && !dialogOpen && <div ref={operationNotice} className={`mb-5 ${page === "settings" || page === "service-settings" ? "mx-auto max-w-3xl" : ""}`}><OperationFeedback /></div>}
          {(bankError != null || infoError != null) && <div role="alert" className="mb-5 space-y-2 rounded-lg border border-destructive/40 p-4">
            <p>{t("概览读取失败，已保存的数据和已完成的操作不受影响。请重试读取，不要重复导入或保存。")}</p>
            <ErrorNotice error={bankError ?? infoError} />
            <Button variant="outline" disabled={busy} onClick={() => run(reloadOverview)}>{t("重试读取概览")}</Button>
          </div>}
          </div>
          <ErrorBoundary key={page} fallback={<RenderFailure />}><Suspense fallback={loadingView}>
          {page === "history" && <HistoryPage state={history} busy={busy} onOpen={openSession} onBrowse={() => navigate("banks")} />}
          {page === "banks" && <BankList
            offset={bankOffset}
            onOffsetChange={setBankOffset}
            revision={listRevision}
            onLoadingChange={setBankListLoading}
            busy={bankActionsUnavailable}
            ready={!!info && banksReady}
            run={run}
            onAddExample={() => run(async () => { await api({ type: "add_example_bank" }); await reloadBanks(); })}
            onOpenSession={openSession}
            onImport={() => navigate("settings", null, true)}
            onHistory={() => { history.setFilter("active"); navigate("history"); }}
            onOpenQuestions={bankId => navigate("questions", bankId)}
            onPractice={bankId => setPracticeSetup({ bank: bankId })}
            onEdit={(bankItem, trigger) => { bankEditorTrigger.current = trigger; setOperationError(null); setBankEditor({ id: bankItem.id, title: bankItem.title, description: bankItem.description }); }}
            onDelete={(bankItem, trigger) => openConfirm({
              title: message("删除“{0}”？", { 0: bankItem.title }),
              label: message("删除题库"),
              description: message("题库及其中题目将被删除，已有练习记录和内容快照会保留。"),
              action: async () => {
                await api({ type: "delete_bank", id: bankItem.id });
                await reloadBanks();
              },
            }, trigger)}
          />}
          {listPage && <QuestionListPage state={questionList} page={page} compact={compact} busy={busy} run={run}
            onOpen={id => run(async () => setDetail(await api({ type: "question_detail", id })))}
            onEdit={(row, trigger) => {
              questionEditorTrigger.current = trigger;
              run(async () => {
                const full = await api({ type: "question_detail", id: row.id });
                setBank(row.bankId);
                const visuals = [full, ...(full.children || [])].flatMap(item => item.visuals);
                const images = Array.from(new Map(visuals.flatMap(visual => {
                  const reference = visual.imageRef || visual.sourceRef;
                  return reference ? [[reference.sha256, { hash: reference.sha256, label: visual.label || visual.description || "" }] as const] : [];
                })).values());
                setEditor({ id: row.id, question: full.question, images, children: (full.children || []).map(child => ({ ...child.question, options: child.question.optionSourceId ? [] : child.question.options })) });
              });
            }}
            onDelete={(row, trigger) => openConfirm({
              title: message("删除这道题目？"), label: message("删除题目"), description: message("历史练习与作答快照仍会保留。"),
              action: async () => { await api({ type: "delete_question", id: row.id }); refreshQuestions(); await reloadBanks(); },
            }, trigger)}
            onBrowse={() => navigate("banks")} />}
          {page === "practice" && session && (
            <Practice
              compact={compact}
              key={session.id}
              session={session}
              onSession={onPracticeSession}
              run={run}
              flushRef={flushRef}
              gradingDrafts={gradingDrafts}
              onGradingDraftChange={(ordinal, draft) => setGradingDrafts(previous => {
                const next = { ...previous }, key = `${session.id}:${ordinal}`;
                if (draft.score || draft.reason) next[key] = draft;
                else delete next[key];
                return next;
              })}
              onConfigureGrading={() => run(async () => { await flushRef.current(); setGradingReturn(session.id); setPage("service-settings"); })}
              onNextUnattempted={session.bankIds?.some(id => banks.some(b => b.id === id)) ? () => setPracticeSetup({ bank: null, bankIds: session.bankIds!.filter(id => banks.some(b => b.id === id)), filter: "unattempted" }) : undefined}
            />
          )}
          {page === "service-settings" && (
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
              restoreOpen={restoreOpen} onRestoreOpenChange={setRestoreOpen}
              onConfigure={() => navigate("service-settings")}
              onPickImport={pickImport}
              onRestore={(recoverAssets, trigger) => openConfirm({
                title: message("用备份替换当前数据？"),
                label: message("恢复备份"),
                description: recoverAssets ? message("恢复会替换全部本地题库和练习记录，并修复缺失或损坏的资源。应用会先校验备份，保留原数据库、现存原始文件和损坏清单；该副本不能作为普通备份直接恢复。") : message("恢复会替换全部本地题库和练习记录。应用将先校验备份，并自动保存当前数据的恢复副本。"),
                action: async () => {
                  const result = await api(recoverAssets ? { type: "restore", recover_assets: true } : { type: "restore" });
                  if (result) {
                    await language.reload();
                    setSettingsRevision(v => v + 1);
                    setSession(null);
                    setGradingDrafts({});
                    setGradingReturn(null);
                    setDetail(null);
                    setBank(null);
                    await reloadBanks();
                    toast.success(message("恢复完成。原数据副本：{0}", { 0: result.recoveryPath }));
                  }
                },
              }, trigger)} />
          )}
          </Suspense></ErrorBoundary>
          </div>
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
              <div className="grid max-h-64 grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto">
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
      {importPreview && <ErrorBoundary fallback={<RenderFailureDialog onClose={() => setImportPreview(null)} />}><Suspense fallback={loadingView}><ImportBankDialog
        key={importPreview.preview.ticket}
        preview={importPreview.preview}
        banks={banks}
        initialBank={importPreview.initialBank}
        busy={busy}
        run={run}
        onClose={() => setImportPreview(null)}
        onImported={async bankId => {
          await reloadBanks();
          setBank(bankId);
          resetQuestions(true);
          setPage("questions");
        }}
      /></Suspense></ErrorBoundary>}
      {bankEditor && (
        <BankEditor
          trigger={bankEditorTrigger.current}
          initial={bankEditor}
          busy={busy}
          onClose={() => { setBankEditor(null); setOperationError(null); }}
          onSave={draft => run(async () => {
            await api({ type: "save_bank", ...draft });
            setBankEditor(null);
            toast.success(message("题库已保存"));
            await reloadBanks();
          })}
        />
      )}
      {editor && bank && (
        <ErrorBoundary fallback={<RenderFailureDialog onClose={() => setEditor(null)} />}> <Suspense fallback={loadingView}><QuestionEditor
          trigger={questionEditorTrigger.current}
          creating={editor.id === null}
          initial={editor.question}
          initialChildren={editor.children}
          images={editor.images}
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
              refreshQuestions();
              await reloadBanks();
              toast.success(message("题目已保存，练习历史不受影响。"));
            })
          }
        /></Suspense></ErrorBoundary>
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
              <DialogDescription>{t("此操作应用于本题及全部子题；原始质量提示会保留。")}</DialogDescription>
            </DialogHeader>
            <Button variant="outline" disabled={busy} onClick={() => run(async () => {
              const reviewedAt = await api({ type: "review_question", id: detail.id, reviewed: detail.reviewedAt == null });
              setDetail(current => current?.id === detail.id ? { ...current, reviewedAt, children: current.children?.map(child => ({ ...child, reviewedAt })) } : current);
              refreshQuestions();
            })}>{detail.reviewedAt == null ? t("标记已复核") : t("撤销复核确认")}</Button>
            <ErrorBoundary fallback={<RenderFailure />}><Suspense fallback={loadingView}>
            {!!detail.children?.length && <QuestionPreview questions={[detail.question,...detail.children.map(c=>c.question)]} reviewedQuestionIds={[detail,...detail.children].filter(row => row.reviewedAt != null).map(row => row.question.id || row.id)} groups={Array.from(new Map([detail,...detail.children].flatMap(r=>r.groups).map(g=>[g.id,g])).values())} visuals={Array.from(new Map([detail,...detail.children].flatMap(r=>r.visuals).map(v=>[v.id,v])).values())}/>}
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
            </Suspense></ErrorBoundary>
          </DialogContent>
        </Dialog>
      )}
      {practiceSetup && <ErrorBoundary fallback={<RenderFailureDialog onClose={() => setPracticeSetup(null)} />}><Suspense fallback={loadingView}><StudySetup banks={banks} initialBank={practiceSetup.bank} initialBankIds={practiceSetup.bankIds} initialFilter={practiceSetup.filter ?? filter} initialMode={mode} initialSearch={search} busy={busy} run={run} onClose={()=>setPracticeSetup(null)} onStart={async s=>{await flushRef.current();setSession(s);setSessionOffset(0);setPracticeSetup(null);setPage("practice");}}/></Suspense></ErrorBoundary>}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !busy) { setConfirm(null); setOperationError(null); }
        }}
      >
        <AlertDialogContent onCloseAutoFocus={event => {
          event.preventDefault();
          const target = confirmTrigger.current?.isConnected ? confirmTrigger.current : document.querySelector<HTMLElement>("main h1");
          if (target) { if (!target.hasAttribute("tabindex")) target.tabIndex = -1; target.focus(); }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm && renderMessage(confirm.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && renderMessage(confirm.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={event => {
                event.preventDefault();
                if (confirm) run(async () => { await confirm.action(); setConfirm(null); });
              }}
            >{busy ? t("正在处理…") : confirm && renderMessage(confirm.label)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Toaster theme={theme.dark ? "dark" : "light"} position="bottom-right" richColors />
    </div>
    </OperationFailure.Provider>
  );
}
