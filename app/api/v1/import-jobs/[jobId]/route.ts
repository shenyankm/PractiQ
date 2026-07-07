import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId } from '@/lib/openwook/api';
import { getImportJob } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/import-jobs/[jobId]', async () => {
    const user = await requireUser();
    const { jobId } = await ctx.params;
    return ok(await getImportJob(user, parseId(jobId, 'jobId')));
  });
}
