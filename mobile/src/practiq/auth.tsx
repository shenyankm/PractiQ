import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { currentSession, login, loginWithGoogle, logout, refreshStoredSession, register, type CloudSession } from '@/cloud';
import { ApiError, apiRequest, flushOutbox, setUnauthorizedHandler } from './api';
import { clearCloudCache, outboxCounts, retryFailedMutations } from './cache';
import { pullGlobalUpdates } from './sync';
import { cloudUserSchema, type CloudUser } from './types';
import {
  customerHasPro,
  identifyRevenueCat,
  listenForCustomerInfo,
  presentProPaywall,
  presentRevenueCatCustomerCenter,
  restoreRevenueCatPurchases,
} from './revenuecat';

type AuthState = {
  loading: boolean;
  session: CloudSession | null;
  user: CloudUser | null;
  hasPro: boolean;
  sync: { running: boolean; pending: number; failed: number };
  signIn: (name: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, code: string) => Promise<void>;
  signInWithGoogle: (idToken: string) => Promise<void>;
  updateProfile: (input: { username: string; email: string | null; currentPassword?: string; newPassword?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  synchronize: (retryFailed?: boolean) => Promise<void>;
  purchasePro: () => Promise<void>;
  restorePurchases: () => Promise<void>;
  manageSubscription: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function CloudAuthProvider({ children }: PropsWithChildren) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [expiredUsername, setExpiredUsername] = useState<string | null>(null);
  const [revenuecatPro, setRevenuecatPro] = useState(false);
  const [sync, setSync] = useState({ running: false, pending: 0, failed: 0 });
  const synchronizing = useRef(false);
  const sessionToken = session?.accessToken;
  const revenuecatAppUserID = user?.revenuecat_app_user_id;

  const refreshCounts = useCallback(async () => {
    const counts = await outboxCounts();
    setSync((current) => ({ ...current, ...counts }));
  }, []);

  const refreshUser = useCallback(async () => {
    if (!sessionToken) return null;
    const next = await apiRequest<CloudUser>('/api/v1/auth/me', {
      token: sessionToken,
      schema: cloudUserSchema,
    });
    setUser(next);
    return next;
  }, [sessionToken]);

  const refreshRevenueCat = useCallback(async () => {
    if (!revenuecatAppUserID) return null;
    const info = await identifyRevenueCat(revenuecatAppUserID);
    setRevenuecatPro(customerHasPro(info));
    return info;
  }, [revenuecatAppUserID]);

  const syncBilling = useCallback(async () => {
    if (!sessionToken || !revenuecatAppUserID) return;
    const result = await apiRequest<{ membership: 'free' | 'pro' }>('/api/v1/billing/sync', {
      method: 'POST',
      token: sessionToken,
    });
    setUser((current) => current?.revenuecat_app_user_id === revenuecatAppUserID
      ? { ...current, membership: result.membership }
      : current);
  }, [revenuecatAppUserID, sessionToken]);

  useEffect(() => setUnauthorizedHandler(() => {
    setExpiredUsername((current) => current || session?.username || null);
    setSession(null);
    setUser(null);
    setRevenuecatPro(false);
    setSync((current) => ({ ...current, running: false }));
  }), [session?.username]);

  const synchronize = useCallback(async (retryFailed = false) => {
    if (!session || synchronizing.current) return;
    synchronizing.current = true;
    setSync((current) => ({ ...current, running: true }));
    try {
      if (retryFailed) await retryFailedMutations();
      // 先推后拉:outbox 回放完再拉服务端增量,避免拉回自己刚写一半的状态
      await flushOutbox();
      const currentUser = await refreshUser().catch(() => null);
      if (currentUser?.id) await pullGlobalUpdates(currentUser.id);
      await refreshCounts();
    } finally {
      synchronizing.current = false;
      setSync((current) => ({ ...current, running: false }));
    }
  }, [refreshCounts, refreshUser, session]);

  useEffect(() => {
    let active = true;
    currentSession().then(async (saved) => {
      if (!active || !saved) return;
      setSession(saved);
      try {
        setUser(await apiRequest<CloudUser>('/api/v1/auth/me', { token: saved.accessToken, schema: cloudUserSchema }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          if (active) {
            setExpiredUsername(saved.username);
            setSession(null);
            setUser(null);
          }
        } else if (active) setUser(null);
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    void synchronize();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshStoredSession().then((next) => {
          if (next) setSession(next);
        }).catch(() => undefined);
        void refreshRevenueCat().then(syncBilling).catch(() => undefined);
        void synchronize();
      }
    });
    return () => subscription.remove();
  }, [refreshRevenueCat, session, syncBilling, synchronize]);

  useEffect(() => {
    if (!session) return;
    const delay = Math.max(0, Date.parse(session.expiresAt) - Date.now() - 60_000);
    if (delay > 2_147_483_647) return;
    const timer = setTimeout(() => {
      void refreshStoredSession(true).then((next) => {
        if (next) setSession(next);
      }).catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    if (!revenuecatAppUserID) return;
    let active = true;
    let removeListener: (() => boolean) | undefined;
    void refreshRevenueCat().then(() => {
      if (!active) return;
      removeListener = listenForCustomerInfo((info) => {
        if (active) setRevenuecatPro(customerHasPro(info));
      });
      void syncBilling().catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      active = false;
      removeListener?.();
    };
  }, [refreshRevenueCat, revenuecatAppUserID, syncBilling]);

  const authenticate = useCallback(async (action: () => Promise<CloudSession>) => {
    const next = await action();
    const nextUser = await apiRequest<CloudUser>('/api/v1/auth/me', { token: next.accessToken, schema: cloudUserSchema }).catch(async (error) => {
      if (error instanceof ApiError && error.status === 0) return null;
      await logout();
      throw error;
    });
    if (expiredUsername && next.username !== expiredUsername) await clearCloudCache();
    setExpiredUsername(null);
    setRevenuecatPro(false);
    setSession(next);
    setUser(nextUser);
  }, [expiredUsername]);

  const value = useMemo<AuthState>(() => ({
    loading,
    session,
    user,
    hasPro: revenuecatPro || user?.membership === 'pro',
    sync,
    signIn: (name, password) => authenticate(() => login(name, password)),
    signUp: (name, email, password, code) => authenticate(() => register(name, email, password, code)),
    signInWithGoogle: (idToken) => authenticate(() => loginWithGoogle(idToken)),
    updateProfile: async (input) => {
      setUser(await apiRequest<CloudUser>('/api/v1/users/me', { method: 'PATCH', body: input, schema: cloudUserSchema }));
    },
    signOut: async () => {
      await logout();
      await clearCloudCache();
      setSession(null);
      setUser(null);
      setRevenuecatPro(false);
      setSync({ running: false, pending: 0, failed: 0 });
    },
    synchronize,
    purchasePro: async () => {
      await refreshRevenueCat();
      const info = await presentProPaywall();
      setRevenuecatPro(customerHasPro(info));
      await syncBilling();
    },
    restorePurchases: async () => {
      await refreshRevenueCat();
      const info = await restoreRevenueCatPurchases();
      setRevenuecatPro(customerHasPro(info));
      await syncBilling();
    },
    manageSubscription: presentRevenueCatCustomerCenter,
  }), [
    authenticate, loading, refreshRevenueCat, revenuecatPro,
    session, sync, syncBilling, synchronize, user,
  ]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useCloudAuth() {
  const value = use(AuthContext);
  if (!value) throw new Error('CloudAuthProvider is missing');
  return value;
}
