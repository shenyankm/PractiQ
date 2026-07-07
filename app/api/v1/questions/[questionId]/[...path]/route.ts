import { requireUser } from '@/lib/openwook/auth';
import { created, noContent, ok, parseId, readJson, ApiError } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import {
  createOption,
  linkQuestionMedia,
  replaceQuestionContentBlocks,
  replaceQuestionKnowledgePoints,
  setQuestionStatus,
  updateOption,
  upsertAnswerKey,
  upsertQuestionMetadata
} from '@/lib/openwook/services';
import { aiHandlers, handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import {
  answerKeySchema,
  contentBlocksSchema,
  generateQuestionAnswerSchema,
  knowledgePointsSchema,
  mediaLinkSchema,
  metadataSchema,
  optionSchema
} from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ questionId: string; path: string[] }> };

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { questionId, path } = await ctx.params;
    const parsedQuestionId = parseId(questionId, 'questionId');

    if (path[0] == 'publish') return ok(await setQuestionStatus(user, parsedQuestionId, 'active'));
    if (path[0] == 'archive') return ok(await setQuestionStatus(user, parsedQuestionId, 'archived'));
    if (path[0] == 'generate-answer') {
      const { generateQuestionAnswerWithMastra } = await aiHandlers();
      const body = generateQuestionAnswerSchema.parse(await readJson(request));
      return ok(await generateQuestionAnswerWithMastra(user, parsedQuestionId, { apply: body.apply ?? true }));
    }
    if (path[0] == 'options') return created(await createOption(user, parsedQuestionId, optionSchema.parse(await readJson(request))));
    if (path[0] == 'media-links') return created(await linkQuestionMedia(user, parsedQuestionId, mediaLinkSchema.parse(await readJson(request))));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { questionId, path } = await ctx.params;

    if (path[0] == 'options' && path[1]) {
      return ok(await updateOption(user, parseId(questionId, 'questionId'), parseId(path[1], 'optionId'), optionSchema.partial().parse(await readJson(request))));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function PUT(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/questions/[questionId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { questionId, path } = await ctx.params;
    const parsedQuestionId = parseId(questionId, 'questionId');

    if (path[0] == 'answer-key') return ok(await upsertAnswerKey(user, parsedQuestionId, answerKeySchema.parse(await readJson(request))));
    if (path[0] == 'metadata') return ok(await upsertQuestionMetadata(user, parsedQuestionId, metadataSchema.parse(await readJson(request))));
    if (path[0] == 'knowledge-points') {
      await replaceQuestionKnowledgePoints(user, parsedQuestionId, knowledgePointsSchema.parse(await readJson(request)).knowledgePointIds);
      return noContent();
    }
    if (path[0] == 'content-blocks') {
      await replaceQuestionContentBlocks(user, parsedQuestionId, contentBlocksSchema.parse(await readJson(request)).blocks);
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}
