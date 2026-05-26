import { withApiObservability } from '@/lib/openwook/observability';

export const dynamic = 'force-dynamic';

async function liveResponse() {
  return Response.json(
    {
      ok: true,
      uptimeSeconds: Math.round(process.uptime())
    },
    {
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  );
}

export async function GET(request: Request) {
  return withApiObservability(request, '/api/health/live', liveResponse);
}
