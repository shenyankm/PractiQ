// use-resource hook + SignInScreen + PrimaryTabs + PrivacyPage tests.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

jest.mock('heroui-native/alert', () => {
  const { Text, View } = require('react-native');
  const Alert: any = ({ children }: any) => <View>{children}</View>;
  Alert.Indicator = () => <View />;
  Alert.Content = ({ children }: any) => <View>{children}</View>;
  Alert.Title = ({ children }: any) => <Text>{children}</Text>;
  return { Alert };
});
jest.mock('heroui-native/button', () => {
  const { Pressable } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return {
    Button: ({ onPress, isDisabled, children }: any) => (
      <Pressable accessibilityRole="button" disabled={!!isDisabled} onPress={isDisabled ? undefined : onPress}><Textify>{children}</Textify></Pressable>
    ),
  };
});
jest.mock('heroui-native/card', () => {
  const { Text, View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  const Card: any = ({ children }: any) => <View><Textify>{children}</Textify></View>;
  Card.Title = ({ children }: any) => <Text>{children}</Text>;
  Card.Description = ({ children }: any) => <Text>{children}</Text>;
  return { Card };
});
jest.mock('heroui-native/input', () => {
  const { TextInput } = require('react-native');
  return { Input: (props: any) => <TextInput {...props} /> };
});
jest.mock('heroui-native/label', () => {
  const { Text } = require('react-native');
  return { Label: ({ children }: any) => <Text>{children}</Text> };
});
jest.mock('heroui-native/surface', () => {
  const { View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return { Surface: ({ children }: any) => <View><Textify>{children}</Textify></View> };
});
jest.mock('heroui-native/text', () => {
  const { Text } = require('react-native');
  const Typography: any = ({ children }: any) => <Text>{children}</Text>;
  Typography.Heading = Typography;
  return { Typography };
});
jest.mock('heroui-native/text-field', () => {
  const { View } = require('react-native');
  const { Textify } = require('./test-utils/textify');
  return { TextField: ({ children }: any) => <View><Textify>{children}</Textify></View> };
});
jest.mock('heroui-native/tabs', () => {
  const { Pressable, View } = require('react-native');
  let onChange: ((name: string) => void) | undefined;
  const Tabs: any = ({ value, onValueChange, children }: any) => {
    onChange = onValueChange;
    return <View>{children}</View>;
  };
  Tabs.List = ({ children }: any) => <View>{children}</View>;
  Tabs.Indicator = () => <View />;
  Tabs.Trigger = ({ value, onLongPress, children }: any) => (
    <Pressable accessibilityRole="button" onPress={() => onChange?.(value)} onLongPress={onLongPress}>
      {typeof children === 'function' ? children({ isSelected: false }) : children}
    </Pressable>
  );
  return { Tabs };
});
jest.mock('heroui-native/hooks', () => ({
  useThemeColor: () => ['#111111', '#999999'],
}));
jest.mock('lucide-react-native', () => {
  const { Text } = require('react-native');
  return { House: () => <Text>icon</Text>, LibraryBig: () => <Text>icon</Text>, ChartNoAxesColumnIncreasing: () => <Text>icon</Text>, Settings: () => <Text>icon</Text> };
});
jest.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
}));

const mockApiRequestPage = jest.fn<any, any[]>();
const mockReadResource = jest.fn<any, any[]>();
const mockWriteResource = jest.fn<any, any[]>();
const mockUseCloudAuth = jest.fn<any, any[]>();
const mockSendEmailCode = jest.fn<any, any[]>();
const mockGoogleConfigure = jest.fn<any, any[]>();
const mockGoogleCheckPlayServices = jest.fn<any, any[]>(async () => undefined);
const mockGoogleSignIn = jest.fn<any, any[]>(async () => ({ type: 'cancelled' }));
const mockGoogleCreateAccount = jest.fn<any, any[]>();
const mockGooglePresentExplicitSignIn = jest.fn<any, any[]>();
const mockUseLanguage = jest.fn<any, any[]>(() => ({
  tr: (_en: string, zh: string) => zh ?? _en,
  language: 'zh-CN',
  setLanguage: jest.fn<any, any[]>(async () => undefined),
}));

