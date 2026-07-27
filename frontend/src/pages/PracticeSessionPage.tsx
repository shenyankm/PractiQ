import { useMemo, useState } from 'react';
import { Alert, Button, Card, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { BankItem, PracticeSession } from '@/lib/types';

type PracticePage = {
  session: PracticeSession;
  question: BankItem | null;
  questionIndex: number;
  total: number;
  answeredCount: number;
  result?: { is_correct?: boolean | null } | null;
  previousIndex?: number | null;
  nextIndex?: number | null;
};

type PracticeResult = {
  id: number;
  question_id: number;
  stem: string;
  is_correct?: boolean | null;
  analysis?: string | null;
};

export default function PracticeSessionPage() {
  const { sessionId = '' } = useParams();
  const [index, setIndex] = useState(0);
  const url = useMemo(() => `/api/v1/practice-sessions/${sessionId}/question-page?index=${index}`, [index, sessionId]);
  const page = useApiResource<PracticePage>(url, {} as PracticePage);
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [results, setResults] = useState<PracticeResult[] | null>(null);

  function payload() {
    switch (page.data.question?.answer_mode) {
      case 'choice': return { selected };
      case 'true_false': return { value: answer === 'true' };
      case 'fill_blank': return { value: answer.split('|').map((item) => item.trim()) };
      default: return { value: answer };
    }
  }

  async function submit() {
    if (!page.data.question) return;
    setError('');
    try {
      await apiRequest(`/api/v1/practice-sessions/${sessionId}/answers`, {
        method: 'POST',
        json: { questionId: page.data.question.question_id, answerPayload: payload() }
      });
      setAnswer('');
      setSelected([]);
      if (page.data.nextIndex !== null && page.data.nextIndex !== undefined) setIndex(page.data.nextIndex);
      else await page.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交失败');
    }
  }

  async function complete() {
    setError('');
    try {
      await apiRequest(`/api/v1/practice-sessions/${sessionId}/complete`, { method: 'POST' });
      setResults(await apiRequest<PracticeResult[]>(`/api/v1/practice-sessions/${sessionId}/results`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '完成练习失败');
    }
  }

  if (results) {
    return (
      <section className="grid gap-4">
        <Typography.Heading level={1}>练习结果</Typography.Heading>
        {results.map((result, resultIndex) => (
          <Card key={result.id}>
            <Card.Content>
              <p>{resultIndex + 1}. {result.stem}</p>
              <p>{result.is_correct === true ? '正确' : result.is_correct === false ? '错误' : '已作答'}</p>
              {result.analysis ? <p>{result.analysis}</p> : null}
            </Card.Content>
          </Card>
        ))}
        <Link href="/dashboard">返回概览</Link>
      </section>
    );
  }

  const question = page.data.question;
  return (
    <section className="mx-auto grid max-w-3xl gap-4">
      <Typography.Heading level={1}>练习</Typography.Heading>
      <PageState loading={page.loading} error={page.error} retry={() => void page.reload()} />
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      {question ? (
        <Card>
          <Card.Header><p>第 {page.data.questionIndex + 1} / {page.data.total} 题</p></Card.Header>
          <Card.Content className="grid gap-4">
            <Typography.Heading level={2}>{question.stem}</Typography.Heading>
            {question.answer_mode === 'choice' ? question.options?.map((option) => (
              <label key={option.id} className="flex gap-2">
                <input
                  type={question.choice_variant === 'multiple' ? 'checkbox' : 'radio'}
                  name="answer"
                  checked={selected.includes(option.option_label)}
                  onChange={() => setSelected((current) => question.choice_variant === 'multiple'
                    ? current.includes(option.option_label)
                      ? current.filter((value) => value !== option.option_label)
                      : [...current, option.option_label]
                    : [option.option_label])}
                />
                {option.option_label}. {option.content}
              </label>
            )) : question.answer_mode === 'true_false' ? (
              <select aria-label="判断答案" className="rounded-xl border p-3" value={answer} onChange={(event) => setAnswer(event.target.value)}>
                <option value="">请选择</option>
                <option value="true">正确</option>
                <option value="false">错误</option>
              </select>
            ) : (
              <textarea
                aria-label="答案"
                className="min-h-28 rounded-xl border p-3"
                placeholder={question.answer_mode === 'fill_blank' ? '多个空用 | 分隔' : '输入答案'}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            )}
            {page.data.result ? <Alert status="success"><Alert.Content><Alert.Description>本题已提交。</Alert.Description></Alert.Content></Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button isDisabled={page.data.previousIndex === null || page.data.previousIndex === undefined} onPress={() => setIndex(page.data.previousIndex || 0)}>上一题</Button>
              <Button variant="primary" onPress={() => void submit()}>提交答案</Button>
              {page.data.nextIndex !== null && page.data.nextIndex !== undefined
                ? <Button onPress={() => setIndex(page.data.nextIndex!)}>下一题</Button>
                : page.data.result ? <Button onPress={() => void complete()}>完成练习</Button> : null}
            </div>
          </Card.Content>
        </Card>
      ) : null}
    </section>
  );
}
