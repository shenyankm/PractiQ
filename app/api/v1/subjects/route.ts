import { handleApiError, ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';
import { listSubjects } from '@/lib/openwook/services';
const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=60';


export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/subjects', async () => {
    try {
      const response = ok(await listSubjects());
      response.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
      return response;
    } catch (error) {
      return handleApiError(error);
    }
  });
}
