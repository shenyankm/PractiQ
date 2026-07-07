import { handleApiError } from '@/lib/openwook/api';
import { handleBillingWebhook } from '@/lib/openwook/billing';
import { withApiObservability } from '@/lib/openwook/observability';

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/billing/webhook', async () => {
    try {
      const rawBody = await request.text();
      await handleBillingWebhook(rawBody, request.headers.get('paddle-signature'));
      return new Response('ok', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    } catch (error) {
      return handleApiError(error);
    }
  });
}
