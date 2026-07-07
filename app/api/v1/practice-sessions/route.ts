import { requireUser } from '@/lib/openwook/auth';
import { created, ok, readJson } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { listPracticeSessions, startPracticeSession } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { practiceStartSchema } from '@/app/api/v1/_shared/schemas';

export async function GET(request: Request) {
  return handleObservedRoute(request, '/api/v1/practice-sessions', async () => {
    const user = await requireUser();
    return ok(await listPracticeSessions(user, new URL(request.url).searchParams));
  });
}

export async function POST(request: Request) {
  return handleObservedRoute(request, '/api/v1/practice-sessions', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    return created(await startPracticeSession(user, practiceStartSchema.parse(await readJson(request))));
  });
}