jest.mock('./practiq/api', () => ({
  apiRequestPage: (...args: unknown[]) => mockApiRequestPage(...args),
}));
jest.mock('./practiq/cache', () => ({
  readResource: (...args: unknown[]) => mockReadResource(...args),
  writeResource: (...args: unknown[]) => mockWriteResource(...args),
}));
jest.mock('./practiq/auth', () => ({ useCloudAuth: (...args: unknown[]) => mockUseCloudAuth(...args) }));
jest.mock('./language', () => ({ useLanguage: () => mockUseLanguage() }));
jest.mock('./cloud', () => ({ sendEmailCode: (...args: unknown[]) => mockSendEmailCode(...args) }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn<any, any[]>(), replace: jest.fn<any, any[]>() },
  Stack: { Screen: () => null },
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require('react');
    useEffect(callback, [callback]);
  },
}));
jest.mock('react-native-nitro-google-signin', () => ({
  GoogleOneTapSignIn: {
    configure: (...args: unknown[]) => mockGoogleConfigure(...args),
    checkPlayServices: (...args: unknown[]) => mockGoogleCheckPlayServices(...args),
    signIn: (...args: unknown[]) => mockGoogleSignIn(...args),
    createAccount: (...args: unknown[]) => mockGoogleCreateAccount(...args),
    presentExplicitSignIn: (...args: unknown[]) => mockGooglePresentExplicitSignIn(...args),
  },
  isNoSavedCredentialFoundResponse: (result: { type?: string }) => result.type === 'noSavedCredentialFound',
  isSuccessResponse: (result: { type?: string }) => result.type === 'success',
}));

import { useEffect } from 'react';
import SignInScreen from './practiq/sign-in-screen';
import { PrimaryTabs } from './components/primary-tabs';
import PrivacyPage from './features/settings/privacy-screen';
import { useCachedResource } from './practiq/use-resource';

const router = () => jest.requireMock('expo-router').router;

beforeEach(() => {
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = 'google-client';
  mockApiRequestPage.mockReset();
  mockReadResource.mockReset();
  mockWriteResource.mockReset();
  mockUseCloudAuth.mockReturnValue({
    user: null,
    session: null,
    hasPro: true,
    signIn: jest.fn<any, any[]>(async () => undefined),
    signUp: jest.fn<any, any[]>(async () => undefined),
    signInWithGoogle: jest.fn<any, any[]>(async () => undefined),
    sync: { running: false, pending: 0, failed: 0 },
  });
  mockSendEmailCode.mockReset();
  mockGoogleConfigure.mockReset();
  mockGoogleCheckPlayServices.mockResolvedValue(undefined);
  mockGoogleSignIn.mockResolvedValue({ type: 'cancelled' });
  mockGoogleCreateAccount.mockReset();
  mockGooglePresentExplicitSignIn.mockReset();
  mockUseLanguage.mockReturnValue({
    tr: (_en: string, zh: string) => zh ?? _en,
    language: 'zh-CN',
    setLanguage: jest.fn<any, any[]>(async () => undefined),
  });
  router().push.mockClear();
  router().replace.mockClear();
});

// ------------------------------------------------------------ use-resource

const passthroughSchema = { safeParse: (value: unknown) => ({ success: Array.isArray(value), data: value }) };

function ResourceProbe({ onValue }: { onValue: (state: unknown) => void }) {
  const state = useCachedResource('probe:key', '/api/v1/probe', [] as { id: number }[], passthroughSchema as never);
  useEffect(() => {
    onValue(state);
  });
  return <Text>{state.loading ? 'loading' : `${state.data.length}:${state.error}`}</Text>;
}

describe('useCachedResource', () => {
  it('fetches, persists and exposes pagination', async () => {
    mockReadResource.mockResolvedValue(null);
    mockApiRequestPage
      .mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }], cursor: 'c1', hasMore: true, limit: 100 })
      .mockResolvedValueOnce({ data: [{ id: 3 }], cursor: '', hasMore: false, limit: 100 });
    let state: any;
    const view = await render(<ResourceProbe onValue={(value) => { state = value; }} />);
    await waitFor(() => expect(view.getByText('2:')).toBeTruthy());
    expect(mockApiRequestPage).toHaveBeenCalledWith('/api/v1/probe', expect.objectContaining({ schema: passthroughSchema }));
    expect(mockWriteResource).toHaveBeenCalledWith('probe:key', [{ id: 1 }, { id: 2 }]);
    expect(state.hasMore).toBe(true);
    await act(async () => {
      await state.loadMore();
    });
    expect(mockApiRequestPage).toHaveBeenCalledWith('/api/v1/probe?cursor=c1', expect.anything());
    expect(mockWriteResource).toHaveBeenCalledWith('probe:key', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(view.getByText('3:')).toBeTruthy();
    await act(async () => {
      await state.update([{ id: 9 }]);
    });
    expect(view.getByText('1:')).toBeTruthy();
    expect(mockWriteResource).toHaveBeenCalledWith('probe:key', [{ id: 9 }]);
  });

  it('keeps cached data and swallows network errors when the cache is warm', async () => {
    mockReadResource.mockResolvedValue([{ id: 7 }]);
    mockApiRequestPage.mockRejectedValue(new Error('offline'));
    let state: any;
    const view = await render(<ResourceProbe onValue={(value) => { state = value; }} />);
    await waitFor(() => expect(view.getByText('1:')).toBeTruthy());
    expect(state.error).toBe('');
  });

  it('reports errors when the cache is empty', async () => {
    mockReadResource.mockResolvedValue(undefined);
    mockApiRequestPage.mockRejectedValue(new Error('offline'));
    const view = await render(<ResourceProbe onValue={(value) => { void value; }} />);
    await waitFor(() => expect(view.getByText('0:offline')).toBeTruthy());
  });
});

