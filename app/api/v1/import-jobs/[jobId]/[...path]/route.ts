import { requireUser } from '@/lib/openwook/auth';
import { ok, parseId, readJson, ApiError } from '@/lib/openwook/api';
import { streamImportEvents, type ImportEventPayload } from '@/lib/openwook/import-events';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { listImportJobChildren, queueImportJobForUser, resolveImportReviewItem, updateImportJobStatus } from '@/lib/openwook/services';
import { handleObservedRoute, isImportChildKind } from '@/app/api/v1/_shared/route-handler';
import { importJobParseSchema, importReviewResolveSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ jobId: string; path: string[] }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/import-jobs/[jobId]/[...path]', async () => {
    const user = await requireUser();
    const { jobId, path } = await ctx.params;
    const parsedJobId = parseId(jobId, 'jobId');

    if (path[0] == 'events' && path[1] == 'stream') {
      const events = await listImportJobChildren(user, parsedJobId, 'events') as unknown as ImportEventPayload[];
      return streamImportEvents(parsedJobId, [...events].reverse(), request.signal);
    }
    if (isImportChildKind(path[0])) return ok(await listImportJobChildren(user, parsedJobId, path[0]));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/import-jobs/[jobId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { jobId, path } = await ctx.params;
    const parsedJobId = parseId(jobId, 'jobId');

    if (path[0] == 'parse') {
      const body = importJobParseSchema.parse(await readJson(request));
      return ok(await queueImportJobForUser(user, parsedJobId, { persistQuestions: body.persistQuestions ?? true }));
    }
    if (path[0] == 'start') return ok(await updateImportJobStatus(user, parsedJobId, 'start'));
    if (path[0] == 'retry') return ok(await updateImportJobStatus(user, parsedJobId, 'retry'));
    if (path[0] == 'cancel') return ok(await updateImportJobStatus(user, parsedJobId, 'cancel'));
    if (path[0] == 'review-items' && path[1] && path[2] == 'resolve') {
      const body = importReviewResolveSchema.parse(await readJson(request));
      return ok(await resolveImportReviewItem(user, parsedJobId, parseId(path[1], 'reviewItemId'), body.note));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}
