import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Flag, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getPracticeQuestionPage } from '@/lib/openwook/services';
import { abandonPracticeAction, completePracticeAction, submitPracticeAnswerAction } from '../../banks/actions';
import { AnswerForm } from './answer-form';
import type { BankQuestionItem } from '@/lib/openwook/types';

export default async function PracticeSessionPage({
  params,
  searchParams
}: {
  params: Promise<{ sessionId: string }>;
  searchParams?: Promise<{ index?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) return null;
  const [{ sessionId }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as { index?: string })
  ]);
  const id = Number(sessionId);
  if (!Number.isInteger(id)) notFound();

  const state = await getPracticeQuestionPage(user, id, new URLSearchParams(query.index ? { index: query.index } : undefined));
  const { session, question, questionIndex, total, result, progress, previousIndex, nextIndex } = state;
  const completeAction = completePracticeAction.bind(null, id);
  const abandonAction = abandonPracticeAction.bind(null, id);
  const answeredCount = progress.filter((item) => item.isAnswered).length;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr_320px]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>进度</CardTitle>
        </CardHeader>
        <CardContent className="grid max-h-96 grid-cols-5 gap-2 overflow-auto lg:grid-cols-4">
          {progress.map((item) => {
            return (
              <Link
                key={item.questionId}
                href={`/practice/${id}?index=${item.index}`}
                className={`flex h-10 items-center justify-center rounded-md border text-xs hover:bg-slate-50 ${item.index === questionIndex ? 'border-slate-900 bg-slate-100' : ''}`}
                aria-label={`第 ${item.index + 1} 题`}
              >
                {item.isAnswered ? (
                  item.isCorrect ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />
                ) : (
                  <Circle className="size-4 text-slate-400" />
                )}
              </Link>
            );
          })}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{sessionTitle(session.session_type)}</h1>
          <p className="text-sm text-slate-500">
            {session.status} · 已答 {answeredCount}/{total} · 正确 {session.correct_count}
          </p>
        </div>
        {!question ? (
          <Card>
            <CardContent className="p-6 text-sm text-slate-500">当前会话没有可练习题目。</CardContent>
          </Card>
        ) : (
          <>
            <QuestionPanel
              sessionId={id}
              question={question}
              index={questionIndex}
              disabled={session.status !== 'active' || Boolean(result)}
              result={result ?? undefined}
            />
            <div className="flex items-center justify-between gap-3">
              {previousIndex === null ? (
                <Button variant="outline" disabled><ChevronLeft className="size-4" />上一题</Button>
              ) : (
                <Button asChild variant="outline">
                  <Link href={`/practice/${id}?index=${previousIndex}`}>
                    <ChevronLeft className="size-4" />
                    上一题
                  </Link>
                </Button>
              )}
              <span className="text-sm text-slate-500">第 {questionIndex + 1} / {total} 题</span>
              {nextIndex === null ? (
                <Button variant="outline" disabled>下一题<ChevronRight className="size-4" /></Button>
              ) : (
                <Button asChild variant="outline">
                  <Link href={`/practice/${id}?index=${nextIndex}`}>
                    下一题
                    <ChevronRight className="size-4" />
                  </Link>
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>结果</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-md bg-slate-100 p-3">
              <div className="text-lg font-semibold">{session.answered_count}</div>
              <div className="text-slate-500">已答</div>
            </div>
            <div className="rounded-md bg-emerald-50 p-3 text-emerald-700">
              <div className="text-lg font-semibold">{session.correct_count}</div>
              <div>正确</div>
            </div>
            <div className="rounded-md bg-red-50 p-3 text-red-700">
              <div className="text-lg font-semibold">{session.wrong_count}</div>
              <div>错误</div>
            </div>
          </div>
          <form action={completeAction}>
            <Button className="w-full" disabled={session.status !== 'active'}>
              <Flag className="size-4" />
              完成会话
            </Button>
          </form>
          <form action={abandonAction}>
            <Button className="w-full" variant="outline" disabled={session.status !== 'active'}>放弃并返回</Button>
          </form>
          {session.status !== 'active' && (
            <Button asChild variant="outline" className="w-full">
              <Link href={session.bank_id ? `/banks/${session.bank_id}` : '/dashboard'}>返回题库</Link>
            </Button>
          )}
          {nextIndex !== null && (
            <Link href={`/practice/${id}?index=${nextIndex}`} className="block text-center text-sm text-slate-500 hover:underline">跳到下一题</Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QuestionPanel({
  sessionId,
  question,
  index,
  disabled,
  result
}: {
  sessionId: number;
  question: BankQuestionItem;
  index: number;
  disabled: boolean;
  result?: { is_correct: boolean | null; score: number | null; answer_payload: Record<string, unknown> };
}) {
  const action = submitPracticeAnswerAction.bind(null, sessionId, question.question_id, question.answer_mode);
  return (
    <Card id={`q-${question.question_id}`}>
      <CardHeader>
        <CardTitle className="flex items-start justify-between gap-3 text-base">
          <span>第 {index + 1} 题</span>
          <span className="rounded bg-slate-100 px-2 py-1 text-xs font-normal">{modeLabel(question.answer_mode)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="whitespace-pre-wrap text-sm leading-6">{question.stem}</div>
        <AnswerForm action={action} disabled={disabled}>
          {renderAnswerInput(question)}
        </AnswerForm>
        {result && (
          <div className={`rounded-md border px-3 py-2 text-sm ${result.is_correct ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : result.is_correct === false ? 'border-red-200 bg-red-50 text-red-800' : 'bg-slate-50 text-slate-700'}`}>
            {result.is_correct === null ? '已提交，简答题等待人工或规则判分。' : result.is_correct ? '回答正确。' : '回答错误。'}
            {question.analysis && <div className="mt-2 text-slate-600">解析：{question.analysis}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function renderAnswerInput(question: BankQuestionItem) {
  if (question.answer_mode === 'choice') {
    const options = question.options?.length
      ? question.options.map((option) => ({ label: option.option_label, content: option.content }))
      : ['A', 'B', 'C', 'D'].map((label) => ({ label, content: label }));
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <input type={question.choice_variant === 'multiple' ? 'checkbox' : 'radio'} name="selected" value={option.label} required={question.choice_variant !== 'multiple'} />
            <span className="font-medium">{option.label}.</span>
            <span>{option.content}</span>
          </label>
        ))}
      </div>
    );
  }
  if (question.answer_mode === 'true_false') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="radio" name="value" value="true" required />正确</label>
        <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="radio" name="value" value="false" required />错误</label>
      </div>
    );
  }
  return <textarea name="value" rows={4} required className="w-full rounded-md border bg-white px-3 py-2 text-sm" placeholder="输入答案" />;
}

function sessionTitle(type: string) {
  if (type === 'review') return '错题复习';
  if (type === 'exam') return '自测模考';
  return '练习作答';
}

function modeLabel(mode: string) {
  return {
    choice: '选择题',
    true_false: '判断题',
    fill_blank: '填空题',
    short_answer: '简答题'
  }[mode] ?? mode;
}
