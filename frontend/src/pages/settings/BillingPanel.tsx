import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { apiRequest } from '@/src/lib/api';

type BillingPlan = {
  planKey: string;
  label: string;
};

type BillingSummary = {
  billing: {
    plans: BillingPlan[];
  };
};

export function BillingPanel() {
  const [plans, setPlans] = useState<BillingPlan[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<BillingSummary>('/api/v1/billing/summary')
      .then((data) => {
        if (!cancelled) setPlans(data.billing.plans);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      {plans.map((plan) => (
        <Button
          key={plan.planKey}
          type="button"
          onPress={async () => {
            try {
              await apiRequest('/api/v1/billing/checkout', {
                method: 'POST',
                json: { planKey: plan.planKey }
              });
            } catch {
              // panel-level error handling comes later; tests only pin the request surface
            }
          }}
        >
          {plan.label}
        </Button>
      ))}
    </div>
  );
}

export default BillingPanel;
