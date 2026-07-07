import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getQuestion } from '@/lib/openwook/services';
import { Badge } from '@heroui/react/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';

type QuestionOptionRow = {
  id: number;
  option_label: string;
  content: string;
  is_correct: boolean;
};

type AnswerKeyRow = {
  id: number;
  answer_mode: string;
  answer_payload: string;
  explanation_payload: string;
  score_payload: string;
};

export default async function QuestionDetailPage({ params }: { params: Promise<{ questionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { questionId } = await params;
  const id = Number(questionId);
  if (!Number.isInteger(id)) notFound();
  const question = await getQuestion(user, id);
  const options = Array.isArray(question.options) ? question.options as QuestionOptionRow[] : [];
  const answerKeys = Array.isArray(question.answer_keys) ? question.answer_keys as AnswerKeyRow[] : [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">题目 #{question.id}</h1>
          <p className="text-sm text-muted-foreground">{question.question_type_id} · {question.answer_mode} · {question.status}</p>
        </div>
        <Link href="/banks" className="button button--outline">
  <ArrowLeft className="size-4" />返回题库
</Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>题干</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-6">{question.stem}</div>
          {options.length > 0 && (
            <div className="grid gap-2">
              {options.map((option) => (
                <div key={option.id} className="flex items-center gap-2 rounded-md border border-border/70 bg-background/35 px-3 py-2 text-sm">
                  {option.is_correct && <CheckCircle2 className="size-4 text-foreground" />}
                  <Badge variant="secondary">{option.option_label}</Badge>
                  <span>{option.content}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>答案键</CardTitle>
          </CardHeader>
          <CardContent>
            {answerKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无答案键。</p>
            ) : (
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(answerKeys, null, 2)}</pre>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>解析</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
            {question.analysis || '暂无解析。'}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
