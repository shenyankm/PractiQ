import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { signSessionToken, verifySessionToken } from '@/lib/openwook/session';

const protectedRoutes = ['/dashboard', '/banks', '/imports', '/practice', '/questions', '/settings'];
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const sessionRenewWindowMs = Number(process.env.SESSION_RENEW_WINDOW_MS || 6 * 60 * 60 * 1000);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = request.cookies.get('session');
  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

  if (isProtectedRoute && !sessionCookie) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
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
          return NextResponse.redirect(new URL('/sign-in', request.url));
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
      console.error('Error updating session:', error);
      res.cookies.delete('session');
      if (isProtectedRoute) {
        return NextResponse.redirect(new URL('/sign-in', request.url));
      }
    }
  }

  return res;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs'
};
