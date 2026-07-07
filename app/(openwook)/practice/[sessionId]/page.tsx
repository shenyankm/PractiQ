import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Flag, XCircle } from 'lucide-react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getPracticeQuestionPage } from '@/lib/openwook/services';
import { abandonPracticeAction, completePracticeAction, submitPracticeAnswerAction } from '../../banks/actions';
import { AnswerForm } from './answer-form';
import type { BankQuestionItem } from '@/lib/openwook/types';
import { Alert, AlertDescription } from '@heroui/react/alert';
import { AlertDialog } from '@heroui/react/alert-dialog';
import { Badge } from '@heroui/react/badge';
import { Button } from '@heroui/react/button';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { Label } from '@heroui/react/label';
import { TextArea } from '@heroui/react/textarea';

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
  const { session, question, questionIndex, total, result, progress, progressTruncated, previousIndex, nextIndex } = state;
  const completeAction = completePracticeAction.bind(null, id);
  const abandonAction = abandonPracticeAction.bind(null, id);
  const answeredCount = state.answeredCount;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
      <Card className="order-3 h-fit lg:order-1">
        <CardHeader>
          <CardTitle>进度</CardTitle>
        </CardHeader>
        <CardContent className="grid max-h-96 grid-cols-5 gap-2 overflow-auto lg:grid-cols-4">
          {progressTruncated && (
            <p className="col-span-full text-xs text-muted-foreground">
              仅显示当前题附近进度，首尾题保留。
            </p>
          )}
          {progress.map((item) => {
            return (
              <Link
                key={item.questionId}
                href={`/practice/${id}?index=${item.index}`}
                className={[
                  'flex h-10 items-center justify-center rounded-md border border-border/70 bg-background/35 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
                  item.index === questionIndex ? 'border-ring bg-foreground/10 text-foreground' : ''
                ].filter(Boolean).join(' ')}
                aria-current={item.index === questionIndex ? 'step' : undefined}
                aria-label={`第 ${item.index + 1} 题，${progressLabel(item, item.index === questionIndex)}`}
              >
                {item.isAnswered ? (
                  item.isCorrect ? <CheckCircle2 className="size-4 text-foreground" /> : <XCircle className="size-4 text-destructive" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" />
                )}
              </Link>
            );
          })}
        </CardContent>
      </Card>

      <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{sessionTitle(session.session_type)}</h1>
          <p className="text-sm text-muted-foreground">
            {session.status} · 已答 {answeredCount}/{total} · 正确 {session.correct_count}
          </p>
        </div>
        {!question ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">当前会话没有可练习题目。</CardContent>
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
                <Button variant="outline" isDisabled><ChevronLeft className="size-4" />上一题</Button>
              ) : (
                <Link href={`/practice/${id}?index=${previousIndex}`} className="button button--outline">
                  <ChevronLeft className="size-4" />
                  上一题
                </Link>
              )}
              <span className="text-sm text-muted-foreground">第 {questionIndex + 1} / {total} 题</span>
              {nextIndex === null ? (
                <Button variant="outline" isDisabled>下一题<ChevronRight className="size-4" /></Button>
              ) : (
                <Link href={`/practice/${id}?index=${nextIndex}`} className="button button--primary">
                  下一题
                  <ChevronRight className="size-4" />
                </Link>
              )}
            </div>
          </>
        )}
      </div>

      <Card className="order-2 h-fit lg:order-3">
        <CardHeader>
          <CardTitle>结果</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-md bg-muted p-3">
              <div className="text-lg font-semibold">{session.answered_count}</div>
              <div className="text-muted-foreground">已答</div>
            </div>
            <div className="rounded-md bg-foreground/10 p-3 text-foreground">
              <div className="text-lg font-semibold">{session.correct_count}</div>
              <div>正确</div>
            </div>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive">
              <div className="text-lg font-semibold">{session.wrong_count}</div>
              <div>错误</div>
            </div>
          </div>
          <AlertDialog>
            <Button className="w-full" isDisabled={session.status !== 'active'}>
              <Flag className="size-4" />
              完成会话
            </Button>
            <AlertDialog.Backdrop>
              <AlertDialog.Container>
                <AlertDialog.Dialog>
                  <AlertDialog.Header>
                    <AlertDialog.Heading>确认完成会话</AlertDialog.Heading>
                  </AlertDialog.Header>
                  <AlertDialog.Body>
                    <p>完成后会锁定本次练习结果，你仍然可以返回题库重新开始新的练习。</p>
                  </AlertDialog.Body>
                  <AlertDialog.Footer>
                    <Button slot="close" variant="tertiary">继续答题</Button>
                    <form action={completeAction}>
                      <Button type="submit" className="w-full sm:w-auto">
                        确认完成
                      </Button>
                    </form>
                  </AlertDialog.Footer>
                </AlertDialog.Dialog>
              </AlertDialog.Container>
            </AlertDialog.Backdrop>
          </AlertDialog>
          <AlertDialog>
            <Button className="w-full" variant="outline" isDisabled={session.status !== 'active'}>
              放弃并返回
            </Button>
            <AlertDialog.Backdrop>
              <AlertDialog.Container>
                <AlertDialog.Dialog>
                  <AlertDialog.Header>
                    <AlertDialog.Heading>确认放弃练习</AlertDialog.Heading>
                  </AlertDialog.Header>
                  <AlertDialog.Body>
                    <p>放弃后会结束当前会话并返回仪表板，已提交的答题记录仍会保留。</p>
                  </AlertDialog.Body>
                  <AlertDialog.Footer>
                    <Button slot="close" variant="tertiary">继续答题</Button>
                    <form action={abandonAction}>
                      <Button type="submit" className="w-full sm:w-auto">
                        确认放弃
                      </Button>
                    </form>
                  </AlertDialog.Footer>
                </AlertDialog.Dialog>
              </AlertDialog.Container>
            </AlertDialog.Backdrop>
          </AlertDialog>
          {session.status !== 'active' && (
            <Link href={session.bank_id ? `/banks/${session.bank_id}` : '/dashboard'} className="button button--outline w-full">
              返回题库
            </Link>
          )}
          {nextIndex !== null && (
            <Link href={`/practice/${id}?index=${nextIndex}`} className="block text-center text-sm text-muted-foreground hover:underline">跳到下一题</Link>
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
          <Badge variant="secondary">{modeLabel(question.answer_mode)}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="whitespace-pre-wrap text-sm leading-6">{question.stem}</div>
        <AnswerForm action={action} disabled={disabled}>
          {renderAnswerInput(question)}
        </AnswerForm>
        {result && (
          <Alert status={result.is_correct === false ? 'danger' : 'success'}>
            <AlertDescription>
              {result.is_correct === null ? '已提交，简答题等待人工或规则判分。' : result.is_correct ? '回答正确。' : '回答错误。'}
              {question.analysis && <div className="mt-2">解析：{question.analysis}</div>}
            </AlertDescription>
          </Alert>
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
    if (question.choice_variant === 'multiple') {
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((option) => {
            const id = `selected-${question.question_id}-${option.label}`;

            return (
              <div key={option.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input
                  id={id}
                  name="selected"
                  type="checkbox"
                  value={option.label}
                  className="size-4 rounded border border-border"
                />
                <Label htmlFor={id} className="flex flex-1 gap-2 font-normal">
                  <span className="font-medium">{option.label}.</span>
                  <span>{option.content}</span>
                </Label>
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const id = `selected-${question.question_id}-${option.label}`;

          return (
            <div key={option.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <input
                id={id}
                name="selected"
                type="radio"
                value={option.label}
                required
                className="size-4 rounded-full border border-border"
              />
              <Label htmlFor={id} className="flex flex-1 gap-2 font-normal">
                <span className="font-medium">{option.label}.</span>
                <span>{option.content}</span>
              </Label>
            </div>
          );
        })}
      </div>
    );
  }
  if (question.answer_mode === 'true_false') {
    return (
      <div role="radiogroup" className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <input
            id={`value-${question.question_id}-true`}
            name="value"
            type="radio"
            value="true"
            required
            className="size-4 rounded-full border border-border"
          />
          <Label htmlFor={`value-${question.question_id}-true`} className="font-normal">正确</Label>
        </div>
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <input
            id={`value-${question.question_id}-false`}
            name="value"
            type="radio"
            value="false"
            required
            className="size-4 rounded-full border border-border"
          />
          <Label htmlFor={`value-${question.question_id}-false`} className="font-normal">错误</Label>
        </div>
      </div>
    );
  }
  return <TextArea name="value" rows={4} required placeholder="输入答案" />;
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

function progressLabel(
  item: { isAnswered: boolean; isCorrect: boolean | null },
  current: boolean
) {
  const status = !item.isAnswered
    ? '未作答'
    : item.isCorrect === true
      ? '已答正确'
      : item.isCorrect === false
        ? '已答错误'
        : '已提交待判分';

  return current ? `${status}，当前题` : status;
}
