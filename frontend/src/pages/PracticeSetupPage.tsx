import { useState } from 'react';
import { Alert, Button, Card, Input, Label, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank, PracticeSession, QuestionType } from '@/lib/types';

export default function PracticeSetupPage() {
  const { bankId = '' } = useParams();
  const bank = useApiResource<Bank>(`/api/v1/banks/${bankId}`, {} as Bank);
  const types = useApiResource<QuestionType[]>(
    bank.data.subject
      ? `/api/v1/question-types?subject=${encodeURIComponent(bank.data.subject)}&scope=question`
      : null,
    [],
  );
  const [mode, setMode] = useState('all');
  const [questionTypeId, setQuestionTypeId] = useState('');
  const [count, setCount] = useState('20');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    setError('');
    try {
      const session = await apiRequest<PracticeSession>('/api/v1/practice-sessions', {
        method: 'POST',
        json: {
          bankId: Number(bankId),
          sessionType: mode === 'exam' ? 'exam' : mode === 'wrong' ? 'review' : 'practice',
          mode,
          questionCount: Number(count),
          questionTypeId: mode === 'by_type' ? questionTypeId || types.data[0]?.type_id : undefined
        }
      });
      window.location.assign(`/practice/${session.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法开始练习');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto grid max-w-xl gap-4">
      <Link href={`/banks/${bankId}`}>返回题库</Link>
      <Typography.Heading level={1}>练习 {bank.data.name || ''}</Typography.Heading>
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      <Card>
        <Card.Content className="grid gap-4">
          <Label htmlFor="practice-mode">模式</Label>
          <select id="practice-mode" className="rounded-xl border p-3" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="all">全部练习</option>
            <option value="wrong">错题重练</option>
            <option value="by_type">按题型练习</option>
            <option value="exam">考试模式</option>
          </select>
          {mode === 'by_type' ? (
            <>
              <Label htmlFor="question-type">题型</Label>
              <select
                id="question-type"
                className="rounded-xl border p-3"
                value={questionTypeId || types.data[0]?.type_id || ''}
                onChange={(event) => setQuestionTypeId(event.target.value)}
              >
                {types.data.map((item) => <option key={item.type_id} value={item.type_id}>{item.display_name}</option>)}
              </select>
            </>
          ) : null}
          <Label htmlFor="question-count">题目数量</Label>
          <Input id="question-count" type="number" min={1} max={500} value={count} onChange={(event) => setCount(event.target.value)} />
          <Button
            variant="primary"
            isDisabled={pending || (mode === 'by_type' && !(questionTypeId || types.data[0]?.type_id))}
            onPress={() => void start()}
          >
            {pending ? '正在创建…' : '开始'}
          </Button>
        </Card.Content>
      </Card>
    </section>
  );
}
