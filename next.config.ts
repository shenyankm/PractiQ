import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV === 'development';
const publicImageUrls = [process.env.NEXT_PUBLIC_APP_URL, process.env.OSS_PUBLIC_BASE_URL, process.env.OBJECT_STORAGE_PUBLIC_BASE_URL]
  .filter((value): value is string => Boolean(value))
  .map((value) => new URL(value));

const nextConfig: NextConfig = {
  images: {
    remotePatterns: publicImageUrls.map((url) => ({
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      hostname: url.hostname,
      port: url.port || undefined,
      pathname: '/**'
    }))
  },
  async headers() {
    const contentSecurityPolicy = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: http:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' }
        ]
      }
    ];
  }
};

export default nextConfig;
