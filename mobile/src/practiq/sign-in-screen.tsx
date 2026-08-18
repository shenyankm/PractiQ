import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
  GoogleOneTapSignIn,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from 'react-native-nitro-google-signin';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { Card } from 'heroui-native/card';
import { Input } from 'heroui-native/input';
import { Label } from 'heroui-native/label';
import { TextField } from 'heroui-native/text-field';
import { Typography } from 'heroui-native/text';

import { ScreenState } from '@/components/screen-state';
import { sendEmailCode } from '@/cloud';
import { useLanguage } from '@/language';
import { useCloudAuth } from './auth';

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;

export default function SignInScreen() {
  const auth = useCloudAuth();
  const { tr } = useLanguage();
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passwordBytes = new TextEncoder().encode(password).length;
  useEffect(() => {
    if (codeCountdown <= 0) return;
    const timer = setTimeout(() => setCodeCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [codeCountdown]);

  async function signInWithGoogle() {
    if (!GOOGLE_CLIENT_ID) return;
    setBusy(true);
    setError('');
    try {
      GoogleOneTapSignIn.configure({
        webClientId: GOOGLE_CLIENT_ID,
        iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
        offlineAccess: false,
      });
      await GoogleOneTapSignIn.checkPlayServices();
      let result = await GoogleOneTapSignIn.signIn();
      if (isNoSavedCredentialFoundResponse(result)) result = await GoogleOneTapSignIn.createAccount();
      if (isNoSavedCredentialFoundResponse(result)) result = await GoogleOneTapSignIn.presentExplicitSignIn();
      if (!isSuccessResponse(result)) return;
      const idToken = result.data.idToken?.trim();
      if (!idToken) throw new Error(tr('Google did not return an ID token.', 'Google 未返回 ID token。'));
      await auth.signInWithGoogle(idToken);
      router.replace('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Sign in failed.', '登录失败。'));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setError('');
    try {
      await sendEmailCode(email.trim());
      setCodeCountdown(60);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Could not send the code.', '验证码发送失败。'));
    }
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (registering) await auth.signUp(name.trim(), email.trim(), password, code.trim());
      else await auth.signIn(name.trim(), password);
      router.replace('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr('Sign in failed.', '登录失败。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenState className="gap-5 rounded-none" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
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
          <>
            <TextField isDisabled={busy}>
              <Label>{tr('Email', '邮箱')}</Label>
              <Input value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            </TextField>
            <TextField isDisabled={busy}>
              <Label>{tr('Email verification code', '邮箱验证码')}</Label>
              <Input value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
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
          <Input value={password} onChangeText={setPassword} secureTextEntry maxLength={72} />
        </TextField>
        <Button isDisabled={busy || !name.trim() || passwordBytes < 8 || passwordBytes > 72 || (registering && code.trim().length !== 6)} onPress={() => void submit()}>
          {busy ? tr('Working…', '处理中…') : registering ? tr('Create account', '创建账号') : tr('Sign in', '登录')}
        </Button>
        {GOOGLE_CLIENT_ID ? (
          <Button variant="secondary" isDisabled={busy} onPress={() => void signInWithGoogle()}>
            {tr('Sign in with Google', '使用 Google 登录')}
          </Button>
        ) : null}
        <Button variant="ghost" isDisabled={busy} onPress={() => setRegistering((value) => !value)}>
          {registering ? tr('Already have an account? Sign in', '已有账号？登录') : tr('Need an account? Register', '没有账号？注册')}
        </Button>
      </Card>
    </ScreenState>
  );
}
