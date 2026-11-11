import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronRight, CloudUpload, Download, EllipsisVertical, Pencil, Play, Trash2, Upload } from "lucide-react";
import { api, type Bank, type BankPage, type UnfinishedSession } from "./api";
import { message, t, useI18n } from "./i18n";
import { toast } from "./notifications";
import { SessionProgress } from "./SessionProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ListPagination } from "@/components/ui/pagination";
import { ErrorNotice } from "./OperationFeedback";

export function BankList({ offset, onOffsetChange, revision, onLoadingChange, busy, ready, run, onOpenSession, onAddExample, onImport, onCloudImport, onHistory, onOpenQuestions, onPractice, onEdit, onDelete }: {
  offset: number;
  onOffsetChange: (offset: number) => void;
  revision: number;
  onLoadingChange: (loading: boolean) => void;
  busy: boolean;
  ready: boolean;
  run: (job: () => Promise<void>) => void;
  onOpenSession: (id: string) => void;
  onAddExample: () => void;
  onImport: () => void;
  onCloudImport: () => void;
  onHistory: () => void;
  onOpenQuestions: (bankId: string) => void;
  onPractice: (bankId: string) => void;
  onEdit: (bank: Bank, trigger: HTMLElement | null) => void;
  onDelete: (bank: Bank, trigger: HTMLElement | null) => void;
}) {
  useI18n();
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const [page, setPage] = useState<BankPage>({ items: [], total: 0, offset: 0 });
  const [unfinished, setUnfinished] = useState<UnfinishedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    onLoadingChange(true);
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
      .finally(() => { if (active) { setLoading(false); onLoadingChange(false); } });
    return () => { active = false; };
  }, [offset, revision, refresh, onOffsetChange, onLoadingChange]);
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
      {error != null && <div role="alert" className="space-y-2"><ErrorNotice error={error} /><Button variant="outline" onClick={() => setRefresh(value => value + 1)}>{t("重试")}</Button></div>}
    </div>}
    {!loading && !error && unfinished && <Card className="resume-card"><CardContent className="resume-content"><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold">{t("继续未完成的练习")}</h2><p className="mt-1 break-words font-medium">{unfinished.title}</p><p className="mt-2 text-sm text-muted-foreground"><SessionProgress session={unfinished} onExpired={() => setRefresh(value => value + 1)}/></p><progress className="practice-progress mt-3" aria-label={t("继续未完成的练习")} max={unfinished.count || 1} value={unfinished.kind && unfinished.kind !== "practice" ? unfinished.draftAnswered ?? 0 : unfinished.answered}/></div><div className="resume-actions"><Button variant="ghost" disabled={busy} onClick={onHistory}>{t("查看全部")}<ChevronRight aria-hidden="true" /></Button><Button disabled={busy} onClick={() => onOpenSession(unfinished.id)}><Play aria-hidden="true" />{unfinished.kind && unfinished.kind !== "practice" ? t("继续考试") : t("继续练习")}</Button></div></CardContent></Card>}
    {!page.total && !loading && !error && ready && <Empty className="min-h-96 border border-dashed"><EmptyHeader><EmptyMedia><BookOpen /></EmptyMedia><EmptyTitle>{t("从第一个题库开始")}</EmptyTitle><EmptyDescription>{t("导入题库 ZIP 即可离线练习；也可在应用内导入 PDF、Word 或图片，由独立后端解析成题库。")}</EmptyDescription></EmptyHeader><EmptyContent><Button disabled={busy} onClick={onImport}><Upload />{t("导入题库 ZIP")}</Button><Button variant="outline" disabled={busy} onClick={onCloudImport}><CloudUpload />{t("导入文档")}</Button><Button variant="ghost" disabled={busy} onClick={onAddExample}><BookOpen />{t("添加示例题库")}</Button></EmptyContent></Empty>}
    <div className="bank-grid">
      {!loading && !error && page.items.map(bank => <Card key={bank.id} className="bank-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="min-w-0 break-words pt-1"><h2>{bank.title}</h2></CardTitle>
            <div className="flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button ref={node => { if (node) triggers.current.set(bank.id, node); else triggers.current.delete(bank.id); }} size="icon" variant="ghost" aria-label={t("题库操作 {0}", { 0: bank.title })} disabled={busy}><EllipsisVertical /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={busy || !bank.count} onSelect={() => run(async () => {
                    const result = await api({ type: "export_bank", bank_id: bank.id });
                    if (result) toast.success(message("题库已导出：{0}", { 0: result.path }));
                  })}><Download className="size-4" />{t("导出题库")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onEdit(bank, triggers.current.get(bank.id) ?? null)}><Pencil className="size-4" />{t("编辑题库")}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => onDelete(bank, triggers.current.get(bank.id) ?? null)}><Trash2 className="size-4" />{t("删除题库")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {bank.description && <CardDescription className="line-clamp-2">{bank.description}</CardDescription>}
          <p className="bank-count"><BookOpen aria-hidden="true" />{t("{0} 题", { 0: bank.count })}</p>
        </CardHeader>
        <CardContent className="bank-actions mt-auto">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenQuestions(bank.id)}>{t("查看题目")}<ChevronRight /></Button>
          {!!bank.count && <Button variant="outline" disabled={busy} onClick={() => onPractice(bank.id)}><Play />{t("开始练习")}</Button>}
        </CardContent>
      </Card>)}
    </div>
    <ListPagination
      ariaLabel={t("题库分页")}
      offset={page.offset}
      total={page.total}
      itemCount={page.items.length}
      disabled={busy || loading || !!error}
      onOffsetChange={onOffsetChange}
    />
  </div>;
}
