import 'server-only';

import { redirect } from 'next/navigation';
import { getCurrentUser } from './auth';
import { assertSameOriginFromHeaders } from './server-action-origin';

export async function requireServerActionUser() {
  await assertSameOriginFromHeaders();
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return user;
}
