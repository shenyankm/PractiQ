import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/openwook/auth';

export async function requireAdminPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') notFound();

  return user;
}
