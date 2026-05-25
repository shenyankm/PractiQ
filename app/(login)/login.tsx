'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
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
    <div className="flex min-h-[100dvh] flex-col justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
      <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-500 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BookOpen className="size-12 text-primary" />
        </div>
      </div>

      <Card className="mt-8 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-3 motion-safe:duration-500 sm:mx-auto sm:w-full sm:max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {mode === 'signin' ? '登录 OpenWook' : '创建 OpenWook 账号'}
          </CardTitle>
          <CardDescription>
            {mode === 'signin' ? '继续管理题库、导入任务和练习记录。' : '注册后即可创建题库并开始练习。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" action={formAction}>
            <input type="hidden" name="redirect" value={redirect || ''} />
            <input type="hidden" name="priceId" value={priceId || ''} />
            <input type="hidden" name="inviteId" value={inviteId || ''} />
            {mode === 'signup' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  defaultValue={state.username}
                  required
                  maxLength={32}
                  placeholder="例如 alice"
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">用户名或邮箱</Label>
              <Input
                id="email"
                name="email"
                type={mode === 'signin' ? 'text' : 'email'}
                autoComplete="email"
                defaultValue={state.email}
                required
                maxLength={50}
                placeholder={mode === 'signin' ? '用户名或邮箱' : '邮箱'}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
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
                placeholder="至少 8 位"
              />
            </div>

            {state?.error && (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="animate-spin" />
                  处理中...
                </>
              ) : mode === 'signin' ? (
                '登录'
              ) : (
                '注册'
              )}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <div className="flex w-full items-center gap-3 text-sm text-muted-foreground">
            <Separator className="flex-1" />
            <span>{mode === 'signin' ? '还没有账号？' : '已经有账号？'}</span>
            <Separator className="flex-1" />
          </div>
          <Button asChild variant="outline" className="w-full">
            <Link href={switchHref}>
              {mode === 'signin' ? '创建账号' : '登录已有账号'}
            </Link>
          </Button>
        </CardFooter>
      </Card>
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
