import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Input, Label, Link } from '@heroui/react';
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
    <form onSubmit={onSubmit}>
      {mode === 'signup' ? (
        <div>
          <Label htmlFor="username">用户名</Label>
          <Input id="username" value={username} onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)} />
        </div>
      ) : null}
      <div>
        <Label htmlFor="email">{mode === 'signin' ? '用户名或邮箱' : '邮箱'}</Label>
        <Input id="email" value={emailOrLogin} onChange={(event: ChangeEvent<HTMLInputElement>) => setEmailOrLogin(event.target.value)} />
      </div>
      <div>
        <Label htmlFor="password">密码</Label>
        <Input id="password" type="password" value={password} onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)} />
      </div>
      <Button type="submit" isDisabled={pending}>{mode === 'signin' ? '登录' : '注册'}</Button>
      <Link href={mode === 'signin' ? '/sign-up' : '/sign-in'}>{mode === 'signin' ? '创建账号' : '登录已有账号'}</Link>
    </form>
  );
}

export default LoginPage;
