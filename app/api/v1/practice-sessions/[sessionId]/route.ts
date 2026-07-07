import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId } from '@/lib/openwook/api';
import { getPracticeSession } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/practice-sessions/[sessionId]', async () => {
    const user = await requireUser();
    const { sessionId } = await ctx.params;
    return ok(await getPracticeSession(user, parseId(sessionId, 'sessionId')));
  });
}
