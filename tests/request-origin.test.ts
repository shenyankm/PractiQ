import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSameOriginRequest, isSameOriginRequest } from '@/lib/openwook/request-origin';
import { ApiError } from '@/lib/openwook/api';

describe('same-origin write request guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows same-origin requests against the configured public origin', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://openwook.cloud');

    const request = new Request('http://127.0.0.1:3000/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://openwook.cloud'
      }
    });

    expect(isSameOriginRequest(request)).toBe(true);
    expect(() => assertSameOriginRequest(request)).not.toThrow();
  });
  it('falls back to the request URL origin when no canonical public origin is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('BASE_URL', '');
    const request = new Request('http://127.0.0.1:3000/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3000'
      }
    });

    expect(isSameOriginRequest(request)).toBe(true);
    expect(() => assertSameOriginRequest(request)).not.toThrow();
  });

  it('rejects cross-site requests that can carry session cookies', () => {
    const request = new Request('https://openwook.cloud/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example'
      }
    });

    expect(isSameOriginRequest(request)).toBe(false);
    expect(() => assertSameOriginRequest(request)).toThrow(ApiError);
  });

  it('uses the canonical public origin behind a reverse proxy', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://openwook.cloud');

    const request = new Request('http://127.0.0.1:3000/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://openwook.cloud',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http'
      }
    });

    expect(isSameOriginRequest(request)).toBe(true);
  });

  it('rejects hostile forwarded host input when it disagrees with the canonical public origin', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://openwook.cloud');

    const request = new Request('http://127.0.0.1:3000/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        host: 'openwook.cloud',
        'x-forwarded-host': 'openwook.cloud',
        'x-forwarded-proto': 'https'
      }
    });

    expect(isSameOriginRequest(request)).toBe(false);
    expect(() => assertSameOriginRequest(request)).toThrow(ApiError);
  });
});
