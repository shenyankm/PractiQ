import { getCurrentUser } from '@/lib/openwook/auth';
import { ok } from '@/lib/openwook/api';
import { withApiObservability } from '@/lib/openwook/observability';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/user', async () => ok(await getCurrentUser()));
}
