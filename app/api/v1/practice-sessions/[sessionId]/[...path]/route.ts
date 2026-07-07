import { requireUser } from '@/lib/openwook/auth';
import { created, ok, parseId, readJson, ApiError } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { completePracticeSession, getPracticeQuestionPage, getPracticeQuestions, getPracticeResults, submitAnswer } from '@/lib/openwook/services';
import { handleObservedRoute } from '@/app/api/v1/_shared/route-handler';
import { answerSchema } from '@/app/api/v1/_shared/schemas';

type RouteContext = { params: Promise<{ sessionId: string; path: string[] }> };

export async function GET(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/practice-sessions/[sessionId]/[...path]', async () => {
    const user = await requireUser();
    const { sessionId, path } = await ctx.params;
    const parsedSessionId = parseId(sessionId, 'sessionId');

    if (path[0] == 'question-page') return ok(await getPracticeQuestionPage(user, parsedSessionId, new URL(request.url).searchParams));
    if (path[0] == 'questions') return ok(await getPracticeQuestions(user, parsedSessionId));
    if (path[0] == 'results') return ok(await getPracticeResults(user, parsedSessionId));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}

export async function POST(request: Request, ctx: RouteContext) {
  return handleObservedRoute(request, '/api/v1/practice-sessions/[sessionId]/[...path]', async () => {
    assertSameOriginRequest(request);
    const user = await requireUser();
    const { sessionId, path } = await ctx.params;
    const parsedSessionId = parseId(sessionId, 'sessionId');

    if (path[0] == 'answers') return created(await submitAnswer(user, parsedSessionId, answerSchema.parse(await readJson(request))));
    if (path[0] == 'complete') return ok(await completePracticeSession(user, parsedSessionId, 'completed'));
    if (path[0] == 'abandon') return ok(await completePracticeSession(user, parsedSessionId, 'abandoned'));

    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  });
}
