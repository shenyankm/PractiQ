import { requireUser } from '@/lib/openwook/auth';
import { ok } from '@/lib/openwook/api';
import { getAnalyticsSummary } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

export async function GET(request: Request) {
  return handleObservedRoute(request, '/api/v1/analytics/me/summary', async () => {
    const user = await requireUser();
    return ok(await getAnalyticsSummary(user));
  });
}
