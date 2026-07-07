import type { Metadata } from 'next';
import { Login } from '../login';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: '注册'
};

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <Login mode="signup" redirect={first(params.redirect)} priceId={first(params.priceId)} inviteId={first(params.inviteId)} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
