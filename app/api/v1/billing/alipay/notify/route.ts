import { ApiError } from '@/lib/openwook/api';
import { handleAlipayNotify } from '@/lib/openwook/alipay';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    params[key] = String(value);
  });
  let success = false;
  try {
    success = await handleAlipayNotify(params);
  } catch (error) {
    console.error('Alipay notify processing failed', error instanceof ApiError ? {
      code: error.code,
      message: error.message
    } : { message: 'Unexpected Alipay notify error' });
  }
  return new Response(success ? 'success' : 'failure', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
