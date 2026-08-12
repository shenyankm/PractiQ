// CloudAuthProvider tests: mocks the cloud/api/cache/sync/revenuecat modules
// and drives sign-in flows, session restore, billing and sync through the
// context exposed to a probe component.
import { act, render, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import type { AppStateStatus } from 'react-native';

const mockLoadSession = jest.fn<any, any[]>(async () => null);
const mockCurrentSession = jest.fn<any, any[]>(async () => null);
const mockRefreshStoredSession = jest.fn<any, any[]>(async () => null);
const mockLogin = jest.fn<any, any[]>();
const mockLoginWithGoogle = jest.fn<any, any[]>();
const mockLogout = jest.fn<any, any[]>();
const mockRegister = jest.fn<any, any[]>();
const mockApiRequest = jest.fn<any, any[]>();
const mockFlushOutbox = jest.fn<any, any[]>();
const mockSetUnauthorizedHandler = jest.fn<any, any[]>();
const mockClearCloudCache = jest.fn<any, any[]>();
const mockOutboxCounts = jest.fn<any, any[]>(async () => ({ pending: 0, failed: 0 }));
const mockRetryFailedMutations = jest.fn<any, any[]>();
const mockPullGlobalUpdates = jest.fn<any, any[]>();
const mockCustomerHasPro = jest.fn<any, any[]>(() => false);
const mockIdentifyRevenueCat = jest.fn<any, any[]>(async () => ({ entitlements: { active: {} } }));
const mockListenForCustomerInfo = jest.fn<any, any[]>(() => () => false);
const mockPresentProPaywall = jest.fn<any, any[]>(async () => ({ entitlements: { active: {} } }));
const mockPresentCustomerCenter = jest.fn<any, any[]>(async () => undefined);
const mockRestoreRevenueCatPurchases = jest.fn<any, any[]>(async () => ({ entitlements: { active: {} } }));

jest.mock('./cloud', () => ({
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  currentSession: (...args: unknown[]) => mockCurrentSession(...args),
  refreshStoredSession: (...args: unknown[]) => mockRefreshStoredSession(...args),
  login: (...args: unknown[]) => mockLogin(...args),
  loginWithGoogle: (...args: unknown[]) => mockLoginWithGoogle(...args),
  logout: (...args: unknown[]) => mockLogout(...args),
  register: (...args: unknown[]) => mockRegister(...args),
  CLOUD_API_URL: 'http://cloud.test',
}));
jest.mock('./practiq/api', () => ({
  ApiError: class extends Error {
    code = '';
    status = 0;
    constructor(message = '', code = '', status = 0) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  flushOutbox: (...args: unknown[]) => mockFlushOutbox(...args),
  setUnauthorizedHandler: (...args: unknown[]) => mockSetUnauthorizedHandler(...args),
}));
jest.mock('./practiq/cache', () => ({
  clearCloudCache: (...args: unknown[]) => mockClearCloudCache(...args),
  outboxCounts: (...args: unknown[]) => mockOutboxCounts(...args),
  retryFailedMutations: (...args: unknown[]) => mockRetryFailedMutations(...args),
}));
jest.mock('./practiq/sync', () => ({
  pullGlobalUpdates: (...args: unknown[]) => mockPullGlobalUpdates(...args),
}));
jest.mock('./practiq/revenuecat', () => ({
  customerHasPro: (...args: unknown[]) => mockCustomerHasPro(...args),
  identifyRevenueCat: (...args: unknown[]) => mockIdentifyRevenueCat(...args),
  listenForCustomerInfo: (...args: unknown[]) => mockListenForCustomerInfo(...args),
  presentProPaywall: (...args: unknown[]) => mockPresentProPaywall(...args),
  presentRevenueCatCustomerCenter: (...args: unknown[]) => mockPresentCustomerCenter(...args),
  restoreRevenueCatPurchases: (...args: unknown[]) => mockRestoreRevenueCatPurchases(...args),
}));

import { CloudAuthProvider, useCloudAuth } from './practiq/auth';

const userData = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  username: 'alice',
  email: 'a@b.c',
  membership: 'free',
  revenuecat_app_user_id: 'rc-1',
  ...overrides,
});

const session = (accessToken = 'tok', username = 'alice') => ({
  accessToken,
  refreshToken: 'refresh-token',
  username,
  expiresAt: '2030-01-01T00:00:00Z',
  refreshExpiresAt: '2030-02-01T00:00:00Z',
});

