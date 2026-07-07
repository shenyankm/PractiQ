import { requireUser } from '@/lib/openwook/auth';
import { created, ok, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { createBank, listBanks } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { bankSchema } from '@/app/api/v1/_shared/schemas';

export async function GET(request: Request) {
  return handleObservedRoute(request, '/api/v1/banks', async () => {
    const user = await requireUser();
    return ok(await listBanks(user, new URL(request.url).searchParams));
  });
}

export async function POST(request: Request) {
  return handleObservedRoute(request, '/api/v1/banks', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    return created(await createBank(user, bankSchema.parse(await readJson(request))));
  });
}
