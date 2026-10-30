import { useCallback, useEffect, useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { api, type SessionPage, type SessionFilter } from "./api";
import { date, duration, t, useI18n } from "./i18n";
import { SessionProgress } from "./SessionProgress";
import { ErrorNotice } from "./OperationFeedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function useHistoryPage(active: boolean, revision: number) {
  const [sessionPage, setSessionPage] = useState<SessionPage>({ items: [], total: 0, offset: 0 });
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [readRevision, setReadRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setSummaryLoading(true);
    setSummaryError(null);
    void api({ type: "sessions_page", limit: 30, offset: sessionOffset, ...(sessionFilter === "all" ? {} : { filter: sessionFilter }) })
      .then(result => { if (current) { setSessionPage(result); setSessionOffset(result.offset); } })
      .catch(error => { if (current) setSummaryError(error); })
      .finally(() => { if (current) setSummaryLoading(false); });
    return () => { current = false; };
  }, [active, sessionOffset, revision, readRevision, sessionFilter]);
  const hasTimedSession = sessionPage.items.some(session => session.deadlineAt != null && session.finishedAt == null && session.submittedAt == null);
  useEffect(() => {
    if (!active || !hasTimedSession) return;
    let current = true, loading = false;
    const refreshClock = () => {
      if (loading) return;
      loading = true;
      void api({ type: "sessions_page", limit: 30, offset: sessionOffset, ...(sessionFilter === "all" ? {} : { filter: sessionFilter }) })
        .then(result => { if (current) { setSessionPage(result); setSessionOffset(result.offset); } })
        .catch(() => {}).finally(() => { loading = false; });
    };
    const timer = window.setInterval(refreshClock, 3000);
    window.addEventListener("focus", refreshClock);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", refreshClock); };
  }, [active, hasTimedSession, sessionOffset, sessionFilter]);
  const refresh = useCallback(() => { setReadRevision(value => value + 1); }, []);
  const setFilter = useCallback((value: SessionFilter) => { setSessionFilter(value); setSessionOffset(0); }, []);
  return { sessionPage, sessionOffset, setSessionOffset, sessionFilter, setFilter, summaryLoading, summaryError, refresh };
}

