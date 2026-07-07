import { handleApiError, ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';
import { listQuestionTypes } from '@/lib/openwook/services';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/question-types', async () => {
    try {
      const url = new URL(request.url);
      return ok(await listQuestionTypes(url.searchParams.get('subject') ?? undefined, url.searchParams.get('scope') ?? undefined));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
