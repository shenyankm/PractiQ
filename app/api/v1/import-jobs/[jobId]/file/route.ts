import { requireUser } from '@/lib/openwook/auth';
import { created, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { addImportJobUploadedFile } from '@/lib/openwook/services/imports-upload';
import { addImportJobFile } from '@/lib/openwook/services';
import { handleObservedRoute, isMultipartFormRequest } from '@/app/api/v1/_shared/route-handler';
import { importJobFileSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/import-jobs/[jobId]/file', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { jobId } = await ctx.params;
    const parsedJobId = parseId(jobId, 'jobId');

    if (isMultipartFormRequest(request)) {
      const formData = await request.formData();
      return created(await addImportJobUploadedFile(user, parsedJobId, formData.get('file')));
    }

    return created(await addImportJobFile(user, parsedJobId, importJobFileSchema.parse(await readJson(request))));
  });
}
