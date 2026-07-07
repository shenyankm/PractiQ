import './globals.css';
import type { Metadata, Viewport } from 'next';
import { publicEnv } from '@/lib/openwook/env.public';

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: {
    default: 'OpenWook',
    template: '%s · OpenWook'
  },
  description: 'Question banks, practice sessions, and import workflows.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className="bg-background text-foreground"
    >
      <body className="min-h-[100dvh] bg-background">
        {children}
      </body>
    </html>
  );
}
