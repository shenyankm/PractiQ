import { useState } from 'react';
import { Alert, Button, Card, Link, Typography } from '@heroui/react';
import { apiRequest } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';

type AdminUser = {
  id: number;
  username: string;
  email: string | null;
  is_active: boolean;
  role: 'admin' | 'user';
  membership: 'free' | 'plus' | 'enterprise';
  bank_count: number;
  import_job_count: number;
  practice_session_count: number;
};

export default function AdminUsersPage() {
  const users = useApiResource<AdminUser[]>(`/api/v1/admin/users${window.location.search || ''}`, []);
  const [confirming, setConfirming] = useState<AdminUser | null>(null);
  const [error, setError] = useState('');

  async function update(user: AdminUser, path: 'status' | 'access', json: unknown) {
    setError('');
    try {
      const changed = await apiRequest<Partial<AdminUser>>(`/api/v1/users/${user.id}/${path}`, {
        method: 'PATCH',
        json,
      });
      users.setData((current) => current.map((item) => item.id === user.id ? { ...item, ...changed } : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新失败');
    }
  }

  return (
    <section className="grid gap-4">
      <Link href="/admin">返回后台</Link>
      <Typography.Heading level={1}>用户管理</Typography.Heading>
      {error || users.error ? <Alert status="danger"><Alert.Content><Alert.Description>{error || users.error}</Alert.Description></Alert.Content></Alert> : null}
      {users.data.map((user) => (
        <Card key={user.id}>
          <Card.Content className="grid gap-3">
            <div>
              <strong>{user.username}</strong>
              <p>{user.email || '未设置邮箱'}</p>
              <p className="text-sm text-muted">题库 {user.bank_count} · 导入 {user.import_job_count} · 练习 {user.practice_session_count}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={user.is_active ? 'danger' : 'primary'}
                onPress={() => user.is_active
                  ? setConfirming(user)
                  : void update(user, 'status', { isActive: true })}
              >
                {user.is_active ? '停用' : '启用'}
              </Button>
              <select
                aria-label={`${user.username} 角色`}
                className="rounded-xl border p-2"
                value={user.role}
                onChange={(event) => void update(user, 'access', { role: event.target.value })}
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
              <select
                aria-label={`${user.username} 会员`}
                className="rounded-xl border p-2"
                value={user.membership}
                onChange={(event) => void update(user, 'access', { membership: event.target.value })}
              >
                <option value="free">Free</option>
                <option value="plus">Plus</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
          </Card.Content>
        </Card>
      ))}
      {confirming ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>确认停用 {confirming.username}？</Alert.Description>
            <div className="flex gap-2">
              <Button
                variant="danger"
                onPress={() => {
                  void update(confirming, 'status', { isActive: false });
                  setConfirming(null);
                }}
              >
                确认停用
              </Button>
              <Button variant="secondary" onPress={() => setConfirming(null)}>取消</Button>
            </div>
          </Alert.Content>
        </Alert>
      ) : null}
      {users.hasMore ? <Button isDisabled={users.loadingMore} onPress={() => void users.loadMore()}>{users.loadingMore ? '加载中…' : '加载更多用户'}</Button> : null}
    </section>
  );
}
