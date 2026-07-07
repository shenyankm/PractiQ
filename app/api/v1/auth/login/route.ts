import { z } from 'zod';
import { comparePasswords, dummyPasswordHash, getCurrentUser, getUserPasswordByLogin, setSession } from '@/lib/openwook/auth';
import { ApiError, handleApiError, ok, readJson } from '@/lib/openwook/api';
import { enforceLoginRateLimit, clientIpFromRequest } from '@/lib/openwook/auth-rate-limit';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1)
});

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/auth/login', async () => {
    try {
      assertSameOriginRequest(request);
      const body = loginSchema.parse(await readJson(request));
      await enforceLoginRateLimit(body.login, clientIpFromRequest(request));
      const found = await getUserPasswordByLogin(body.login);
      const passwordMatches = await comparePasswords(body.password, found?.password ?? dummyPasswordHash);
      if (!found?.password || !passwordMatches) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid login or password');
      }
      await setSession(found.id);
      return ok(await getCurrentUser());
    } catch (error) {
      return handleApiError(error);
    }
  });
}

