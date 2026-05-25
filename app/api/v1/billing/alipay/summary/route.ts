import { requireUser } from '@/lib/openwook/auth';
import { handleApiError, ok } from '@/lib/openwook/api';
import { getAlipayBillingSummary } from '@/lib/openwook/alipay';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return ok(await getAlipayBillingSummary(user));
  } catch (error) {
    return handleApiError(error);
  }
}
