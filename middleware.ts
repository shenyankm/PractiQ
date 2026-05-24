import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { signSessionToken, verifySessionToken } from '@/lib/openwook/session';

const protectedRoutes = ['/dashboard', '/banks', '/imports', '/practice', '/questions', '/settings'];

export async function middleware(request: NextRequest) {
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
      const expiresInOneDay = new Date(Date.now() + 24 * 60 * 60 * 1000);

      res.cookies.set({
        name: 'session',
        value: await signSessionToken({
          ...parsed,
          expires: expiresInOneDay.toISOString()
        }, '1 day'),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: expiresInOneDay
      });
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
