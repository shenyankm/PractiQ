import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/src/lib/api';

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.me().then((data) => {
      if (cancelled) return;
      setUser((data as { user?: AuthUser | null } | AuthUser | null)?.user ?? (data as AuthUser | null) ?? null);
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
