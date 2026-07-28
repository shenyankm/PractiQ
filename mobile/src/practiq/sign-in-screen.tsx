import { useState } from 'react';
import { router } from 'expo-router';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { useLanguage } from '@/language';
import { useCloudAuth } from './auth';

export default function SignInScreen() {
  const auth = useCloudAuth();
  const { tr } = useLanguage();
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordBytes = new TextEncoder().encode(password).length;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (registering) await auth.signUp(name.trim(), email.trim(), password);
      else await auth.signIn(name.trim(), password);
      router.replace('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Sign in failed.', '登录失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState className="gap-5 rounded-none">
      <Typography.Heading type="h1">PractiQ</Typography.Heading>
      <Typography color="muted">{tr('Use your PractiQ account to sync learning data with the Web app.', '登录 PractiQ 云端账号，在手机与 Web 间同步学习数据。')}</Typography>
      <Card className="gap-4">
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        <TextField isDisabled={busy}>
          <Label>{registering ? tr('Username', '用户名') : tr('Username or email', '用户名或邮箱')}</Label>
          <Input value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} />
        </TextField>
        {registering ? (
          <TextField isDisabled={busy}>
            <Label>{tr('Email', '邮箱')}</Label>
            <Input value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          </TextField>
        ) : null}
        <TextField isDisabled={busy}>
          <Label>{tr('Password', '密码')}</Label>
          <Input value={password} onChangeText={setPassword} secureTextEntry maxLength={72} />
        </TextField>
        <Button isDisabled={busy || !name.trim() || passwordBytes < 8 || passwordBytes > 72} onPress={() => void submit()}>
          {busy ? tr('Working…', '处理中…') : registering ? tr('Create account', '创建账号') : tr('Sign in', '登录')}
        </Button>
        <Button variant="ghost" isDisabled={busy} onPress={() => setRegistering((value) => !value)}>
          {registering ? tr('Already have an account? Sign in', '已有账号？登录') : tr('Need an account? Register', '没有账号？注册')}
        </Button>
      </Card>
    </ScreenState>
  );
}
