import { requireUser } from '@/lib/openwook/auth';
import { handleApiError, ok } from '@/lib/openwook/api';
import { getBillingSummary } from '@/lib/openwook/billing';
import { withApiObservability } from '@/lib/openwook/observability';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/billing/summary', async () => {
    try {
      const user = await requireUser();
      return ok(await getBillingSummary(user));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
