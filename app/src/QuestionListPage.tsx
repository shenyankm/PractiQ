import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CircleAlert, MoreHorizontal, Pencil, Search, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import { api, modeNames, type QuestionSummary } from "./api";
import { questionKinds } from "./english";
import { message, t, useI18n } from "./i18n";
import { toast } from "./notifications";
import { ErrorNotice } from "./OperationFeedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function useQuestionListPage(page: string, bank: string | null) {
  const [questions, setQuestions] = useState<QuestionSummary[]>([]);
  const [questionTotal, setQuestionTotal] = useState(0);
  const [questionRevision, setQuestionRevision] = useState(0);
  const preserveQuestionRows = useRef(false);
  const [questionError, setQuestionError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [questionFiltersOpen, setQuestionFiltersOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const filter = page === "wrong" ? "wrong" : page === "favorite" ? "favorite" : "";
  useEffect(() => { setOffset(0); }, [page, bank, search, mode, filter]);
  useEffect(() => {
    if (!["questions", "wrong", "favorite"].includes(page)) return;
    let active = true;
    if (!preserveQuestionRows.current) {
      setLoading(true);
      setQuestions([]);
      setQuestionTotal(0);
    }
    preserveQuestionRows.current = false;
    setQuestionError(null);
    const timer = setTimeout(() => {
      void api({ type: "questions_page", bank_ids: page === "questions" && bank ? [bank] : [], search, mode, filter, limit: 30, offset })
        .then(rows => { if (active) { setQuestions(rows.items); setQuestionTotal(rows.total); setOffset(rows.offset); } })
        .catch(error => { if (active) setQuestionError(error); })
        .finally(() => { if (active) setLoading(false); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [page, bank, search, mode, filter, offset, questionRevision]);
  const refresh = useCallback((preserveRows = false) => {
    preserveQuestionRows.current = preserveRows;
    setQuestionRevision(value => value + 1);
  }, []);
  const reset = useCallback((clearResults = false) => {
    preserveQuestionRows.current = false;
    setSearch("");
    setMode("");
    setQuestionFiltersOpen(false);
    if (clearResults) {
      setOffset(0);
      setQuestions([]);
      setQuestionTotal(0);
    }
  }, []);
  async function favorite(row: QuestionSummary) {
    await api({ type: "favorite", id: row.id, value: !row.favorite });
    setQuestions(current => current.map(item => item.id === row.id ? { ...item, favorite: !row.favorite } : item));
    toast.success(message(row.favorite ? "已取消收藏" : "已收藏"), { position: "top-center", style: { width: "min(100%, calc(100vw - 2 * var(--mobile-offset-left, 16px)))" } });
    refresh(true);
  }
  return { questions, questionTotal, questionError, search, setSearch, mode, setMode, questionFiltersOpen, setQuestionFiltersOpen, offset, setOffset, loading, filter, refresh, reset, favorite };
}

export function QuestionListPage({ state, page, compact, busy, run, onOpen, onEdit, onDelete, onBrowse }: {
  state: ReturnType<typeof useQuestionListPage>;
  page: string;
  compact: boolean;
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onOpen: (id: string) => void;
  onEdit: (row: QuestionSummary, trigger: HTMLElement | null) => void;
  onDelete: (row: QuestionSummary, trigger: HTMLElement | null) => void;
  onBrowse: () => void;
}) {
  useI18n();
  const { questions, questionTotal, questionError, search, setSearch, mode, setMode, questionFiltersOpen, setQuestionFiltersOpen, offset, setOffset, loading } = state;
  const hasQuestionFilters = !!(search || mode);
  const loadingView = <p role="status" className="p-4 text-sm text-muted-foreground">{t("加载中…")}</p>;
  return (
    <div className="space-y-5">
      <div className="question-filters flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-2 sm:min-w-64 sm:basis-64">
          <Label htmlFor="question-search">{t("搜索题目")}</Label>
          <InputGroup>
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput
              id="question-search"
              aria-label={t("搜索题目")}
              placeholder={t("搜索题干、选项或内容…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </InputGroup>
        </div>
        {compact && <Button variant="outline" aria-expanded={questionFiltersOpen} aria-controls="question-filter-options" onClick={() => setQuestionFiltersOpen(value => !value)}><SlidersHorizontal />{t("筛选")}{mode && <Badge variant="secondary">1</Badge>}</Button>}
        <div id="question-filter-options" className={compact ? questionFiltersOpen ? "flex basis-full flex-wrap items-end gap-3" : "hidden" : "contents"}>
        <div className="min-w-0 max-w-full space-y-2">
          <Label htmlFor="question-mode">{t("筛选题型")}</Label>
          <NativeSelect
            id="question-mode"
            aria-label={t("筛选题型")}
            value={mode}
            onValueChange={value => setMode(value)}
          >
            <NativeSelectOption value="">{t("全部题型")}</NativeSelectOption>
            <NativeSelectOption value="single">{t("单选题")}</NativeSelectOption>
            <NativeSelectOption value="multiple">{t("多选题")}</NativeSelectOption>
            {Object.entries({...modeNames(),...questionKinds()}).filter(([key])=>key!=="gap_fill").map(([v, label]) => (
              <NativeSelectOption key={v} value={v}>{label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        </div>
        {hasQuestionFilters && <Button variant="outline" disabled={busy} onClick={() => { setSearch(""); setMode(""); setOffset(0); document.getElementById("question-search")?.focus(); }}>{t("清除筛选")}</Button>}
      </div>
      {page === "wrong" && questions.length > 0 && <p className="text-sm text-muted-foreground">{t("错误和未得满分的题目会出现在这里，再次答对或得满分后自动移出；未评分不算错题。")}</p>}
      {loading ? loadingView : questionError != null ? (
        <div role="alert" className="space-y-3 rounded-xl border p-4">
          <p className="font-medium">{t("加载题目失败")}</p>
          <ErrorNotice error={questionError} />
          <Button variant="outline" disabled={busy} onClick={() => state.refresh()}>{t("重试")}</Button>
        </div>
      ) : questions.length ? (
        <>
          <div className="divide-y rounded-xl border bg-card">
            {questions.map((row, i) => (
              <div key={row.id} className="question-row flex min-h-20 flex-wrap items-center gap-3 p-3 sm:flex-nowrap sm:gap-4 sm:p-4">
                <span className="w-8 shrink-0 text-sm text-muted-foreground">
                  {offset + i + 1}
                </span>
                <button
                  className="flex min-w-0 flex-1 flex-col items-stretch gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                  disabled={busy}
                  onClick={() => onOpen(row.id)}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Badge variant="outline" className="mt-0.5 shrink-0">
                      {modeNames()[row.question.answerMode || ""] || t("未知题型")}
                    </Badge>
                    <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-6 wrap-anywhere">
                      {row.question.stem || row.question.sourceText || t("题干缺失")}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.reviewRequired && (
                        <CircleAlert className="size-4 review-warning" role="img" aria-label={t("待复核")} />
                      )}
                      {row.hasWrong && (
                        <Badge variant="destructive">{row.hasPartialScore ? t("部分得分") : t("错题")}</Badge>
                      )}
                    </div>
                    {row.latestScore && <span className="text-xs text-muted-foreground">{t("上次 {0} / {1} 分", { 0: row.latestScore.earnedCents / 100, 1: row.latestScore.maxCents / 100 })}</span>}
                    {page !== "questions" && (
                      <span className="max-w-full truncate text-xs text-muted-foreground" title={row.bankTitle}>
                        {row.bankTitle}
                      </span>
                    )}
                  </div>
                </button>
                <div className="question-actions flex shrink-0 gap-3 sm:gap-4">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={row.favorite ? t("取消收藏") : t("收藏题目")}
                  aria-pressed={row.favorite}
                  disabled={busy}
                  onClick={() => run(() => state.favorite(row))}
                >
                  <Star
                    className={row.favorite ? "fill-current text-amber-500 dark:text-amber-400" : ""}
                  />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button id={`question-actions-${row.id}`} size="icon" variant="ghost" aria-label={t("题目更多操作 {0}", {0: offset + i + 1})} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() => onEdit(row, document.getElementById(`question-actions-${row.id}`))}
                >
                  <Pencil />{t("编辑题目")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive"
                  disabled={busy}
                  onSelect={() => onDelete(row, document.getElementById(`question-actions-${row.id}`))}
                >
                  <Trash2 />{t("删除题目")}
                </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                </div>
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
              <EmptyMedia>{page === "favorite" ? <Star /> : <BookOpen />}</EmptyMedia>
              <EmptyTitle>{hasQuestionFilters ? t("没有符合筛选的题目") : page === "wrong" ? t("暂时没有错题") : page === "favorite" ? t("还没有收藏题目") : t("没有找到题目")}</EmptyTitle>
              <EmptyDescription>{hasQuestionFilters ? t("清除筛选以查看当前列表中的全部题目。") : page === "wrong" ? t("错误和未得满分的题目会出现在这里，再次答对或得满分后自动移出；未评分不算错题。") : page === "favorite" ? t("浏览题库时点击题目旁的星标，即可在这里集中复习。") : t("尝试调整筛选，或导入新的题目。")}</EmptyDescription>
            </EmptyHeader>
            {page === "favorite" && !hasQuestionFilters && <EmptyContent><Button variant="outline" onClick={onBrowse}>{t("浏览题库")}</Button></EmptyContent>}
          </Empty>
        )
      )}
    </div>
  );
}
