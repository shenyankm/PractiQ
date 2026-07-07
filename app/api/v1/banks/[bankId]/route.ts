import { requireUser } from '@/lib/openwook/auth';
import { noContent, ok, parseId, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { deleteBank, getBank, updateBank } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { bankUpdateSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ bankId: string }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]', async () => {
    const user = await requireUser();
    const { bankId } = await ctx.params;
    return ok(await getBank(user, parseId(bankId, 'bankId')));
  });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { bankId } = await ctx.params;
    return ok(await updateBank(user, parseId(bankId, 'bankId'), bankUpdateSchema.parse(await readJson(request))));
  });
}

export async function DELETE(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/banks/[bankId]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { bankId } = await ctx.params;
    await deleteBank(user, parseId(bankId, 'bankId'));
    return noContent();
  });
}
