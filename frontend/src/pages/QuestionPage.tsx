import { useState } from 'react';
import { Alert, Button, Card, Input, Label, Typography } from '@heroui/react';
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
  const [newOptionLabel, setNewOptionLabel] = useState('');
  const [newOptionContent, setNewOptionContent] = useState('');
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
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    }
  }

  async function uploadMedia(file: File) {
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const asset = await apiRequest<{ id: number }>('/api/v1/media', { method: 'POST', body: form });
      await apiRequest(`/api/v1/questions/${questionId}/media-links`, {
        method: 'POST',
        json: { mediaId: asset.id, mediaKind: 'image', sortOrder: question.data.media_links.length + 1 },
      });
      await question.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    }
  }

  return (
    <section className="mx-auto grid max-w-3xl gap-4">
      <Typography.Heading level={1}>{question.data.can_edit ? '编辑题目' : '题目'}</Typography.Heading>
      <PageState loading={question.loading} error={question.error} retry={() => void question.reload()} />
      {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
      {!question.loading && !question.error ? (
        <Card>
          <Card.Content className="grid gap-3">
            <p className="text-sm text-muted">{question.data.question_type_id} · {question.data.answer_mode} · {question.data.status}</p>
            {!question.data.can_edit ? (
              <>
                <Typography.Heading level={2}>{question.data.stem}</Typography.Heading>
                {question.data.options.map((option) => <p key={option.id}>{option.option_label}. {option.content}</p>)}
                {question.data.media_links.map((link) => (
                  <img key={link.id} alt="题目附件" className="max-h-96 max-w-full object-contain" src={`/api/v1/media/${link.media_id}/content`} />
                ))}
              </>
            ) : (
              <>
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
            <Button variant="secondary" onPress={() => void action(`/api/v1/questions/${questionId}/generate-answer`, { method: 'POST', json: { apply: true } })}>AI 生成并应用答案</Button>
            {question.data.answer_mode === 'choice' ? (
              <div className="grid gap-3">
                <Typography.Heading level={3}>选项</Typography.Heading>
                {question.data.options.map((option) => (
                  <div className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[6rem_1fr_auto_auto]" key={option.id}>
                    <Input
                      aria-label="选项标签"
                      defaultValue={option.option_label}
                      onBlur={(event) => {
                        if (event.target.value !== option.option_label) void action(`/api/v1/questions/${questionId}/options/${option.id}`, {
                          method: 'PATCH',
                          json: { label: event.target.value },
                        });
                      }}
                    />
                    <Input
                      aria-label="选项内容"
                      defaultValue={option.content}
                      onBlur={(event) => {
                        if (event.target.value !== option.content) void action(`/api/v1/questions/${questionId}/options/${option.id}`, {
                          method: 'PATCH',
                          json: { content: event.target.value },
                        });
                      }}
                    />
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(option.is_correct)}
                        onChange={(event) => void action(`/api/v1/questions/${questionId}/options/${option.id}`, {
                          method: 'PATCH',
                          json: { isCorrect: event.target.checked },
                        })}
                      />
                      正确
                    </label>
                    <Button variant="danger" onPress={() => void action(`/api/v1/questions/${questionId}/options/${option.id}`, { method: 'DELETE' })}>删除</Button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Input aria-label="新选项标签" placeholder="标签，如 A" value={newOptionLabel} onChange={(event) => setNewOptionLabel(event.target.value)} />
                  <Input aria-label="新选项内容" placeholder="选项内容" value={newOptionContent} onChange={(event) => setNewOptionContent(event.target.value)} />
                  <Button
                    isDisabled={!newOptionLabel.trim() || !newOptionContent.trim()}
                    onPress={() => void action(`/api/v1/questions/${questionId}/options`, {
                      method: 'POST',
                      json: { label: newOptionLabel, content: newOptionContent, isCorrect: false },
                    }).then(() => {
                      setNewOptionLabel('');
                      setNewOptionContent('');
                    })}
                  >
                    添加选项
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="grid gap-3">
              <Typography.Heading level={3}>媒体</Typography.Heading>
              <input
                aria-label="上传题目图片"
                accept="image/png,image/jpeg,image/gif,image/webp"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadMedia(file);
                  event.target.value = '';
                }}
              />
              {question.data.media_links.map((link) => (
                <div key={link.id} className="grid gap-2">
                  <img alt="题目附件" className="max-h-96 max-w-full object-contain" src={`/api/v1/media/${link.media_id}/content`} />
                  <Button
                    variant="danger"
                    onPress={() => void action(`/api/v1/questions/${questionId}/media-links/${link.media_id}`, { method: 'DELETE' })}
                  >
                    移除图片
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {question.data.status === 'draft' ? <Button onPress={() => void action(`/api/v1/questions/${questionId}/publish`, { method: 'POST' })}>发布</Button> : null}
              {question.data.status === 'active' ? <Button onPress={() => void action(`/api/v1/questions/${questionId}/archive`, { method: 'POST' })}>归档</Button> : null}
              <Button variant="danger" onPress={() => {
                if (!window.confirm('确定删除这道题？')) return;
                void apiRequest(`/api/v1/questions/${questionId}`, { method: 'DELETE' }).then(() => window.history.back());
              }}>删除</Button>
            </div>
              </>
            )}
          </Card.Content>
        </Card>
      ) : null}
    </section>
  );
}
