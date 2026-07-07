import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

describe('OpenWook proxy redirects', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the canonical public origin for unauthenticated protected routes behind a reverse proxy', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://openwook.cloud');

    const request = new NextRequest('http://127.0.0.1:3000/dashboard', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http'
      }
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://openwook.cloud/sign-in');
  });

  it('falls back to the request URL origin when no canonical public origin is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('BASE_URL', '');
    const request = new NextRequest('http://127.0.0.1:3001/settings', {
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https'
      }
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${request.nextUrl.origin}/sign-in`);
  });
});
