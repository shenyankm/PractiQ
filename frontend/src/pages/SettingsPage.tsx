import { Card, Typography } from '@heroui/react';
import { useAuth } from '@/auth/AuthProvider';

export default function SettingsPage() {
  const user = useAuth();
  return (
    <section className="grid gap-5">
      <Typography.Heading level={1}>设置</Typography.Heading>
      <Card>
        <Card.Header><Typography.Heading level={2}>账号</Typography.Heading></Card.Header>
        <Card.Content className="grid gap-2">
          <p>用户名：{user?.username || '—'}</p>
          <p>邮箱：{user?.email || '—'}</p>
          <p>角色：{user?.role || '—'}</p>
          <p>会员：{user?.membership || 'free'}</p>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header><Typography.Heading level={2}>数据说明</Typography.Heading></Card.Header>
        <Card.Content>
          <p>OpenWook 以云端 PostgreSQL 为权威数据源。PractiQ 移动端会保留离线副本，并在联网后同步。</p>
        </Card.Content>
      </Card>
    </section>
  );
}
