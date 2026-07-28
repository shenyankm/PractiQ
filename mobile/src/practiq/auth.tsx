import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { loadSession, login, logout, register, type CloudSession } from '@/cloud';
import { ApiError, apiRequest, flushOutbox, setUnauthorizedHandler } from './api';
import { clearCloudCache, outboxCounts, retryFailedMutations } from './cache';
import { cloudUserSchema, type CloudUser } from './types';

type AuthState = {
  loading: boolean;
  session: CloudSession | null;
  user: CloudUser | null;
  sync: { running: boolean; pending: number; failed: number };
  signIn: (name: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  updateProfile: (input: { username: string; email: string | null; currentPassword?: string; newPassword?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  synchronize: (retryFailed?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function CloudAuthProvider({ children }: PropsWithChildren) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [expiredUsername, setExpiredUsername] = useState<string | null>(null);
  const [sync, setSync] = useState({ running: false, pending: 0, failed: 0 });
  const synchronizing = useRef(false);

  const refreshCounts = useCallback(async () => {
    const counts = await outboxCounts();
    setSync((current) => ({ ...current, ...counts }));
  }, []);

  useEffect(() => setUnauthorizedHandler(() => {
    setExpiredUsername((current) => current || session?.username || null);
    setSession(null);
    setUser(null);
    setSync((current) => ({ ...current, running: false }));
  }), [session?.username]);

  const synchronize = useCallback(async (retryFailed = false) => {
    if (!session || synchronizing.current) return;
    synchronizing.current = true;
    setSync((current) => ({ ...current, running: true }));
    try {
      if (retryFailed) await retryFailedMutations();
      await flushOutbox();
      await refreshCounts();
    } finally {
      synchronizing.current = false;
      setSync((current) => ({ ...current, running: false }));
    }
  }, [refreshCounts, session]);

  useEffect(() => {
    let active = true;
    loadSession().then(async (saved) => {
      if (!active || !saved) return;
      setSession(saved);
      try {
        setUser(await apiRequest<CloudUser>('/api/v1/auth/me', { token: saved.token, schema: cloudUserSchema }));
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
      if (state === 'active') void synchronize();
    });
    return () => subscription.remove();
  }, [session, synchronize]);

  const authenticate = useCallback(async (action: () => Promise<CloudSession>) => {
    const next = await action();
    const nextUser = await apiRequest<CloudUser>('/api/v1/auth/me', { token: next.token, schema: cloudUserSchema }).catch(async (error) => {
      if (error instanceof ApiError && error.status === 0) return null;
      await logout();
      throw error;
    });
    if (expiredUsername && next.username !== expiredUsername) await clearCloudCache();
    setExpiredUsername(null);
    setSession(next);
    setUser(nextUser);
  }, [expiredUsername]);

  const value = useMemo<AuthState>(() => ({
    loading,
    session,
    user,
    sync,
    signIn: (name, password) => authenticate(() => login(name, password)),
    signUp: (name, email, password) => authenticate(() => register(name, email, password)),
    updateProfile: async (input) => {
      setUser(await apiRequest<CloudUser>('/api/v1/users/me', { method: 'PATCH', body: input, schema: cloudUserSchema }));
    },
    signOut: async () => {
      await logout();
      await clearCloudCache();
      setSession(null);
      setUser(null);
      setSync({ running: false, pending: 0, failed: 0 });
    },
    synchronize,
  }), [authenticate, loading, session, sync, synchronize, user]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useCloudAuth() {
  const value = use(AuthContext);
  if (!value) throw new Error('CloudAuthProvider is missing');
  return value;
}
