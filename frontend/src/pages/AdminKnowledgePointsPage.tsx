import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Alert, Button, Card, Input, Label, Link, Typography } from '@heroui/react';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';

type Subject = { subject_id: string; display_name: string };
type KnowledgePoint = {
  id: number;
  subject_id: string;
  code: string;
  display_name: string;
  parent_id: number | null;
};

export default function AdminKnowledgePointsPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const points = useApiResource<KnowledgePoint[]>(`/api/v1/admin/knowledge-points?${params.toString()}`, []);
  const [editing, setEditing] = useState<KnowledgePoint | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<Subject[]>('/api/v1/subjects').then(setSubjects).catch(() => setSubjects([]));
  }, [params]);

  const subjectId = params.get('subject') || subjects[0]?.subject_id || 'math';

  function select(point: KnowledgePoint | null) {
    setEditing(point);
    setCode(point?.code || '');
    setName(point?.display_name || '');
    setParentId(point?.parent_id?.toString() || '');
    setError('');
  }

  async function save() {
    setError('');
    try {
      const saved = await apiRequest<KnowledgePoint>(
        editing ? `/api/v1/knowledge-points/${editing.id}` : '/api/v1/knowledge-points',
        {
          method: editing ? 'PATCH' : 'POST',
          json: editing
            ? { code, displayName: name, parentId: parentId ? Number(parentId) : null }
            : { subjectId, code, displayName: name, parentId: parentId ? Number(parentId) : null, metadata: {} },
        },
      );
      points.setData((current) => editing
        ? current.map((point) => point.id === saved.id ? saved : point)
        : [...current, saved].sort((a, b) => a.code.localeCompare(b.code)));
      select(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    }
  }

  return (
    <section className="grid gap-4">
      <Link href="/admin">返回后台</Link>
      <Link href="/admin/users">用户</Link>
      <Typography.Heading level={1}>知识点管理</Typography.Heading>
      {error || points.error ? <Alert status="danger"><Alert.Content><Alert.Description>{error || points.error}</Alert.Description></Alert.Content></Alert> : null}
      <Card>
        <Card.Content className="grid gap-3">
          <Typography.Heading level={2}>{editing ? '编辑知识点' : '创建知识点'}</Typography.Heading>
          <Label htmlFor="code">编码</Label>
          <Input id="code" value={code} onChange={(event: ChangeEvent<HTMLInputElement>) => setCode(event.target.value)} />
          <Label htmlFor="name">名称</Label>
          <Input id="name" value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} />
          <Label htmlFor="parent">父级 ID（留空为顶级）</Label>
          <Input id="parent" type="number" min={1} value={parentId} onChange={(event: ChangeEvent<HTMLInputElement>) => setParentId(event.target.value)} />
          <div className="flex gap-2">
            <Button type="button" isDisabled={!code.trim() || !name.trim()} onPress={() => void save()}>{editing ? '保存修改' : '创建知识点'}</Button>
            {editing ? <Button type="button" variant="secondary" onPress={() => select(null)}>取消</Button> : null}
          </div>
        </Card.Content>
      </Card>
      {points.data.map((point) => (
        <Card key={point.id}>
          <Card.Content className="flex items-center justify-between gap-3">
            <span>{point.code} · {point.display_name}{point.parent_id ? ` · 父级 #${point.parent_id}` : ''}</span>
            <Button variant="secondary" onPress={() => select(point)}>编辑</Button>
          </Card.Content>
        </Card>
      ))}
      {points.hasMore ? <Button isDisabled={points.loadingMore} onPress={() => void points.loadMore()}>{points.loadingMore ? '加载中…' : '加载更多知识点'}</Button> : null}
    </section>
  );
}
