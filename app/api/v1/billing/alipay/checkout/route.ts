import { requireUser } from '@/lib/openwook/auth';
import { created, handleApiError } from '@/lib/openwook/api';
import { createAlipayCheckout } from '@/lib/openwook/alipay';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const user = await requireUser();
    return created(await createAlipayCheckout(user));
  } catch (error) {
    return handleApiError(error);
  }
}
