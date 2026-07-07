import { requireUser } from '@/lib/openwook/auth';
import { created, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { linkOptionMedia } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { mediaLinkSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ optionId: string }> };

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/options/[optionId]/media-links', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { optionId } = await ctx.params;
    return created(await linkOptionMedia(user, parseId(optionId, 'optionId'), mediaLinkSchema.parse(await readJson(request))));
  });
}
