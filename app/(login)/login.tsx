'use client';
import { useActionState } from 'react';

import {
  Link,
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Description,
  FieldGroup,
  Input,
  Label,
  Separator
} from '@heroui/react';
import { BookOpen, Loader2 } from 'lucide-react';
import { signIn, signUp } from './actions';
import type { ActionState } from './actions';
import { buttonVariants } from '@heroui/styles';

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
    <div className="flex min-h-[100dvh] flex-col justify-center bg-[radial-gradient(circle_at_top,rgb(0_0_0_/_0.06),transparent_28rem),var(--background)] px-4 py-12 sm:px-6 lg:px-8 dark:bg-[radial-gradient(circle_at_top,rgb(255_255_255_/_0.08),transparent_28rem),var(--background)]">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BookOpen className="size-12 text-foreground" />
        </div>
      </div>

      <Card className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
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
            <FieldGroup className="gap-4">
              {mode === 'signup' && (
                <div>
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
              <div>
                <Label htmlFor="email">
                  {mode === 'signin' ? '用户名或邮箱' : '邮箱'}
                </Label>
                <Input
                  id="email"
                  name="email"
                  type={mode === 'signin' ? 'text' : 'email'}
                  autoComplete={mode === 'signin' ? 'username' : 'email'}
                  defaultValue={state.email}
                  required
                  maxLength={50}
                  placeholder={mode === 'signin' ? '用户名或邮箱' : '邮箱'}
                />
              </div>

              <div>
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'signin' ? 'current-password' : 'new-password'
                  }
                  required
                  minLength={8}
                  maxLength={100}
                  placeholder="至少 8 位"
                />
                {mode === 'signup' ? (
                  <Description>至少 8 位，建议包含字母和数字。</Description>
                ) : null}
              </div>
            </FieldGroup>

            {state?.error && (
              <Alert status="danger">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              fullWidth
              isDisabled={pending}
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
          <Link href={switchHref} className={buttonVariants({ variant: 'outline' })}>
  {mode === 'signin' ? '创建账号' : '登录已有账号'}
</Link>
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
