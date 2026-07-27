import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input, Label, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank, BankItem } from '@/lib/types';

type QuestionType = { type_id: string; display_name: string; default_answer_mode?: string | null };

export default function ManageBankPage() {
  const { bankId = '' } = useParams();
  const bank = useApiResource<Bank>(`/api/v1/banks/${bankId}`, {} as Bank);
  const items = useApiResource<BankItem[]>(`/api/v1/banks/${bankId}/items?limit=100`, []);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [stem, setStem] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [questionTypeId, setQuestionTypeId] = useState('');
  const [answerMode, setAnswerMode] = useState('short_answer');
  const [answer, setAnswer] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bank.data.subject) return;
    apiRequest<QuestionType[]>(`/api/v1/question-types?subject=${encodeURIComponent(bank.data.subject)}&scope=question`)
      .then((value) => {
        setTypes(value);
        const first = value[0];
        if (first) {
          setQuestionTypeId(first.type_id);
          setAnswerMode(first.default_answer_mode || 'short_answer');
        }
      })
      .catch(() => setTypes([]));
  }, [bank.data.subject]);

  async function createQuestion(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const selected = answer.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
      const options = answerMode === 'choice'
        ? optionsText.split('\n').map((value) => value.trim()).filter(Boolean).map((content, index) => {
          const label = String.fromCharCode(65 + index);
          return { label, content, isCorrect: selected.includes(label) };
        })
        : [];
      const answerPayload = answerMode === 'true_false'
        ? { value: answer === 'true' }
        : answerMode === 'fill_blank'
          ? { value: answer.split('|').map((value) => value.trim()).filter(Boolean) }
          : answerMode === 'choice'
            ? { selected }
            : { value: answer };
      await apiRequest(`/api/v1/banks/${bankId}/questions`, {
        method: 'POST',
        json: {
          questionTypeId,
          answerMode,
          stem,
          analysis,
          choiceVariant: answerMode === 'choice' ? (selected.length > 1 ? 'multiple' : 'single') : undefined,
          status: 'draft',
          options,
          answerPayload
        }
      });
      setStem('');
      setAnalysis('');
      setAnswer('');
      setOptionsText('');
      await items.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-5">
      <Link href={`/banks/${bankId}`}>返回题库</Link>
      <Typography.Heading level={1}>管理 {bank.data.name || '题库'}</Typography.Heading>
      <PageState loading={bank.loading || items.loading} error={bank.error || items.error} retry={() => void Promise.all([bank.reload(), items.reload()])} />
      <Card>
        <Card.Header><Typography.Heading level={2}>添加题目</Typography.Heading></Card.Header>
        <Card.Content>
          <form className="grid gap-3" onSubmit={createQuestion}>
            {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
            <Label htmlFor="question-type">题型</Label>
            <select id="question-type" className="rounded-xl border p-3" value={questionTypeId} onChange={(event) => {
              setQuestionTypeId(event.target.value);
              const selected = types.find((item) => item.type_id === event.target.value);
              if (selected?.default_answer_mode) setAnswerMode(selected.default_answer_mode);
            }}>
              {types.map((item) => <option key={item.type_id} value={item.type_id}>{item.display_name}</option>)}
            </select>
            <Label htmlFor="answer-mode">答案模式</Label>
            <select id="answer-mode" className="rounded-xl border p-3" value={answerMode} onChange={(event) => setAnswerMode(event.target.value)}>
              <option value="choice">选择</option>
              <option value="true_false">判断</option>
              <option value="fill_blank">填空</option>
              <option value="short_answer">简答</option>
            </select>
            <Label htmlFor="stem">题干</Label>
            <textarea id="stem" required className="min-h-28 rounded-xl border p-3" value={stem} onChange={(event) => setStem(event.target.value)} />
            {answerMode === 'choice' ? (
              <>
                <Label htmlFor="options">选项（每行一个，自动标记 A、B、C…）</Label>
                <textarea id="options" required className="min-h-28 rounded-xl border p-3" value={optionsText} onChange={(event) => setOptionsText(event.target.value)} />
              </>
            ) : null}
            <Label htmlFor="answer">参考答案</Label>
            {answerMode === 'true_false' ? (
              <select id="answer" required className="rounded-xl border p-3" value={answer} onChange={(event) => setAnswer(event.target.value)}>
                <option value="">请选择</option>
                <option value="true">正确</option>
                <option value="false">错误</option>
              </select>
            ) : (
              <Input
                id="answer"
                placeholder={answerMode === 'choice' ? '如 A 或 A,B' : answerMode === 'fill_blank' ? '多个空用 | 分隔' : undefined}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            )}
            <Label htmlFor="analysis">解析</Label>
            <textarea id="analysis" className="min-h-20 rounded-xl border p-3" value={analysis} onChange={(event) => setAnalysis(event.target.value)} />
            <Button type="submit" variant="primary" isDisabled={pending || !stem.trim() || !answer.trim() || !questionTypeId}>{pending ? '保存中…' : '保存草稿'}</Button>
          </form>
        </Card.Content>
      </Card>
      <div className="grid gap-2">
        {items.data.map((item) => (
          <Card key={item.question_id}>
            <Card.Content className="flex items-center justify-between gap-3">
              <span>{item.stem}</span>
              <Link href={`/questions/${item.question_id}`}>编辑</Link>
            </Card.Content>
          </Card>
        ))}
      </div>
    </section>
  );
}
