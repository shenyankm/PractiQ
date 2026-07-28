import { useEffect, useState } from 'react';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Chip } from 'heroui-native/chip';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { Spinner } from 'heroui-native/spinner';
import { TextField } from 'heroui-native/text-field';

import { CLOUD_API_URL, loadSession, login, logout, register, sendEmailCode } from '@/cloud';
import { useLanguage } from '@/language';

type Tr = ReturnType<typeof useLanguage>['tr'];

export function AccountCard({ tr }: { tr: Tr }) {
  const [username, setUsername] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loginName, setLoginName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    loadSession()
      .then((session) => { if (active) setUsername(session?.username ?? null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (codeCountdown <= 0) return;
    const timer = setTimeout(() => setCodeCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [codeCountdown]);

  const sendCode = async () => {
    setError('');
    try {
      await sendEmailCode(email.trim());
      setCodeCountdown(60);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Could not send the code.', '验证码发送失败。'));
    }
  };

  const submit = async () => {
    const name = loginName.trim();
    if (!name) return setError(tr('Enter a username or email.', '请输入用户名或邮箱。'));
    if (mode === 'register' && (name.length < 3 || name.length > 20)) {
      return setError(tr('Usernames are 3-20 letters, numbers, or underscores.', '用户名为 3-20 个字母、数字或下划线。'));
    }
    if (mode === 'register' && !email.trim()) return setError(tr('Enter an email address.', '请输入邮箱。'));
    if (mode === 'register' && code.trim().length !== 6) {
      return setError(tr('Enter the 6-digit email verification code.', '请输入 6 位邮箱验证码。'));
    }
    const passwordBytes = new TextEncoder().encode(password).length;
    if (passwordBytes < 8 || passwordBytes > 72) {
      return setError(tr('Passwords are 8-72 bytes.', '密码为 8-72 字节。'));
    }
    setBusy(true);
    setError('');
    try {
      const session = mode === 'login'
        ? await login(name, password)
        : await register(name, email.trim(), password, code.trim());
      setUsername(session.username);
      setPassword('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Sign-in failed.', '登录失败。'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError('');
    try {
      await logout();
      setUsername(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Sign-out failed.', '登出失败。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="gap-3">
      <Card.Title>{tr('Cloud account', '云端账户')}</Card.Title>
      <Chip color={username ? 'success' : 'warning'} variant="soft">
        {username ? tr('AI ready', 'AI 可用') : tr('Not signed in', '未登录')}
      </Chip>
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            {tr(
              `AI document parsing, answer generation, and learning reports run on the PractiQ cloud service (${CLOUD_API_URL}). Your banks and practice data stay on this device; each AI transfer is confirmed before sending.`,
              `AI 文档解析、答案生成和学习报告由 PractiQ 云端服务（${CLOUD_API_URL}）提供。题库与练习数据仍保存在本机；每次 AI 传输前都会再次确认。`,
            )}
          </Alert.Description>
        </Alert.Content>
      </Alert>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
        </Alert>
      ) : null}
      {loading ? <Spinner /> : username ? (
        <>
          <Card.Description>{tr(`Signed in as ${username}`, `已登录：${username}`)}</Card.Description>
          <Button variant="danger" isDisabled={busy} onPress={() => void signOut()}>
            {busy ? tr('Signing out...', '登出中...') : tr('Sign out', '登出')}
          </Button>
        </>
      ) : (
        <>
          <TextField isDisabled={busy}>
            <Label>{mode === 'login' ? tr('Username or email', '用户名或邮箱') : tr('Username', '用户名')}</Label>
            <Input
              accessibilityLabel={mode === 'login' ? tr('Username or email', '用户名或邮箱') : tr('Username', '用户名')}
              value={loginName}
              onChangeText={setLoginName}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={254}
            />
          </TextField>
          {mode === 'register' ? (
            <>
              <TextField isDisabled={busy}>
                <Label>{tr('Email', '邮箱')}</Label>
                <Input
                  accessibilityLabel={tr('Email', '邮箱')}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  maxLength={254}
                />
              </TextField>
              <TextField isDisabled={busy}>
                <Label>{tr('Email verification code', '邮箱验证码')}</Label>
                <Input
                  accessibilityLabel={tr('Email verification code', '邮箱验证码')}
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  maxLength={6}
                />
              </TextField>
              <Button variant="ghost" isDisabled={busy || codeCountdown > 0 || !email.trim()} onPress={() => void sendCode()}>
                {codeCountdown > 0
                  ? tr(`Retry in ${codeCountdown}s`, `${codeCountdown} 秒后重试`)
                  : tr('Send code', '发送验证码')}
              </Button>
            </>
          ) : null}
          <TextField isDisabled={busy}>
            <Label>{tr('Password', '密码')}</Label>
            <Input
              accessibilityLabel={tr('Password', '密码')}
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              maxLength={72}
            />
          </TextField>
          <Button isDisabled={busy} onPress={() => void submit()}>
            {busy
              ? tr('Working...', '处理中...')
              : mode === 'login' ? tr('Sign in', '登录') : tr('Create account', '注册')}
          </Button>
          <Button
            variant="ghost"
            isDisabled={busy}
            onPress={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? tr('Create an account', '没有账户？注册') : tr('Have an account? Sign in', '已有账户？登录')}
          </Button>
        </>
      )}
    </Card>
  );
}
