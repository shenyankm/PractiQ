import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId } from '@/lib/openwook/api';
import { getBankLeaderboard } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

type RouteContext = { params: Promise<{ bankId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/analytics/banks/[bankId]/leaderboard', async () => {
    const user = await requireUser();
    const { bankId } = await ctx.params;
    return ok(await getBankLeaderboard(user, parseId(bankId, 'bankId'), Number(new URL(request.url).searchParams.get('limit') || 20)));
  });
}
