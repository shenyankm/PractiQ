import { number, message, MessageError, t, useI18n } from "./i18n";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ai } from "./ai-api";
import { api, type Session, type Attempt, type GradingResponse } from "./api";
import { ErrorNotice } from "./OperationFeedback";
import { cents } from "./paper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface GradingDraft { score: string; reason: string }

function gradingStatus(status: string) { return ({graded: t("已完成"), ungraded:t("未能评分，需复核"), unknown:t("评分结果待确认")})[status] || status; }
function eligible(a:Attempt){const q=a.snapshot.question;return a.submittedAt!=null&&!a.skipped&&q.answerMode==="short_answer"&&!!q.stem&&!!a.answer?.text?.trim()&&!!(q.scoringRubric||q.answerPayload?.text)&&!a.snapshot.missingAssets&&!q.missingFields.some(k=>["stem","material","media","answerMode"].includes(k))&&!["manual","self"].includes(a.gradeKind);}
function GradeDetails({request}: {request: GradingResponse}) {
  const error = request.appError || request.error;
  return <div className="space-y-2">
    {error && <ErrorNotice error={error} />}
    {typeof request.result?.reason === "string" && request.result.reason && <p>{request.result.reason}</p>}
    {Array.isArray(request.result?.evidence) && request.result.evidence.filter(e=>typeof e === "string").map((e,i)=><p key={i}>{e}</p>)}
    {Array.isArray(request.result?.reviewReasons) && request.result.reviewReasons.filter(e=>typeof e === "string").map((e,i)=><p key={i}>{t("复核提示：{0}", {0:e})}</p>)}
    {Array.isArray(request.result?.criteria) && request.result.criteria.length > 0 && <details open>
      <summary className="cursor-pointer font-medium">{t("评分点（原始分值）")}</summary>
      <ol className="mt-3 space-y-4">
        {request.result.criteria.filter(c=>c && typeof c.criterion === "string" && typeof c.referenceQuote === "string" && typeof c.answerQuote === "string" && typeof c.reason === "string" && Number.isSafeInteger(c.scoreCents) && Number.isSafeInteger(c.maxCents)).map((c,i)=><li key={i} className="space-y-1 break-words">
          <p className="font-medium">{c.criterion} · {c.scoreCents/100} / {c.maxCents/100}</p>
          <p>{t("评分依据：{0}", {0:c.referenceQuote})}</p>
          <p>{t("作答引用：{0}", {0:c.answerQuote || t("未找到对应作答")})}</p>
          <p className="text-muted-foreground">{c.reason}</p>
        </li>)}
      </ol>
    </details>}
  </div>;
}
export function ExamResults({
  session,
  onSession,
  run,
  onNextUnattempted,
  draft,
  onDraftChange,
  onConfigure,
  questionContainer,
}: {
  session: Session;
  onSession: (s: Session) => void;
  run: (j: () => Promise<void>) => void;
  onNextUnattempted?: () => void;
  draft?: GradingDraft;
  onDraftChange?: (draft: GradingDraft) => void;
  onConfigure?: () => void;
  questionContainer?: HTMLElement | null;
}) {
  useI18n();
  const [running,setRunning]=useState(false); const stopped=useRef(false);const [error, setError] = useState<unknown>(null);
  const [failedAttempt, setFailedAttempt] = useState<{ sessionId: string; ordinal: number } | null>(null);
  const [localDrafts, setLocalDrafts] = useState<Record<string, GradingDraft>>({});
  const [saving, setSaving] = useState(false);
  const draftKey = `${session.id}:${session.attempts[session.position].ordinal}`;
  const { score, reason } = draft ?? localDrafts[draftKey] ?? { score: "", reason: "" };
  const changeDraft = onDraftChange ?? ((value: GradingDraft) => setLocalDrafts(previous => ({ ...previous, [draftKey]: value })));
  const [retryConfirm,setRetryConfirm]=useState(false);
  const a=session.attempts[session.position];
  const exam=session.kind&&session.kind!=="practice";const submitted=exam?!!session.submittedAt:!!session.finishedAt||a.submittedAt!=null;
  const { graded, full, total, earned, pending, pendingPoints, retryCount, skipped, unresolved } = useMemo(() => {
    const attempts=submitted?session.attempts:[];
    const graded=attempts.filter(a=>exam?a.earnedCents!=null:a.result!==null);
    const full=graded.filter(a=>exam?a.earnedCents===a.maxCents:a.result===true).length;
    const total=attempts.reduce((n,a)=>n+(a.maxCents||0),0), earned=graded.reduce((n,a)=>n+(a.earnedCents||0),0);
    const pending=attempts.filter(a=>exam&&a.earnedCents==null);
    const pendingPoints=pending.reduce((n,a)=>n+(a.maxCents||0),0);
    const retryCount=attempts.filter(a=>a.result===false).length;
    const skipped=attempts.filter(a=>a.skipped).length;
    const unresolved=attempts.length-graded.length-(exam?0:skipped);
    return { graded, full, total, earned, pending, pendingPoints, retryCount, skipped, unresolved };
  }, [session.attempts, exam, submitted]);
  const pendingAi = useMemo(() => {
    const candidates = exam ? pending : (a ? [a] : []);
    return candidates.filter(item => eligible(item) && !item.grading?.ai && !item.grading?.lastRequest);
  }, [exam, pending, a]);
  if(!submitted)return null;
  const latest=a.grading?.lastRequest;
  const configurationError = error ?? latest?.appError;
  const needsConfiguration = ["LOCAL_SERVICE_URL_REQUIRED", "LOCAL_SERVICE_TOKEN_REQUIRED", "LOCAL_SERVICE_TOKEN_INVALID", "INVALID_SERVICE_TOKEN", "LOCAL_MODEL_URL_REQUIRED", "LOCAL_MODEL_ID_REQUIRED", "LOCAL_MODEL_KEY_REQUIRED"].includes(String((configurationError as { code?: string } | null)?.code ?? ""));
  function grade(items:Attempt[],retry=false){run(async()=>{
    stopped.current=false;setRunning(true);setError(null);setFailedAttempt(null);
    try {
      for(const item of items){
        if(stopped.current)break;
        try {
          const s=await ai({type:"grade",id:session.id,ordinal:item.ordinal,retry});onSession(s);
        } catch(e) {
          setError(e);setFailedAttempt({sessionId:session.id,ordinal:item.ordinal});
          if(!["LOCAL_GRADING_INELIGIBLE","LOCAL_GRADING_IMAGE_MISSING","LOCAL_GRADING_TOO_LARGE"].includes(String((e as {code?:string} | null)?.code ?? "")))break;
        }
      }
    } finally {setRunning(false);}
  });}
  const summaryPart = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3">
        <h3 className="font-semibold text-base">{exam ? (pending.length ? t("预估成绩") : t("本次成绩")) : t("本次练习结果")}</h3>
      </div>
      <dl className="result-metrics">
        <div><dt>{exam ? t("已确定得分") : t("满分题 / 已判定题")}</dt><dd className="tabular-nums">{exam ? `${earned/100} / ${total/100}` : graded.length ? `${full} / ${graded.length}` : "—"}</dd></div>
        <div><dt>{t("未答/跳过")}</dt><dd className="tabular-nums">{skipped}</dd></div>
        <div><dt>{exam ? t("待评分") : t("未判定")}</dt><dd className="tabular-nums">{unresolved}</dd></div>
      </dl>
      <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t("判定详情")}</summary>
        {exam&&<p className="mt-2 tabular-nums">{t("已确定得分 {0} / {1} 分；{2} {3}% · 待评分 {4} 题（共 {5} 分）", { 0: earned/100, 1: total/100, 2: pending.length?t("已确定得分率"):t("得分率"), 3: total?number(earned/total*100, 1):0, 4: pending.length, 5: pendingPoints/100 })}</p>}
        <p className="mt-2 tabular-nums">{t("正确率（满分题 / 已判定题）：{0} · 未答/跳过 {1} · 未判定 {2}", { 0: graded.length?`${full}/${graded.length} · ${number(full/graded.length*100, 1)}%`:"—", 1: skipped, 2: unresolved })}</p>
      </details>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!retryCount||running} onClick={()=>run(async()=>onSession(await api({type:"retry_wrong",id:session.id})))}>{exam?t("重练本次未得满分题"):t("重练本次错题")}</Button>
      {onNextUnattempted&&<Button variant="outline" disabled={running} onClick={onNextUnattempted}>{t("继续下一批未做题")}</Button>}
      {!!pendingAi.length&&<Button disabled={running} onClick={()=>grade(pendingAi)}>{t("AI 评分/继续（{0} 题，将调用模型）", { 0: pendingAi.length })}</Button>}{running&&<Button variant="outline" onClick={()=>{stopped.current=true;}}>{t("停止后续评分")}</Button>}{exam&&!session.finishedAt&&<Button variant="outline" disabled={running} onClick={()=>run(async()=>onSession(await api({type:"complete_review",id:session.id})))}>{t("结束核对（可保留未判定）")}</Button>}
      </div>
      {error != null && <div role="alert"><ErrorNotice error={error} /></div>}
      {needsConfiguration && onConfigure && <Button variant="outline" disabled={running || saving} onClick={onConfigure}>{t("配置 AI 服务")}</Button>}
    </>
  );

  const questionPart = (exam || a.snapshot.question.answerMode === "short_answer") ? (
    <>
      {!exam && a.earnedCents==null && a.gradeKind!=="self" && <p className="text-sm text-muted-foreground">{t("练习评分使用原题分值；未提供分值时按百分制评分。")}</p>}
      {!exam && a.gradeKind==="self" ? <p>{t("用户自评")} · {t(a.result ? "回答正确" : "回答错误")}</p> : <p role="status" aria-live="polite" aria-atomic="true" className="tabular-nums">{t("当前题：{0} / {1} 分 · {2}", { 0: a.earnedCents==null?t("待评分"):a.earnedCents/100, 1: a.maxCents!=null?a.maxCents/100:!exam?(a.snapshot.question.sourceScore||100):0, 2: a.gradeKind==="ai"?t("AI 评分"):a.gradeKind==="manual"?t("人工评分"):a.gradeKind==="auto"?t("自动判分"):t("未判定") })}{a.earnedCents!=null&&a.earnedCents>0&&a.earnedCents<(a.maxCents||0)&&` · ${t("部分得分")}`}</p>}
      {a.grading?.ai&&<GradeDetails request={a.grading.ai}/>}
      {latest&&<div className="space-y-2"><p>{t("上次请求：{0}", {0:gradingStatus(latest.status)})}{a.earnedCents!=null&&` · ${t("已有得分保留。")}`}</p><GradeDetails request={latest}/></div>}
      {eligible(a)&&!a.grading?.ai&&!latest&&<p>{t("尚未请求 AI 评分。")}</p>}
      {eligible(a)&&latest?.status==="unknown"&&<><p>{t("先核对上次请求；重新评分会创建新的付费请求。")}</p><Button variant="outline" disabled={running} onClick={()=>grade([a])}>{t("核对上次评分结果")}</Button></>}
      {a.grading?.manual&&<p>{t("人工改分原因：{0}", { 0: a.grading.manual.reason })}</p>}
      {!eligible(a)&&a.earnedCents==null&&a.gradeKind!=="self"&&<p>{t("缺少完整题目、作答或评分依据，需人工处理。")}</p>}
      {eligible(a) && (a.grading?.ai || a.grading?.lastRequest || (failedAttempt?.sessionId === session.id && failedAttempt.ordinal === a.ordinal && (error as {code?:string} | null)?.code === "LOCAL_GRADING_TARGET_CHANGED")) && (
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
      {exam&&<><div className="flex flex-wrap items-end gap-3"><div className="w-32 space-y-2"><Label htmlFor="manual-score">{t("人工得分")}</Label><Input id="manual-score" inputMode="decimal" disabled={saving || running} aria-label={t("人工得分")} placeholder={t("得分")} value={score} onChange={e=>changeDraft({ score: e.target.value, reason })}/></div><div className="basis-full space-y-2 sm:basis-0 sm:flex-1"><Label htmlFor="manual-reason">{t("改分原因")}</Label><Input id="manual-reason" aria-invalid={!reason.trim() && error != null} disabled={saving || running} aria-label={t("改分原因")} placeholder={t("人工评分/改分原因（必填）")} value={reason} onChange={e=>changeDraft({ score, reason: e.target.value })}/></div><Button variant="outline" disabled={saving || running} onClick={()=>{try{const value=cents(score);if(!reason.trim())throw new MessageError(message("请填写原因"));setError(null);run(async()=>{
        setSaving(true);
        try {
          const updated = await api({type:"manual_score",id:session.id,ordinal:a.ordinal,cents:value,reason});
          changeDraft({ score: "", reason: "" });
          onSession(updated);
        } catch (error) { setError(error); }
        finally { setSaving(false); }
      });}catch(e){setError(e);}}}>{saving ? t("正在保存…") : t("保存人工评分")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("人工评分需点击保存；未保存草稿将在退出应用后丢失。")}</p></>}
    </>
  ) : null;

  if (questionContainer !== undefined) {
    return <>
      <section className="space-y-3 rounded-lg border bg-card p-4 shadow-none" aria-label={t("本次结果")}>{summaryPart}</section>
      {questionContainer && questionPart && createPortal(
        <section className="space-y-3 rounded-lg border bg-muted/20 p-4" aria-label={t("核对评分")}>{questionPart}</section>,
        questionContainer,
      )}
    </>;
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={t("本次结果")}>
      {summaryPart}
      {questionPart}
    </section>
  );
}
