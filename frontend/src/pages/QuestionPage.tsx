import { useState } from 'react';
import { Alert, Button, Card, Label, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Question } from '@/lib/types';

export default function QuestionPage() {
  const { questionId = '' } = useParams();
  const question = useApiResource<Question>(`/api/v1/questions/${questionId}`, {} as Question);
  const [draft, setDraft] = useState<{
    questionId: string;
    stem: string;
    analysis: string;
    answerJSON: string;
  } | null>(null);
  const [error, setError] = useState('');
  const values = draft?.questionId === questionId ? draft : {
    questionId,
    stem: question.data.stem || '',
    analysis: question.data.analysis || '',
    answerJSON: question.data.answer_keys?.[0]?.answer_payload || '{}'
  };

  async function action(path: string, options: { method: string; json?: unknown }) {
    setError('');
    try {
      await apiRequest(path, options);
      await question.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    }
  }

  return (
    <section className="mx-auto grid max-w-3xl gap-4">
      <Typography.Heading level={1}>编辑题目</Typography.Heading>
      <PageState loading={question.loading} error={question.error} retry={() => void question.reload()} />
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      {!question.loading && !question.error ? (
        <Card>
          <Card.Content className="grid gap-3">
            <p className="text-sm text-muted">{question.data.question_type_id} · {question.data.answer_mode} · {question.data.status}</p>
            <Label htmlFor="edit-stem">题干</Label>
            <textarea id="edit-stem" className="min-h-32 rounded-xl border p-3" value={values.stem} onChange={(event) => setDraft({ ...values, stem: event.target.value })} />
            <Label htmlFor="edit-analysis">解析</Label>
            <textarea id="edit-analysis" className="min-h-24 rounded-xl border p-3" value={values.analysis} onChange={(event) => setDraft({ ...values, analysis: event.target.value })} />
            <Button variant="primary" onPress={() => void action(`/api/v1/questions/${questionId}`, { method: 'PATCH', json: { stem: values.stem, analysis: values.analysis } })}>保存内容</Button>
            <Label htmlFor="answer-json">答案 JSON</Label>
            <textarea id="answer-json" className="min-h-24 rounded-xl border p-3 font-mono" value={values.answerJSON} onChange={(event) => setDraft({ ...values, answerJSON: event.target.value })} />
            <Button onPress={() => {
              try {
                const answerPayload = JSON.parse(values.answerJSON);
                void action(`/api/v1/questions/${questionId}/answer-key`, {
                  method: 'PUT',
                  json: { answerMode: question.data.answer_mode, answerPayload, explanationPayload: {}, scorePayload: {} }
                });
              } catch {
                setError('答案必须是有效 JSON。');
              }
            }}>保存答案</Button>
            <div className="flex flex-wrap gap-2">
              {question.data.status === 'draft' ? <Button onPress={() => void action(`/api/v1/questions/${questionId}/publish`, { method: 'POST' })}>发布</Button> : null}
              {question.data.status === 'active' ? <Button onPress={() => void action(`/api/v1/questions/${questionId}/archive`, { method: 'POST' })}>归档</Button> : null}
              <Button variant="danger" onPress={() => {
                if (!window.confirm('确定删除这道题？')) return;
                void apiRequest(`/api/v1/questions/${questionId}`, { method: 'DELETE' }).then(() => window.history.back());
              }}>删除</Button>
            </div>
          </Card.Content>
        </Card>
      ) : null}
    </section>
  );
}
