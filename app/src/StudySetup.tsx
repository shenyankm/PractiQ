import { useEffect, useState } from "react";
import { api, errorMessage, type Bank, type Session, type SessionKind, type QuestionRow } from "./api";
import { allocate, cents, questionType, sample, types } from "./paper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function StudySetup({banks, initialBank, initialFilter, initialMode="", initialSearch="", onClose, onStart, run, busy}: {banks:Bank[];initialBank:string|null;initialFilter:string;initialMode?:string;initialSearch?:string;onClose:()=>void;onStart:(s:Session)=>Promise<void>;run:(job:()=>Promise<void>)=>void;busy:boolean}) {
  const [bankIds,setBanks]=useState<string[]>(initialBank?[initialBank]:[]);
  const [kind,setKind]=useState<SessionKind>("practice");
  const [mode,setMode]=useState(initialMode); const [filter,setFilter]=useState(initialFilter);const [search,setSearch]=useState(initialSearch);
  const [rows,setRows]=useState<QuestionRow[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const [count,setCount]=useState(20); const [minutes,setMinutes]=useState(60); const [random,setRandom]=useState(false);
  const [selection,setSelection]=useState("count");const [selected,setSelected]=useState<string[]>([]);const [quotas,setQuotas]=useState<Record<string,number>>({});
  const [preview,setPreview]=useState<QuestionRow[]>([]);const [scores,setScores]=useState<string[]>([]);const [total,setTotal]=useState("100");const [budgets,setBudgets]=useState<Record<string,string>>({});
  const bankKey=JSON.stringify(bankIds);
  useEffect(()=>{let active=true;setLoading(true);setError("");setPreview([]);setSelected([]);
    void api<QuestionRow[]>({type:"questions",bank_id:null,bank_ids:JSON.parse(bankKey),search,mode,filter}).then(q=>{if(active){setRows(q);setCount(Math.min(20,q.length));}}).catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[bankKey,search,mode,filter]);
  const attempt=(job:()=>void)=>{try{setError("");job();}catch(e){setError(errorMessage(e));}};
  function generate(){attempt(()=>{
    let picked=selection==="manual" ? rows.filter(q=>selected.includes(q.id)) : selection==="quota" ? Object.keys(types).flatMap(k=>quotas[k]?sample(rows.filter(q=>questionType(q.question)===k),quotas[k],random):[]) : sample(rows,count,random);
    if(!picked.length||picked.length>1000)throw new Error("请选择 1–1000 题");
    const values=allocate(picked,cents(total));setScores(values.map(v=>(v/100).toFixed(2)));setPreview(picked);
    const next:Record<string,number>={};picked.forEach((q,i)=>{const k=questionType(q.question);next[k]=(next[k]||0)+values[i];});setBudgets(Object.fromEntries(Object.entries(next).map(([k,v])=>[k,(v/100).toFixed(2)])));
  });}
  const invalidate=()=>setPreview([]);
  return <Dialog open onOpenChange={v=>{if(!v&&!busy)onClose();}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>练习与考试组卷</DialogTitle><DialogDescription>先选择题目，再预览配分。更改选题或总分需要重新生成预览。</DialogDescription></DialogHeader>
    <fieldset disabled={busy} className="space-y-4">
      <label>模式 <select aria-label="模式" value={kind} onChange={e=>{setKind(e.target.value as SessionKind);invalidate();}}><option value="practice">即时反馈练习</option><option value="self_test">不限时自测</option><option value="mock_exam">限时模考</option></select></label>
      {kind==="mock_exam"&&<label>考试分钟数<Input aria-label="考试分钟数" type="number" min={1} max={1440} value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label>}
      <fieldset className="flex flex-wrap gap-3"><legend>题库（不勾选表示全部）</legend>{banks.map(b=><label key={b.id}><input type="checkbox" checked={bankIds.includes(b.id)} onChange={e=>setBanks(e.target.checked?[...bankIds,b.id]:bankIds.filter(id=>id!==b.id))}/>{b.title}（{b.count}）</label>)}</fieldset>
      <div className="flex flex-wrap gap-4"><label>题型 <select aria-label="题型" value={mode} onChange={e=>setMode(e.target.value)}><option value="">全部题型</option><option value="choice">全部选择题</option>{Object.entries(types).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>范围 <select aria-label="范围" value={filter} onChange={e=>setFilter(e.target.value)}>{[["","全部"],["wrong","错题"],["favorite","收藏"],["unattempted","未做题"]].map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div>
      <Input aria-label="搜索题目" placeholder="搜索题目" value={search} onChange={e=>setSearch(e.target.value)}/>
      <p>{loading?"加载中…":`可用 ${rows.length} 题`}</p>
      <label>选题方式 <select aria-label="选题方式" value={selection} onChange={e=>{setSelection(e.target.value);invalidate();}}><option value="count">总题数</option><option value="quota">按题型数量</option><option value="manual">手动选择</option></select></label>
      {selection==="count"&&<Input aria-label="题目数量" type="number" min={1} max={Math.min(1000,rows.length)} value={count} onChange={e=>{setCount(Number(e.target.value));invalidate();}}/>}
      {selection==="quota"&&<div className="grid grid-cols-4 gap-3">{Object.entries(types).map(([k,v])=><label key={k}>{v}（可用 {rows.filter(q=>questionType(q.question)===k).length}）<Input aria-label={`${v}题数`} type="number" min={0} value={quotas[k]||0} onChange={e=>{setQuotas({...quotas,[k]:Number(e.target.value)});invalidate();}}/></label>)}</div>}
      {selection==="manual"&&<div className="max-h-60 space-y-2 overflow-auto">{rows.map(q=><label key={q.id} className="block"><input type="checkbox" checked={selected.includes(q.id)} onChange={e=>{setSelected(e.target.checked?[...selected,q.id]:selected.filter(id=>id!==q.id));invalidate();}}/> {q.question.stem||"题干缺失"}</label>)}</div>}
      {selection!=="manual"&&<label><input type="checkbox" checked={random} onChange={e=>{setRandom(e.target.checked);invalidate();}}/> 随机抽题（不勾选按顺序）</label>}
      {kind!=="practice"&&<label>考试总分<Input aria-label="考试总分" value={total} onChange={e=>{setTotal(e.target.value);invalidate();}}/></label>}
      <Button disabled={loading} onClick={generate}>生成选题与配分预览</Button>
      {!!preview.length&&<section className="space-y-3"><p>已选 {preview.length} 题；材料题按子题计数，原卷分值仅供参考。</p>
        {kind!=="practice"&&<><div className="grid grid-cols-4 gap-3">{Object.keys(budgets).map(k=><label key={k}>{types[k]||"未分类"}预算<Input aria-label={`${types[k]||k}预算`} value={budgets[k]} onChange={e=>setBudgets({...budgets,[k]:e.target.value})}/></label>)}</div><Button variant="outline" onClick={()=>attempt(()=>setScores(allocate(preview,cents(total),Object.fromEntries(Object.entries(budgets).map(([k,v])=>[k,cents(v)]))).map(v=>(v/100).toFixed(2))))}>按题型预算重新配分（覆盖逐题修改）</Button></>}
        <div className="max-h-72 space-y-3 overflow-auto">{preview.map((q,i)=><div key={q.id} className="flex items-center gap-3"><span className="flex-1">{i+1}. {q.question.stem||"题干缺失"}（原卷 {q.question.sourceScore??"未提供"} 分）</span>{kind!=="practice"&&<Input className="w-24" aria-label={`第 ${i+1} 题分值`} value={scores[i]} onChange={e=>setScores(scores.map((s,j)=>j===i?e.target.value:s))}/>}</div>)}</div>
        <Button onClick={()=>attempt(()=>{const values=kind==="practice"?[]:scores.map(cents);const target=cents(total);if(kind!=="practice"&&(values.some(v=>v<1)||values.reduce((a,b)=>a+b,0)!==target))throw new Error("每题至少 0.01 分，逐题分值之和必须等于总分");run(async()=>onStart(await api<Session>({type:"start_paper",paper:{question_ids:preview.map(q=>q.id),kind,minutes:kind==="mock_exam"?minutes:null,scores:values,total_cents:target}})));})}>开始{kind==="practice"?"练习":"考试"}</Button>
      </section>}
      {error&&<p role="alert" className="text-destructive">{error}</p>}
    </fieldset>
  </DialogContent></Dialog>;
}
