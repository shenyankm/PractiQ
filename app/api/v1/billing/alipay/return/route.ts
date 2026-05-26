import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/openwook/api';
import { handleAlipayReturn } from '@/lib/openwook/alipay';
import { errorToLog, logger } from '@/lib/openwook/logger';
import { withApiObservability } from '@/lib/openwook/observability';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withApiObservability(request, '/api/v1/billing/alipay/return', async () => {
    const url = new URL(request.url);
    let paid = false;
    let outTradeNo: string | undefined;

    try {
      const result = await handleAlipayReturn(url.searchParams);
      paid = Boolean(result.paid);
      outTradeNo = result.outTradeNo;
    } catch (error) {
      outTradeNo = url.searchParams.get('out_trade_no') ?? undefined;
      logger.warn(
        error instanceof ApiError ? { code: error.code, message: error.message } : errorToLog(error),
        'alipay return processing failed'
      );
    }

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || url.origin).replace(/\/$/, '');
    const redirectUrl = new URL('/settings', appUrl);
    redirectUrl.searchParams.set('alipay', paid ? 'paid' : 'pending');
    if (outTradeNo) redirectUrl.searchParams.set('order', outTradeNo);
    return NextResponse.redirect(redirectUrl);
  });
}