// ----------------------------------------------------------- SignInScreen

describe('SignInScreen', () => {
  it('signs in with name and password', async () => {
    const signIn = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn, signUp: jest.fn<any, any[]>(), signInWithGoogle: jest.fn<any, any[]>(), sync: { running: false, pending: 0, failed: 0 } });
    const view = await render(<SignInScreen />);
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[0], 'alice');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[1], 'password');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('登录'));
    });
    expect(signIn).toHaveBeenCalledWith('alice', 'password');
    expect(router().replace).toHaveBeenCalledWith('/');
  });

  it('registers with email verification code and countdown', async () => {
    const signUp = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn: jest.fn<any, any[]>(), signUp, signInWithGoogle: jest.fn<any, any[]>(), sync: { running: false, pending: 0, failed: 0 } });
    mockSendEmailCode.mockResolvedValue({ ok: true });
    const view = await render(<SignInScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('没有账号？注册'));
    });
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[0], 'bob');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[1], 'b@c.d');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[2], '123456');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[3], 'password');
    });
    await act(async () => {
      await fireEvent.press(view.getByText('发送验证码'));
    });
    expect(mockSendEmailCode).toHaveBeenCalledWith('b@c.d');
    expect(view.getByText('60 秒后重试')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('创建账号'));
    });
    expect(signUp).toHaveBeenCalledWith('bob', 'b@c.d', 'password', '123456');
  });

  it('shows errors and disables submit for short passwords', async () => {
    const signIn = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn, signUp: jest.fn<any, any[]>(), signInWithGoogle: jest.fn<any, any[]>(), sync: { running: false, pending: 0, failed: 0 } });
    const view = await render(<SignInScreen />);
    const inputs = view.container.queryAll((node: any) => node.type === 'TextInput');
    await act(async () => {
      await fireEvent.changeText(inputs[0], 'alice');
    });
    await act(async () => {
      await fireEvent.changeText(inputs[1], 'short');
    });
    const buttons = view.container.queryAll((node: any) => node.props.accessibilityRole === 'button');
    expect(buttons.some((button) => button.props.accessibilityState?.disabled === true)).toBe(true); // submit disabled for short password
    await act(async () => {
      await fireEvent.changeText(inputs[1], 'long-password');
    });
    signIn.mockRejectedValueOnce(new Error('bad credentials'));
    await act(async () => {
      await fireEvent.press(view.getByText('登录'));
    });
    expect(view.getByText('bad credentials')).toBeTruthy();
  });

  it('signs in with Google when the response succeeds', async () => {
    const signInWithGoogle = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn: jest.fn<any, any[]>(), signUp: jest.fn<any, any[]>(), signInWithGoogle, sync: { running: false, pending: 0, failed: 0 } });
    mockGoogleSignIn.mockResolvedValue({ type: 'success', data: { idToken: 'id-token' } });
    const view = await render(<SignInScreen />);
    expect(view.getByText('使用 Google 登录')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalledWith('id-token'));
    expect(mockGoogleConfigure).toHaveBeenCalledWith(expect.objectContaining({ webClientId: 'google-client', offlineAccess: false }));
    expect(router().replace).toHaveBeenCalledWith('/');
  });

  it('falls back from saved credentials to account creation and explicit sign-in', async () => {
    const signInWithGoogle = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn: jest.fn<any, any[]>(), signUp: jest.fn<any, any[]>(), signInWithGoogle, sync: { running: false, pending: 0, failed: 0 } });
    mockGoogleSignIn.mockResolvedValue({ type: 'noSavedCredentialFound' });
    mockGoogleCreateAccount.mockResolvedValue({ type: 'noSavedCredentialFound' });
    mockGooglePresentExplicitSignIn.mockResolvedValue({ type: 'success', data: { idToken: 'explicit-token' } });
    const view = await render(<SignInScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    expect(mockGoogleCreateAccount).toHaveBeenCalledTimes(1);
    expect(mockGooglePresentExplicitSignIn).toHaveBeenCalledTimes(1);
    expect(signInWithGoogle).toHaveBeenCalledWith('explicit-token');
  });

  it('does not authenticate after Google cancellation or a missing ID token', async () => {
    const signInWithGoogle = jest.fn<any, any[]>(async () => undefined);
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn: jest.fn<any, any[]>(), signUp: jest.fn<any, any[]>(), signInWithGoogle, sync: { running: false, pending: 0, failed: 0 } });
    const view = await render(<SignInScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    expect(signInWithGoogle).not.toHaveBeenCalled();
    expect(router().replace).not.toHaveBeenCalled();

    mockGoogleSignIn.mockResolvedValue({ type: 'success', data: { idToken: '   ' } });
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    expect(signInWithGoogle).not.toHaveBeenCalled();
    expect(view.getByText('Google 未返回 ID token。')).toBeTruthy();
  });

  it('shows native and backend Google failures without navigating', async () => {
    const signInWithGoogle = jest.fn<any, any[]>(async () => { throw new Error('backend rejected token'); });
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, signIn: jest.fn<any, any[]>(), signUp: jest.fn<any, any[]>(), signInWithGoogle, sync: { running: false, pending: 0, failed: 0 } });
    mockGoogleCheckPlayServices.mockRejectedValueOnce(new Error('Play Services unavailable'));
    const view = await render(<SignInScreen />);
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    expect(view.getByText('Play Services unavailable')).toBeTruthy();
    expect(signInWithGoogle).not.toHaveBeenCalled();

    mockGoogleSignIn.mockResolvedValue({ type: 'success', data: { idToken: 'id-token' } });
    await act(async () => {
      await fireEvent.press(view.getByText('使用 Google 登录'));
    });
    expect(view.getByText('backend rejected token')).toBeTruthy();
    expect(router().replace).not.toHaveBeenCalled();
  });

});

