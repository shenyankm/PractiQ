import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { errorToLog, logger } from '@/lib/openwook/logger';
import { signSessionToken, verifySessionToken } from '@/lib/openwook/session';

const protectedRoutes = ['/dashboard', '/banks', '/imports', '/practice', '/questions', '/settings'];
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const sessionRenewWindowMs = Number(process.env.SESSION_RENEW_WINDOW_MS || 6 * 60 * 60 * 1000);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = request.cookies.get('session');
  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

  if (isProtectedRoute && !sessionCookie) {
    return redirectToSignIn(request);
  }

  const res = NextResponse.next();

  if (sessionCookie && request.method === 'GET') {
    try {
      const parsed = await verifySessionToken(sessionCookie.value);
      const currentExpiresAt = new Date(parsed.expires).getTime();
      const now = Date.now();

      if (!Number.isFinite(currentExpiresAt) || currentExpiresAt <= now) {
        res.cookies.delete('session');
        if (isProtectedRoute) {
          return redirectToSignIn(request);
        }
      } else if (currentExpiresAt - now <= sessionRenewWindowMs) {
        const renewedExpiresAt = new Date(now + sessionTtlMs);
        const expirationSeconds = `${Math.ceil(sessionTtlMs / 1000)}s`;

        res.cookies.set({
          name: 'session',
          value: await signSessionToken({
            ...parsed,
            expires: renewedExpiresAt.toISOString()
          }, expirationSeconds),
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          expires: renewedExpiresAt
        });
      }
    } catch (error) {
      logger.warn({ ...errorToLog(error), path: pathname }, 'session renewal failed');
      res.cookies.delete('session');
      if (isProtectedRoute) {
        return redirectToSignIn(request);
      }
    }
  }

  return res;
}

function redirectToSignIn(request: NextRequest) {
  const origin = normalizedOrigin(process.env.NEXT_PUBLIC_APP_URL)
    ?? normalizedOrigin(process.env.BASE_URL)
    ?? request.nextUrl.origin;

  return NextResponse.redirect(new URL('/sign-in', origin));
}

function normalizedOrigin(value: string | undefined) {
  if (!value) return undefined;

  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export const config = {
  matcher: ['/((?!api|_next/data|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)']
};
