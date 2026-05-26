import { ApiError } from '@/lib/openwook/api';
import { handleAlipayNotify } from '@/lib/openwook/alipay';
import { errorToLog, logger } from '@/lib/openwook/logger';
import { withApiObservability } from '@/lib/openwook/observability';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/billing/alipay/notify', async () => {
    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    let success = false;
    try {
      success = await handleAlipayNotify(params);
    } catch (error) {
      logger.warn(
        error instanceof ApiError ? { code: error.code, message: error.message } : errorToLog(error),
        'alipay notify processing failed'
      );
    }

    return new Response(success ? 'success' : 'failure', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  });
}
