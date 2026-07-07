import { requireUser } from '@/lib/openwook/auth';
import { ok, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { aiHandlers, handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { aiDocumentParseSchema } from '@/app/api/v1/_shared/schemas';

export async function POST(request: Request) {
  return handleObservedRoute(request, '/api/v1/ai/parse-document', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { parseDocumentWithMastra } = await aiHandlers();
    return ok(await parseDocumentWithMastra(user, aiDocumentParseSchema.parse(await readJson(request))));
  });
}
