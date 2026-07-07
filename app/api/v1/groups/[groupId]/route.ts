import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { getGroup, updateGroup } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { groupSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ groupId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/groups/[groupId]', async () => {
    const user = await requireUser();
    const { groupId } = await ctx.params;
    return ok(await getGroup(user, parseId(groupId, 'groupId')));
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/groups/[groupId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { groupId } = await ctx.params;
    return ok(await updateGroup(user, parseId(groupId, 'groupId'), groupSchema.partial().parse(await readJson(request))));
  });
}