// probeRef lets tests drive the provider context after render.
const probeRef: { current: ReturnType<typeof useCloudAuth> | null } = { current: null };

function AuthProbeProbe({ children }: { children: React.ReactNode }) {
  probeRef.current = useCloudAuth();
  return <>{children}</>;
}

function AuthProbe() {
  const auth = useCloudAuth();
  const sessionLabel = auth.loading ? 'loading' : auth.session ? `session:${auth.user?.username ?? 'no-user'}` : 'signed-out';
  const proLabel = auth.hasPro ? ':pro' : '';
  return <Text>{`${sessionLabel}${proLabel}`}</Text>;
}

async function renderProvider() {
  return await render(
    <CloudAuthProvider>
      <AuthProbeProbe>
        <AuthProbe />
      </AuthProbeProbe>
    </CloudAuthProvider>,
  );
}

function defaultApiRequest(path: string) {
  if (path === '/api/v1/auth/me') return Promise.resolve(userData());
  if (path === '/api/v1/billing/sync') return Promise.resolve({ membership: 'free' });
  if (path === '/api/v1/users/me') return Promise.resolve(userData({ username: 'bob' }));
  return Promise.reject(new Error(`unexpected request: ${path}`));
}

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type: string, _handler: (state: AppStateStatus) => void) => ({
    remove: jest.fn<any, any[]>(),
  }));
  mockLoadSession.mockResolvedValue(null);
  mockCurrentSession.mockResolvedValue(null);
  mockLogin.mockResolvedValue(session());
  mockLoginWithGoogle.mockResolvedValue(session());
  mockLogout.mockReset();
  mockRegister.mockResolvedValue(session('tok', 'bob'));
  mockApiRequest.mockImplementation(defaultApiRequest);
  mockFlushOutbox.mockReset();
  mockSetUnauthorizedHandler.mockReset();
  mockClearCloudCache.mockReset();
  mockOutboxCounts.mockResolvedValue({ pending: 0, failed: 0 });
  mockRetryFailedMutations.mockReset();
  mockPullGlobalUpdates.mockReset();
  mockCustomerHasPro.mockReturnValue(false);
  mockIdentifyRevenueCat.mockResolvedValue({ entitlements: { active: {} } });
  mockPresentProPaywall.mockResolvedValue({ entitlements: { active: {} } });
  mockRestoreRevenueCatPurchases.mockResolvedValue({ entitlements: { active: {} } });
  probeRef.current = null;
});

