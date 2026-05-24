'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BookOpen, Loader2 } from 'lucide-react';
import { signIn, signUp } from './actions';
import type { ActionState } from './actions';

type LoginProps = {
  mode?: 'signin' | 'signup';
  redirect?: string;
  priceId?: string;
  inviteId?: string;
};

export function Login({ mode = 'signin', redirect, priceId, inviteId }: LoginProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    mode === 'signin' ? signIn : signUp,
    { error: '' }
  );
  const switchHref = buildAuthHref(mode === 'signin' ? '/sign-up' : '/sign-in', {
    redirect,
    priceId,
    inviteId
  });

  return (
    <div className="min-h-[100dvh] flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BookOpen className="h-12 w-12 text-orange-500" />
        </div>
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          {mode === 'signin' ? '登录 OpenWook' : '创建 OpenWook 账号'}
        </h2>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <form className="space-y-6" action={formAction}>
          <input type="hidden" name="redirect" value={redirect || ''} />
          <input type="hidden" name="priceId" value={priceId || ''} />
          <input type="hidden" name="inviteId" value={inviteId || ''} />
          {mode === 'signup' && (
            <div>
              <Label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700"
              >
                用户名
              </Label>
              <div className="mt-1">
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  defaultValue={state.username}
                  required
                  maxLength={32}
                  className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-orange-500 focus:border-orange-500 focus:z-10 sm:text-sm"
                  placeholder="例如 alice"
                />
              </div>
            </div>
          )}
          <div>
            <Label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700"
            >
              用户名或邮箱
            </Label>
            <div className="mt-1">
              <Input
                id="email"
                name="email"
                type={mode === 'signin' ? 'text' : 'email'}
                autoComplete="email"
                defaultValue={state.email}
                required
                maxLength={50}
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-orange-500 focus:border-orange-500 focus:z-10 sm:text-sm"
                placeholder={mode === 'signin' ? '用户名或邮箱' : '邮箱'}
              />
            </div>
          </div>

          <div>
            <Label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700"
            >
              密码
            </Label>
            <div className="mt-1">
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={
                  mode === 'signin' ? 'current-password' : 'new-password'
                }
                defaultValue={state.password}
                required
                minLength={8}
                maxLength={100}
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-orange-500 focus:border-orange-500 focus:z-10 sm:text-sm"
                placeholder="至少 8 位"
              />
            </div>
          </div>

          {state?.error && (
            <div className="text-red-500 text-sm">{state.error}</div>
          )}

          <div>
            <Button
              type="submit"
              className="w-full flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500"
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="animate-spin mr-2 h-4 w-4" />
                  处理中...
                </>
              ) : mode === 'signin' ? (
                '登录'
              ) : (
                '注册'
              )}
            </Button>
          </div>
        </form>

        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-gray-50 text-gray-500">
                {mode === 'signin'
                  ? '还没有账号？'
                  : '已经有账号？'}
              </span>
            </div>
          </div>

          <div className="mt-6">
            <Link
              href={switchHref}
              className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500"
            >
              {mode === 'signin' ? '创建账号' : '登录已有账号'}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAuthHref(
  pathname: string,
  params: { redirect?: string; priceId?: string; inviteId?: string }
) {
  const searchParams = new URLSearchParams();
  if (params.redirect) searchParams.set('redirect', params.redirect);
  if (params.priceId) searchParams.set('priceId', params.priceId);
  if (params.inviteId) searchParams.set('inviteId', params.inviteId);
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}
