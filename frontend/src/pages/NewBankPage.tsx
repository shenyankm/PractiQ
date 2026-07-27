import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Input, Label, Link, Typography } from '@heroui/react';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import type { Bank } from '@/lib/types';

type Subject = { subject_id: string; display_name: string };

export default function NewBankPage() {
  const subjects = useApiResource<Subject[]>('/api/v1/subjects', []);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('general');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const bank = await apiRequest<Bank>('/api/v1/banks', {
        method: 'POST',
        json: { name, description, subject, isPublic }
      });
      window.location.assign(`/banks/${bank.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto grid max-w-2xl gap-4">
      <Link href="/banks">返回题库</Link>
      <Typography.Heading level={1}>新建题库</Typography.Heading>
      <Card>
        <Card.Content>
          <form className="grid gap-4" onSubmit={submit}>
            {error ? <Alert status="danger"><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert> : null}
            <Label htmlFor="bank-name">名称</Label>
            <Input id="bank-name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
            <Label htmlFor="bank-description">描述</Label>
            <textarea id="bank-description" className="min-h-24 rounded-xl border p-3" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
            <Label htmlFor="bank-subject">学科</Label>
            <select id="bank-subject" className="rounded-xl border p-3" value={subject} onChange={(event) => setSubject(event.target.value)}>
              {subjects.data.map((item) => <option key={item.subject_id} value={item.subject_id}>{item.display_name}</option>)}
            </select>
            <label className="flex items-center gap-2"><input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />公开题库</label>
            <Button type="submit" variant="primary" isDisabled={pending || !name.trim()}>{pending ? '创建中…' : '创建'}</Button>
          </form>
        </Card.Content>
      </Card>
    </section>
  );
}
