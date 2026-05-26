import { readinessResponse } from '../route';
import { withApiObservability } from '@/lib/openwook/observability';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/health/ready', readinessResponse);
}
