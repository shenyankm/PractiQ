import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, Download, EllipsisVertical, Pencil, Play, Trash2, Upload } from "lucide-react";
import { api, errorMessage, type Bank, type BankPage, type UnfinishedSession } from "./api";
import { message, t, useI18n } from "./i18n";
import { toast } from "./notifications";
import { SessionProgress } from "./SessionProgress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function BankList({ offset, onOffsetChange, revision, busy, ready, run, onOpenSession, onAddExample, onImport, onHistory, onOpenQuestions, onPractice, onPracticeUnattempted, onEdit, onDelete }: {
  offset: number;
  onOffsetChange: (offset: number) => void;
  revision: number;
  busy: boolean;
  ready: boolean;
  run: (job: () => Promise<void>) => void;
  onOpenSession: (id: string) => void;
  onAddExample: () => void;
  onImport: (bankId?: string) => void;
  onHistory: () => void;
  onOpenQuestions: (bankId: string) => void;
  onPractice: (bankId: string) => void;
  onPracticeUnattempted: (bankId: string) => void;
  onEdit: (bank: Bank) => void;
  onDelete: (bank: Bank) => void;
}) {
  useI18n();
  const [page, setPage] = useState<BankPage>({ items: [], total: 0, offset: 0 });
  const [unfinished, setUnfinished] = useState<UnfinishedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      api({ type: "banks_page", limit: 30, offset }),
      api({ type: "unfinished_session" }),
    ]).then(([result, pending]) => {
      if (active) {
        setPage(result);
        setUnfinished(pending);
        onOffsetChange(result.offset);
      }
    }).catch(cause => { if (active) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [offset, revision, refresh, onOffsetChange]);
  const timedSession = unfinished?.deadlineAt != null ? unfinished.id : null;
  useEffect(() => {
    if (!timedSession) return;
    let active = true, loading = false;
    const refreshClock = () => {
      if (loading) return;
      loading = true;
      void api({ type: "unfinished_session" }).then(pending => {
        if (active) setUnfinished(pending);
      }).catch(() => {}).finally(() => { loading = false; });
    };
    const timer = window.setInterval(refreshClock, 3000);
    window.addEventListener("focus", refreshClock);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refreshClock); };
  }, [timedSession]);
  return <div className="space-y-5">
    {(loading || error != null) && <div className="space-y-3" aria-busy={loading}>
      {loading && <p role="status">{t("加载中…")}</p>}
      {error != null && <div role="alert"><p>{errorMessage(error)}</p><Button variant="outline" onClick={() => setRefresh(value => value + 1)}>{t("重试")}</Button></div>}
    </div>}
    {!loading && !error && unfinished && <Card className="border-primary/30 bg-primary/5"><CardContent className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center"><div className="min-w-0"><h2 className="font-semibold">{t("继续未完成的练习")}</h2><p className="mt-1 break-words text-sm text-muted-foreground">{unfinished.title} · <SessionProgress session={unfinished} onExpired={() => setRefresh(value => value + 1)}/></p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={onHistory}>{t("查看全部")}</Button><Button disabled={busy} onClick={() => onOpenSession(unfinished.id)}><Play />{unfinished.kind && unfinished.kind !== "practice" ? t("继续考试") : t("继续练习")}</Button></div></CardContent></Card>}
    {!page.total && !loading && !error && ready && <Empty className="min-h-96 border border-dashed"><EmptyHeader><EmptyMedia><BookOpen /></EmptyMedia><EmptyTitle>{t("从第一份题库开始")}</EmptyTitle><EmptyDescription>{t("导入题库 ZIP 或添加示例题库，开始离线练习。文档解析请使用独立 AI 服务网页。")}</EmptyDescription></EmptyHeader><EmptyContent><Button disabled={busy} onClick={() => onImport()}><Upload />{t("导入题库 ZIP")}</Button><Button variant="outline" disabled={busy} onClick={onAddExample}><BookOpen />{t("添加示例题库")}</Button></EmptyContent></Empty>}
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      {!loading && !error && page.items.map(bank => <Card key={bank.id}>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="min-w-0 break-words pt-1">{bank.title}</CardTitle>
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant="secondary">{t("{0} 题", { 0: bank.count })}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={t("题库操作 {0}", { 0: bank.title })} disabled={busy}><EllipsisVertical /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={busy || !bank.count} onSelect={() => run(async () => {
                    const result = await api({ type: "export_bank", bank_id: bank.id });
                    if (result) toast.success(message("题库已导出：{0}", { 0: result.path }));
                  })}><Download className="size-4" />{t("导出题库 ZIP")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEdit(bank)}><Pencil className="size-4" />{t("编辑题库")}</DropdownMenuItem>
                  <DropdownMenuItem disabled={busy || !bank.count} onSelect={() => onPracticeUnattempted(bank.id)}><Play className="size-4" />{t("练习未做题")}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDelete(bank)}><Trash2 className="size-4" />{t("删除题库")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <CardDescription className="line-clamp-2 min-h-10">{bank.description}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenQuestions(bank.id)}>{t("查看题目")}<ChevronRight /></Button>
          {bank.count ? <Button disabled={busy} onClick={() => onPractice(bank.id)}><Play />{t("开始练习")}</Button>
            : <Button disabled={busy} onClick={() => onImport(bank.id)}><Upload />{t("导入题库 ZIP")}</Button>}
        </CardContent>
      </Card>)}
    </div>
    <div className="flex items-center justify-end gap-3">
      {page.total > 30 && (
        <nav aria-label={t("题库分页")} className="flex flex-1 flex-wrap items-center justify-between gap-3">
          <span role="status" className="text-sm text-muted-foreground">{!loading && !error && t("{0}–{1} / {2} 条", { 0: page.total ? page.offset + 1 : 0, 1: page.offset + page.items.length, 2: page.total })}</span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || loading || !!error || page.offset === 0} onClick={() => onOffsetChange(Math.max(0, page.offset - 30))}>{t("上一页")}</Button>
            <Button variant="outline" disabled={busy || loading || !!error || page.offset + 30 >= page.total} onClick={() => onOffsetChange(page.offset + 30)}>{t("下一页")}</Button>
          </div>
        </nav>
      )}
      <Button variant="outline" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{t("刷新")}</Button>
    </div>
  </div>;
}
