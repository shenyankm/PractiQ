import { SplashScreen } from '@/splash';

import '../global.css';
import { router, Stack, type ErrorBoundaryProps, useSegments } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import { Suspense, useEffect, useState } from 'react';
import { Alert as NativeAlert, Platform, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { Alert } from 'heroui-native/alert';
import { Button } from 'heroui-native/button';
import { useThemeColor } from 'heroui-native/hooks';
import { HeroUINativeProvider } from 'heroui-native/provider';
import { Spinner } from 'heroui-native/spinner';
import { Surface } from 'heroui-native/surface';
import { Typography } from 'heroui-native/text';
import { useUniwind } from 'uniwind';

import { DATABASE_NAME, SQLITE_OPEN_OPTIONS } from '@/database';
import { migrateDatabase } from '@/database/migrations';
import { LanguageProvider, useLanguage } from '@/language';
import { CONTENT_MAX_WIDTH } from '@/layout';
import { CloudAuthProvider, useCloudAuth } from '@/openwook/auth';

export const unstable_settings = { initialRouteName: '(tabs)' };

const DATABASE_OPTIONS = SQLITE_OPEN_OPTIONS;

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');

  const confirmRestore = () => NativeAlert.alert(
    'Restore from backup?',
    'Use this only if retrying still cannot start the app. The selected backup will replace the unavailable local database and files.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Choose backup',
        style: 'destructive',
        onPress: () => void (async () => {
          setBusy(true);
          setRestoreError('');
          let db: SQLite.SQLiteDatabase | null = null;
          try {
            const { restoreDatabase } = await import('@/files/backup');
            db = await SQLite.openDatabaseAsync(DATABASE_NAME, DATABASE_OPTIONS);
            const restored = await restoreDatabase(db, { recoveryMode: true });
            if (!restored) return;
            retry();
          } catch {
            setRestoreError('Restore failed. Current data was not replaced.');
          } finally {
            await db?.closeAsync().catch(() => undefined);
            setBusy(false);
          }
        })(),
      },
    ],
  );

  return (
    <GestureHandlerRootView>
      <HeroUINativeProvider>
        <Surface className="gap-3" onLayout={() => SplashScreen.hide()}>
          <Typography.Heading>PractiQ could not start</Typography.Heading>
          <Typography>The local database failed a version or integrity check. Retry first; if it still fails, restore a complete backup.</Typography>
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>{restoreError || error.message}</Alert.Title></Alert.Content>
          </Alert>
          <Button isDisabled={busy} onPress={retry}>Retry</Button>
          <Button isDisabled={busy} onPress={confirmRestore} variant="secondary">{busy ? 'Working...' : 'Restore backup'}</Button>
        </Surface>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView>
      <HeroUINativeProvider>
        <SafeAreaProvider>
          <Suspense fallback={<StartupFallback />}>
            <SQLite.SQLiteProvider
              databaseName={DATABASE_NAME}
              onInit={migrateDatabase}
              options={DATABASE_OPTIONS}
              useSuspense
            >
              <LanguageProvider>
                <CloudAuthProvider>
                  <ThemedStatusBar />
                  <AppNavigator />
                </CloudAuthProvider>
              </LanguageProvider>
            </SQLite.SQLiteProvider>
          </Suspense>
        </SafeAreaProvider>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}

function AppNavigator() {
  const auth = useCloudAuth();
  const segments = useSegments();
  const { tr } = useLanguage();
  const { left, right } = useSafeAreaInsets();
  const [backgroundColor, foregroundColor] = useThemeColor(['background', 'foreground']);
  const contentStyle = {
    alignSelf: 'center' as const,
    backgroundColor,
    maxWidth: CONTENT_MAX_WIDTH,
    paddingLeft: left,
    paddingRight: right,
    width: '100%' as const,
  };
  const reducedMotion = useReducedMotion();
  const animation = reducedMotion
    ? ('none' as const)
    : Platform.OS === 'android' ? ('slide_from_right' as const) : ('default' as const);
  useEffect(() => {
    if (auth.loading) return;
    const signingIn = segments[0] === 'sign-in';
    if (!auth.session && !signingIn) router.replace('/sign-in');
    if (auth.session && signingIn) router.replace('/');
  }, [auth.loading, auth.session, segments]);
  if (auth.loading) return <StartupFallback />;
  return (
    <Surface className="flex-1 rounded-none bg-background p-0" onLayout={() => SplashScreen.hide()}>
      <Stack screenOptions={{
        animation,
        contentStyle,
        gestureEnabled: true,
        headerBackButtonDisplayMode: 'minimal',
        headerLeft: Platform.OS === 'android'
          ? ({ canGoBack }) => canGoBack ? (
            <Button
              accessibilityLabel={tr('Back', '返回')}
              isIconOnly
              onPress={() => router.back()}
              size="md"
              variant="ghost"
            >
              <ArrowLeft color={foregroundColor} size={24} />
            </Button>
          ) : null
          : undefined,
        headerShadowVisible: false,
      }}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false, contentStyle: { backgroundColor } }} />
        <Stack.Screen name="settings/ai" options={{ title: tr('Cloud account', '云端账户') }} />
        <Stack.Screen name="settings/data" options={{ title: tr('Local data', '本地数据') }} />
        <Stack.Screen name="imports/index" options={{ title: tr('Document imports', '文档导入') }} />
        <Stack.Screen name="search" options={{ title: tr('Search', '搜索') }} />
      </Stack>
    </Surface>
  );
}

function ThemedStatusBar() {
  const { theme } = useUniwind();
  return <StatusBar barStyle={theme === 'dark' ? 'light-content' : 'dark-content'} />;
}

function StartupFallback() {
  return (
    <Surface accessibilityRole="progressbar" accessibilityLabel="Preparing local database">
      <Typography.Heading>PractiQ</Typography.Heading>
      <Spinner />
      <Typography color="muted">Checking local data...</Typography>
    </Surface>
  );
}
