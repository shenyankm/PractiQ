import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Alert, Avatar, Button, Card, Description, FieldError, Fieldset, Form, InputGroup, Label, Link, TextField, Typography } from '@heroui/react';
import { useSearchParams } from 'react-router-dom';
import { ApiClientError, apiRequest } from '@/lib/api';

export type LoginPageProps = {
  mode?: 'signin' | 'signup';
};

// eslint-disable-next-line react-refresh/only-export-components -- tested redirect safety helper
export function safeRedirect(value: string | null) {
  if (!value) return '/dashboard';
  try {
    const redirect = new URL(value, window.location.origin);
    if (redirect.origin !== window.location.origin) return '/dashboard';
    return redirect.pathname + redirect.search + redirect.hash;
  } catch {
    return '/dashboard';
  }
}

function submissionErrorMessage(error: unknown) {
  if (!(error instanceof ApiClientError)) return '请求失败，请稍后重试。';
  if (!Array.isArray(error.details)) return error.message;
  const details = error.details
    .filter((detail): detail is { message: string } => typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string')
    .map((detail) => detail.message);
  return details.join(' ') || error.message;
}

export function LoginPage({ mode = 'signin' }: LoginPageProps) {
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [emailOrLogin, setEmailOrLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [codeCountdown, setCodeCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const redirect = safeRedirect(searchParams.get('redirect'));
  const isSignUp = mode === 'signup';

  useEffect(() => {
    if (codeCountdown <= 0) return;
    countdownRef.current = setTimeout(() => setCodeCountdown(codeCountdown - 1), 1000);
    return () => clearTimeout(countdownRef.current);
  }, [codeCountdown]);

  async function onSendCode() {
    setSubmissionError(null);
    try {
      await apiRequest('/api/v1/auth/email-code', {
        method: 'POST',
        json: { email: emailOrLogin }
      });
      setCodeCountdown(60);
    } catch (error) {
      setSubmissionError(submissionErrorMessage(error));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSignUp && password !== confirmPassword) return;
    setSubmissionError(null);
    setPending(true);
    try {
      if (!isSignUp) {
        await apiRequest('/api/v1/auth/login', {
          method: 'POST',
          json: { login: emailOrLogin, password }
        });
      } else {
        await apiRequest('/api/v1/auth/register', {
          method: 'POST',
          json: { username, email: emailOrLogin, password, code: verificationCode }
        });
      }
      window.location.assign(redirect);
    } catch (error) {
      setSubmissionError(submissionErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-8">
      <div className="w-full max-w-lg">
        <Form onSubmit={onSubmit}>
          <Card>
            <Card.Header>
              <div className="flex flex-col items-center gap-3">
                <Avatar aria-hidden="true" color="accent" size="lg" variant="soft">
                  <Avatar.Fallback>OW</Avatar.Fallback>
                </Avatar>
                <Typography.Heading align="center" level={1}>
                  {isSignUp ? '创建账号' : '欢迎回来'}
                </Typography.Heading>
                <Typography.Paragraph align="center" color="muted">
                  {isSignUp ? '加入 PractiQ，开始你的学习之旅。' : '登录以继续使用 PractiQ。'}
                </Typography.Paragraph>
              </div>
            </Card.Header>
            <Card.Content>
              {submissionError ? (
                <Alert role="alert" status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>无法提交</Alert.Title>
                    <Alert.Description>{submissionError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
              <Fieldset aria-label={isSignUp ? '注册信息' : '登录信息'}>
                <Fieldset.Group>
                  {isSignUp ? (
                    <TextField isRequired name="username" fullWidth>
                      <Label>用户名</Label>
                      <InputGroup fullWidth>
                        <InputGroup.Prefix>@</InputGroup.Prefix>
                        <InputGroup.Input
                          autoComplete="username"
                          maxLength={20}
                          minLength={3}
                          pattern="[A-Za-z0-9_]+"
                          placeholder="输入用户名"
                          value={username}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setUsername(event.target.value)}
                        />
                      </InputGroup>
                      <Description>3-20 个字符，仅限字母、数字和下划线。</Description>
                      <FieldError />
                    </TextField>
                  ) : null}
                  <TextField isRequired name={isSignUp ? 'email' : 'login'} fullWidth>
                    <Label>{isSignUp ? '邮箱' : '用户名或邮箱'}</Label>
                    <InputGroup fullWidth>
                      <InputGroup.Prefix>@</InputGroup.Prefix>
                      <InputGroup.Input
                        autoComplete={isSignUp ? 'email' : 'username'}
                        placeholder={isSignUp ? '输入邮箱地址' : '输入用户名或邮箱'}
                        type={isSignUp ? 'email' : 'text'}
                        value={emailOrLogin}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setEmailOrLogin(event.target.value)}
                      />
                    </InputGroup>
                    <FieldError />
                  </TextField>
                  {isSignUp ? (
                    <TextField isRequired name="code" fullWidth>
                      <Label>邮箱验证码</Label>
                      <InputGroup fullWidth>
                        <InputGroup.Input
                          autoComplete="one-time-code"
                          inputMode="numeric"
                          maxLength={6}
                          minLength={6}
                          pattern="[0-9]{6}"
                          placeholder="输入 6 位验证码"
                          value={verificationCode}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setVerificationCode(event.target.value)}
                        />
                        <InputGroup.Suffix>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            isDisabled={codeCountdown > 0 || !emailOrLogin}
                            onPress={onSendCode}
                          >
                            {codeCountdown > 0 ? `${codeCountdown} 秒后重试` : '发送验证码'}
                          </Button>
                        </InputGroup.Suffix>
                      </InputGroup>
                      <Description>验证码将发送到上方邮箱，10 分钟内有效。</Description>
                      <FieldError />
                    </TextField>
                  ) : null}
                  <TextField
                    isRequired
                    name="password"
                    validate={(value) => {
                      const length = new TextEncoder().encode(value).length;
                      if (isSignUp && length < 8) return '密码至少需要 8 字节。';
                      return length > 72 ? '密码不能超过 72 字节。' : null;
                    }}
                    fullWidth
                  >
                    <Label>密码</Label>
                    <InputGroup fullWidth>
                      <InputGroup.Prefix>*</InputGroup.Prefix>
                      <InputGroup.Input
                        autoComplete={isSignUp ? 'new-password' : 'current-password'}
                        placeholder="输入密码"
                        type={isPasswordVisible ? 'text' : 'password'}
                        value={password}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
                      />
                      <InputGroup.Suffix>
                        <Button
                          aria-label={isPasswordVisible ? '隐藏密码' : '显示密码'}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onPointerDown={(event) => event.preventDefault()}
                          onPress={() => setIsPasswordVisible(!isPasswordVisible)}
                        >
                          {isPasswordVisible ? '隐藏' : '显示'}
                        </Button>
                      </InputGroup.Suffix>
                    </InputGroup>
                    {isSignUp ? <Description>至少 8 字节，最多 72 字节。</Description> : null}
                    <FieldError />
                  </TextField>
                  {isSignUp ? (
                    <TextField
                      isRequired
                      name="confirmPassword"
                      validate={(value) => value !== password ? '两次密码输入不一致。' : null}
                      fullWidth
                    >
                      <Label>确认密码</Label>
                      <InputGroup fullWidth>
                        <InputGroup.Prefix>*</InputGroup.Prefix>
                        <InputGroup.Input
                          autoComplete="new-password"
                          placeholder="再次输入密码"
                          type={isPasswordVisible ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setConfirmPassword(event.target.value)}
                        />
                      </InputGroup>
                      <FieldError />
                    </TextField>
                  ) : null}
                </Fieldset.Group>
              </Fieldset>
            </Card.Content>
            <Card.Footer>
              <div className="flex w-full flex-col gap-4">
                <Button fullWidth variant="primary" type="submit" isDisabled={pending}>
                  {isSignUp ? '注册' : '登录'}
                </Button>
                <Button
                  fullWidth
                  variant="secondary"
                  type="button"
                  onPress={() => window.location.assign('/api/v1/auth/google/start')}
                >
                  使用 Google 登录
                </Button>
                <Typography.Paragraph align="center" color="muted" size="sm">
                  {isSignUp ? '已有账号？' : '还没有账号？'}{' '}
                  <Link href={isSignUp ? '/sign-in' : '/sign-up'}>
                    {isSignUp ? '登录' : '创建账号'}
                  </Link>
                </Typography.Paragraph>
              </div>
            </Card.Footer>
          </Card>
        </Form>
      </div>
    </main>
  );
}

export default LoginPage;
