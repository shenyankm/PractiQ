import { requireUser } from '@/lib/openwook/auth';
import { handleApiError, ok } from '@/lib/openwook/api';
import { getAlipayBillingSummary } from '@/lib/openwook/alipay';
import { withApiObservability } from '@/lib/openwook/observability';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/billing/alipay/summary', async () => {
    try {
      const user = await requireUser();
      return ok(await getAlipayBillingSummary(user));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
