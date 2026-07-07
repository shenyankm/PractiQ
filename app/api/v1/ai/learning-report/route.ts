import { requireUser } from '@/lib/openwook/auth';
import { ok, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { aiHandlers, handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { aiReportSchema } from '@/app/api/v1/_shared/schemas';

export async function POST(request: Request) {
  return handleObservedRoute(request, '/api/v1/ai/learning-report', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { generateLearningReportWithMastra } = await aiHandlers();
    return ok(await generateLearningReportWithMastra(user, aiReportSchema.parse(await readJson(request))));
  });
}
