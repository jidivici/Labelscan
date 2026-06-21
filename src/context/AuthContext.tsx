/**
 * AuthContext — app-wide authentication state.
 *
 * On mount it resolves the persisted token into a status; it also subscribes to
 * the API client's "unauthenticated" event so an expired/invalid session (a 401
 * on an authenticated request) drops the app back to the login screen.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { login as apiLogin, logout as apiLogout } from '../services/auth';
import { getToken, getUsername, onUnauthenticated } from '../services/authStorage';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: AuthStatus;
  /** The signed-in username, restored on cold start; null when signed out. */
  user: string | null;
  /** Throws on failure (e.g. bad credentials) — caller renders the error. */
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    // Restore session (token + username) from storage on cold start.
    Promise.all([getToken(), getUsername()]).then(([token, username]) => {
      if (!mounted) return;
      setStatus(token ? 'signedIn' : 'signedOut');
      setUser(token ? username : null);
    });

    // Session expired / token rejected mid-use → back to login.
    const unsubscribe = onUnauthenticated(() => {
      if (!mounted) return;
      setStatus('signedOut');
      setUser(null);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    await apiLogin(username, password); // throws on failure (persists username too)
    setUser(username);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('signedOut');
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
