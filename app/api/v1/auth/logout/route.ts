import { clearSession } from '@/lib/openwook/auth';
import { handleApiError, noContent } from '@/lib/openwook/api';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await clearSession();
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
