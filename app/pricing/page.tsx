import type { Metadata } from 'next';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/openwook/auth';
import { getBillingConfig } from '@/lib/openwook/billing';
import { BillingPanel } from '@/app/(openwook)/settings/billing-panel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@heroui/react/card';
import { Badge } from '@heroui/react/badge';

export const metadata: Metadata = {
  title: '定价'
};

export default async function PricingPage() {
  const [user, billing] = await Promise.all([getCurrentUser(), Promise.resolve(getBillingConfig())]);

  if (user) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">定价与会员</h1>
          <p className="text-sm text-muted-foreground">选择 Free、Plus 或 Enterprise，并通过 Paddle Checkout 完成开通。</p>
        </div>
        <BillingPanel />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="text-center">
        <Badge variant="soft">Paddle Billing</Badge>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">选择适合你的会员方案</h1>
        <p className="mt-2 text-sm text-muted-foreground">Free 适合基础使用；Plus 面向个人高频使用；Enterprise 面向团队与更高阶场景。</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <PlanCard
          title="Free"
          price="¥0"
          description="基础账号与练习功能"
          highlights={[
            '基础题库与练习流程',
            '本地账号资料管理',
            '适合轻量体验'
          ]}
          footer={<Link href="/sign-up" className="button button--outline w-full justify-center">免费开始</Link>}
        />

        {billing.plans.map((plan) => (
          <PlanCard
            key={plan.planKey}
            title={plan.label}
            price={`${formatMoney(plan.amountCents, plan.currencyCode)} / ${plan.interval === 'year' ? '年' : '月'}`}
            description={plan.planKey === 'plus' ? '适合个人升级' : '适合团队与高频使用'}
            highlights={plan.planKey === 'plus'
              ? ['付费会员能力解锁', '通过 Paddle Checkout 支付', '支持续费与订阅同步']
              : ['企业档会员模型', '通过 Paddle Checkout 支付', '适合更高阶与团队场景']}
            footer={billing.configured
              ? <Link href="/sign-in?redirect=/pricing" className="button button--primary w-full justify-center">登录后购买</Link>
              : <div className="text-xs text-muted-foreground">尚未配置 Paddle 价格 ID</div>}
          />
        ))}
      </div>

      <div className="flex justify-center">
        <Link href="/sign-in?redirect=/pricing" className="button button--ghost">
          已有账号？登录后直接开通
        </Link>
      </div>
    </div>
  );
}

function PlanCard({
  title,
  price,
  description,
  highlights,
  footer
}: {
  title: string;
  price: string;
  description: string;
  highlights: string[];
  footer: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="gap-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <div className="text-2xl font-semibold">{price}</div>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <ul className="flex flex-1 flex-col gap-2 text-sm text-muted-foreground">
          {highlights.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
        {footer}
      </CardContent>
    </Card>
  );
}

function formatMoney(amountCents: number, currencyCode: string) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(amountCents / 100);
}
