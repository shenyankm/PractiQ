import type { Metadata } from 'next';
import { Login } from '../login';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: '登录'
};

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <Login mode="signin" redirect={first(params.redirect)} priceId={first(params.priceId)} inviteId={first(params.inviteId)} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
