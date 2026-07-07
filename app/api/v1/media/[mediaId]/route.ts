import { requireUser } from '@/lib/openwook/auth';
import { noContent, ok, parseId } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { deleteMediaAsset, getMediaAsset } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

type RouteContext = { params: Promise<{ mediaId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/media/[mediaId]', async () => {
    const user = await requireUser();
    const { mediaId } = await ctx.params;
    return ok(await getMediaAsset(user, parseId(mediaId, 'mediaId')));
  });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/media/[mediaId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { mediaId } = await ctx.params;
    await deleteMediaAsset(user, parseId(mediaId, 'mediaId'));
    return noContent();
  });
}
