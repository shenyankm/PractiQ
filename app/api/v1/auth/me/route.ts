import { getCurrentUser } from '@/lib/openwook/auth';
import { handleApiError, ok } from '@/lib/openwook/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return ok(await getCurrentUser());
  } catch (error) {
    return handleApiError(error);
  }
}
