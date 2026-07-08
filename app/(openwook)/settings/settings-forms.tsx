'use client';

import Image from 'next/image';
import { useActionState } from 'react';
import {
  Avatar,
  AvatarFallback,
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Description,
  FieldGroup,
  Input,
  Label
} from '@heroui/react';
import { KeyRound, UserRound } from 'lucide-react';
import { updatePasswordAction, updateProfileAction, type SettingsActionState } from '../banks/actions';

type ProfileSettingsCardProps = {
  avatarOptimized: boolean;
  avatarUrl: string | null;
  email: string | null;
  username: string;
};

export function ProfileSettingsCard({ avatarOptimized, avatarUrl, email, username }: ProfileSettingsCardProps) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(updateProfileAction, {
    email: email ?? '',
    username
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserRound className="size-4" />个人资料</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <div className="flex items-center gap-4">
              <Avatar className="size-16 overflow-hidden border border-border/70">
                {avatarUrl ? <Image src={avatarUrl} alt={username} width={64} height={64} sizes="64px" unoptimized={!avatarOptimized} className="size-full object-cover" /> : null}
                <AvatarFallback className="bg-foreground/10 text-base font-semibold text-foreground">
                  {username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <Label htmlFor="avatar">头像</Label>
                <Input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
                <Description>支持 PNG、JPEG、WebP 和 GIF。</Description>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="username">用户名</Label>
                <Input id="username" name="username" defaultValue={state.username ?? username} required maxLength={32} />
              </div>
              <div>
                <Label htmlFor="email">邮箱</Label>
                <Input id="email" name="email" type="email" defaultValue={state.email ?? email ?? ''} />
              </div>
            </div>
            {state.error ? (
              <div role="alert" aria-live="polite">
                <Alert status="danger">
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            {state.success ? (
              <div role="alert" aria-live="polite">
                <Alert status="success">
                  <AlertDescription>{state.success}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            <Button type="submit" isDisabled={pending} aria-busy={pending}>保存设置</Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

export function PasswordSettingsCard() {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(updatePasswordAction, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />安全</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <div>
              <Label htmlFor="currentPassword">当前密码</Label>
              <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
            </div>
            <div>
              <Label htmlFor="password">新密码</Label>
              <Input id="password" name="password" type="password" minLength={8} maxLength={100} autoComplete="new-password" required />
              <Description>至少 8 位。保存后请使用新密码登录。</Description>
            </div>
            <div>
              <Label htmlFor="confirmPassword">确认新密码</Label>
              <Input id="confirmPassword" name="confirmPassword" type="password" minLength={8} maxLength={100} autoComplete="new-password" required />
            </div>
            {state.error ? (
              <div role="alert" aria-live="polite">
                <Alert status="danger">
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            {state.success ? (
              <div role="alert" aria-live="polite">
                <Alert status="success">
                  <AlertDescription>{state.success}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            <Button type="submit" isDisabled={pending} aria-busy={pending}>更新密码</Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
