import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import { SWRConfig } from 'swr';
import { getCurrentUser } from '@/lib/openwook/auth';

export const metadata: Metadata = {
  title: 'OpenWook',
  description: 'Question banks, practice sessions, and import workflows.'
};

export const viewport: Viewport = {
  maximumScale: 1
};

const manrope = Manrope({ subsets: ['latin'] });

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`bg-white dark:bg-gray-950 text-black dark:text-white ${manrope.className}`}
    >
      <body className="min-h-[100dvh] bg-gray-50">
        <SWRConfig
          value={{
            fallback: {
              '/api/v1/auth/me': getCurrentUser()
            }
          }}
        >
          {children}
        </SWRConfig>
      </body>
    </html>
  );
}
