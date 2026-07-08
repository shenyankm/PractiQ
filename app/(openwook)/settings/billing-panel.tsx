'use client';

import { useEffect, useState, useTransition } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle
} from '@heroui/react';
import { openPaddleCheckout, type PaddleCheckoutSession, type PaddleEnvironment } from './paddle-checkout';

type PlanKey = 'plus' | 'enterprise';
type Membership = 'free' | 'plus' | 'enterprise';
type BillingInterval = 'month' | 'year';
type SubscriptionStatus = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled';
type SubscriptionSource = 'free' | 'paddle';

type BillingPlan = {
  planKey: PlanKey;
  label: string;
  priceId: string;
  amountCents: number;
  currencyCode: string;
  interval: BillingInterval;
  trialDays: number | null;
};

type BillingSubscription = {
  membership: Membership;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  currentPeriodEndsAt: string | null;
  paddleSubscriptionId: string | null;
  paddleTransactionId: string | null;
  paddlePriceId: string | null;
};

type BillingSummary = {
  environment: PaddleEnvironment;
  configured: boolean;
  plans: BillingPlan[];
  subscription: BillingSubscription;
};

type BillingSummaryResponse = {
  data?: {
    billing?: BillingSummary;
  };
  error?: {
    message?: string;
  };
};

type CheckoutResponse = {
  data?: {
    checkout?: PaddleCheckoutSession;
  };
  error?: {
    message?: string;
  };
};

const MEMBERSHIP_LABELS: Record<Membership, string> = {
  free: 'Free',
  plus: 'Plus',
  enterprise: 'Enterprise'
};

const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  inactive: '未订阅',
  trialing: '试用中',
  active: '有效',
  past_due: '待补款',
  canceled: '已取消'
};

const SOURCE_LABELS: Record<SubscriptionSource, string> = {
  free: 'Free',
  paddle: 'Paddle'
};

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: '月',
  year: '年'
};

const FREE_PLAN_COPY = [
  '浏览仪表板、题库和练习记录',
  '基础账号资料与密码管理',
  '适合个人试用与轻量使用'
];

const PLAN_COPY_BY_KEY: Record<PlanKey, string[]> = {
  plus: [
    '解锁付费会员能力',
    '适合个人持续使用',
    '通过 Paddle Checkout 在线支付'
  ],
  enterprise: [
    '面向团队或高频使用场景',
    '优先使用 Enterprise 会员身份',
    '通过 Paddle Checkout 在线支付'
  ]
};

export function BillingPanel() {
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [activePlanKey, setActivePlanKey] = useState<PlanKey | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    async function loadBillingSummary() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch('/api/v1/billing/summary');
        const payload = await response.json() as BillingSummaryResponse;
        if (!response.ok || !payload.data?.billing) {
          throw new Error(payload.error?.message || '会员方案加载失败，请稍后重试。');
        }

        if (!cancelled) {
          setBilling(payload.data.billing);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : '会员方案加载失败，请稍后重试。');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadBillingSummary();

    return () => {
      cancelled = true;
    };
  }, []);

  function startCheckout(planKey: PlanKey) {
    setCheckoutError(null);
    setActivePlanKey(planKey);

    startTransition(async () => {
      try {
        const response = await fetch('/api/v1/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planKey })
        });
        const payload = await response.json() as CheckoutResponse;
        if (!response.ok || !payload.data?.checkout) {
          throw new Error(payload.error?.message || 'Paddle Checkout 创建失败，请稍后重试。');
        }

        await openPaddleCheckout(payload.data.checkout);
      } catch (checkoutFailure) {
        setCheckoutError(checkoutFailure instanceof Error ? checkoutFailure.message : 'Paddle Checkout 创建失败，请稍后重试。');
      } finally {
        setActivePlanKey(null);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>会员方案</CardTitle>
          <p className="text-sm text-muted-foreground">Free 为默认方案，Plus 与 Enterprise 通过 Paddle Checkout 开通。</p>
        </div>
        {billing ? <Badge variant="soft">{billing.environment}</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {checkoutError ? <p role="alert" className="text-destructive">{checkoutError}</p> : null}
        {isLoading ? <p className="text-muted-foreground">加载会员方案...</p> : null}
        {billing ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <SummaryRow label="当前会员" value={MEMBERSHIP_LABELS[billing.subscription.membership]} />
              <SummaryRow label="订阅状态" value={STATUS_LABELS[billing.subscription.status]} />
              <SummaryRow label="账单来源" value={SOURCE_LABELS[billing.subscription.source]} />
              <SummaryRow label="当前周期结束" value={formatDateTime(billing.subscription.currentPeriodEndsAt)} />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <PlanCard
                title="Free"
                description="默认方案"
                price="¥0"
                highlights={FREE_PLAN_COPY}
                footer={billing.subscription.membership === 'free' ? '当前方案' : '无需结账'}
                isCurrent={billing.subscription.membership === 'free'}
              />
              {billing.plans.map((plan) => {
                const isCurrent = billing.subscription.membership === plan.planKey;
                const isBusy = isPending && activePlanKey === plan.planKey;

                return (
                  <PlanCard
                    key={plan.planKey}
                    title={plan.label}
                    description={plan.planKey === 'plus' ? '适合个人升级' : '适合团队与高频使用'}
                    price={`${formatMoney(plan.amountCents, plan.currencyCode)} / ${INTERVAL_LABELS[plan.interval]}`}
                    highlights={[
                      ...PLAN_COPY_BY_KEY[plan.planKey],
                      plan.trialDays ? `${plan.trialDays} 天试用` : '无试用期'
                    ]}
                    footer={billing.configured ? null : 'Paddle 价格未配置，暂时无法发起结账。'}
                    isCurrent={isCurrent}
                    action={
                      <Button
                        type="button"
                        onPress={() => startCheckout(plan.planKey)}
                        isDisabled={!billing.configured || isCurrent || isBusy}
                        aria-busy={isBusy}
                        fullWidth
                      >
                        {isBusy ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
                        {isCurrent ? `${plan.label} 已开通` : `升级到 ${plan.label}`}
                      </Button>
                    }
                  />
                );
              })}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PlanCard({
  title,
  description,
  price,
  highlights,
  footer,
  isCurrent,
  action
}: {
  title: string;
  description: string;
  price: string;
  highlights: string[];
  footer: string | null;
  isCurrent: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border border-border/70 bg-background/80 p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{title}</div>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {isCurrent ? <Badge variant="secondary">当前方案</Badge> : null}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{price}</div>
      <ul className="space-y-2 text-sm text-muted-foreground">
        {highlights.map((highlight) => (
          <li key={highlight} className="rounded-md border border-border/60 px-3 py-2">{highlight}</li>
        ))}
      </ul>
      <div className="mt-auto flex flex-col gap-2">
        {action}
        {footer ? <p className="text-xs text-muted-foreground">{footer}</p> : null}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
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

function formatDateTime(value: string | null) {
  if (!value) return '无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无';
  return date.toLocaleString('zh-CN');
}
