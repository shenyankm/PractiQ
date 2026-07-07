import { requireUser } from '@/lib/openwook/auth';
import { created, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { createMediaAsset } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { mediaSchema } from '@/app/api/v1/_shared/schemas';

export async function POST(request: Request) {
  return handleObservedRoute(request, '/api/v1/media', async () => {
    assertSameOriginRequest(request);
    await requireUser();
    return created(await createMediaAsset(mediaSchema.parse(await readJson(request))));
  });
}
