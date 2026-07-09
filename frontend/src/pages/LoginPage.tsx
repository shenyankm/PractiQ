import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Card, Input, Label, Link, TextField } from '@heroui/react';
import { useSearchParams } from 'react-router-dom';
import { apiRequest } from '@/lib/api';

export type LoginPageProps = {
  mode?: 'signin' | 'signup';
};

function safeRedirect(value: string | null) {
  if (!value) return '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}

export function LoginPage({ mode = 'signin' }: LoginPageProps) {
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [emailOrLogin, setEmailOrLogin] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const redirect = safeRedirect(searchParams.get('redirect'));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      if (mode === 'signin') {
        await apiRequest('/api/v1/auth/login', {
          method: 'POST',
          json: { login: emailOrLogin, password }
        });
      } else {
        await apiRequest('/api/v1/auth/register', {
          method: 'POST',
          json: { username, email: emailOrLogin, password }
        });
      }
      window.location.assign(redirect);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-default-50 px-4">
      <Card className="w-full max-w-sm">
        <form className="space-y-4 p-6" onSubmit={onSubmit}>
          <div>
            <h1 className="text-xl font-semibold">
              {mode === 'signin' ? '登录 OpenWook' : '创建 OpenWook 账号'}
            </h1>
            <p className="mt-1 text-sm text-default-500">
              {mode === 'signin' ? '使用用户名或邮箱继续。' : '填写信息后即可开始使用。'}
            </p>
          </div>
          {mode === 'signup' ? (
            <TextField fullWidth>
              <Label>用户名</Label>
              <Input value={username} onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)} />
            </TextField>
          ) : null}
          <TextField fullWidth>
            <Label>{mode === 'signin' ? '用户名或邮箱' : '邮箱'}</Label>
            <Input value={emailOrLogin} onChange={(event: ChangeEvent<HTMLInputElement>) => setEmailOrLogin(event.target.value)} />
          </TextField>
          <TextField fullWidth>
            <Label>密码</Label>
            <Input type="password" value={password} onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)} />
          </TextField>
          <div className="flex items-center gap-3">
            <Button variant="primary" type="submit" isDisabled={pending}>
              {mode === 'signin' ? '登录' : '注册'}
            </Button>
            <Link href={mode === 'signin' ? '/sign-up' : '/sign-in'}>
              {mode === 'signin' ? '创建账号' : '登录已有账号'}
            </Link>
          </div>
        </form>
      </Card>
    </main>
  );
}

export default LoginPage;