export function HistoryPage({ state, busy, onOpen, onBrowse }: {
  state: ReturnType<typeof useHistoryPage>;
  busy: boolean;
  onOpen: (id: string) => void;
  onBrowse: () => void;
}) {
  useI18n();
  const { sessionPage, setSessionOffset, sessionFilter, summaryLoading, summaryError } = state;
  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3"><Label htmlFor="history-filter">{t("练习记录状态")}</Label><NativeSelect id="history-filter" value={sessionFilter} disabled={busy} onValueChange={value => { state.setFilter(value as SessionFilter); }}>
      <NativeSelectOption value="all">{t("全部")}</NativeSelectOption><NativeSelectOption value="active">{t("进行中")}</NativeSelectOption><NativeSelectOption value="review">{t("待核对")}</NativeSelectOption><NativeSelectOption value="finished">{t("已结束")}</NativeSelectOption>
    </NativeSelect></div><Button variant="outline" disabled={busy || summaryLoading} onClick={() => state.refresh()}>{t("刷新")}</Button></div>
    {(summaryLoading || summaryError != null) && (
      <div className="mb-5 space-y-3" aria-busy={summaryLoading}>
        {summaryLoading && <p role="status">{t("加载中…")}</p>}
        {summaryError != null && <div role="alert" className="space-y-2"><ErrorNotice error={summaryError} /><Button variant="outline" onClick={() => state.refresh()}>{t("重试")}</Button></div>}
      </div>
    )}
    {!summaryLoading && !summaryError &&
      (sessionPage.items.length ? (
        <div className="space-y-3">
          {sessionPage.items.map((s) => (
            <Card key={s.id} className="py-3">
              <CardContent className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="min-w-0 break-words font-medium">{s.title}</h2>
                    <Badge variant="secondary">
                      {s.finishedAt ? t("已结束") : s.submittedAt ? t("待核对") : t("进行中")}
                    </Badge>
                  </div>
                  <div className="text-sm tabular-nums">
                    {s.finishedAt || s.submittedAt ? <p className="font-semibold">{s.kind && s.kind !== "practice"
                      ? t("{0} {1} / {2} 分", { 0: s.pendingGrades ? t("预估成绩") : t("成绩"), 1: (s.earnedCents || 0) / 100, 2: (s.totalCents || 0) / 100 })
                      : s.graded ? t("已判定 {0} 题，答对 {1} 题 · 正确率 {2}%", { 0: s.graded, 1: s.correct, 2: Math.round((s.correct / s.graded) * 100) }) : t("暂无已判定题目")}</p>
                      : <SessionProgress session={s} onExpired={() => state.refresh()}/>}
                  </div>
                  {!!(s.finishedAt || s.submittedAt) && <p className="text-sm text-muted-foreground">{t("未答/跳过 {0} 题 · {1} {2} 题", {0:s.skipped, 1:s.kind && s.kind !== "practice" ? t("待评分") : t("未判定"), 2:s.kind && s.kind !== "practice" ? s.pendingGrades ?? 0 : Math.max(0,s.answered-s.graded-s.skipped)})}</p>}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>{date(s.createdAt)} · {duration(s.elapsedMs)}</span>
                    {!!(s.finishedAt || s.submittedAt) && <SessionProgress session={s} active={false}/>}
                  </div>
                  {!!(s.answered || s.finishedAt || s.submittedAt) && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("判定详情")}</summary><p className="mt-2">{t("自动判定 {0} · 自评 {1} · 跳过 {2} · 未判定 {3}", { 0: s.autoGraded, 1: s.selfGraded, 2: s.skipped, 3: s.kind && s.kind !== "practice" ? s.pendingGrades : s.answered - s.graded - s.skipped })}</p></details>}
                </div>
                <Button
                  className="shrink-0"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onOpen(s.id)}
                >
                  {s.finishedAt ? t("查看记录") : s.submittedAt ? t("核对评分") : s.kind && s.kind !== "practice" ? t("继续考试") : t("继续练习")}
                  <ChevronRight />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Empty className="min-h-96 border border-dashed">
          <EmptyHeader>
            <EmptyMedia><History /></EmptyMedia>
            <EmptyTitle>{sessionFilter === "all" ? t("还没有练习记录") : t("没有符合此状态的记录")}</EmptyTitle>
            <EmptyDescription>{sessionFilter === "all" ? t("开始练习后，即可在这里继续作答或回顾结果。") : t("尝试选择其他状态。")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button variant="outline" disabled={busy} onClick={() => { if (sessionFilter === "all") onBrowse(); else { state.setFilter("all"); } }}>{sessionFilter === "all" ? t("查看题库") : t("查看全部记录")}</Button></EmptyContent>
        </Empty>
      ))}
    {sessionPage.total > 30 && <div className="mt-5 flex items-center justify-end gap-3">
        <nav aria-label={t("练习记录分页")} className="flex flex-1 items-center justify-between gap-3">
          <span role="status" className="text-sm text-muted-foreground">{!summaryLoading && !summaryError && t("{0}–{1} / {2} 条", {0: sessionPage.total ? sessionPage.offset + 1 : 0, 1: sessionPage.offset + sessionPage.items.length, 2: sessionPage.total})}</span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || summaryLoading || !!summaryError || sessionPage.offset === 0} onClick={() => setSessionOffset(Math.max(0, sessionPage.offset - 30))}>{t("上一页")}</Button>
            <Button variant="outline" disabled={busy || summaryLoading || !!summaryError || sessionPage.offset + 30 >= sessionPage.total} onClick={() => setSessionOffset(sessionPage.offset + 30)}>{t("下一页")}</Button>
          </div>
        </nav>
    </div>}
  </>;
}
