import { t, useI18n } from "./i18n";
import { ExamResults } from "./ExamResults";
import { memo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  api,
  answerReady,
  canInteract,
  duration,
  modeNames,
  type Answer,
  type Attempt,
  type Session,
} from "./api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, X, SkipForward, Pencil } from "lucide-react";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { Content, Markdown } from "./Content";
import { AnswerInput, AnswerDisplay } from "./AnswerInput";
import type { MutableRefObject } from "react";
export function Practice({
  session,
  onSession,
  run,
  flushRef,
}: {
  session: Session;
  onSession: (s: Session) => void;
  run: (job: () => Promise<void>) => void;
  flushRef: MutableRefObject<() => Promise<void>>;
}) {
  useI18n();
  const attempt = session.attempts[session.position];
  const q = attempt.snapshot.question;
  const [answer, setAnswer] = useState<Answer | null>(attempt.answer);
  const [saved, setSaved] = useState<"已保存" | "保存中…" | "保存失败" | "待保存">("已保存");
  const [saveError, setSaveError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const finishButton = useRef<HTMLButtonElement>(null);
  const elapsed = useRef(attempt.elapsedMs);
  const answerRef = useRef(answer);
  const chain = useRef(Promise.resolve());
  const submitted = attempt.submittedAt !== null;
  const exam = !!session.kind && session.kind !== "practice";
  const handedIn = exam && session.submittedAt != null;
  const finished = session.finishedAt !== null || handedIn;
  const [confirmFinish,setConfirmFinish]=useState(false);
  const favorite = attempt.favorite;
  useEffect(() => {
    if (handedIn) {
      setAnswer(attempt.answer);
      answerRef.current = attempt.answer;
    }
  }, [handedIn, attempt.answer]);
  function persist(submit: true, skip?: boolean, selfResult?: boolean | null): Promise<Session>;
  function persist(submit?: false, skip?: boolean, selfResult?: boolean | null): Promise<void>;
  function persist(
    submit = false,
    skip = false,
    selfResult: boolean | null = null,
  ) {
    const captured = { answer: answerRef.current, elapsed: elapsed.current };
    setSaved("保存中…");
    const job = chain.current
      .catch(() => {})
      .then((): Promise<Session | void> => submit ?
        api<Session>({
          type: "save_attempt",
          id: session.id,
          ordinal: session.position,
          answer: captured.answer,
          elapsed_ms: captured.elapsed,
          submit,
          skip,
          self_result: selfResult,
        }) : api<void>({type:"save_draft", id:session.id, ordinal:session.position, answer:captured.answer, elapsed_ms:captured.elapsed}),
      );
    chain.current = job.then(
      () => {
        setSaved("已保存");
        setSaveError(false);
      },
      () => {
        setSaved("保存失败");
        setSaveError(true);
      },
    );
    return job;
  }
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
  }, [session.id, session.position, submitted, finished, exam, handedIn, session.deadlineAt]);
  function change(a: Answer | null) {
    setAnswer(a);
    answerRef.current = a;
    setSaved("待保存");
    void persist().catch(() => {});
  }
  const go = useCallback((position: number) => {
    run(async () => {
      await flushRef.current();
      onSession(
        await api<Session>({ type: "position", id: session.id, position }),
      );
    });
  }, [run, onSession, session.id, flushRef]);
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
  const selfAllowed =
    !attempt.skipped &&
    !exam && (attempt.autoResult === null || q.answerMode === "fill_blank");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-6">
      <Card className="overflow-visible">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {modeNames()[q.answerMode || ""] || t("自由作答")}
                {q.answerMode === "choice"
                  ? q.choiceVariant === "multiple"
                    ? t(" · 多选")
                    : t(" · 单选")
                  : ""}
              </Badge>
              <span className="text-sm text-muted-foreground">{t("第 {0} / {1} 题", { 0: session.position + 1, 1: session.attempts.length })}</span>
            </div>
            <PracticeClock elapsed={elapsed} active={!submitted && !finished} deadlineAt={exam && !handedIn ? session.deadlineAt : null} saved={saved} finished={finished} onAutosave={() => { void persist().catch(() => {}); }} onExpire={() => run(async () => onSession(await api<Session>({type:"session",id:session.id})))}/>

          </div>
          <p className="truncate text-xs text-muted-foreground" title={session.title}>{session.title}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          {saveError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 p-3 text-sm"><p>{t("答案保存失败，请重试或保持窗口打开。")}</p><Button variant="outline" disabled={saved === "保存中…"} onClick={() => run(async () => { await persist(); })}>{t("重试保存")}</Button></div>}
          <div className="flex gap-2">
            {attempt.snapshot.id && favorite != null && <Button variant="outline" onClick={()=>run(async()=>{await api({type:"favorite",id:attempt.snapshot.id!,value:!favorite});onSession(await api<Session>({type:"session",id:session.id}));})}>{favorite?t("取消收藏"):t("收藏原题")}</Button>}
            {exam && !handedIn && <Button variant="outline" onClick={()=>run(async()=>{await flushRef.current();onSession(await api({type:"flag",id:session.id,ordinal:session.position,value:!attempt.flagged}));})}>{attempt.flagged?t("取消待检查标记"):t("标记待检查")}</Button>}
          </div>
          <ExamResults session={session} onSession={onSession} run={run}/>
          <Content snapshot={attempt.snapshot} exam={exam&&!handedIn} revealOriginal={exam ? handedIn : submitted} />
          <AnswerInput
            question={q}
            value={answer}
            onChange={change}
            disabled={submitted || finished}
          />
          {!submitted && !finished && answer != null && <Button variant="outline" onClick={()=>change(null)}>{t("清空作答")}</Button>}
          {submitted && (
            <section className="space-y-4 rounded-lg border bg-muted/30 p-5">
              <div className="flex items-center gap-3">
                <Badge
                  variant={
                    attempt.result === false ? "destructive" : "secondary"
                  }
                >
                  {exam
                    ? attempt.earnedCents == null ? t("待评分") : t("{0}{1} / {2} 分", { 0: attempt.skipped ? t("未答 · ") : "", 1: attempt.earnedCents / 100, 2: (attempt.maxCents || 0) / 100 })
                    : attempt.skipped
                    ? t("已跳过")
                    : attempt.result === true
                      ? t("回答正确")
                      : attempt.result === false
                        ? t("回答错误")
                        : t("未判定")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {attempt.gradeKind === "ai" ? t("AI 评分") : attempt.gradeKind === "manual" ? t("人工评分") : attempt.gradeKind === "self"
                    ? t("用户自评")
                    : attempt.gradeKind === "auto"
                      ? t("自动判定")
                      : t("不计入正确率")}
                </span>
              </div>
              <h3 className="font-medium">{t("参考答案")}</h3>
              <AnswerDisplay answer={q.answerPayload} question={q} />
              {selfAllowed && !finished && (
                <div className="flex items-center gap-3">
                  <span className="text-sm">{t("对照答案自评：")}</span>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        onSession(await persist(true, false, true));
                      })
                    }
                  >{t("我答对了")}</Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      run(async () => {
                        onSession(await persist(true, false, false));
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
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-card py-3">
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
      <aside className="sticky top-0 self-start space-y-4">
        <AnswerCard session={session} answer={answer} exam={exam} go={go} />
        {!finished && <Button ref={finishButton} className="w-full" variant="outline" onClick={() => run(async () => { await flushRef.current(); onSession(await api({type:"session", id:session.id})); setConfirmFinish(true); })}>{exam ? t("交卷") : t("结束练习")}</Button>}
        <AlertDialog open={confirmFinish && !finished} onOpenChange={open => { if (!finishing) setConfirmFinish(open); }}>
          <AlertDialogContent className="sm:max-w-lg" onCloseAutoFocus={event => { event.preventDefault(); finishButton.current?.focus(); }}>
            <AlertDialogHeader><AlertDialogTitle>{exam ? t("确认交卷？") : t("结束本次练习？")}</AlertDialogTitle><AlertDialogDescription>{t("已提交 {0} 题；未提交草稿 {1} 题；空白 {2} 题。结束后不能修改答案。", { 0: session.attempts.filter(a => a.submittedAt != null).length, 1: session.attempts.filter(a => a.submittedAt == null && a.answer !== null).length, 2: session.attempts.filter(a => a.submittedAt == null && a.answer === null).length })}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter className="flex-wrap"><AlertDialogCancel disabled={finishing}>{t("继续作答")}</AlertDialogCancel>{!exam && <Button variant="outline" disabled={finishing} onClick={() => finish(false)}>{t("草稿记为跳过并结束")}</Button>}<Button disabled={finishing} onClick={() => finish(true)}>{finishing ? t("正在保存…") : exam ? t("确认交卷") : t("提交草稿并结束")}</Button></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {finished && (
          <Card>
            <CardContent className="pt-5 text-sm">{t("作答已锁定，当前显示作答时的内容快照。")}</CardContent>
          </Card>
        )}
      </aside>
    </div>
  );
}

function PracticeClock({elapsed, active, deadlineAt, saved, finished, onAutosave, onExpire}: {
  elapsed: MutableRefObject<number>; active: boolean; deadlineAt?: number | null;
  saved: "已保存" | "保存中…" | "保存失败" | "待保存"; finished: boolean;
  onAutosave: () => void; onExpire: () => void;
}) {
  useI18n();
  const [seconds, setSeconds] = useState(elapsed.current);
  const [clock, setClock] = useState(Date.now);
  const autosave = useEffectEvent(onAutosave);
  const expire = useEffectEvent(onExpire);
  useEffect(() => {
    if (!active && !deadlineAt) return;
    let last = performance.now(), ticks = 0;
    const timer = setInterval(() => {
      if (deadlineAt) {
        const now = Date.now();
        setClock(now);
        if (now >= deadlineAt) { expire(); return; }
      }
      const current = performance.now();
      const delta = Math.min(current - last, 1500);
      last = current;
      if (active && document.visibilityState === "visible" && document.hasFocus()) {
        elapsed.current += Math.round(delta);
        setSeconds(elapsed.current);
        if (++ticks % 3 === 0) autosave();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [elapsed, active, deadlineAt]);
  return <div className="space-y-1 text-sm text-muted-foreground">
    <span>{duration(seconds)} · {finished ? t("历史快照") : t(saved)}</span>
    {deadlineAt ? <p role="timer">{t("剩余 {0}（后台与关闭应用不暂停）", { 0: duration(Math.max(0, deadlineAt-clock)) })}</p> : null}
  </div>;
}

function answerState(a: Attempt, draft: Answer | null, exam: boolean) {
    if (a.skipped) return t("已跳过");
    if (a.submittedAt != null) {
      if (a.result === true) return t("正确");
      if (a.result === false) return exam ? t("未得满分") : t("错误");
      return t("已提交，待判定");
    }
    if (answerReady(canInteract(a.snapshot.question) ? a.snapshot.question : { ...a.snapshot.question, answerMode: "short_answer" }, draft)) return t("已作答，未提交");
    if (draft !== null) return t("草稿未完成");
    return t("未作答");
  }

const AnswerCardItem = memo(function AnswerCardItem({a, current, answer, exam, go}: {
  a: Attempt; current: boolean; answer: Answer | null; exam: boolean; go: (position: number) => void;
}) {
  useI18n();
  const state = answerState(a, answer, exam);
  const answered = !current && !a.skipped && a.result !== false && answer !== null;
  return (
                <Button
                  key={a.ordinal}
                  size="sm"
                  variant={
                    current
                      ? "default"
                      : a.result === false
                        ? "destructive"
                        : a.submittedAt
                          ? "secondary"
                          : "outline"
                  }
                  className={`relative min-h-9 ${current ? "underline decoration-2 underline-offset-4" : answered ? "border-sky-200 bg-sky-100 text-sky-900 hover:bg-sky-200 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100 dark:hover:bg-sky-900/60" : ""} ${a.flagged ? "ring-2 ring-amber-400 ring-offset-1" : ""}`}
                  aria-current={current ? "step" : undefined}
                  aria-label={t("转到第 {0} 题，{1}{2}", { 0: a.ordinal + 1, 1: state, 2: a.flagged ? t("，待检查") : "" })}
                  title={`${state}${a.flagged ? t("，待检查") : ""}`}
                  onClick={() => go(a.ordinal)}
                >
                  {a.ordinal + 1}
                </Button>
  );
});

const AnswerCard = memo(function AnswerCard({session, answer, exam, go}: {
  session: Session; answer: Answer | null; exam: boolean; go: (position: number) => void;
}) {
  useI18n();
  return (
        <Card>
          <CardHeader>
            <CardTitle>{t("答题卡")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-2">
              {session.attempts.map(a => <AnswerCardItem key={a.ordinal} a={a} current={a.ordinal === session.position} answer={a.ordinal === session.position ? answer : a.answer} exam={exam} go={go} />)}
            </div>
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Pencil className="size-3"/>{t("草稿")}</span><span className="flex items-center gap-1"><Check className="size-3"/>{t("已提交")}</span><span className="flex items-center gap-1"><X className="size-3"/>{exam ? t("未得满分") : t("错误")}</span><span className="flex items-center gap-1"><SkipForward className="size-3"/>{t("跳过")}</span></p>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("{0} {1} / {2}。草稿自动保存，可随时离开后继续。", { 0: exam ? t("已作答") : t("已提交"), 1: session.attempts.filter((a) => exam ? a.answer !== null : a.submittedAt).length, 2: session.attempts.length })}</p>
          </CardContent>
        </Card>
  );
});
