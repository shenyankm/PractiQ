import { KeyRound, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getAnalyticsSummary } from '@/lib/openwook/services';
import { updateProfileAction } from '../banks/actions';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const summary = await getAnalyticsSummary(user);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
          <p className="text-sm text-slate-500">维护账号资料、密码和会员信息。</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><UserRound className="size-4" />个人资料</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={updateProfileAction} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input id="username" name="username" defaultValue={user.username} required maxLength={32} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">邮箱</Label>
                  <Input id="email" name="email" type="email" defaultValue={user.email ?? ''} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">新密码</Label>
                <Input id="password" name="password" type="password" minLength={8} placeholder="留空则不修改" />
              </div>
              <Button type="submit">保存设置</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />账号状态</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="角色" value={user.role === 'admin' ? '管理员' : '用户'} />
            <Row label="会员" value={user.membership} />
            <Row label="Plus 试用" value={formatTrial(user.plus_trial_ends_at)} />
            <Row label="状态" value={user.is_active ? '启用' : '停用'} />
            <Row label="题库" value={summary.owned_banks} />
            <Row label="答题" value={summary.attempts} />
            <Row label="正确率" value={`${summary.accuracy}%`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>数据</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <Button asChild variant="outline" size="sm">
              <a href="/api/v1/exports/me/summary.pdf">导出 PDF</a>
            </Button>
            <p>当前版本保留本地账号和题库数据。</p>
            <p>导出和删除账号会走独立审批流程，避免误删题库和练习记录。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function formatTrial(value: string | null) {
  if (!value) return '无';
  const trialEndsAt = new Date(value);
  if (Number.isNaN(trialEndsAt.getTime())) return '无';
  if (trialEndsAt.getTime() <= Date.now()) return '已结束';
  return trialEndsAt.toLocaleDateString('zh-CN');
}
