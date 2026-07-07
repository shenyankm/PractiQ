import { getCurrentUser } from '@/lib/openwook/auth';
import { handleApiError, ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';


export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/auth/me', async () => {
    try {
      return ok(await getCurrentUser());
    } catch (error) {
      return handleApiError(error);
    }
  });
}
