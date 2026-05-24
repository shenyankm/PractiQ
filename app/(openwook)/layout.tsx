import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/openwook/auth';
import { OpenWookShell } from './openwook-shell';

export const dynamic = 'force-dynamic';

export default async function OpenWookLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <OpenWookShell
      user={{
        username: user.username,
        membership: user.membership
      }}
    >
      {children}
    </OpenWookShell>
  );
}
