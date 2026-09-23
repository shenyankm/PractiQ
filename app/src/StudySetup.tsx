import { message, MessageError, t, useI18n } from "./i18n";
import { useEffect, useState } from "react";
import { api, errorMessage, type BankChoice, type Session, type SessionKind, type QuestionRow, type QuestionStats, type PaperPreview } from "./api";
import { cents, questionType, types } from "./paper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function StudySetup({banks, initialBank, initialFilter, initialMode="", initialSearch="", onClose, onStart, run, busy}: {banks:BankChoice[];initialBank:string|null;initialFilter:string;initialMode?:string;initialSearch?:string;onClose:()=>void;onStart:(s:Session)=>Promise<void>;run:(job:()=>Promise<void>)=>void;busy:boolean}) {
  useI18n();
  const [bankIds, setBanks] = useState<string[]>(() => initialBank ? [initialBank] : banks.filter(b => b.count > 0).map(b => b.id));
  const [kind, setKind] = useState<SessionKind>("practice");
  const [mode, setMode] = useState(initialMode), [filter, setFilter] = useState(initialFilter), [search, setSearch] = useState(initialSearch);
  const [rows, setRows] = useState<QuestionRow[]>([]), [loadedQuery, setLoadedQuery] = useState("");
  const [stats, setStats] = useState<QuestionStats>({ count: 0, types: {} });
  const [offset, setOffset] = useState(0), [rootCount, setRootCount] = useState(0), [loadedPage, setLoadedPage] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [count, setCount] = useState(20), [minutes, setMinutes] = useState(60), [random, setRandom] = useState(false);
  const [selection, setSelection] = useState("count"), [selected, setSelected] = useState<string[]>([]), [quotas, setQuotas] = useState<Record<string,number>>({});
  const [paper, setPaper] = useState<PaperPreview | null>(null);
  const [preview, setPreview] = useState<QuestionRow[]>([]), [scores, setScores] = useState<string[]>([]), [total, setTotal] = useState("100"), [budgets, setBudgets] = useState<Record<string,string>>({});
  const query = JSON.stringify({bank_ids: bankIds, search, mode, filter});
  const pageQuery = JSON.stringify({ query, offset });
  const pageLoading = selection === "manual" && loadedPage !== pageQuery;
  const loading = loadedQuery !== query || pageLoading;
  useEffect(() => {
    let active = true;
    setError(null); setPreview([]); setPaper(null); setSelected([]); setOffset(0);
    const values = JSON.parse(query);
    if (!values.bank_ids.length) {
      setRows([]); setStats({ count: 0, types: {} }); setCount(0); setLoadedQuery(query);
      return;
    }
    const timer = setTimeout(() => {
      void api({type:"question_stats", bank_id:null, ...values})
        .then(result => { if (active) { setStats(result); setCount(Math.min(20, result.count)); } })
        .catch(e => { if (active) { setStats({ count: 0, types: {} }); setError(e); } })
        .finally(() => { if (active) setLoadedQuery(query); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  useEffect(() => {
    if (selection !== "manual") return;
    let active = true;
    setRows([]);
    const values = JSON.parse(query);
    if (!values.bank_ids.length) { setRootCount(0); setLoadedPage(pageQuery); return; }
    const timer = setTimeout(() => {
      void api({type:"questions_page", bank_id:null, ...values, limit:30, offset})
        .then(result => { if (active) { setRows(result.items); setRootCount(result.total); setOffset(result.offset); } })
        .catch(e => { if (active) { setRootCount(0); setError(e); } })
        .finally(() => { if (active) setLoadedPage(pageQuery); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query, pageQuery, selection, offset]);
    const perform = (job:()=>Promise<void>) => run(async()=>{setError(null);try{await job();}catch(e){setError(e);}});
  const invalidate = () => { setPreview([]); setPaper(null); };
  async function generate(withBudgets = false) {
    const result = await api({type:"preview_paper", request:{bank_ids:bankIds,search,mode,filter,selection,count,quotas,question_ids:selected,random,total_cents:kind === "practice" ? 0 : cents(total),budgets:withBudgets ? Object.fromEntries(Object.entries(budgets).map(([k,v])=>[k,cents(v)])) : {}}});
    setPaper(result); setPreview(result.questions); setScores(result.scores.map(v=>(v/100).toFixed(2)));
    return result;
  }
  function start() {
    perform(async () => {
      const result = kind === "practice" ? await generate() : paper;
      if (!result) throw new MessageError(message("请先选择题目并生成预览"));
      const session=await api({type:"start_paper",paper:{question_ids:result.questionIds,digest:result.digest,kind,minutes:kind === "mock_exam" ? minutes : null,scores:kind === "practice" ? [] : scores.map(cents),total_cents:kind === "practice" ? 0 : cents(total)}});
      await onStart(session);
    });
  }
  const available = stats.count;
  const chosen = banks.filter(b => bankIds.includes(b.id));
  const selectedCount = selection === "count" ? count : selection === "manual" ? selected.length : Object.values(quotas).reduce((a, b) => a + b, 0);
  return <Dialog open onOpenChange={v => { if (!v && !busy) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader className="shrink-0 pr-8"><DialogTitle>{t("开始练习或考试")}</DialogTitle><DialogDescription>{kind === "practice" ? t("选择题数即可开始；跨题库和题型筛选在高级设置中。") : t("先预览题目与配分，再开始考试。更改选题或总分后需重新预览。")}</DialogDescription></DialogHeader>
      <fieldset disabled={busy} className="min-h-0 min-w-0 space-y-5 overflow-y-auto p-1 text-sm">
        <div className="grid grid-cols-2 gap-4">
          <label className="grid gap-2 font-medium">{t("模式")}<NativeSelect disabled={busy} className="w-full" value={kind} onChange={e => { setKind(e.target.value as SessionKind); invalidate(); }}><NativeSelectOption value="practice">{t("即时反馈练习")}</NativeSelectOption><NativeSelectOption value="self_test">{t("不限时自测")}</NativeSelectOption><NativeSelectOption value="mock_exam">{t("限时模考")}</NativeSelectOption></NativeSelect></label>
          {kind === "mock_exam" && <label className="grid gap-2 font-medium">{t("考试时长（分钟）")}<Input aria-label={t("考试分钟数")} type="number" min={1} max={1440} value={minutes} onChange={e => setMinutes(Number(e.target.value))}/></label>}
          {selection === "count" && <label className="grid gap-2 font-medium">{t("题目数量")}<Input type="number" min={1} max={Math.min(1000, available)} value={count} onChange={e => { setCount(Number(e.target.value)); invalidate(); }}/></label>}
          {kind !== "practice" && <label className="grid gap-2 font-medium">{t("考试总分")}<Input value={total} onChange={e => { setTotal(e.target.value); invalidate(); }}/></label>}
        </div>
        {selection !== "manual" && <label className="flex items-center gap-2">{t("出题顺序")}<NativeSelect disabled={busy} aria-label={t("出题顺序")} className="w-full max-w-40" value={random ? "random" : "ordered"} onChange={e => { setRandom(e.target.value === "random"); invalidate(); }}><NativeSelectOption value="ordered">{t("顺序练习")}</NativeSelectOption><NativeSelectOption value="random">{t("随机抽题")}</NativeSelectOption></NativeSelect></label>}
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">{t("高级设置 · 题库、筛选与选题方式")}</summary>
          <div className="mt-4 space-y-5">
            <fieldset><legend className="mb-2 font-medium">{t("选择题库")}</legend><div className="mb-3 flex gap-2"><Button variant="outline" onClick={() => { setBanks(banks.filter(b => b.count > 0).map(b => b.id)); invalidate(); }}>{t("全选可用题库")}</Button><Button variant="ghost" onClick={() => { setBanks([]); invalidate(); }}>{t("清空选择")}</Button></div>
              <div className="grid grid-cols-2 gap-2">{banks.map(b => <label className="flex min-w-0 items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5" key={b.id}><Checkbox className="mt-0.5" disabled={busy || !b.count} checked={bankIds.includes(b.id)} onCheckedChange={checked => { setBanks(checked === true ? [...bankIds, b.id] : bankIds.filter(id => id !== b.id)); invalidate(); }}/><span className="min-w-0 break-words">{b.title}（{b.count}）</span></label>)}</div>
            </fieldset>
            <div className="grid grid-cols-2 gap-4">
              <label className="grid gap-2">{t("题型")}<NativeSelect disabled={busy} className="w-full" value={mode} onChange={e => { setMode(e.target.value); invalidate(); }}><NativeSelectOption value="">{t("全部题型")}</NativeSelectOption><NativeSelectOption value="choice">{t("全部选择题")}</NativeSelectOption>{Object.entries(types()).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}</NativeSelect></label>
              <label className="grid gap-2">{t("范围")}<NativeSelect disabled={busy} className="w-full" value={filter} onChange={e => { setFilter(e.target.value); invalidate(); }}>{[["",t("全部")],["wrong",t("错题")],["favorite",t("收藏")],["unattempted",t("未做题")]].map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}</NativeSelect></label>
            </div>
            <label className="grid gap-2">{t("关键词")}<Input aria-label={t("搜索题目")} placeholder={t("搜索题干或关键词")} value={search} onChange={e => { setSearch(e.target.value); invalidate(); }}/></label>
            <label className="grid gap-2">{t("选题方式")}<NativeSelect disabled={busy} className="w-full" value={selection} onChange={e => { setSelection(e.target.value); invalidate(); }}><NativeSelectOption value="count">{t("总题数")}</NativeSelectOption><NativeSelectOption value="quota">{t("按题型数量")}</NativeSelectOption><NativeSelectOption value="manual">{t("手动选择")}</NativeSelectOption></NativeSelect></label>
            {selection === "quota" && <div className="grid grid-cols-3 gap-3">{Object.entries(types()).map(([k, v]) => <label className="grid gap-2" key={k}>{t("{0}（可用 {1}）", { 0: v, 1: stats.types[k] || 0 })}<Input aria-label={t(["reading","word_bank","cloze"].includes(k) ? "{0}组数" : "{0}题数", { 0: v })} type="number" min={0} value={quotas[k] || 0} onChange={e => { setQuotas({...quotas, [k]:Number(e.target.value)}); invalidate(); }}/></label>)}</div>}
            {selection === "manual" && <div className="space-y-2">{rows.map(q => <label key={q.id} className="flex items-start gap-2 rounded-md border p-3"><Checkbox className="mt-0.5" disabled={busy || loading} checked={selected.includes(q.id)} onCheckedChange={checked => { setSelected(checked === true ? [...selected, q.id] : selected.filter(id => id !== q.id)); invalidate(); }}/>{q.question.stem || t("题干缺失")}</label>)}
              {rootCount > 30 && <div className="flex items-center justify-between gap-3">
                <span>{t("第 {0}–{1} 题", { 0: offset + 1, 1: Math.min(offset + 30, rootCount) })}</span>
                <div className="flex gap-2"><Button variant="outline" disabled={busy || pageLoading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 30))}>{t("上一页")}</Button><Button variant="outline" disabled={busy || pageLoading || offset + 30 >= rootCount} onClick={() => setOffset(value => value + 30)}>{t("下一页")}</Button></div>
              </div>}
            </div>}
          </div>
        </details>
        {kind !== "practice" && !!preview.length && <section className="space-y-4 rounded-xl border p-4"><h3 className="font-semibold">{t("选题与配分预览 · {0} 题", { 0: preview.length })}</h3><p className="text-muted-foreground">{t("材料题按子题计数，原卷分值仅供参考。")}</p>
          <details><summary className="cursor-pointer">{t("按题型分配总分")}</summary><div className="my-3 grid grid-cols-3 gap-3">{Object.keys(types()).filter(k => preview.some(q => (q.rootType || questionType(q.question))===k)).map(k => <label className="grid gap-2" key={k}>{t("{0}预算", { 0: types()[k] || t("未分类") })}<Input aria-label={t("{0}预算", { 0: types()[k] || k })} value={budgets[k] || "0"} onChange={e => setBudgets({...budgets, [k]:e.target.value})}/></label>)}</div><Button variant="outline" onClick={() => perform(async () => { await generate(true); })}>{t("按题型预算重新配分（覆盖逐题修改）")}</Button></details>
          <div className="divide-y">{preview.map((q, i) => <div key={q.id} className="flex items-center gap-3 py-3"><span className="min-w-0 flex-1 break-words">{i + 1}. {q.question.stem || t("题干缺失")}{q.question.sourceScore != null && t("（原卷 {0} 分）", { 0: q.question.sourceScore })}</span><Input className="w-24 shrink-0" aria-label={t("第 {0} 题分值", { 0: i + 1 })} value={scores[i]} onChange={e => setScores(scores.map((s, j) => j === i ? e.target.value : s))}/></div>)}</div>
        </section>}
      </fieldset>
      <div className="shrink-0 space-y-3 border-t pt-3">
        <p role="status" className="text-sm">{!bankIds.length ? t("请选择至少一个题库") : loading ? t("正在加载题目…") : <>{t("已选 {0} · 可用 {1} 题 · 本次 {2} 题{3}{4}{5}", { 0: chosen.length === 1 ? chosen[0].title : t("{0} 个题库", { 0: chosen.length }), 1: available, 2: selectedCount, 3: filter && ` · ${{wrong:t("错题"), favorite:t("收藏"), unattempted:t("未做题")}[filter]}`, 4: mode && ` · ${types()[mode] || t("选择题")}`, 5: search && t(" · 关键词：{0}", { 0: search }) })}</>}</p>
        {!!filter && ["reading", "word_bank", "cloze"].some(type => stats.types[type]) && <p className="text-sm text-muted-foreground">{t("命中子题时纳入完整题组，包含组内其他子题。")}</p>}
        {error != null && <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>{t("取消")}</Button>{kind !== "practice" && <Button variant={preview.length ? "outline" : "default"} disabled={busy || loading || !available || !bankIds.length} onClick={() => perform(async () => { await generate(); })}>{preview.length ? t("重新生成预览") : t("预览题目与配分")}</Button>}{(kind === "practice" || !!preview.length) && <Button disabled={busy || loading || !available || !bankIds.length} onClick={start}>{kind === "practice" ? t("立即开始") : t("开始考试")}</Button>}</div>
      </div>
    </DialogContent>
  </Dialog>;
}
