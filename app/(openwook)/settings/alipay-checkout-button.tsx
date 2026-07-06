'use client';

import { useState, useTransition } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@heroui/react';


type CheckoutResponse = {
  data?: {
    paymentHtml?: string;
  };
  error?: {
    message?: string;
  };
};

export function AlipayCheckoutButton({ disabled = false }: { disabled?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function startCheckout() {
    setError(null);
    startTransition(async () => {
      const response = await fetch('/api/v1/billing/alipay/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const payload = await response.json() as CheckoutResponse;
      if (!response.ok || !payload.data?.paymentHtml) {
        setError(payload.error?.message || '支付宝下单失败，请稍后重试。');
        return;
      }

      const container = document.createElement('div');
      container.innerHTML = payload.data.paymentHtml;
      container.style.position = 'fixed';
      container.style.inset = '0';
      container.style.zIndex = '9999';
      container.style.background = 'white';
      document.body.appendChild(container);
      const form = container.querySelector('form');
      if (form) {
        form.submit();
      } else {
        setError('支付宝支付表单生成失败。');
        container.remove();
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        onClick={startCheckout}
        isDisabled={disabled || isPending}
        aria-busy={isPending}
        className="w-full"
      >
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
        购买月付套餐
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
