import { z } from 'zod';
import { handleApiError, ok, parseId, readJson } from '@/lib/openwook/api';
import { requireUser } from '@/lib/openwook/auth';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';
import { updateKnowledgePoint } from '@/lib/openwook/services';

const knowledgePointSchema = z.object({
  subjectId: z.string().min(1).max(32),
  code: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  parentId: z.number().int().positive().optional().nullable(),
  metadata: z.record(z.unknown()).optional()
});

type Ctx = { params: Promise<{ knowledgePointId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return withApiObservability(request, '/api/v1/knowledge-points/[knowledgePointId]', async () => {
    try {
      assertSameOriginRequest(request);
      const user = await requireUser();
      const { knowledgePointId } = await ctx.params;
      return ok(await updateKnowledgePoint(user, parseId(knowledgePointId, 'knowledgePointId'), knowledgePointSchema.partial().parse(await readJson(request))));
    } catch (error) {
      return handleApiError(error);
    }
  });
}
