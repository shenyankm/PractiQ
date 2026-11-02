import { useEffect, useState } from "react";
import { api, type LearningCounts, type LearningOverview, type Session } from "./api";
import { date, number, t } from "./i18n";
import { types } from "./paper";
import { causeNames } from "./QuestionNotes";
import { ErrorNotice } from "./OperationFeedback";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function LearningPage({ revision, busy, run, onStart, onPractice, onSettings }: {
  revision: number; busy: boolean; run: (job: () => Promise<void>) => void;
  onStart: (session: Session) => Promise<void>;
  onPractice: (bank: string | null, mode: string) => void;
  onSettings: () => void;
}) {
  const [days, setDays] = useState<7 | 30>(7), [cause, setCause] = useState("");
  const [data, setData] = useState<LearningOverview | null>(null);
  const [error, setError] = useState<unknown>(null), [retry, setRetry] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    const today = new Date(); today.setHours(0,0,0,0);
    const since = new Date(today); since.setDate(since.getDate() - days + 1);
    void api({type:"learning_overview",days,today_start:today.getTime(),since:since.getTime()}).then(result => { if (active) setData(result); })
      .catch(error => { if (active) setError(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days,revision,retry]);
  const review = (data?.review ?? []).filter(item => !cause || item.causes.some(value => value === cause));
  let size = 0;
  const selected = review.filter(item => { if (size + item.count > 1000) return false; size += item.count; return true; });
  const reasons = {repeated_wrong:t("反复出错"),wrong:t("最近答错"),stale:t("较久未练")};
  const grading = [{label:t("自动判定"),score:data?.counts.auto},{label:t("自评"),score:data?.counts.selfAssessed},{label:t("AI 评分"),score:data?.counts.ai},{label:t("人工评分"),score:data?.counts.manual}];
  return <div className="learning-page space-y-6" aria-busy={loading}>
    <div className="flex justify-end"><Button variant="outline" disabled={busy || loading} onClick={() => setRetry(value=>value+1)}>{t("刷新")}</Button></div>
    {error != null && <div role="alert" className="space-y-2"><ErrorNotice error={error}/><Button variant="outline" onClick={() => setRetry(value=>value+1)}>{t("重试")}</Button></div>}
    {loading && <p role="status">{t("加载中…")}</p>}
    {!loading && error == null && data && <>
      {data.backup.due && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"><p>{data.backup.lastBackupAt == null ? t("尚未导出学习数据备份。") : t("上次备份后新增 {0} 次作答、修改 {1} 条笔记。",{0:data.backup.newAttempts,1:data.backup.changedNotes})}</p><Button variant="outline" disabled={busy} onClick={onSettings}>{t("前往备份")}</Button></div>}
      <section className="space-y-3" aria-labelledby="today-review-title">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="today-review-title" className="text-lg font-medium">{t("今日复习")}</h2><Button disabled={busy || !selected.length} onClick={() => run(async () => {
          const preview = await api({type:"preview_paper",request:{bank_ids:[...new Set(selected.map(item=>item.bankId))],search:"",mode:"",filter:"",selection:"manual",count:0,quotas:{},question_ids:selected.map(item=>item.rootId),random:false,total_cents:0}});
          await onStart(await api({type:"start_paper",paper:{question_ids:preview.questionIds,digest:preview.digest,kind:"practice",minutes:null,scores:[],total_cents:0}}));
        })}>{t("开始复习 {0} 题",{0:size})}</Button></div>
        <div className="flex flex-wrap items-center gap-3"><Label htmlFor="review-cause-filter">{t("按错因筛选")}</Label><NativeSelect id="review-cause-filter" value={cause} disabled={busy} onValueChange={setCause}><NativeSelectOption value="">{t("全部错因")}</NativeSelectOption>{Object.entries(causeNames()).map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></div>
        {review.length ? <ul className="divide-y rounded-lg border px-4">{review.slice(0,5).map(item => <li key={item.rootId} className="flex items-start justify-between gap-4 py-3"><div className="min-w-0"><p className="line-clamp-2 text-sm">{item.stem || t("原文未提供题干")}</p><p className="mt-1 text-xs text-muted-foreground">{item.bankTitle} · {reasons[item.reason]} · {t("{0} 题",{0:item.count})}</p></div><span className="shrink-0 text-xs text-muted-foreground tabular-nums">{date(item.lastAnsweredAt)}</span></li>)}</ul> : <div className="rounded-lg border p-4 text-sm"><p>{cause ? t("当前推荐中没有符合此错因的题目。") : t("暂无待复习题目。")}</p><Button variant="outline" className="mt-3" disabled={busy} onClick={() => onPractice(null,"")}>{t("开始新的练习")}</Button></div>}
        {review.length > 5 && <details className="text-sm"><summary className="cursor-pointer">{t("查看其余 {0} 组",{0:review.length-5})}</summary><ul className="mt-2 space-y-2">{review.slice(5).map(item=><li key={item.rootId}>{item.stem || t("原文未提供题干")} · {reasons[item.reason]} · {t("{0} 题",{0:item.count})}</li>)}</ul></details>}
      </section>
      <section className="space-y-4 border-t pt-5" aria-labelledby="learning-statistics-title">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="learning-statistics-title" className="text-lg font-medium">{t("学习统计与薄弱项")}</h2><div className="flex items-center gap-3"><Label htmlFor="learning-days">{t("统计范围")}</Label><NativeSelect id="learning-days" disabled={busy} value={String(days)} onValueChange={value=>setDays(Number(value) as 7 | 30)}><NativeSelectOption value="7">{t("近 7 天")}</NativeSelectOption><NativeSelectOption value="30">{t("近 30 天")}</NativeSelectOption></NativeSelect></div></div>
        <p className="text-xs text-muted-foreground">{date(data.since)} — {date(data.through)}</p>
        <dl className="grid grid-cols-3 divide-x rounded-lg border py-4 text-center tabular-nums">{[[t("已提交作答"),data.counts.submitted],[t("未判定"),data.counts.ungraded],[t("跳过"),data.counts.skipped]].map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-2xl">{number(Number(value))}</dd></div>)}</dl>
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <div className="space-y-3"><h3 className="font-medium">{t("按题库")}</h3><Breakdown rows={data.banks.map(bank=>({key:bank.id,label:bank.title,counts:bank.counts,disabled:!bank.available,practice:()=>onPractice(bank.id,"")}))} busy={busy}/></div>
          <div className="space-y-3"><h3 className="font-medium">{t("按题型")}</h3><Breakdown rows={data.kinds.map(row=>({key:row.kind,label:types()[row.kind] || t("未识别题型"),counts:row.counts,practice:()=>onPractice(null,row.kind)}))} busy={busy}/></div>
        </div>
        <details className="text-sm"><summary className="cursor-pointer">{t("判定方式明细")}</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-muted-foreground"><th className="py-2 text-left font-normal">{t("判定方式")}</th><th className="text-right font-normal">{t("已判定")}</th><th className="text-right font-normal">{t("答对")}</th></tr></thead><tbody>{grading.map(({label,score})=><tr key={label} className="border-t"><td className="py-2">{label}</td><td className="text-right tabular-nums">{number(score?.graded ?? 0)}</td><td className="text-right tabular-nums">{number(score?.correct ?? 0)}</td></tr>)}</tbody></table></div></details>
      </section>
    </>}
  </div>;
}

function Breakdown({rows,busy}: {rows:{key:string;label:string;counts:LearningCounts;disabled?:boolean;practice:()=>void}[];busy:boolean}) {
  const ranked = [...rows].sort((a,b) => {
    const rate = (c:LearningCounts) => c.auto.graded ? c.auto.correct/c.auto.graded : 2;
    return rate(a.counts)-rate(b.counts) || b.counts.submitted-a.counts.submitted;
  });
  if (!rows.length) return <p className="rounded-lg border p-4 text-sm text-muted-foreground">{t("此时间范围内暂无已提交作答。")}</p>;
  return <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><thead><tr className="text-muted-foreground"><th className="p-3 text-left font-normal">{t("范围")}</th><th className="p-3 text-right font-normal">{t("作答次数")}</th><th className="p-3 text-right font-normal">{t("自动判定正确率")}</th><th className="p-3 text-right font-normal">{t("操作")}</th></tr></thead><tbody>{ranked.map(row=><tr key={row.key} className="border-t"><td className="max-w-60 break-words p-3">{row.label}</td><td className="p-3 text-right tabular-nums">{number(row.counts.submitted)}</td><td className="whitespace-nowrap p-3 text-right tabular-nums">{row.counts.auto.graded ? `${Math.round(row.counts.auto.correct/row.counts.auto.graded*100)}%` : "—"}<span className="block text-xs text-muted-foreground">{row.counts.auto.correct} / {row.counts.auto.graded}</span></td><td className="p-3 text-right"><Button variant="outline" size="sm" disabled={busy || row.disabled} onClick={row.practice}>{t("专项练习")}</Button></td></tr>)}</tbody></table></div>;
}
