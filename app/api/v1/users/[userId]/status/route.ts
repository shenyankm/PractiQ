import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { setUserStatus } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { userStatusSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ userId: string }> };

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/users/[userId]/status', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { userId } = await ctx.params;
    const body = userStatusSchema.parse(await readJson(request));
    return ok(await setUserStatus(user, parseId(userId, 'userId'), body.isActive));
  });
}
