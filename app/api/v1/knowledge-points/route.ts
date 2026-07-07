import { z } from 'zod';
import { created, handleApiError, ok, readJson } from '@/lib/openwook/api';
import { requireUser } from '@/lib/openwook/auth';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { createKnowledgePoint, listKnowledgePoints } from '@/lib/openwook/services';
const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60';


const knowledgePointSchema = z.object({
  subjectId: z.string().min(1).max(32),
  code: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  parentId: z.number().int().positive().optional().nullable(),
  metadata: z.record(z.unknown()).optional()
});

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/knowledge-points', async () => {
    try {
      const url = new URL(request.url);
      const parentId = url.searchParams.get('parentId');
      const response = ok(await listKnowledgePoints(url.searchParams.get('subject') ?? undefined, parentId ? Number(parentId) : undefined));
      response.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
      return response;
    } catch (error) {
      return handleApiError(error);
    }
  });
}

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/knowledge-points', async () => {
    try {
      assertSameOriginRequest(request);
      const user = await requireUser();
      return created(await createKnowledgePoint(user, knowledgePointSchema.parse(await readJson(request))));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
