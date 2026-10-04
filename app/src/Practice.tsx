import { duration, t, useI18n } from "./i18n";
import { ListeningPlayer } from "./ListeningPlayer";
import { questionKinds } from "./english";
import { ExamResults } from "./ExamResults";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  api,
  answerReady,
  canInteract,
  modeNames,
  type Answer,
  type Attempt,
  type Session,
} from "./api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, X, SkipForward, Pencil, Circle, ArrowUpToLine, ArrowDownToLine, LocateFixed, type LucideIcon } from "lucide-react";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { Content, Markdown } from "./Content";
import { AnswerInput, AnswerDisplay } from "./AnswerInput";
import type { MutableRefObject } from "react";
type PracticeProps = {
  session: Session;
  onSession: (s: Session) => void;
  run: (job: () => Promise<void>) => void;
  flushRef: MutableRefObject<() => Promise<void>>;
  onNextUnattempted?: () => void;
};
export function Practice(props: PracticeProps) {
  const { session, onSession, run, flushRef } = props;
  useI18n();
  const attempt = session.attempts[session.position];
  const listening=attempt.snapshot.materials?.find(q=>q.answerMode === "listening");
  const exam = !!session.kind && session.kind !== "practice";
  const finished = session.finishedAt !== null || (exam && session.submittedAt != null);
  const [draft, setDraft] = useState<{ sessionId: string; position: number; answer: Answer | null }>();
  const answer = !finished && draft?.sessionId === session.id && draft.position === session.position ? draft.answer : attempt.answer;
  const onDraft = useCallback((answer: Answer | null) => setDraft({ sessionId: session.id, position: session.position, answer }), [session.id, session.position]);
  const [confirmFinish,setConfirmFinish]=useState(false);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => { setConfirmFinish(false); setDraft(undefined); }, [session.id]);
  const finishButton = useRef<HTMLButtonElement>(null);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const reviewOnClose = useRef(false);
  const go = useCallback((position: number) => {
    run(async () => {
      await flushRef.current();
      onSession(await api({ type: "position", id: session.id, position }));
    });
  }, [run, onSession, session.id, flushRef]);
  const unassessed = exam ? [] : session.attempts.filter(a => a.submittedAt != null && !a.skipped && a.result === null);
  function finish(submitDrafts: boolean) {
    run(async () => {
      setFinishing(true);
      try {
        await flushRef.current();
        onSession(await api({ type: "submit_paper", id: session.id, submit_drafts: submitDrafts }));
        setConfirmFinish(false);
      } finally { setFinishing(false); }
    });
  }
  return <div className="space-y-4">
    {listening && <ListeningPlayer key={`${session.id}-${listening.id}-${listening.audioRef?.sha256}`} question={listening} session={session}/>}
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_240px]">
      <PracticeQuestion key={`${session.id}-${session.position}`} {...props} go={go} onDraft={onDraft} questionHeading={questionHeading}/>
      <aside className="min-w-0 self-start space-y-4 md:sticky md:top-0">
        <AnswerCard key={session.id} session={session} answer={answer} exam={exam} go={go} />
        {!finished && <Button ref={finishButton} className="w-full" variant="outline" onClick={() => run(async () => { await flushRef.current(); onSession(await api({type:"session", id:session.id})); setConfirmFinish(true); })}>{exam ? t("交卷") : t("结束练习")}</Button>}
        <AlertDialog open={confirmFinish && !finished} onOpenChange={open => { if (!finishing) setConfirmFinish(open); }}>
          <AlertDialogContent className="sm:max-w-lg" onCloseAutoFocus={event => { event.preventDefault(); (reviewOnClose.current ? questionHeading : finishButton).current?.focus(); reviewOnClose.current = false; }}>
            <AlertDialogHeader><AlertDialogTitle>{exam ? t("确认交卷？") : t("结束本次练习？")}</AlertDialogTitle><AlertDialogDescription>{t("已提交 {0} 题；未提交草稿 {1} 题；空白 {2} 题。结束后不能修改答案。", { 0: session.attempts.filter(a => a.submittedAt != null).length, 1: session.attempts.filter(a => a.submittedAt == null && hasAnswer(a.answer)).length, 2: session.attempts.filter(a => a.submittedAt == null && !hasAnswer(a.answer)).length })}{unassessed.length > 0 && <span className="mt-2 block">{t("还有 {0} 题未自评。结束后仍可在练习记录中核对并补充自评。", {0:unassessed.length})}</span>}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter className="flex-wrap"><AlertDialogCancel disabled={finishing}>{t("继续作答")}</AlertDialogCancel>{unassessed.length > 0 && <Button variant="outline" disabled={finishing} onClick={() => { reviewOnClose.current = true; setConfirmFinish(false); go(unassessed[0].ordinal); }}>{t("去核对")}</Button>}{!exam && <Button variant="outline" disabled={finishing} onClick={() => finish(false)}>{unassessed.length > 0 ? t("草稿记为跳过并结束（保留未判定）") : t("草稿记为跳过并结束")}</Button>}<Button disabled={finishing} onClick={() => finish(true)}>{finishing ? t("正在保存…") : exam ? t("确认交卷") : unassessed.length > 0 ? t("提交草稿并结束（保留未判定）") : t("提交草稿并结束")}</Button></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {finished && <Card><CardContent className="pt-5 text-sm">{t("作答已锁定，当前显示作答时的内容快照。")}</CardContent></Card>}
      </aside>
    </div>
  </div>;
}
function PracticeQuestion({
  session,
  onSession,
  run,
  flushRef,
  onNextUnattempted,
  go,
  onDraft,
  questionHeading,
}: PracticeProps & {
  go: (position: number) => void;
  onDraft: (answer: Answer | null) => void;
  questionHeading: MutableRefObject<HTMLHeadingElement | null>;
}) {
  useI18n();
  const attempt = session.attempts[session.position];
  const q = attempt.snapshot.question;
  const [answer, setAnswer] = useState<Answer | null>(attempt.answer);
  const [saved, setSaved] = useState<"已保存" | "保存中…" | "保存失败" | "待保存">("已保存");
  const [saveError, setSaveError] = useState(false);
  const elapsed = useRef(attempt.elapsedMs);
  const answerRef = useRef(answer);
  const chain = useRef(Promise.resolve());
  const pendingDraft = useRef<{ answer: Answer | null; elapsed: number } | null>(null);
  const draftJob = useRef<Promise<void> | null>(null);
  const submitted = attempt.submittedAt !== null;
  const exam = !!session.kind && session.kind !== "practice";
  const handedIn = exam && session.submittedAt != null;
  const finished = session.finishedAt !== null || handedIn;
  const favorite = attempt.favorite;
  useEffect(() => { questionHeading.current?.focus(); }, [questionHeading]);
  useEffect(() => {
    if (handedIn) {
      setAnswer(attempt.answer);
      answerRef.current = attempt.answer;
    }
  }, [handedIn, attempt.answer]);
  const persist = useCallback((
    submit = false,
    skip = false,
  ): Promise<Session | void> => {
    const captured = { answer: answerRef.current, elapsed: elapsed.current };
    setSaved("保存中…");
    let job: Promise<Session | void>;
    if (submit) {
      job = chain.current.catch(() => {}).then(() => api({
        type: "save_attempt", id: session.id, ordinal: session.position,
        answer: captured.answer, elapsed_ms: captured.elapsed,
        submit, skip,
      }));
    } else {
      pendingDraft.current = captured;
      if (draftJob.current) return draftJob.current;
      const drain = chain.current.catch(() => {}).then(async () => {
        while (pendingDraft.current) {
          const next = pendingDraft.current;
          pendingDraft.current = null;
          try {
            await api({type:"save_draft", id:session.id, ordinal:session.position, answer:next.answer, elapsed_ms:next.elapsed});
          } catch (error) {
            if (!pendingDraft.current) throw error;
          }
        }
      });
      draftJob.current = drain;
      job = drain;
    }
    chain.current = job.then(
      () => {
        if (draftJob.current === job) draftJob.current = null;
        setSaved("已保存");
        setSaveError(false);
      },
      () => {
        if (draftJob.current === job) draftJob.current = null;
        setSaved("保存失败");
        setSaveError(true);
      },
    );
    return job;
  }, [session.id, session.position]) as {
    (submit: true, skip?: boolean): Promise<Session>;
    (submit?: false, skip?: boolean): Promise<void>;
  };
  useEffect(() => {
    const flush = async () => {
      if (!submitted && !finished) await persist();
      else await chain.current;
    };
    flushRef.current = flush;
    const save = () => {
      if (!submitted && !finished) void flush().catch(() => {});
    };
    document.addEventListener("visibilitychange", save);
    return () => {
      document.removeEventListener("visibilitychange", save);
      if (flushRef.current === flush)
        flushRef.current = async () => {
          await chain.current;
        };
    };
  }, [session.id, session.position, submitted, finished, persist, flushRef]);
  function change(a: Answer | null) {
    setAnswer(a);
    onDraft(a);
    answerRef.current = a;
    setSaved("待保存");
    void persist().catch(() => {});
  }
  const blankTargets = useMemo(() => {
    const ids = new Set([q, ...(attempt.snapshot.materials || [])]
      .flatMap(material => [...(material.passage || []), ...material.contentBlocks])
      .filter(block => block.partType === "blank").map(block => block.questionId));
    return ids.size ? session.attempts.filter(a => ids.has(a.snapshot.question.id)) : [];
  }, [q, attempt.snapshot.materials, session.attempts]);
  const materialSiblings = useMemo(() => attempt.snapshot.materials?.length ? session.attempts.filter(a => a.snapshot.question.parentId === q.parentId) : [], [attempt.snapshot.materials, session.attempts, q.parentId]);
  const siblingPage = Math.floor(Math.max(0, materialSiblings.findIndex(a => a.ordinal === session.position)) / 30);
  const onBlank = useCallback((id: string) => {
    const target = blankTargets.find(a => a.snapshot.question.id === id);
    if (target) go(target.ordinal);
  }, [blankTargets, go]);
  const blankAnswers = useMemo(() => blankTargets.length ? Object.fromEntries(blankTargets.map(a => {
    const value = a.ordinal === session.position ? answer : a.answer;
    return [a.snapshot.question.id || "", value?.correct?.join(", ") || value?.answers?.join(", ") || ""];
  })) : undefined, [blankTargets, session.position, answer]);
  const selfAllowed =
    !attempt.skipped &&
    !exam && (attempt.autoResult === null || q.answerMode === "fill_blank");
  const resultLabel = exam
    ? attempt.earnedCents == null ? t("待评分") : t("{0}{1} / {2} 分", { 0: attempt.skipped ? t("未答 · ") : attempt.earnedCents > 0 && attempt.earnedCents < (attempt.maxCents || 0) ? `${t("部分得分")} · ` : "", 1: attempt.earnedCents / 100, 2: (attempt.maxCents || 0) / 100 })
    : attempt.skipped ? t("已跳过") : attempt.result === true ? t("回答正确") : attempt.result === false
      ? q.answerMode === "fill_blank" && attempt.gradeKind === "auto" ? t("文本不完全一致") : t("回答错误")
      : t("未判定");
  return (
      <Card className="overflow-visible">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {(q.questionKind ? questionKinds()[q.questionKind] : modeNames()[q.answerMode || ""]) || t("自由作答")}
                {q.answerMode === "choice"
                  ? q.choiceVariant === "multiple"
                    ? t(" · 多选")
                    : t(" · 单选")
                  : ""}
              </Badge>
              <h2 ref={questionHeading} tabIndex={-1} className="text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("第 {0} / {1} 题", { 0: session.position + 1, 1: session.attempts.length })}</h2>
            </div>
            <PracticeClock elapsed={elapsed} active={!submitted && !finished} deadlineAt={exam && !handedIn ? session.deadlineAt : null} clockNow={session.clockNow} saved={saved} finished={finished} onAutosave={() => { void persist().catch(() => {}); }} loadSession={() => api({type:"session",id:session.id})} onSession={onSession}/>

          </div>
          <p className="truncate text-xs text-muted-foreground" title={session.title}>{session.title}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          {saveError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 p-3 text-sm"><p>{t("答案保存失败，请重试或保持窗口打开。")}</p><Button variant="outline" disabled={saved === "保存中…"} onClick={() => run(async () => { await persist(); })}>{t("重试保存")}</Button></div>}
          <div className="flex flex-wrap gap-2">
            {attempt.snapshot.id && favorite != null && <Button variant="outline" onClick={()=>run(async()=>{await api({type:"favorite",id:attempt.snapshot.id!,value:!favorite});onSession(await api({type:"session",id:session.id}));})}>{favorite?t("取消收藏"):t("收藏原题")}</Button>}
            {exam && !handedIn && <Button variant="outline" onClick={()=>run(async()=>{await flushRef.current();onSession(await api({type:"flag",id:session.id,ordinal:session.position,value:!attempt.flagged}));})}>{attempt.flagged?t("取消待检查标记"):t("标记待检查")}</Button>}
          </div>
          <ExamResults session={session} onSession={onSession} run={run} onNextUnattempted={onNextUnattempted}/>
          {!exam && <p role="status" aria-label={t("答题状态")} aria-live="polite" aria-atomic="true" className="sr-only">{submitted ? t("第 {0} 题：{1}", {0:attempt.ordinal+1,1:resultLabel}) : ""}</p>}
          <Content snapshot={attempt.snapshot} exam={exam&&!handedIn} revealOriginal={exam ? handedIn : submitted} materialDialog
            onBlank={blankTargets.length ? onBlank : undefined} blankAnswers={blankAnswers}/>
          {!!materialSiblings.length && <nav className="flex flex-wrap gap-2" aria-label={t("题组子题")}>
            {materialSiblings.slice(siblingPage * 30, siblingPage * 30 + 30).map(a=><Button key={a.ordinal} variant={a.ordinal===session.position?"secondary":"outline"} size="sm" onClick={()=>go(a.ordinal)}>{a.ordinal+1}</Button>)}
            {materialSiblings.length > 30 && <div className="flex w-full items-center justify-between gap-3 text-sm">
              <span>{t("第 {0}–{1} 项", { 0: siblingPage * 30 + 1, 1: Math.min(siblingPage * 30 + 30, materialSiblings.length) })}</span>
              <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!siblingPage} onClick={() => go(materialSiblings[(siblingPage - 1) * 30].ordinal)}>{t("上一页")}</Button><Button variant="outline" size="sm" disabled={(siblingPage + 1) * 30 >= materialSiblings.length} onClick={() => go(materialSiblings[(siblingPage + 1) * 30].ordinal)}>{t("下一页")}</Button></div>
            </div>}
          </nav>}
          <AnswerInput
            question={q}
            value={answer}
            usedOptions={q.optionSourceId && attempt.snapshot.materials?.some(p=>p.id===q.optionSourceId && !p.allowReuse) ? session.attempts.filter(a=>a.ordinal!==session.position && a.snapshot.question.optionSourceId===q.optionSourceId).flatMap(a=>a.answer?.correct || []) : []}
            onChange={change}
            disabled={submitted || finished}
          />
          {!submitted && !finished && answer != null && <Button variant="outline" onClick={()=>change(null)}>{t("清空作答")}</Button>}
          {submitted && (
            <section className="space-y-4 rounded-lg border bg-muted/30 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <Badge
                  variant={
                    attempt.result === false && !(exam && (attempt.earnedCents || 0) > 0) ? "destructive" : "secondary"
                  }
                >
                  {resultLabel}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {attempt.gradeKind === "ai" ? t("AI 评分") : attempt.gradeKind === "manual" ? t("人工评分") : attempt.gradeKind === "self"
                    ? t("用户自评")
                    : attempt.gradeKind === "auto"
                      ? t("自动判定")
                      : t("不计入正确率")}
                </span>
              </div>
              {q.answerMode === "fill_blank" && attempt.autoResult === false && <p className="text-sm text-muted-foreground">{t("填空按去除首尾空白后的文本逐空比较，大小写和标点均保留。请核对差异后确认评分。")}</p>}
              <h3 className="font-medium">{t("参考答案")}</h3>
              <AnswerDisplay answer={q.answerPayload} question={q} response={attempt.answer} />
              {selfAllowed && (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm">{t("对照答案自评：")}</span>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        onSession(await api({type:"self_assess",id:session.id,ordinal:attempt.ordinal,result:true}));
                      })
                    }
                  >{t("我答对了")}</Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        onSession(await api({type:"self_assess",id:session.id,ordinal:attempt.ordinal,result:false}));
                      })
                    }
                  >{t("我答错了")}</Button>
                </div>
              )}
              {attempt.gradeKind === "self" && attempt.autoResult !== null && (
                <p className="text-xs text-muted-foreground">{t("原自动判定：{0}", { 0: attempt.autoResult ? t("正确") : t("错误") })}</p>
              )}
              <h3 className="font-medium">{t("解析")}</h3>
              <Markdown>{q.analysis || t("原文未提供解析。")}</Markdown>
            </section>
          )}
          <div className="z-10 flex md:sticky md:bottom-0 flex-wrap items-center justify-between gap-3 border-t bg-card py-3">
          {!exam && !submitted && !finished && (
            <div className="flex gap-3">
              <Button
                disabled={
                  !answerReady(
                    canInteract(q) ? q : { ...q, answerMode: "short_answer" },
                    answer,
                  )
                }
                onClick={() =>
                  run(async () => {
                    onSession(await persist(true));
                  })
                }
              >{t("提交答案")}</Button>
              <Button
                variant="outline"
                onClick={() =>
                  run(async () => {
                    onSession(await persist(true, true));
                  })
                }
              >{t("跳过此题")}</Button>
            </div>
          )}

            <Button
              variant="outline"
              disabled={session.position === 0}
              onClick={() => go(session.position - 1)}
            >{t("上一题")}</Button>
            <Button
              variant="outline"
              disabled={session.position === session.attempts.length - 1}
              onClick={() => go(session.position + 1)}
            >{t("下一题")}</Button>
          </div>
        </CardContent>
      </Card>
  );
}

