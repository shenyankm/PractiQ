import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

describe('OpenWook proxy redirects', () => {
  it('uses the public forwarded origin for unauthenticated protected routes', async () => {
    const request = new NextRequest('http://127.0.0.1:3000/dashboard', {
      headers: {
        host: 'openwook.cloud',
        'x-forwarded-host': 'openwook.cloud',
        'x-forwarded-proto': 'https'
      }
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://openwook.cloud/sign-in');
  });

  it('falls back to the Host header when forwarded headers are unavailable', async () => {
    const request = new NextRequest('http://127.0.0.1:3001/settings', {
      headers: {
        host: 'openwook.cloud'
      }
    });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://openwook.cloud/sign-in');
  });
});