describe('CloudAuthProvider', () => {
  it('starts signed out when no session is stored', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    expect(mockCurrentSession).toHaveBeenCalled();
    expect(mockFlushOutbox).not.toHaveBeenCalled();
  });

  it('restores a valid session, refreshes the user and syncs on mount', async () => {
    mockCurrentSession.mockResolvedValue(session());
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('session:alice')).toBeTruthy());
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/auth/me', expect.objectContaining({ token: 'tok' }));
    await waitFor(() => expect(mockFlushOutbox).toHaveBeenCalled());
    expect(mockPullGlobalUpdates).toHaveBeenCalledWith(1);
    expect(mockOutboxCounts).toHaveBeenCalled();
  });

  it('clears an expired session on a 401', async () => {
    mockCurrentSession.mockResolvedValue(session('old'));
    mockApiRequest.mockRejectedValue(new (jest.requireMock('./practiq/api').ApiError)('expired', '', 401));
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
  });

  it('keeps the session but drops the user when the fetch fails without a 401', async () => {
    mockCurrentSession.mockResolvedValue(session('old'));
    mockApiRequest.mockRejectedValue(new Error('network'));
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('session:no-user')).toBeTruthy());
  });

  it('signs in, signs up with Google and signs out', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    await act(async () => {
      await ctx.signIn('alice', 'password');
    });
    expect(mockLogin).toHaveBeenCalledWith('alice', 'password');
    expect(view.getByText('session:alice')).toBeTruthy();

    mockLoginWithGoogle.mockClear();
    await act(async () => {
      await ctx.signInWithGoogle('id-token');
    });
    expect(mockLoginWithGoogle).toHaveBeenCalledWith('id-token');

    await act(async () => {
      await ctx.signOut();
    });
    expect(mockLogout).toHaveBeenCalled();
    expect(mockClearCloudCache).toHaveBeenCalled();
    expect(view.getByText('signed-out')).toBeTruthy();
  });

  it('registers and updates the profile', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    mockApiRequest.mockImplementation((path: string) => {
      if (path === '/api/v1/auth/me') return Promise.resolve(userData({ username: 'bob' }));
      if (path === '/api/v1/billing/sync') return Promise.resolve({ membership: 'free' });
      return Promise.resolve(null);
    });
    await act(async () => {
      await ctx.signUp('bob', 'b@c.d', 'password', '123456');
    });
    expect(mockRegister).toHaveBeenCalledWith('bob', 'b@c.d', 'password', '123456');
    expect(view.getByText('session:bob')).toBeTruthy();

    await act(async () => {
      await ctx.updateProfile({ username: 'bob', email: null });
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/v1/users/me', expect.objectContaining({
      method: 'PATCH',
      body: { username: 'bob', email: null },
    }));
  });

  it('synchronizes with retry when requested', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    await act(async () => {
      await ctx.signIn('alice', 'password');
    });
    await waitFor(() => expect(mockPullGlobalUpdates).toHaveBeenCalled()); // mount sync finished
    const latest = probeRef.current!; // re-read after sign-in: the earlier ctx predates the session
    mockRetryFailedMutations.mockClear();
    mockFlushOutbox.mockClear();
    mockPullGlobalUpdates.mockClear();
    await act(async () => {
      await latest.synchronize(true);
    });
    expect(mockRetryFailedMutations).toHaveBeenCalled();
    expect(mockFlushOutbox).toHaveBeenCalled();
    expect(mockPullGlobalUpdates).toHaveBeenCalledWith(1);
  });

  it('purchases, restores and manages the subscription', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    await act(async () => {
      await ctx.signIn('alice', 'password');
    });
    mockCustomerHasPro.mockReturnValue(true);
    await act(async () => {
      await ctx.purchasePro();
    });
    expect(mockPresentProPaywall).toHaveBeenCalled();
    await waitFor(() => expect(view.getByText('session:alice:pro')).toBeTruthy());

    await act(async () => {
      await ctx.restorePurchases();
    });
    expect(mockRestoreRevenueCatPurchases).toHaveBeenCalled();

    await act(async () => {
      await ctx.manageSubscription();
    });
    expect(mockPresentCustomerCenter).toHaveBeenCalled();
  });

  it('exposes pro from the server membership and reacts to app foregrounding', async () => {
    const handlerSpy = jest.spyOn(AppState, 'addEventListener');
    let appStateHandler: ((state: AppStateStatus) => void) | null = null;
    handlerSpy.mockImplementation((_type: string, handler: (state: AppStateStatus) => void) => {
      appStateHandler = handler;
      return { remove: jest.fn<any, any[]>() } as unknown as { remove: () => void };
    });
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    mockApiRequest.mockImplementation((path: string) => {
      if (path === '/api/v1/auth/me') return Promise.resolve(userData({ membership: 'pro' }));
      if (path === '/api/v1/billing/sync') return Promise.resolve({ membership: 'pro' });
      return Promise.resolve(null);
    });
    await act(async () => {
      await ctx.signIn('alice', 'password');
    });
    await waitFor(() => expect(view.getByText('session:alice:pro')).toBeTruthy());
    mockFlushOutbox.mockClear();
    await act(async () => {
      appStateHandler?.('active');
    });
    expect(mockFlushOutbox).toHaveBeenCalled(); // foreground sync
    handlerSpy.mockRestore();
  });

  it('rejects failed sign-ins and the unauthorized handler clears state', async () => {
    const view = await renderProvider();
    await waitFor(() => expect(view.getByText('signed-out')).toBeTruthy());
    const ctx = probeRef.current!;

    mockLogin.mockRejectedValue(new Error('bad credentials'));
    await expect(ctx.signIn('alice', 'password')).rejects.toThrow('bad credentials');

    mockLogin.mockResolvedValue(session());
    await act(async () => {
      await ctx.signIn('alice', 'password');
    });
    expect(view.getByText('session:alice')).toBeTruthy();
    const unauthorized = mockSetUnauthorizedHandler.mock.calls[0][0] as () => void;
    await act(async () => {
      unauthorized();
    });
    expect(view.getByText('signed-out')).toBeTruthy();
  });
});
