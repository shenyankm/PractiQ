import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiRequest } from '@/lib/api';

export type AuthUser = {
  username: string;
  membership: 'free' | 'plus' | 'enterprise';
  role: 'admin' | 'user';
  avatarUrl: string | null;
  avatarOptimized: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false
});
type AuthMeResponse = { user?: AuthUser | null } | AuthUser | null;

function normalizeAuthUser(data: AuthMeResponse): AuthUser | null {
  if (!data) return null;
  if (Object.prototype.hasOwnProperty.call(data, 'user')) {
    return (data as { user?: AuthUser | null }).user ?? null;
  }
  return data as AuthUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/v1/auth/me').then((data) => {
      if (cancelled) return;
      setUser(normalizeAuthUser(data as AuthMeResponse));
      setIsLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setUser(null);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ user, isLoading, isAuthenticated: Boolean(user) }), [user, isLoading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
