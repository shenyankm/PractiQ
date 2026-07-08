import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Input, Label, Link } from '@heroui/react';
import { apiRequest } from '@/lib/api';

type Subject = { subject_id: string; display_name: string };
type KnowledgePoint = { id: number; display_name: string };

export default function AdminKnowledgePointsPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [points, setPoints] = useState<KnowledgePoint[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    apiRequest<Subject[]>('/api/v1/subjects').then(setSubjects).catch(() => setSubjects([]));
    apiRequest<KnowledgePoint[]>(`/api/v1/admin/knowledge-points?${params.toString()}`).then(setPoints).catch(() => setPoints([]));
  }, [params]);

  const subjectId = params.get('subject') || subjects[0]?.subject_id || 'math';

  return (
    <div>
      <Link href="/admin">返回后台</Link>
      <Link href="/admin/users">用户</Link>
      {points.map((point) => <div key={point.id}>{point.display_name}</div>)}
      <div>
        <Label htmlFor="code">编码</Label>
        <Input id="code" value={code} onChange={(event: ChangeEvent<HTMLInputElement>) => setCode(event.target.value)} />
      </div>
      <div>
        <Label htmlFor="name">名称</Label>
        <Input id="name" value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} />
      </div>
      <Button
        type="button"
        onPress={async () => {
          await apiRequest('/api/v1/knowledge-points', {
            method: 'POST',
            json: { subjectId, code, displayName: name, parentId: null, metadata: {} }
          });
        }}
      >
        创建知识点
      </Button>
    </div>
  );
}
