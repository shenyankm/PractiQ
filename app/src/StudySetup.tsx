import { useEffect, useState } from "react";
import { api, errorMessage, type Bank, type Session, type SessionKind, type QuestionRow } from "./api";
import { allocate, cents, questionType, sample, types } from "./paper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function StudySetup({banks, initialBank, initialFilter, initialMode="", initialSearch="", onClose, onStart, run, busy}: {banks:Bank[];initialBank:string|null;initialFilter:string;initialMode?:string;initialSearch?:string;onClose:()=>void;onStart:(s:Session)=>Promise<void>;run:(job:()=>Promise<void>)=>void;busy:boolean}) {
  const [bankIds, setBanks] = useState<string[]>(initialBank ? [initialBank] : banks.filter(b => b.count > 0).map(b => b.id));
  const [kind, setKind] = useState<SessionKind>("practice");
  const [mode, setMode] = useState(initialMode), [filter, setFilter] = useState(initialFilter), [search, setSearch] = useState(initialSearch);
  const [rows, setRows] = useState<QuestionRow[]>([]), [loadedQuery, setLoadedQuery] = useState("");
  const [error, setError] = useState("");
  const [count, setCount] = useState(20), [minutes, setMinutes] = useState(60), [random, setRandom] = useState(false);
  const [selection, setSelection] = useState("count"), [selected, setSelected] = useState<string[]>([]), [quotas, setQuotas] = useState<Record<string,number>>({});
  const [preview, setPreview] = useState<QuestionRow[]>([]), [scores, setScores] = useState<string[]>([]), [total, setTotal] = useState("100"), [budgets, setBudgets] = useState<Record<string,string>>({});
  const query = JSON.stringify({bank_ids: bankIds, search, mode, filter});
  const loading = loadedQuery !== query;
  useEffect(() => {
    let active = true;
    setError(""); setPreview([]); setSelected([]);
    const values = JSON.parse(query);
    if (!values.bank_ids.length) {
      setRows([]); setCount(0); setLoadedQuery(query);
      return;
    }
    void api<QuestionRow[]>({type:"questions", bank_id:null, ...values})
      .then(q => { if (active) { setRows(q); setCount(Math.min(20, q.length)); } })
      .catch(e => { if (active) { setRows([]); setError(errorMessage(e)); } })
      .finally(() => { if (active) setLoadedQuery(query); });
    return () => { active = false; };
  }, [query]);
  const attempt = (job: () => void) => { try { setError(""); job(); } catch (e) { setError(errorMessage(e)); } };
  const invalidate = () => setPreview([]);
  function pick() {
    if (loading || !bankIds.length) throw new Error("请选择至少一个题库并等待题目加载完成");
    const picked = selection === "manual" ? rows.filter(q => selected.includes(q.id))
      : selection === "quota" ? Object.keys(types).flatMap(k => quotas[k] ? sample(rows.filter(q => questionType(q.question) === k), quotas[k], random) : [])
      : sample(rows, count, random);
    if (!picked.length || picked.length > 1000) throw new Error("请选择 1–1000 题");
    return picked;
  }
  function generate() {
    attempt(() => {
      const picked = pick(), values = allocate(picked, cents(total));
      setScores(values.map(v => (v / 100).toFixed(2))); setPreview(picked);
      const next: Record<string, number> = {};
      picked.forEach((q, i) => { const k = questionType(q.question); next[k] = (next[k] || 0) + values[i]; });
      setBudgets(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, (v / 100).toFixed(2)])));
    });
  }
  function start() {
    attempt(() => {
      const picked = kind === "practice" ? pick() : preview;
      if (loading || !bankIds.length || !picked.length) throw new Error("请先选择题目并生成预览");
      if (kind === "mock_exam" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) throw new Error("考试时长须为 1–1440 分钟");
      const values = kind === "practice" ? [] : scores.map(cents), target = kind === "practice" ? 0 : cents(total);
      if (kind !== "practice" && (values.some(v => v < 1) || values.reduce((a, b) => a + b, 0) !== target)) throw new Error("每题至少 0.01 分，逐题分值之和必须等于总分");
      run(async () => onStart(await api<Session>({type:"start_paper", paper:{question_ids:picked.map(q => q.id), kind, minutes:kind === "mock_exam" ? minutes : null, scores:values, total_cents:target}})));
    });
  }
  const chosen = banks.filter(b => bankIds.includes(b.id));
  const selectedCount = selection === "count" ? count : selection === "manual" ? selected.length : Object.values(quotas).reduce((a, b) => a + b, 0);
  return <Dialog open onOpenChange={v => { if (!v && !busy) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader className="shrink-0 pr-8"><DialogTitle>开始练习或考试</DialogTitle><DialogDescription>{kind === "practice" ? "选择题数即可开始；跨题库和题型筛选在高级设置中。" : "先预览题目与配分，再开始考试。更改选题或总分后需重新预览。"}</DialogDescription></DialogHeader>
      <fieldset disabled={busy} className="min-h-0 min-w-0 space-y-5 overflow-y-auto p-1 text-sm">
        <div className="grid grid-cols-2 gap-4">
          <label className="grid gap-2 font-medium">模式<NativeSelect disabled={busy} className="w-full" value={kind} onChange={e => { setKind(e.target.value as SessionKind); invalidate(); }}><NativeSelectOption value="practice">即时反馈练习</NativeSelectOption><NativeSelectOption value="self_test">不限时自测</NativeSelectOption><NativeSelectOption value="mock_exam">限时模考</NativeSelectOption></NativeSelect></label>
          {kind === "mock_exam" && <label className="grid gap-2 font-medium">考试时长（分钟）<Input aria-label="考试分钟数" type="number" min={1} max={1440} value={minutes} onChange={e => setMinutes(Number(e.target.value))}/></label>}
          {selection === "count" && <label className="grid gap-2 font-medium">题目数量<Input type="number" min={1} max={Math.min(1000, rows.length)} value={count} onChange={e => { setCount(Number(e.target.value)); invalidate(); }}/></label>}
          {kind !== "practice" && <label className="grid gap-2 font-medium">考试总分<Input value={total} onChange={e => { setTotal(e.target.value); invalidate(); }}/></label>}
        </div>
        {selection !== "manual" && <label className="flex items-center gap-2">出题顺序<NativeSelect disabled={busy} aria-label="出题顺序" className="w-full max-w-40" value={random ? "random" : "ordered"} onChange={e => { setRandom(e.target.value === "random"); invalidate(); }}><NativeSelectOption value="ordered">顺序练习</NativeSelectOption><NativeSelectOption value="random">随机抽题</NativeSelectOption></NativeSelect></label>}
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">高级设置 · 题库、筛选与选题方式</summary>
          <div className="mt-4 space-y-5">
            <fieldset><legend className="mb-2 font-medium">选择题库</legend><div className="mb-3 flex gap-2"><Button variant="outline" onClick={() => { setBanks(banks.filter(b => b.count > 0).map(b => b.id)); invalidate(); }}>全选可用题库</Button><Button variant="ghost" onClick={() => { setBanks([]); invalidate(); }}>清空选择</Button></div>
              <div className="grid grid-cols-2 gap-2">{banks.map(b => <label className="flex min-w-0 items-start gap-2 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5" key={b.id}><Checkbox className="mt-0.5" disabled={busy || !b.count} checked={bankIds.includes(b.id)} onCheckedChange={checked => { setBanks(checked === true ? [...bankIds, b.id] : bankIds.filter(id => id !== b.id)); invalidate(); }}/><span className="min-w-0 break-words">{b.title}（{b.count}）</span></label>)}</div>
            </fieldset>
            <div className="grid grid-cols-2 gap-4">
              <label className="grid gap-2">题型<NativeSelect disabled={busy} className="w-full" value={mode} onChange={e => { setMode(e.target.value); invalidate(); }}><NativeSelectOption value="">全部题型</NativeSelectOption><NativeSelectOption value="choice">全部选择题</NativeSelectOption>{Object.entries(types).map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}</NativeSelect></label>
              <label className="grid gap-2">范围<NativeSelect disabled={busy} className="w-full" value={filter} onChange={e => { setFilter(e.target.value); invalidate(); }}>{[["","全部"],["wrong","错题"],["favorite","收藏"],["unattempted","未做题"]].map(([k, v]) => <NativeSelectOption key={k} value={k}>{v}</NativeSelectOption>)}</NativeSelect></label>
            </div>
            <label className="grid gap-2">关键词<Input aria-label="搜索题目" placeholder="搜索题干或关键词" value={search} onChange={e => { setSearch(e.target.value); invalidate(); }}/></label>
            <label className="grid gap-2">选题方式<NativeSelect disabled={busy} className="w-full" value={selection} onChange={e => { setSelection(e.target.value); invalidate(); }}><NativeSelectOption value="count">总题数</NativeSelectOption><NativeSelectOption value="quota">按题型数量</NativeSelectOption><NativeSelectOption value="manual">手动选择</NativeSelectOption></NativeSelect></label>
            {selection === "quota" && <div className="grid grid-cols-3 gap-3">{Object.entries(types).map(([k, v]) => <label className="grid gap-2" key={k}>{v}（可用 {rows.filter(q => questionType(q.question) === k).length}）<Input aria-label={`${v}题数`} type="number" min={0} value={quotas[k] || 0} onChange={e => { setQuotas({...quotas, [k]:Number(e.target.value)}); invalidate(); }}/></label>)}</div>}
            {selection === "manual" && <div className="space-y-2">{rows.map(q => <label key={q.id} className="flex items-start gap-2 rounded-md border p-3"><Checkbox className="mt-0.5" disabled={busy} checked={selected.includes(q.id)} onCheckedChange={checked => { setSelected(checked === true ? [...selected, q.id] : selected.filter(id => id !== q.id)); invalidate(); }}/>{q.question.stem || "题干缺失"}</label>)}</div>}
          </div>
        </details>
        {kind !== "practice" && !!preview.length && <section className="space-y-4 rounded-xl border p-4"><h3 className="font-semibold">选题与配分预览 · {preview.length} 题</h3><p className="text-muted-foreground">材料题按子题计数，原卷分值仅供参考。</p>
          <details><summary className="cursor-pointer">按题型分配总分</summary><div className="my-3 grid grid-cols-3 gap-3">{Object.keys(budgets).map(k => <label className="grid gap-2" key={k}>{types[k] || "未分类"}预算<Input aria-label={`${types[k] || k}预算`} value={budgets[k]} onChange={e => setBudgets({...budgets, [k]:e.target.value})}/></label>)}</div><Button variant="outline" onClick={() => attempt(() => setScores(allocate(preview, cents(total), Object.fromEntries(Object.entries(budgets).map(([k,v]) => [k,cents(v)]))).map(v => (v/100).toFixed(2))))}>按题型预算重新配分（覆盖逐题修改）</Button></details>
          <div className="divide-y">{preview.map((q, i) => <div key={q.id} className="flex items-center gap-3 py-3"><span className="min-w-0 flex-1 break-words">{i + 1}. {q.question.stem || "题干缺失"}{q.question.sourceScore != null && `（原卷 ${q.question.sourceScore} 分）`}</span><Input className="w-24 shrink-0" aria-label={`第 ${i + 1} 题分值`} value={scores[i]} onChange={e => setScores(scores.map((s, j) => j === i ? e.target.value : s))}/></div>)}</div>
        </section>}
      </fieldset>
      <div className="shrink-0 space-y-3 border-t pt-3">
        <p role="status" className="text-sm">{!bankIds.length ? "请选择至少一个题库" : loading ? "正在加载题目…" : <>已选 {chosen.length === 1 ? chosen[0].title : `${chosen.length} 个题库`} · 可用 {rows.length} 题 · 本次 {selectedCount} 题{filter && ` · ${{wrong:"错题", favorite:"收藏", unattempted:"未做题"}[filter]}`}{mode && ` · ${types[mode] || "选择题"}`}{search && ` · 关键词：${search}`}</>}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>{kind !== "practice" && <Button variant={preview.length ? "outline" : "default"} disabled={busy || loading || !rows.length || !bankIds.length} onClick={generate}>{preview.length ? "重新生成预览" : "预览题目与配分"}</Button>}{(kind === "practice" || !!preview.length) && <Button disabled={busy || loading || !rows.length || !bankIds.length} onClick={start}>{kind === "practice" ? "立即开始" : "开始考试"}</Button>}</div>
      </div>
    </DialogContent>
  </Dialog>;
}
