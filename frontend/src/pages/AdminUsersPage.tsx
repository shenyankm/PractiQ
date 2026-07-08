import { useEffect, useState } from 'react';
import { Button, Link } from '@heroui/react';
import { apiRequest } from '@/src/lib/api';

type AdminUser = {
  id: number;
  username: string;
  email: string;
  is_active: boolean;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [confirming, setConfirming] = useState<AdminUser | null>(null);
  useEffect(() => {
    const query = window.location.search || '';
    apiRequest<AdminUser[]>(`/api/v1/admin/users${query}`).then(setUsers).catch(() => setUsers([]));
  }, []);
  return (
    <div>
      <Link href="/admin">返回后台</Link>
      <Button type="button">保存</Button>
      {users.map((user) => (
        <div key={user.id}>
          <div>{user.username}</div>
          <div>{user.email}</div>
          <Button type="button" onPress={() => setConfirming(user)}>停用</Button>
        </div>
      ))}
      {confirming ? (
        <Button
          type="button"
          onPress={async () => {
            await apiRequest(`/api/v1/users/${confirming.id}/status`, {
              method: 'PATCH',
              json: { isActive: false }
            });
            setConfirming(null);
          }}
        >
          确认停用
        </Button>
      ) : null}
    </div>
  );
}
