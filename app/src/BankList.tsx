import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, Download, EllipsisVertical, Pencil, Play, Trash2, Upload } from "lucide-react";
import { api, errorMessage, type Bank, type BankPage, type UnfinishedSession } from "./api";
import { message, t, useI18n } from "./i18n";
import { toast } from "./notifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function BankList({ offset, onOffsetChange, revision, busy, ready, run, onOpenSession, onImport, onOpenQuestions, onPractice, onEdit, onDelete }: {
  offset: number;
  onOffsetChange: (offset: number) => void;
  revision: number;
  busy: boolean;
  ready: boolean;
  run: (job: () => Promise<void>) => void;
  onOpenSession: (id: string) => void;
  onImport: (bankId: string | null) => void;
  onOpenQuestions: (bankId: string) => void;
  onPractice: (bankId: string) => void;
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
  return <div className="space-y-5">
    <div className="mb-5 space-y-3" aria-busy={loading}>
      {loading && <p role="status">{t("加载中…")}</p>}
      {error != null && <div role="alert"><p>{errorMessage(error)}</p><Button variant="outline" onClick={() => setRefresh(value => value + 1)}>{t("重试")}</Button></div>}
      <nav aria-label={t("题库分页")} className="flex items-center justify-between gap-3">
        <span role="status" className="text-sm text-muted-foreground">{!loading && !error && t("{0}–{1} / {2} 条", { 0: page.total ? page.offset + 1 : 0, 1: page.offset + page.items.length, 2: page.total })}</span>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{t("刷新")}</Button>
          <Button variant="outline" disabled={busy || loading || !!error || page.offset === 0} onClick={() => onOffsetChange(Math.max(0, page.offset - 30))}>{t("上一页")}</Button>
          <Button variant="outline" disabled={busy || loading || !!error || page.offset + 30 >= page.total} onClick={() => onOffsetChange(page.offset + 30)}>{t("下一页")}</Button>
        </div>
      </nav>
    </div>
    {!loading && !error && unfinished && <Card className="border-primary/30 bg-primary/5"><CardContent className="flex items-center justify-between gap-4"><div className="min-w-0"><h2 className="font-semibold">{t("继续未完成的练习")}</h2><p className="mt-1 break-words text-sm text-muted-foreground">{t("{0} · 已提交 {1}/{2} 题", { 0: unfinished.title, 1: unfinished.answered, 2: unfinished.count })}</p></div><Button disabled={busy} onClick={() => onOpenSession(unfinished.id)}><Play />{t("继续练习")}</Button></CardContent></Card>}
    {!page.total && !loading && !error && ready && <Empty className="min-h-96 border border-dashed"><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>{t("从第一份题库开始")}</EmptyTitle><EmptyDescription>{t("已有 PractiQ ZIP 可离线导入；PDF、文本或图片可通过 AI 解析为题目。")}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => onImport(null)}><Upload />{t("导入第一份题库")}</Button></EmptyContent></Empty>}
    <div className="grid grid-cols-2 gap-5 xl:grid-cols-3">
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
            : <Button disabled={busy} onClick={() => onImport(bank.id)}><Upload />{t("导入题目")}</Button>}
        </CardContent>
      </Card>)}
    </div>
  </div>;
}
