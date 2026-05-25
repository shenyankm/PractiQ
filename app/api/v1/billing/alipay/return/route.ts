import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/openwook/api';
import { handleAlipayReturn } from '@/lib/openwook/alipay';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  let paid = false;
  let outTradeNo: string | undefined;
  try {
    const result = await handleAlipayReturn(url.searchParams);
    paid = Boolean(result.paid);
    outTradeNo = result.outTradeNo;
  } catch (error) {
    outTradeNo = url.searchParams.get('out_trade_no') ?? undefined;
    console.error('Alipay return processing failed', error instanceof ApiError ? {
      code: error.code,
      message: error.message
    } : { message: 'Unexpected Alipay return error' });
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL || url.origin).replace(/\/$/, '');
  const redirectUrl = new URL('/settings', appUrl);
  redirectUrl.searchParams.set('alipay', paid ? 'paid' : 'pending');
  if (outTradeNo) redirectUrl.searchParams.set('order', outTradeNo);
  return NextResponse.redirect(redirectUrl);
}
