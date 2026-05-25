import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/openwook/auth';
import { OpenWookShell } from './openwook-shell';

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false
  }
};

export default async function OpenWookLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <OpenWookShell
      user={{
        username: user.username,
        membership: user.membership,
        role: user.role,
        avatarUrl: user.avatar_url
      }}
    >
      {children}
    </OpenWookShell>
  );
}
