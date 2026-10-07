import { number, message, MessageError, t, useI18n } from "./i18n";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useRef, useState } from "react";
import { ai } from "./ai-api";
import { api, errorMessage, type Session, type Attempt, type GradingResponse } from "./api";
import { cents } from "./paper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface GradingDraft { score: string; reason: string }

function gradingStatus(status: string) { return ({graded: t("已完成"), ungraded:t("未能评分，需复核"), unknown:t("评分结果待确认")})[status] || status; }
function eligible(a:Attempt){const q=a.snapshot.question;return q.answerMode==="short_answer"&&!!q.stem&&!!a.answer?.text?.trim()&&!!(q.scoringRubric||q.answerPayload?.text)&&!a.snapshot.missingAssets&&!q.missingFields.some(k=>["stem","material","media","answerMode"].includes(k))&&a.gradeKind!=="manual";}
function GradeDetails({request}: {request: GradingResponse}) {
  const error = request.appError ? errorMessage(request.appError) : request.error ? errorMessage(request.error) : null;
  return <div className="space-y-2">
    {error && <p>{error}</p>}
    {request.result?.reason && <p>{request.result.reason}</p>}
    {request.result?.evidence.map((e,i)=><p key={i}>{e}</p>)}
    {request.result?.reviewReasons.map((e,i)=><p key={i}>{t("复核提示：{0}", {0:e})}</p>)}
  </div>;
}
export function ExamResults({session,onSession,run,onNextUnattempted,draft,onDraftChange,onConfigure}:{session:Session;onSession:(s:Session)=>void;run:(j:()=>Promise<void>)=>void;onNextUnattempted?:()=>void;draft?:GradingDraft;onDraftChange?:(draft:GradingDraft)=>void;onConfigure?:()=>void}) {
  useI18n();
  const [running,setRunning]=useState(false); const stopped=useRef(false);const [error, setError] = useState<unknown>(null);
  const [localDraft, setLocalDraft] = useState<GradingDraft>({ score: "", reason: "" });
  const [saving, setSaving] = useState(false);
  const { score, reason } = draft ?? localDraft;
  const changeDraft = onDraftChange ?? setLocalDraft;
  const [retryConfirm,setRetryConfirm]=useState(false);
  const exam=session.kind&&session.kind!=="practice";const submitted=exam?!!session.submittedAt:!!session.finishedAt;
  const a=session.attempts[session.position];
  if(!submitted)return null;
  const graded=session.attempts.filter(a=>exam?a.earnedCents!=null:a.result!==null);
  const full=graded.filter(a=>exam?a.earnedCents===a.maxCents:a.result===true).length;
  const total=session.attempts.reduce((n,a)=>n+(a.maxCents||0),0), earned=graded.reduce((n,a)=>n+(a.earnedCents||0),0);
  const pending=session.attempts.filter(a=>exam&&a.earnedCents==null);
  const pendingAi=pending.filter(a=>eligible(a)&&!a.grading?.ai&&!a.grading?.lastRequest);
  const latest=a.grading?.lastRequest;
  const configurationError = error ?? latest?.appError;
  const needsConfiguration = ["LOCAL_SERVICE_URL_REQUIRED", "LOCAL_SERVICE_TOKEN_REQUIRED", "LOCAL_SERVICE_TOKEN_INVALID", "INVALID_SERVICE_TOKEN"].includes(String((configurationError as { code?: string } | null)?.code ?? ""));
  const retryCount=session.attempts.filter(a=>a.result===false).length;
  const skipped = session.attempts.filter(a => a.skipped).length;
  const unresolved = session.attempts.length - graded.length - session.attempts.filter(a => !exam && a.skipped).length;
  function grade(items:Attempt[],retry=false){run(async()=>{stopped.current=false;setRunning(true);setError(null);try{for(const item of items){if(stopped.current)break;const s=await ai({type:"grade",id:session.id,ordinal:item.ordinal,retry});onSession(s);}}catch(e){setError(e);}finally{setRunning(false);}});}
  return <section className="space-y-3 rounded-lg border p-4" aria-label={t("本次结果")}>
    <h3 className="font-medium">{exam?(pending.length?t("暂定成绩"):t("本次成绩")):t("本次练习结果")}</h3>
    <dl className="result-metrics">
      <div><dt>{exam ? t("已确定得分") : t("满分题 / 已判定题")}</dt><dd>{exam ? `${earned/100} / ${total/100}` : graded.length ? `${full} / ${graded.length}` : "—"}</dd></div>
      <div><dt>{t("未答／跳过")}</dt><dd>{skipped}</dd></div>
      <div><dt>{exam ? t("待评分") : t("未判定")}</dt><dd>{unresolved}</dd></div>
    </dl>
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("判定详情")}</summary>
      {exam&&<p className="mt-2">{t("已确定得分 {0} / {1} 分；{2} {3}% · 待评分 {4} 题（共 {5} 分）", { 0: earned/100, 1: total/100, 2: pending.length?t("已确定得分率"):t("得分率"), 3: total?number(earned/total*100, 1):0, 4: pending.length, 5: pending.reduce((n,a)=>n+(a.maxCents||0),0)/100 })}</p>}
      <p className="mt-2">{t("正确率（满分题 / 已判定题）：{0} · 未答／跳过 {1} · 未判定 {2}", { 0: graded.length?`${full}/${graded.length} · ${number(full/graded.length*100, 1)}%`:"—", 1: skipped, 2: unresolved })}</p>
    </details>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!retryCount||running} onClick={()=>run(async()=>onSession(await api({type:"retry_wrong",id:session.id})))}>{exam?t("重练本次未得满分题"):t("重练本次错题")}</Button>
    {onNextUnattempted&&<Button variant="outline" disabled={running} onClick={onNextUnattempted}>{t("继续下一批未做题")}</Button>}
    {exam&&<>{!!pendingAi.length&&<Button disabled={running} onClick={()=>grade(pendingAi)}>{t("AI 评分／继续（{0} 题，将调用模型）", { 0: pendingAi.length })}</Button>}{running&&<Button variant="outline" onClick={()=>{stopped.current=true;}}>{t("停止后续评分")}</Button>}{!session.finishedAt&&<Button variant="outline" disabled={running} onClick={()=>run(async()=>onSession(await api({type:"complete_review",id:session.id})))}>{t("结束核对（可保留未判定）")}</Button>}</>}
    </div>
    {exam&&<>
      <p role="status" aria-live="polite" aria-atomic="true">{t("当前题：{0} / {1} 分 · {2}", { 0: a.earnedCents==null?t("待评分"):a.earnedCents/100, 1: (a.maxCents||0)/100, 2: a.gradeKind==="ai"?t("AI 评分"):a.gradeKind==="manual"?t("人工评分"):a.gradeKind==="auto"?t("自动判分"):t("未判定") })}{a.earnedCents!=null&&a.earnedCents>0&&a.earnedCents<(a.maxCents||0)&&` · ${t("部分得分")}`}</p>
      {a.grading?.ai&&<GradeDetails request={a.grading.ai}/>}
      {latest&&<div className="space-y-2"><p>{t("上次请求：{0}", {0:gradingStatus(latest.status)})}{a.earnedCents!=null&&` · ${t("已有得分保留。")}`}</p><GradeDetails request={latest}/></div>}
      {eligible(a)&&!a.grading?.ai&&!latest&&<p>{t("尚未请求 AI 评分。")}</p>}
      {eligible(a)&&latest?.status==="unknown"&&<><p>{t("先核对上次请求；重新评分会创建新的付费请求。")}</p><Button variant="outline" disabled={running} onClick={()=>grade([a])}>{t("核对上次评分结果")}</Button></>}
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
      <div className="flex flex-wrap items-end gap-3"><div className="w-32 space-y-2"><Label htmlFor="manual-score">{t("人工得分")}</Label><Input id="manual-score" inputMode="decimal" disabled={saving || running} aria-label={t("人工得分")} placeholder={t("得分")} value={score} onChange={e=>changeDraft({ score: e.target.value, reason })}/></div><div className="basis-full space-y-2 sm:basis-0 sm:flex-1"><Label htmlFor="manual-reason">{t("改分原因")}</Label><Input id="manual-reason" disabled={saving || running} aria-label={t("改分原因")} placeholder={t("人工评分／改分原因（必填）")} value={reason} onChange={e=>changeDraft({ score, reason: e.target.value })}/></div><Button variant="outline" disabled={saving || running} onClick={()=>{try{const value=cents(score);if(!reason.trim())throw new MessageError(message("请填写原因"));setError(null);run(async()=>{
        setSaving(true);
        try {
          const updated = await api({type:"manual_score",id:session.id,ordinal:a.ordinal,cents:value,reason});
          changeDraft({ score: "", reason: "" });
          onSession(updated);
        } catch (error) { setError(error); }
        finally { setSaving(false); }
      });}catch(e){setError(e);}}}>{saving ? t("正在保存…") : t("保存人工评分")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("人工评分草稿仅在本次应用运行期间保留；点击保存后才写入记录。")}</p>
    </>}
    {error != null &&<p role="alert">{errorMessage(error)}</p>}
    {needsConfiguration && onConfigure && <Button variant="outline" disabled={running || saving} onClick={onConfigure}>{t("配置 AI 服务")}</Button>}
  </section>;
}
