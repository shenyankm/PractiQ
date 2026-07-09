import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Link } from '@heroui/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  const navigate = useNavigate();
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
      navigate(redirect);
      window.location.assign(redirect);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-default-50 px-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl bg-content1 p-6 shadow-small"
        onSubmit={onSubmit}
      >
        <div>
          <h1 className="text-xl font-semibold">
            {mode === 'signin' ? '登录 OpenWook' : '创建 OpenWook 账号'}
          </h1>
          <p className="mt-1 text-sm text-default-500">
            {mode === 'signin' ? '使用用户名或邮箱继续。' : '填写信息后即可开始使用。'}
          </p>
        </div>
        {mode === 'signup' ? (
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="username">
              用户名
            </label>
            <input
              className="w-full rounded-xl border border-default-200 px-3 py-2 outline-none focus:border-default-400"
              id="username"
              value={username}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="email">
            {mode === 'signin' ? '用户名或邮箱' : '邮箱'}
          </label>
          <input
            className="w-full rounded-xl border border-default-200 px-3 py-2 outline-none focus:border-default-400"
            id="email"
            value={emailOrLogin}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setEmailOrLogin(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="password">
            密码
          </label>
          <input
            className="w-full rounded-xl border border-default-200 px-3 py-2 outline-none focus:border-default-400"
            id="password"
            type="password"
            value={password}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button color="primary" type="submit" isDisabled={pending} isLoading={pending}>
            {mode === 'signin' ? '登录' : '注册'}
          </Button>
          <Link href={mode === 'signin' ? '/sign-up' : '/sign-in'} size="sm">
            {mode === 'signin' ? '创建账号' : '登录已有账号'}
          </Link>
        </div>
      </form>
    </main>
  );
}

export default LoginPage;
