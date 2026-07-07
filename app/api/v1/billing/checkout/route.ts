import { z } from 'zod';
import { requireUser } from '@/lib/openwook/auth';
import { created, handleApiError, readJson } from '@/lib/openwook/api';
import { createBillingCheckout } from '@/lib/openwook/billing';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

const checkoutBodySchema = z.object({
  planKey: z.enum(['plus', 'enterprise'])
});

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/billing/checkout', async () => {
    try {
      assertSameOriginRequest(request);
      const user = await requireUser();
      const body = checkoutBodySchema.parse(await readJson(request));
      return created(await createBillingCheckout(user, body.planKey));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
