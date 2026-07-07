import { z } from 'zod';
import { hashPassword, setSession } from '@/lib/openwook/auth';
import { created, handleApiError, readJson } from '@/lib/openwook/api';
import { sql } from '@/lib/openwook/db';
import { enforceRegisterRateLimit, clientIpFromRequest } from '@/lib/openwook/auth-rate-limit';
import { withApiObservability } from '@/lib/openwook/observability';
import { assertSameOriginRequest } from '@/lib/openwook/request-origin';


const registerSchema = z.object({
  username: z.string().trim().min(2).max(32),
  email: z.string().email().optional().nullable(),
  password: z.string().min(8).max(100)
});

export async function POST(request: Request) {
  return withApiObservability(request, '/api/v1/auth/register', async () => {
    try {
      assertSameOriginRequest(request);
      await enforceRegisterRateLimit(clientIpFromRequest(request));
      const body = registerSchema.parse(await readJson(request));
      const passwordHash = await hashPassword(body.password);
      const rows = await sql`
        INSERT INTO users (username, email, password_hash, role, membership, plus_trial_ends_at)
        VALUES (${body.username}, ${body.email ?? null}, ${passwordHash}, 'user', 'free', NOW() + INTERVAL '3 days')
        RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
      `;
      await setSession(rows[0].id);
      return created(rows[0]);
    } catch (error) {
      return handleApiError(error);
    }
  });
}