function PracticeClock({elapsed, active, deadlineAt, clockNow, saved, finished, onAutosave, loadSession, onSession}: {
  elapsed: MutableRefObject<number>; active: boolean; deadlineAt?: number | null; clockNow?: number;
  saved: "已保存" | "保存中…" | "保存失败" | "待保存"; finished: boolean;
  onAutosave: () => void; loadSession: () => Promise<Session>; onSession: (session: Session) => void;
}) {
  useI18n();
  const [seconds, setSeconds] = useState(elapsed.current);
  const [clock, setClock] = useState(() => clockNow ?? Date.now());
  const autosave = useEffectEvent(onAutosave);
  const load = useEffectEvent(loadSession);
  const updateSession = useEffectEvent(onSession);
  useEffect(() => {
    if (!active && !deadlineAt) return;
    let last = performance.now(), ticks = 0, polls = 0;
    let base = clockNow ?? Date.now(), synced = last;
    let disposed = false, refreshing = false;
    const refresh = () => {
      if (!deadlineAt || refreshing) return;
      refreshing = true;
      void load().then(session => {
        if (disposed || !session) return;
        if (session.submittedAt != null) { updateSession(session); return; }
        if (session.clockNow != null) {
          base = session.clockNow;
          synced = performance.now();
          setClock(base);
        }
      }).catch(() => {}).finally(() => { refreshing = false; });
    };
    const timer = setInterval(() => {
      const current = performance.now();
      if (deadlineAt) {
        const now = base + current - synced;
        setClock(now);
        // Native continuous time also includes sleep on platforms whose performance.now does not.
        if (++polls % 3 === 0 || now >= deadlineAt) refresh();
      }
      const delta = Math.min(current - last, 1500);
      last = current;
      if (active && document.visibilityState === "visible" && document.hasFocus()) {
        elapsed.current += Math.round(delta);
        setSeconds(elapsed.current);
        if (++ticks % 3 === 0) autosave();
      }
    }, 1000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [elapsed, active, deadlineAt, clockNow]);
  return <div className="space-y-1 text-sm text-muted-foreground">
    <span>{duration(seconds)} · {finished ? t("历史快照") : t(saved)}</span>
    {deadlineAt ? <p role="timer">{t("剩余 {0}（后台与关闭应用不暂停）", { 0: duration(Math.max(0, deadlineAt-clock)) })}</p> : null}
  </div>;
}

// Match native has_answer: a partial draft counts, but whitespace-only values do not.
function hasAnswer(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.values(value).some(hasAnswer);
  return true;
}

function answerState(a: Attempt, draft: Answer | null, exam: boolean) {
    if (a.skipped) return t("已跳过");
    if (a.submittedAt != null) {
      if (a.result === true) return t("正确");
      if (a.result === false) return exam ? (a.earnedCents || 0) > 0 ? t("部分得分") : t("未得满分") : a.snapshot.question.answerMode === "fill_blank" && a.gradeKind === "auto" ? t("文本不完全一致") : t("错误");
      return t("已提交，待判定");
    }
    if (answerReady(canInteract(a.snapshot.question) ? a.snapshot.question : { ...a.snapshot.question, answerMode: "short_answer" }, draft)) return t("已作答，未提交");
    if (hasAnswer(draft)) return t("草稿未完成");
    return t("未作答");
  }

function answerMarker(a: Attempt, draft: Answer | null): LucideIcon {
  if (a.skipped) return SkipForward;
  if (a.submittedAt != null) return a.result === false ? X : Check;
  return hasAnswer(draft) ? Pencil : Circle;
}

const AnswerCardItem = memo(function AnswerCardItem({ordinal, current, state, Marker, answered, flagged, variant, go}: {
  ordinal: number; current: boolean; state: string; answered: boolean; flagged: boolean;
  Marker: LucideIcon;
  variant: "default" | "destructive" | "secondary" | "outline"; go: (position: number) => void;
}) {
  useI18n();
  return (
                <Button
                  size="sm"
                  variant={variant}
                  className={`relative h-auto min-h-10 flex-col gap-0 px-1 py-1 ${current ? "underline decoration-2 underline-offset-4" : answered ? "border-sky-200 bg-sky-100 text-sky-900 hover:bg-sky-200 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100 dark:hover:bg-sky-900/60" : ""} ${flagged ? "ring-2 ring-amber-400 ring-offset-1" : ""}`}
                  aria-current={current ? "step" : undefined}
                  aria-label={t("转到第 {0} 题，{1}{2}", { 0: ordinal + 1, 1: state, 2: flagged ? t("，待检查") : "" })}
                  title={`${state}${flagged ? t("，待检查") : ""}`}
                  onClick={() => go(ordinal)}
                >
                  <span>{ordinal + 1}</span>
                  <Marker className="size-3" aria-hidden="true" focusable="false"/>
                </Button>
  );
});

const AnswerCard = memo(function AnswerCard({session, answer, exam, go}: {
  session: Session; answer: Answer | null; exam: boolean; go: (position: number) => void;
}) {
  useI18n();
  const grid = useRef<HTMLDivElement>(null);
  const revealCurrent = useCallback((focus = false) => {
    const container = grid.current;
    const current = container?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!container || !current) return;
    if (current.offsetTop < container.scrollTop) container.scrollTop = current.offsetTop;
    else if (current.offsetTop + current.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = current.offsetTop + current.offsetHeight - container.clientHeight;
    if (focus) current.focus({ preventScroll: true });
  }, []);
  useEffect(() => { revealCurrent(); }, [session.position, revealCurrent]);
  return (
        <Card>
          <CardHeader>
            <CardTitle>{t("答题卡")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex gap-2">
              <Button variant="outline" size="icon" aria-label={t("转到第一题")} title={t("转到第一题")} disabled={session.position === 0} onClick={() => go(0)}><ArrowUpToLine/></Button>
              <Button variant="outline" size="icon" aria-label={t("定位当前题")} title={t("定位当前题")} onClick={() => revealCurrent(true)}><LocateFixed/></Button>
              <Button variant="outline" size="icon" aria-label={t("转到最后一题")} title={t("转到最后一题")} disabled={session.position === session.attempts.length - 1} onClick={() => go(session.attempts.length - 1)}><ArrowDownToLine/></Button>
            </div>
            <div ref={grid} role="region" aria-label={t("答题卡")} tabIndex={0} className="answer-card-grid relative grid max-h-[min(45vh,24rem)] grid-cols-4 gap-2 overflow-y-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {session.attempts.map(a => {
                const current = a.ordinal === session.position;
                const draft = current ? answer : a.answer;
                return <AnswerCardItem key={a.ordinal} ordinal={a.ordinal} current={current} state={answerState(a, draft, exam)} Marker={answerMarker(a, draft)} answered={!current && !a.skipped && a.result !== false && hasAnswer(draft)} flagged={!!a.flagged} variant={current ? "default" : a.result === false && !(exam && (a.earnedCents || 0) > 0) ? "destructive" : a.submittedAt ? "secondary" : "outline"} go={go}/>;
              })}
            </div>
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Circle className="size-3" aria-hidden="true"/>{t("未作答")}</span><span className="flex items-center gap-1"><Pencil className="size-3" aria-hidden="true"/>{t("草稿")}</span><span className="flex items-center gap-1"><Check className="size-3" aria-hidden="true"/>{t("已提交")}</span><span className="flex items-center gap-1"><X className="size-3" aria-hidden="true"/>{exam ? t("未得满分") : t("错误")}</span><span className="flex items-center gap-1"><SkipForward className="size-3" aria-hidden="true"/>{t("跳过")}</span></p>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("{0} {1} / {2}。草稿自动保存，可随时离开后继续。", { 0: exam ? t("已作答") : t("已提交"), 1: session.attempts.filter((a) => exam ? hasAnswer(a.ordinal === session.position ? answer : a.answer) : a.submittedAt != null).length, 2: session.attempts.length })}</p>
          </CardContent>
        </Card>
  );
});
