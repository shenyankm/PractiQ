import { number, message, MessageError, t, useI18n, locale } from "./i18n";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, errorMessage, type Session, type Attempt } from "./api";
import { cents } from "./paper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function gradingStatus(status: string) { return ({graded: t("已完成"), ungraded:t("未判定"), unknown:t("待确认")})[status] || status; }
function eligible(a:Attempt){const q=a.snapshot.question;return q.answerMode==="short_answer"&&!!q.stem&&!!a.answer?.text?.trim()&&!!(q.scoringRubric||q.answerPayload?.text)&&!a.snapshot.missingAssets&&!q.missingFields.some(k=>["stem","material","media","answerMode"].includes(k))&&a.gradeKind!=="manual";}
export function ExamResults({session,onSession,run}:{session:Session;onSession:(s:Session)=>void;run:(j:()=>Promise<void>)=>void}) {
  useI18n();
  const [running,setRunning]=useState(false); const stopped=useRef(false);const [error, setError] = useState<unknown>(null);const [score,setScore]=useState("");const [reason,setReason]=useState("");
  const [retryConfirm,setRetryConfirm]=useState(false);
  const exam=session.kind&&session.kind!=="practice";const submitted=exam?!!session.submittedAt:!!session.finishedAt;
  const a=session.attempts[session.position];
  if(!submitted)return null;
  const graded=session.attempts.filter(a=>exam?a.earnedCents!=null:a.result!==null);
  const full=graded.filter(a=>exam?a.earnedCents===a.maxCents:a.result===true).length;
  const total=session.attempts.reduce((n,a)=>n+(a.maxCents||0),0), earned=graded.reduce((n,a)=>n+(a.earnedCents||0),0);
  const pending=session.attempts.filter(a=>exam&&a.earnedCents==null);
  const pendingAi=pending.filter(eligible);
  function grade(items:Attempt[],retry=false){run(async()=>{stopped.current=false;setRunning(true);setError(null);try{for(const item of items){if(stopped.current)break;const s=await invoke<Session>("ai_request",{locale: locale(),request:{type:"grade",id:session.id,ordinal:item.ordinal,retry}});onSession(s);}}catch(e){setError(e);}finally{setRunning(false);}});}
  return <section className="space-y-3 rounded-lg border p-4" aria-label={t("本次结果")}>
    <h3 className="font-medium">{exam?(pending.length?t("暂定成绩"):t("本次成绩")):t("本次练习结果")}</h3>
    {exam&&<p>{t("已确定得分 {0} / {1} 分；{2} {3}% · 待评分 {4} 题（共 {5} 分）", { 0: earned/100, 1: total/100, 2: pending.length?t("已确定得分率"):t("得分率"), 3: total?number(earned/total*100, 1):0, 4: pending.length, 5: pending.reduce((n,a)=>n+(a.maxCents||0),0)/100 })}</p>}
    <p>{t("正确率（满分题 / 已判定题）：{0} · 未答／跳过 {1} · 未判定 {2}", { 0: graded.length?`${full}/${graded.length} · ${number(full/graded.length*100, 1)}%`:"—", 1: session.attempts.filter(a=>a.skipped).length, 2: session.attempts.length-graded.length-session.attempts.filter(a=>!exam&&a.skipped).length })}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>run(async()=>onSession(await api({type:"retry_wrong",id:session.id})))}>{t("重练本次错题")}</Button>
    {exam&&<>{!!pendingAi.length&&<Button disabled={running} onClick={()=>grade(pendingAi)}>{t("AI 评分／继续（{0} 题，将调用模型）", { 0: pendingAi.length })}</Button>}{running&&<Button variant="outline" onClick={()=>{stopped.current=true;}}>{t("停止后续评分")}</Button>}{!session.finishedAt&&<Button variant="outline" disabled={running} onClick={()=>run(async()=>onSession(await api({type:"complete_review",id:session.id})))}>{t("结束核对（可保留未判定）")}</Button>}</>}
    </div>
    {exam&&<>
      <p>{t("当前题：{0} / {1} 分 · {2}", { 0: a.earnedCents==null?t("待评分"):t("{0} 分", { 0: a.earnedCents/100 }), 1: (a.maxCents||0)/100, 2: a.gradeKind==="ai"?t("AI 评分"):a.gradeKind==="manual"?t("人工评分"):a.gradeKind==="auto"?t("自动判分"):t("未判定") })}</p>
      {a.grading?.ai&&<div className="space-y-2"><p>{(a.grading.ai.appError ? errorMessage(a.grading.ai.appError) : a.grading.ai.error ? errorMessage(a.grading.ai.error) : null)||a.grading.ai.result?.reason||gradingStatus(a.grading.ai.status)}</p>{a.grading.ai.result?.evidence.map((e,i)=><p key={i}>{e}</p>)}{a.grading.ai.result?.reviewReasons.map((e,i)=><p key={i}>{t("复核提示：{0}", { 0: e })}</p>)}</div>}
      {a.grading?.lastRequest&&<p>{t("上次请求：{0}；已有得分保留。", { 0: a.grading.lastRequest.appError ? errorMessage(a.grading.lastRequest.appError) : a.grading.lastRequest.error ? errorMessage(a.grading.lastRequest.error) : gradingStatus(a.grading.lastRequest.status) })}</p>}
      {a.grading?.manual&&<p>{t("人工改分原因：{0}", { 0: a.grading.manual.reason })}</p>}
      {!eligible(a)&&a.earnedCents==null&&<p>{t("缺少完整题目、作答或评分依据，需人工处理。")}</p>}
      {eligible(a) && (a.grading?.ai || a.grading?.lastRequest) && (
        <AlertDialog open={retryConfirm} onOpenChange={setRetryConfirm}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={running}>{t("重新评分当前题")}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("重新评分当前题？")}</AlertDialogTitle>
              <AlertDialogDescription>{t("将创建新请求，可能再次产生模型费用。原评分记录保留。")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
              <AlertDialogAction disabled={running} onClick={() => grade([a], true)}>{t("确认重新评分")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <div className="flex flex-wrap gap-2"><Input className="w-32" aria-label={t("人工得分")} placeholder={t("得分")} value={score} onChange={e=>setScore(e.target.value)}/><Input className="flex-1" aria-label={t("改分原因")} placeholder={t("人工评分／改分原因（必填）")} value={reason} onChange={e=>setReason(e.target.value)}/><Button variant="outline" onClick={()=>{try{const value=cents(score);if(!reason.trim())throw new MessageError(message("请填写原因"));run(async()=>onSession(await api({type:"manual_score",id:session.id,ordinal:a.ordinal,cents:value,reason})));}catch(e){setError(e);}}}>{t("保存人工评分")}</Button></div>
    </>}
    {error != null &&<p role="alert">{errorMessage(error)}</p>}
  </section>;
}
