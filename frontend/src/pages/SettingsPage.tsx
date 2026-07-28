import { useState } from 'react';
import { Alert, Button, Card, Input, Label, Typography } from '@heroui/react';
import { useAuth } from '@/auth/AuthProvider';
import { apiRequest } from '@/lib/api';
import type { AuthUser } from '@/lib/types';

export default function SettingsPage() {
  const user = useAuth();
  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  const usernameValue = username ?? user?.username ?? '';
  const emailValue = email ?? user?.email ?? '';

  async function save() {
    setPending(true);
    setMessage('');
    try {
      const updated = await apiRequest<AuthUser>('/api/v1/users/me', {
        method: 'PATCH',
        json: {
          username: usernameValue.trim(),
          email: emailValue.trim() || null,
          ...(newPassword ? { currentPassword, newPassword } : {})
        }
      });
      setUsername(updated.username);
      setEmail(updated.email || '');
      setCurrentPassword('');
      setNewPassword('');
      setMessage('账号资料已更新。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-5">
      <Typography.Heading level={1}>设置</Typography.Heading>
      <Card>
        <Card.Header><Typography.Heading level={2}>账号</Typography.Heading></Card.Header>
        <Card.Content className="grid gap-3">
          {message ? <Alert><Alert.Content><Alert.Description>{message}</Alert.Description></Alert.Content></Alert> : null}
          <Label htmlFor="settings-username">用户名</Label>
          <Input id="settings-username" value={usernameValue} onChange={(event) => setUsername(event.target.value)} />
          <Label htmlFor="settings-email">邮箱</Label>
          <Input id="settings-email" type="email" value={emailValue} onChange={(event) => setEmail(event.target.value)} />
          <Label htmlFor="settings-current-password">当前密码（仅修改密码时填写）</Label>
          <Input id="settings-current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          <Label htmlFor="settings-new-password">新密码</Label>
          <Input id="settings-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <Button isDisabled={pending || !usernameValue.trim()} onPress={() => void save()}>{pending ? '保存中…' : '保存账号资料'}</Button>
          <p>角色：{user?.role || '—'}</p>
          <p>会员：{user?.membership || 'free'}</p>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header><Typography.Heading level={2}>数据说明</Typography.Heading></Card.Header>
        <Card.Content>
          <p>PractiQ 以云端 PostgreSQL 为权威数据源。PractiQ 移动端会保留离线副本，并在联网后同步。</p>
        </Card.Content>
      </Card>
    </section>
  );
}
