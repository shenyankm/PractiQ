import { requireUser } from '@/lib/openwook/auth';
import { created, noContent, parseId, readJson, ApiError } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { addQuestionToGroup, linkGroupMedia, removeQuestionFromGroup, reorderGroupQuestions } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { addGroupQuestionSchema, mediaLinkSchema, reorderGroupQuestionsSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ groupId: string; path: string[] }> };

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/groups/[groupId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { groupId, path } = await ctx.params;
    const parsedGroupId = parseId(groupId, 'groupId');

    if (path[0] == 'questions') {
      const body = addGroupQuestionSchema.parse(await readJson(request));
      return created(await addQuestionToGroup(user, parsedGroupId, body.questionId, body.sortOrder));
    }
    if (path[0] == 'media-links') return created(await linkGroupMedia(user, parsedGroupId, mediaLinkSchema.parse(await readJson(request))));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/groups/[groupId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { groupId, path } = await ctx.params;

    if (path[0] == 'questions' && path[1] == 'reorder') {
      await reorderGroupQuestions(user, parseId(groupId, 'groupId'), reorderGroupQuestionsSchema.parse(await readJson(request)).items);
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/groups/[groupId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { groupId, path } = await ctx.params;

    if (path[0] == 'questions' && path[1]) {
      await removeQuestionFromGroup(user, parseId(groupId, 'groupId'), parseId(path[1], 'questionId'));
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}
