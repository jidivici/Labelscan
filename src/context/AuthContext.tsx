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
  useRef,
  useState,
} from 'react';

import {
  activateOperator,
  login as apiLogin,
  logout as apiLogout,
  restoreAuthentication,
} from '../services/auth';
import {
  onUnauthenticated,
  onOperatorContextChanged,
} from '../services/authStorage';
import { businessProfileFor, type BusinessProfile } from '../services/businessProfiles';
import { queryClient } from '../services/queryClient';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: AuthStatus;
  /** The signed-in username, restored on cold start; null when signed out. */
  user: string | null;
  /** Server-authoritative portal assignment; never selected by the mobile client. */
  businessPortalId: string | null;
  /** Server-authoritative current trade code. */
  tradeCode: string | null;
  /** Versioned V1 presentation contract for the current trade. */
  businessProfile: BusinessProfile;
  /** Throws on failure (e.g. bad credentials) — caller renders the error. */
  signIn: (username: string, password: string) => Promise<void>;
  /** Consume a one-use token, set the first password and sign the operator in. */
  activate: (token: string, newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<string | null>(null);
  const [businessPortalId, setBusinessPortalId] = useState<string | null>(null);
  const [tradeCode, setTradeCode] = useState<string | null>(null);
  const portalRef = useRef<string | null>(null);

  const applyOperatorContext = useCallback(
    (context: { businessPortalId: string; tradeCode: string } | null) => {
      const nextPortal = context?.businessPortalId ?? null;
      if (portalRef.current && nextPortal && portalRef.current !== nextPortal) {
        // Never render cached catalogue data from a previous portal on a shared device.
        queryClient.clear();
      }
      portalRef.current = nextPortal;
      setBusinessPortalId(nextPortal);
      setTradeCode(context?.tradeCode ?? null);
    },
    [],
  );

  useEffect(() => {
    let mounted = true;

    // Validate the persisted refresh credential on every cold start. A stored
    // access token may already be expired or revoked, so it is never enough on
    // its own to enter the signed-in state.
    restoreAuthentication().then((restored) => {
      if (!mounted) return;
      setStatus(restored ? 'signedIn' : 'signedOut');
      setUser(restored?.username ?? null);
      applyOperatorContext(restored);
    });

    // Session expired / token rejected mid-use → back to login.
    const unsubscribe = onUnauthenticated(() => {
      if (!mounted) return;
      setStatus('signedOut');
      setUser(null);
      applyOperatorContext(null);
      queryClient.clear();
    });
    const unsubscribeContext = onOperatorContextChanged((context) => {
      if (!mounted) return;
      applyOperatorContext(context);
    });

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeContext();
    };
  }, [applyOperatorContext]);

  const signIn = useCallback(async (username: string, password: string) => {
    const session = await apiLogin(username, password);
    setUser(session.username);
    applyOperatorContext(session);
    setStatus('signedIn');
  }, [applyOperatorContext]);

  const activate = useCallback(async (token: string, newPassword: string) => {
    const session = await activateOperator(token, newPassword);
    setUser(session.username);
    applyOperatorContext(session);
    setStatus('signedIn');
  }, [applyOperatorContext]);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      queryClient.clear();
      setUser(null);
      applyOperatorContext(null);
      setStatus('signedOut');
    }
  }, [applyOperatorContext]);

  const businessProfile = businessProfileFor(tradeCode);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        businessPortalId,
        tradeCode,
        businessProfile,
        signIn,
        activate,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
