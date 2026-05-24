import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';

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
      className={`bg-background text-foreground ${manrope.className}`}
    >
      <body className="min-h-[100dvh] bg-background">
        {children}
      </body>
    </html>
  );
}
