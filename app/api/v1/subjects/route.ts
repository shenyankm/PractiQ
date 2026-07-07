import { handleApiError, ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';
import { listSubjects } from '@/lib/openwook/services';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/subjects', async () => {
    try {
      return ok(await listSubjects());
    } catch (error) {
      return handleApiError(error);
    }
  });
}
