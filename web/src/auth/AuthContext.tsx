import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  browserLogin,
  browserLogout,
  getAccessOverview,
  refreshBrowserSessionPayload,
} from '../api';
import type { Session } from '../types';
import { applyAccessOverview, hasCapability, sessionFromAuthPayload } from './capabilities';
import { CAPABILITIES } from '../types';

interface AuthContextValue {
  session: Session | null;
  restoring: boolean;
  login: (organizationSlug: string, username: string, password: string) => Promise<Session>;
  refreshAccess: () => Promise<Session | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  initialSession?: Session | null;
}

export function AuthProvider({ children, initialSession }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(initialSession ?? null);
  const [restoring, setRestoring] = useState(initialSession === undefined);

  useEffect(() => {
    if (initialSession !== undefined) return;
    let active = true;
    refreshBrowserSessionPayload()
      .then(async (payload) => {
        if (!payload) return null;
        const bearerSession = sessionFromAuthPayload(payload);
        const overview = await getAccessOverview(bearerSession);
        return applyAccessOverview(bearerSession, overview);
      })
      .then((restored) => {
        if (active) setSession(restored && hasCapability(restored, CAPABILITIES.WEB_ACCESS) ? restored : null);
      })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, [initialSession]);

  const login = useCallback(async (organizationSlug: string, username: string, password: string) => {
    const bearerSession = sessionFromAuthPayload(await browserLogin(organizationSlug, username, password));
    let next: Session;
    try {
      next = applyAccessOverview(bearerSession, await getAccessOverview(bearerSession));
    } catch (cause) {
      await browserLogout().catch(() => undefined);
      throw cause;
    }
    if (!hasCapability(next, CAPABILITIES.WEB_ACCESS)) {
      await browserLogout().catch(() => undefined);
      throw new Error('Ce compte ne dispose pas d’un accès au portail web.');
    }
    setSession(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    try {
      await browserLogout();
    } finally {
      setSession(null);
    }
  }, []);

  const refreshAccess = useCallback(async () => {
    if (!session) return null;
    const next = applyAccessOverview(session, await getAccessOverview(session));
    setSession(next);
    return next;
  }, [session]);

  const value = useMemo(
    () => ({ session, restoring, login, refreshAccess, logout }),
    [login, logout, refreshAccess, restoring, session],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
