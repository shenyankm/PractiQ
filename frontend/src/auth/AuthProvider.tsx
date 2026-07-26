import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiRequest } from '@/lib/api';

export type AuthUser = {
  role: 'admin' | 'user';
};

const AuthContext = createContext<AuthUser | null | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>();

  useEffect(() => {
    let active = true;
    apiRequest<AuthUser | null>('/api/v1/auth/me').then(
      (currentUser) => {
        if (active) setUser(currentUser);
      },
      () => {
        if (active) setUser(null);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  return <AuthContext value={user}>{children}</AuthContext>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
