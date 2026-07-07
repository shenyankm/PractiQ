import { requireUser } from '@/lib/openwook/auth';
import { ok } from '@/lib/openwook/api';
import { aiHandlers, handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

export async function GET(request: Request) {
  return handleObservedRoute(request, '/api/v1/ai/artifacts', async () => {
    const user = await requireUser();
    const { getAiArtifacts } = await aiHandlers();
    return ok(await getAiArtifacts(user, new URL(request.url).searchParams));
  });
}
