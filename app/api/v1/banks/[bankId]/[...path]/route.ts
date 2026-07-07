import { requireUser } from '@/lib/openwook/auth';
import { created, noContent, ok, parseId, readJson, ApiError } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { createGroup, createQuestion, listBankItems, reorderBankItems, setFavorite } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { bankItemsReorderSchema, groupSchema, questionSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ bankId: string; path: string[] }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]/[...path]', async () => {
    const user = await requireUser();
    const { bankId, path } = await ctx.params;
    const parsedBankId = parseId(bankId, 'bankId');

    if (path[0] == 'items') {
      return ok(await listBankItems(user, parsedBankId, new URL(request.url).searchParams));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { bankId, path } = await ctx.params;
    const parsedBankId = parseId(bankId, 'bankId');

    if (path[0] == 'favorite') {
      await setFavorite(user, parsedBankId, true);
      return noContent();
    }

    if (path[0] == 'questions') {
      return created(await createQuestion(user, parsedBankId, questionSchema.parse(await readJson(request))));
    }

    if (path[0] == 'groups') {
      return created(await createGroup(user, parsedBankId, groupSchema.parse(await readJson(request))));
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { bankId, path } = await ctx.params;

    if (path[0] == 'items' && path[1] == 'reorder') {
      await reorderBankItems(user, parseId(bankId, 'bankId'), bankItemsReorderSchema.parse(await readJson(request)).items);
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { bankId, path } = await ctx.params;

    if (path[0] == 'favorite') {
      await setFavorite(user, parseId(bankId, 'bankId'), false);
      return noContent();
    }

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}