// ------------------------------------------------------------ PrimaryTabs

describe('PrimaryTabs', () => {
  const tabProps = (overrides: Record<string, unknown> = {}) => ({
    state: {
      routes: [
        { key: 'k-index', name: 'index' },
        { key: 'k-banks', name: 'banks' },
        { key: 'k-settings', name: 'settings' },
      ],
      index: 0,
    },
    descriptors: {
      'k-index': { options: { title: '概览' } },
      'k-banks': { options: {} },
      'k-settings': { options: {} },
    },
    navigation: { navigate: jest.fn<any, any[]>(), emit: jest.fn<any, any[]>((event: unknown) => event) },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    ...overrides,
  });

  it('shows the upgrade promotion without pro and navigates on press', async () => {
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: false, sync: { running: false, pending: 0, failed: 0 } });
    const props = tabProps();
    const view = await render(<PrimaryTabs {...(props as any)} />);
    expect(view.getByText('FREE · 升级 PRO，解锁云端 AI 并移除广告')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByText('FREE · 升级 PRO，解锁云端 AI 并移除广告'));
    });
    expect(props.navigation.navigate).toHaveBeenCalledWith('settings');
  });

  it('renders tabs and navigates to a non-selected route', async () => {
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, sync: { running: false, pending: 0, failed: 0 } });
    const props = tabProps();
    const view = await render(<PrimaryTabs {...(props as any)} />);
    expect(view.getByText('概览')).toBeTruthy();
    expect(view.getByText('banks')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getAllByText('banks')[0]);
    });
    expect(props.navigation.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabPress', target: 'k-banks' }));
    expect(props.navigation.navigate).toHaveBeenCalledWith('banks', undefined);
  });

  it('does not re-navigate when the selected tab is pressed or the event is prevented', async () => {
    mockUseCloudAuth.mockReturnValue({ user: null, session: null, hasPro: true, sync: { running: false, pending: 0, failed: 0 } });
    const prevented = tabProps({
      navigation: { navigate: jest.fn<any, any[]>(), emit: jest.fn<any, any[]>(() => ({ defaultPrevented: true })) },
    });
    const view = await render(<PrimaryTabs {...(prevented as any)} />);
    await act(async () => {
      await fireEvent.press(view.getByText('概览'));
    });
    expect(prevented.navigation.navigate).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------- PrivacyPage

describe('PrivacyPage', () => {
  it('renders the policy text', async () => {
    const view = await render(<PrivacyPage />);
    expect(view.getByText('生效日期：2026 年 8 月 11 日')).toBeTruthy();
    expect(view.getByText('云端数据')).toBeTruthy();
    expect(view.getByText('凭证与网络')).toBeTruthy();
  });
});
