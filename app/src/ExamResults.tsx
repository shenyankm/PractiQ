import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, errorMessage, type Session, type Attempt } from "./api";
import { cents } from "./paper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function eligible(a:Attempt){const q=a.snapshot.question;return q.answerMode==="short_answer"&&!!q.stem&&!!a.answer?.text?.trim()&&!!(q.scoringRubric||q.answerPayload?.text)&&!a.snapshot.missingAssets&&!q.missingFields.some(k=>["stem","material","media","answerMode"].includes(k))&&a.gradeKind!=="manual";}
export function ExamResults({session,onSession,run}:{session:Session;onSession:(s:Session)=>void;run:(j:()=>Promise<void>)=>void}) {
  const [running,setRunning]=useState(false); const stopped=useRef(false);const [error,setError]=useState("");const [score,setScore]=useState("");const [reason,setReason]=useState("");
  const [retryConfirm,setRetryConfirm]=useState(false);
  const exam=session.kind&&session.kind!=="practice";const submitted=exam?!!session.submittedAt:!!session.finishedAt;
  const a=session.attempts[session.position];
  if(!submitted)return null;
  const graded=session.attempts.filter(a=>exam?a.earnedCents!=null:a.result!==null);
  const full=graded.filter(a=>exam?a.earnedCents===a.maxCents:a.result===true).length;
  const total=session.attempts.reduce((n,a)=>n+(a.maxCents||0),0), earned=graded.reduce((n,a)=>n+(a.earnedCents||0),0);
  const pending=session.attempts.filter(a=>exam&&a.earnedCents==null);
  const pendingAi=pending.filter(eligible);
  function grade(items:Attempt[],retry=false){stopped.current=false;setRunning(true);setError("");run(async()=>{try{for(const item of items){if(stopped.current)break;const s=await invoke<Session>("ai_request",{request:{type:"grade",id:session.id,ordinal:item.ordinal,retry}});onSession(s);}}catch(e){setError(errorMessage(e));}finally{setRunning(false);}});}
  return <section className="space-y-3 rounded-lg border p-4" aria-label="本次结果">
    <h3 className="font-medium">{exam?(pending.length?"暂定成绩":"本次成绩"):"本次练习结果"}</h3>
    {exam&&<p>已确定得分 {earned/100} / {total/100} 分；{pending.length?"已确定得分率":"得分率"} {total?(earned/total*100).toFixed(1):0}% · 待评分 {pending.length} 题（共 {pending.reduce((n,a)=>n+(a.maxCents||0),0)/100} 分）</p>}
    <p>正确率（满分题 / 已判定题）：{graded.length?`${full}/${graded.length} · ${(full/graded.length*100).toFixed(1)}%`:"—"} · 未答／跳过 {session.attempts.filter(a=>a.skipped).length} · 未判定 {session.attempts.length-graded.length-session.attempts.filter(a=>!exam&&a.skipped).length}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>run(async()=>onSession(await api({type:"retry_wrong",id:session.id})))}>重练本次错题</Button>
    {exam&&<>{!!pendingAi.length&&<Button disabled={running} onClick={()=>grade(pendingAi)}>AI 评分／继续（{pendingAi.length} 题，将调用模型）</Button>}{running&&<Button variant="outline" onClick={()=>{stopped.current=true;}}>停止后续评分</Button>}{!session.finishedAt&&<Button variant="outline" disabled={running} onClick={()=>run(async()=>onSession(await api({type:"complete_review",id:session.id})))}>结束核对（可保留未判定）</Button>}</>}
    </div>
    {exam&&<>
      <p>当前题：{a.earnedCents==null?"待评分":`${a.earnedCents/100} 分`} / {(a.maxCents||0)/100} 分 · {a.gradeKind==="ai"?"AI 评分":a.gradeKind==="manual"?"人工评分":a.gradeKind==="auto"?"自动判分":"未判定"}</p>
      {a.grading?.ai&&<div className="space-y-2"><p>{a.grading.ai.error||a.grading.ai.result?.reason||a.grading.ai.status}</p>{a.grading.ai.result?.evidence.map((e,i)=><p key={i}>{e}</p>)}{a.grading.ai.result?.reviewReasons.map((e,i)=><p key={i}>复核提示：{e}</p>)}</div>}
      {a.grading?.lastRequest&&<p>上次请求：{a.grading.lastRequest.error||a.grading.lastRequest.status}；已有得分保留。</p>}
      {a.grading?.manual&&<p>人工改分原因：{a.grading.manual.reason}</p>}
      {!eligible(a)&&a.earnedCents==null&&<p>缺少完整题目、作答或评分依据，需人工处理。</p>}
      {eligible(a)&&(a.grading?.ai||a.grading?.lastRequest)&&<><Button variant="outline" disabled={running} onClick={()=>setRetryConfirm(true)}>重新评分当前题</Button>{retryConfirm&&<div role="alert"><p>将创建新请求，可能再次产生模型费用。原评分记录保留。</p><Button onClick={()=>{setRetryConfirm(false);grade([a],true);}}>确认重新评分</Button><Button variant="ghost" onClick={()=>setRetryConfirm(false)}>取消</Button></div>}</>}
      <div className="flex flex-wrap gap-2"><Input className="w-32" aria-label="人工得分" placeholder="得分" value={score} onChange={e=>setScore(e.target.value)}/><Input className="flex-1" aria-label="改分原因" placeholder="人工评分／改分原因（必填）" value={reason} onChange={e=>setReason(e.target.value)}/><Button variant="outline" onClick={()=>{try{const value=cents(score);if(!reason.trim())throw new Error("请填写原因");run(async()=>onSession(await api({type:"manual_score",id:session.id,ordinal:a.ordinal,cents:value,reason})));}catch(e){setError(errorMessage(e));}}}>保存人工评分</Button></div>
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
