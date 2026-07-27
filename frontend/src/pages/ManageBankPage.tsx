import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input, Label, Link, Typography } from '@heroui/react';
import { useParams } from 'react-router-dom';
import { PageState } from '@/components/PageState';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank, BankGroup, BankItem } from '@/lib/types';

type QuestionType = { type_id: string; display_name: string; default_answer_mode?: string | null };

export default function ManageBankPage() {
  const { bankId = '' } = useParams();
  const bank = useApiResource<Bank>(`/api/v1/banks/${bankId}`, {} as Bank);
  const items = useApiResource<BankItem[]>(`/api/v1/banks/${bankId}/items?limit=100&includeAnswers=true`, []);
  const groups = useApiResource<BankGroup[]>(`/api/v1/banks/${bankId}/groups?limit=100`, []);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [bankName, setBankName] = useState<string | null>(null);
  const [bankDescription, setBankDescription] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [stem, setStem] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [questionTypeId, setQuestionTypeId] = useState('');
  const [answerMode, setAnswerMode] = useState('short_answer');
  const [answer, setAnswer] = useState('');
  const [optionsText, setOptionsText] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupInstructions, setGroupInstructions] = useState('');
  const [groupQuestions, setGroupQuestions] = useState<Record<number, string>>({});
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

  const bankNameValue = bankName ?? bank.data.name ?? '';
  const bankDescriptionValue = bankDescription ?? bank.data.description ?? '';
  const isPublicValue = isPublic ?? Boolean(bank.data.is_public);

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

  async function updateBank(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const updated = await apiRequest<Bank>(`/api/v1/banks/${bankId}`, {
        method: 'PATCH',
        json: {
          name: bankNameValue.trim(),
          description: bankDescriptionValue.trim() || null,
          isPublic: isPublicValue,
        },
      });
      bank.setData({ ...updated, is_owner: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存题库失败');
    } finally {
      setPending(false);
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await apiRequest(`/api/v1/banks/${bankId}/groups`, {
        method: 'POST',
        json: {
          title: groupTitle.trim(),
          instructions: groupInstructions.trim() || null,
          contentMode: 'text_only',
          status: 'draft',
        },
      });
      setGroupTitle('');
      setGroupInstructions('');
      await groups.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建组合题失败');
    } finally {
      setPending(false);
    }
  }

  async function groupAction(path: string, options: { method: string; json?: unknown }) {
    setPending(true);
    setError('');
    try {
      await apiRequest(path, options);
      await Promise.all([groups.reload(), items.reload()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '组合题操作失败');
    } finally {
      setPending(false);
    }
  }

  const standaloneItems = items.data.filter((item) => !item.group_id);

  return (
    <section className="grid gap-5">
      <Link href={`/banks/${bankId}`}>返回题库</Link>
      <Typography.Heading level={1}>管理 {bank.data.name || '题库'}</Typography.Heading>
      <PageState loading={bank.loading || items.loading || groups.loading} error={bank.error || items.error || groups.error} retry={() => void Promise.all([bank.reload(), items.reload(), groups.reload()])} />
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      <Card>
        <Card.Header><Typography.Heading level={2}>题库资料</Typography.Heading></Card.Header>
        <Card.Content>
          <form className="grid gap-3" onSubmit={updateBank}>
            <Label htmlFor="bank-name">名称</Label>
            <Input id="bank-name" required maxLength={100} value={bankNameValue} onChange={(event) => setBankName(event.target.value)} />
            <Label htmlFor="bank-description">描述</Label>
            <textarea id="bank-description" className="min-h-20 rounded-xl border p-3" maxLength={500} value={bankDescriptionValue} onChange={(event) => setBankDescription(event.target.value)} />
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isPublicValue} onChange={(event) => setIsPublic(event.target.checked)} />
              公开题库
            </label>
            <Button type="submit" isDisabled={pending || !bankNameValue.trim()}>保存题库资料</Button>
          </form>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header><Typography.Heading level={2}>添加题目</Typography.Heading></Card.Header>
        <Card.Content>
          <form className="grid gap-3" onSubmit={createQuestion}>
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
      <Card>
        <Card.Header><Typography.Heading level={2}>组合题</Typography.Heading></Card.Header>
        <Card.Content className="grid gap-4">
          <form className="grid gap-3" onSubmit={createGroup}>
            <Label htmlFor="group-title">组合题标题</Label>
            <Input id="group-title" maxLength={1000} required value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} />
            <Label htmlFor="group-instructions">作答说明</Label>
            <textarea id="group-instructions" className="min-h-20 rounded-xl border p-3" maxLength={20000} value={groupInstructions} onChange={(event) => setGroupInstructions(event.target.value)} />
            <Button type="submit" isDisabled={pending || !groupTitle.trim()}>创建组合题</Button>
          </form>
          {groups.data.map((group) => (
            <div className="grid gap-3 rounded-xl border p-3" key={group.id}>
              <Input
                aria-label={`组合题 ${group.id} 标题`}
                defaultValue={group.title || ''}
                onBlur={(event) => {
                  if (event.target.value.trim() !== (group.title || '')) void groupAction(`/api/v1/groups/${group.id}`, {
                    method: 'PATCH',
                    json: { title: event.target.value.trim() },
                  });
                }}
              />
              <textarea
                aria-label={`组合题 ${group.id} 作答说明`}
                className="min-h-20 rounded-xl border p-3"
                defaultValue={group.instructions || ''}
                onBlur={(event) => {
                  if (event.target.value.trim() !== (group.instructions || '')) void groupAction(`/api/v1/groups/${group.id}`, {
                    method: 'PATCH',
                    json: { instructions: event.target.value.trim() || null },
                  });
                }}
              />
              <p className="text-sm text-muted">{group.status} · {group.question_count} 题</p>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={`加入组合题 ${group.id}`}
                  className="min-w-48 rounded-xl border p-2"
                  value={groupQuestions[group.id] || ''}
                  onChange={(event) => setGroupQuestions((current) => ({ ...current, [group.id]: event.target.value }))}
                >
                  <option value="">选择题目</option>
                  {standaloneItems.map((item) => <option key={item.question_id} value={item.question_id}>{item.stem}</option>)}
                </select>
                <Button
                  isDisabled={pending || !groupQuestions[group.id]}
                  onPress={() => void groupAction(`/api/v1/groups/${group.id}/questions`, {
                    method: 'POST',
                    json: { questionId: Number(groupQuestions[group.id]) },
                  }).then(() => setGroupQuestions((current) => ({ ...current, [group.id]: '' })))}
                >
                  加入题目
                </Button>
                {group.status !== 'active' ? <Button onPress={() => void groupAction(`/api/v1/groups/${group.id}/publish`, { method: 'POST' })}>发布组合题</Button> : null}
                {group.status === 'active' ? <Button variant="secondary" onPress={() => void groupAction(`/api/v1/groups/${group.id}/archive`, { method: 'POST' })}>归档组合题</Button> : null}
                <Button variant="danger" onPress={() => {
                  if (window.confirm('确定删除这个组合题？题目会保留为独立题目。')) {
                    void groupAction(`/api/v1/groups/${group.id}`, { method: 'DELETE' });
                  }
                }}>删除组合题</Button>
              </div>
              {items.data.filter((item) => item.group_id === group.id).map((item) => (
                <div className="flex items-center justify-between gap-2" key={item.question_id}>
                  <Link href={`/questions/${item.question_id}`}>{item.stem}</Link>
                  <Button variant="danger" onPress={() => void groupAction(`/api/v1/groups/${group.id}/questions/${item.question_id}`, { method: 'DELETE' })}>移出组合题</Button>
                </div>
              ))}
            </div>
          ))}
          {groups.hasMore ? <Button isDisabled={groups.loadingMore} onPress={() => void groups.loadMore()}>{groups.loadingMore ? '加载中…' : '加载更多组合题'}</Button> : null}
        </Card.Content>
      </Card>
      <div className="grid gap-2">
        {items.data.map((item) => (
          <Card key={`${item.group_id || 0}-${item.question_id}`}>
            <Card.Content className="flex items-center justify-between gap-3">
              <span>{item.stem}</span>
              <Link href={`/questions/${item.question_id}`}>编辑</Link>
            </Card.Content>
          </Card>
        ))}
        {items.hasMore ? <Button isDisabled={items.loadingMore} onPress={() => void items.loadMore()}>{items.loadingMore ? '加载中…' : '加载更多题目'}</Button> : null}
      </div>
    </section>
  );
}
