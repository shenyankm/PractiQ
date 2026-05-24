import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Circle, Flag, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getPracticeQuestions, getPracticeResults, getPracticeSession } from '@/lib/openwook/services';
import { abandonPracticeAction, completePracticeAction, submitPracticeAnswerAction } from '../../banks/actions';
import type { BankQuestionItem } from '@/lib/openwook/types';

export default async function PracticeSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { sessionId } = await params;
  const id = Number(sessionId);
  if (!Number.isInteger(id)) notFound();

  const [session, questions, results] = await Promise.all([
    getPracticeSession(user, id),
    getPracticeQuestions(user, id),
    getPracticeResults(user, id)
  ]);
  const answered = new Map(results.map((answer) => [answer.question_id, answer]));
  const nextQuestion = questions.find((question) => !answered.has(question.question_id)) ?? questions[0];
  const completeAction = completePracticeAction.bind(null, id);
  const abandonAction = abandonPracticeAction.bind(null, id);

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr_320px]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>进度</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {questions.map((question, index) => {
            const result = answered.get(question.question_id);
            return (
              <a key={question.question_id} href={`#q-${question.question_id}`} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-slate-50">
                {result ? (
                  result.is_correct ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />
                ) : (
                  <Circle className="size-4 text-slate-400" />
                )}
                <span>第 {index + 1} 题</span>
              </a>
            );
          })}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">练习作答</h1>
          <p className="text-sm text-slate-500">
            {session.status} · 已答 {session.answered_count}/{session.question_count} · 正确 {session.correct_count}
          </p>
        </div>
        {questions.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-slate-500">当前会话没有可练习题目。</CardContent>
          </Card>
        ) : (
          questions.map((question, index) => (
            <QuestionPanel
              key={question.question_id}
              sessionId={id}
              question={question}
              index={index}
              disabled={session.status !== 'active' || answered.has(question.question_id)}
              result={answered.get(question.question_id)}
            />
          ))
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
          {nextQuestion && <a href={`#q-${nextQuestion.question_id}`} className="block text-center text-sm text-slate-500 hover:underline">跳到下一题</a>}
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
        <form action={action} className="space-y-3">
          {renderAnswerInput(question)}
          <input type="hidden" name="durationMs" value="0" />
          <Button type="submit" disabled={disabled}>提交答案</Button>
        </form>
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
            <input type={question.choice_variant === 'multiple' ? 'checkbox' : 'radio'} name="selected" value={option.label} />
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
        <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="radio" name="value" value="true" />正确</label>
        <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><input type="radio" name="value" value="false" />错误</label>
      </div>
    );
  }
  return <textarea name="value" rows={4} required className="w-full rounded-md border bg-white px-3 py-2 text-sm" placeholder="输入答案" />;
}

function modeLabel(mode: string) {
  return {
    choice: '选择题',
    true_false: '判断题',
    fill_blank: '填空题',
    short_answer: '简答题'
  }[mode] ?? mode;
}
