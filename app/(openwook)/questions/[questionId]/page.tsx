import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getQuestion } from '@/lib/openwook/services';

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
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">题目 #{question.id}</h1>
          <p className="text-sm text-slate-500">{question.question_type_id} · {question.answer_mode} · {question.status}</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/banks"><ArrowLeft className="size-4" />返回题库</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>题干</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-sm leading-6">{question.stem}</div>
          {options.length > 0 && (
            <div className="grid gap-2">
              {options.map((option) => (
                <div key={option.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  {option.is_correct && <CheckCircle2 className="size-4 text-emerald-600" />}
                  <span className="font-medium">{option.option_label}.</span>
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
              <p className="text-sm text-slate-500">暂无答案键。</p>
            ) : (
              <pre className="max-h-72 overflow-auto rounded-md bg-slate-50 p-3 text-xs">{JSON.stringify(answerKeys, null, 2)}</pre>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>解析</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
            {question.analysis || '暂无解析。'}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
