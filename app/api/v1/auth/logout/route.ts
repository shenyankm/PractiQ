import { clearSession } from '@/lib/openwook/auth';
import { handleApiError, noContent } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/auth/logout', async () => {
    try {
      assertSameOriginRequest(request);
      await clearSession();
      return noContent();
    } catch (error) {
      return handleApiError(error);
    }
  });
}
