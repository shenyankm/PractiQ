import type { Metadata } from 'next';
import { KeyRound } from 'lucide-react';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getAlipayBillingSummary } from '@/lib/openwook/alipay';
import { isConfiguredRemoteImageUrl } from '@/lib/openwook/remote-images';
import { getAnalyticsSummary } from '@/lib/openwook/services';
import { AlipayCheckoutButton } from './alipay-checkout-button';
import { PasswordSettingsCard, ProfileSettingsCard } from './settings-forms';
import { Card, CardContent, CardHeader, CardTitle } from '@heroui/react/card';
import { Tab, TabList, TabPanel, Tabs } from '@heroui/react/tabs';

export const metadata: Metadata = {
  title: '设置'
};

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const [summary, billing] = await Promise.all([
    getAnalyticsSummary(user),
    getAlipayBillingSummary(user)
  ]);
  const avatarUrl = httpUrlOrNull(user.avatar_url);
  const avatarOptimized = isConfiguredRemoteImageUrl(avatarUrl);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="text-sm text-muted-foreground">维护账号资料、密码、会员信息和数据导出。</p>
      </div>

      <Tabs defaultSelectedKey="profile" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <TabList className="grid w-full grid-cols-4">
            <Tab id="profile">资料</Tab>
            <Tab id="security">安全</Tab>
            <Tab id="billing">会员</Tab>
            <Tab id="data">数据</Tab>
          </TabList>

          <TabPanel id="profile" className="m-0">
            <ProfileSettingsCard
              avatarOptimized={avatarOptimized}
              avatarUrl={avatarUrl}
              email={user.email}
              username={user.username}
            />
          </TabPanel>

          <TabPanel id="security" className="m-0">
            <PasswordSettingsCard />
          </TabPanel>

          <TabPanel id="billing" className="m-0">
            <Card>
              <CardHeader>
                <CardTitle>月付套餐</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <Row label="套餐" value={billing.plan.subject} />
                <Row label="价格" value={`¥${billing.plan.amount} / 月`} />
                {billing.latestOrder ? (
                  <>
                    <Row label="最近订单" value={billing.latestOrder.out_trade_no} />
                    <Row label="订单状态" value={billing.latestOrder.status} />
                  </>
                ) : null}
                <AlipayCheckoutButton disabled={!billing.configured} />
                {!billing.configured ? (
                  <p className="text-xs text-muted-foreground">支付宝环境变量未配置，暂不能发起支付。</p>
                ) : null}
              </CardContent>
            </Card>
          </TabPanel>

          <TabPanel id="data" className="m-0">
            <Card>
              <CardHeader>
                <CardTitle>数据</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
                <a
                  className="button button--outline button--sm w-fit"
                  href="/api/v1/exports/me/summary.pdf"
                >
                  导出 PDF
                </a>
                <p>当前版本保留本地账号和题库数据。</p>
                <p>导出和删除账号会走独立审批流程，避免误删题库和练习记录。</p>
              </CardContent>
            </Card>
          </TabPanel>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />账号状态</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <Row label="角色" value={user.role === 'admin' ? '管理员' : '用户'} />
              <Row label="会员" value={user.membership} />
              <Row label="Plus 试用" value={formatTrial(user.plus_trial_ends_at)} />
              <Row label="Plus 到期" value={formatDateTime(user.plus_expires_at)} />
              <Row label="状态" value={user.is_active ? '启用' : '停用'} />
              <Row label="题库" value={summary.owned_banks} />
              <Row label="答题" value={summary.attempts} />
              <Row label="正确率" value={`${summary.accuracy}%`} />
            </CardContent>
          </Card>
        </div>
      </Tabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
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

function formatDateTime(value: string | null) {
  if (!value) return '无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无';
  return date.toLocaleString('zh-CN');
}

function httpUrlOrNull(value: string | null) {
  return value && /^https?:\/\//.test(value) ? value : null;
}
