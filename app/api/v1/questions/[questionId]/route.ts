import { requireUser } from '@/lib/openwook/auth';
import { noContent, ok, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { deleteQuestion, getQuestion, updateQuestion } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { questionUpdateSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ questionId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]', async () => {
    const user = await requireUser();
    const { questionId } = await ctx.params;
    return ok(await getQuestion(user, parseId(questionId, 'questionId')));
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { questionId } = await ctx.params;
    return ok(await updateQuestion(user, parseId(questionId, 'questionId'), questionUpdateSchema.parse(await readJson(request))));
  });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { questionId } = await ctx.params;
    await deleteQuestion(user, parseId(questionId, 'questionId'));
    return noContent();
  });
}
