import { getCurrentUser } from '@/lib/openwook/auth';

export async function GET() {
  const user = await getCurrentUser();
  return Response.json(user);
}
