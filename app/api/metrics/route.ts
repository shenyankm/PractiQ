import { refreshImportQueueMetrics } from '@/lib/openwook/import-queue';
import { metrics } from '@/lib/openwook/metrics';
import { withApiObservability } from '@/lib/openwook/observability';
import { env } from '@/lib/openwook/env';

export const dynamic = 'force-dynamic';

function isAuthorized(request: Request) {
  const token = env.METRICS_TOKEN;
  if (!token) return env.NODE_ENV !== 'production';
  const authorization = request.headers.get('Authorization') ?? request.headers.get('authorization');
  return authorization === `Bearer ${token}`;
}

export async function GET(request: Request) {
  return withApiObservability(request, '/api/metrics', async () => {
    if (!isAuthorized(request)) {
      return Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'Metrics endpoint requires authorization' } },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    await refreshImportQueueMetrics();

    return new Response(await metrics.registry.metrics(), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': metrics.registry.contentType
      }
    });
  });
}
