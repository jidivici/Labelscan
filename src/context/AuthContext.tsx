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
  login as apiLogin,
  logout as apiLogout,
  restoreAuthentication,
} from '../services/auth';
import {
  captureActiveSession,
  clearSessionCredentials,
  invalidateActiveSessionWork,
  onUnauthenticated,
  onOperatorContextChanged,
  operatorContextKey,
} from '../services/authStorage';
import { businessProfileFor, type BusinessProfile } from '../services/businessProfiles';
import { queryClient } from '../services/queryClient';
import { clearLocalSessionData, purgeLegacyLocalData } from '../services/sessionData';
import type { OperatorContext } from '../services/authStorage';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: AuthStatus;
  /** The signed-in username, restored on cold start; null when signed out. */
  user: string | null;
  organizationId: string | null;
  actorId: string | null;
  /** Server-authoritative portal assignment; never selected by the mobile client. */
  businessPortalId: string | null;
  /** Server-authoritative current trade code. */
  tradeCode: string | null;
  /** Versioned V2 presentation contract for the current trade. */
  businessProfile: BusinessProfile;
  /** Throws on failure (e.g. bad credentials) — caller renders the error. */
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [actorId, setActorId] = useState<string | null>(null);
  const [businessPortalId, setBusinessPortalId] = useState<string | null>(null);
  const [tradeCode, setTradeCode] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);
  const statusRef = useRef<AuthStatus>('loading');
  const transitionSequenceRef = useRef(0);
  const transitionTailRef = useRef<Promise<void>>(Promise.resolve());

  const commitOperatorContext = useCallback((context: OperatorContext | null) => {
    scopeRef.current = context ? operatorContextKey(context) : null;
    setOrganizationId(context?.organizationId ?? null);
    setActorId(context?.actorId ?? null);
    setBusinessPortalId(context?.businessPortalId ?? null);
    setTradeCode(context?.tradeCode ?? null);
  }, []);

  const setCurrentStatus = useCallback((next: AuthStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const transitionOperatorContext = useCallback(
    (
      context: OperatorContext | null,
      finalStatus: AuthStatus,
      mode: 'clear' | 'preserve-owned' | 'already-cleared' = 'clear',
    ): Promise<void> => {
      const nextScope = context ? operatorContextKey(context) : null;
      const sameScope = nextScope != null && scopeRef.current === nextScope;

      const sequence = ++transitionSequenceRef.current;
      if (!sameScope) setCurrentStatus('loading');
      const run = transitionTailRef.current.then(async () => {
        try {
          // This global purge is itself serialized and each queue deletion goes
          // through its local write mutex, so no delayed write can resurrect data.
          if (!sameScope) {
            if (mode === 'preserve-owned') {
              await purgeLegacyLocalData({
                failClosed: true,
                ownerScopeKey: nextScope ?? undefined,
              });
            }
            else if (mode !== 'already-cleared') await clearLocalSessionData();
          }
          if (sequence !== transitionSequenceRef.current) return;
          if (finalStatus === 'signedIn') {
            const fence = await captureActiveSession();
            if (!fence || fence.scopeKey !== nextScope) {
              throw new Error('MOBILE_SESSION_CHANGED');
            }
          }
          if (sequence !== transitionSequenceRef.current) return;
          commitOperatorContext(context);
          setCurrentStatus(finalStatus);
        } catch (error) {
          // Cancel this transition and every newer transition already queued behind
          // it. None may commit over a failed purge.
          transitionSequenceRef.current += 1;
          invalidateActiveSessionWork();
          await Promise.allSettled([clearSessionCredentials()]);
          setUser(null);
          commitOperatorContext(null);
          setCurrentStatus('signedOut');
          throw error;
        }
      });
      transitionTailRef.current = run.catch(() => undefined);
      return run;
    },
    [commitOperatorContext, setCurrentStatus],
  );

  useEffect(() => {
    let mounted = true;

    // Validate the persisted refresh credential on every cold start. A stored
    // access token may already be expired or revoked, so it is never enough on
    // its own to enter the signed-in state.
    restoreAuthentication()
      .then((restored) => {
        if (!mounted) return;
        setUser(restored?.username ?? null);
        void transitionOperatorContext(
          restored,
          restored ? 'signedIn' : 'signedOut',
          restored ? 'preserve-owned' : 'clear',
        ).catch(() => undefined);
      })
      .catch(() => {
        if (!mounted) return;
        // SecureStore refused at least one deletion. Keep all authenticated UI
        // closed; the next explicit sign-in retries the purge before any network call.
        invalidateActiveSessionWork();
        setUser(null);
        commitOperatorContext(null);
        setCurrentStatus('signedOut');
      });

    // Session expired / token rejected mid-use → back to login.
    const unsubscribe = onUnauthenticated(() => {
      if (!mounted) return;
      setUser(null);
      queryClient.clear();
      void transitionOperatorContext(null, 'signedOut').catch(() => undefined);
    });
    const unsubscribeContext = onOperatorContextChanged((context) => {
      if (!mounted) return;
      // Login/cold-start explicitly commit their validated response below. This
      // listener is only for a server-driven scope change during token refresh.
      if (statusRef.current === 'signedIn' && context) {
        void transitionOperatorContext(context, 'signedIn').catch(
          () => undefined,
        );
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeContext();
    };
  }, [transitionOperatorContext]);

  const signIn = useCallback(async (username: string, password: string) => {
    // Fail closed over a previous logout/revocation cleanup: all native deletes
    // must complete before credentials for another identity can be requested.
    await clearSessionCredentials();
    // Purge the prior identity before the server can persist the new one. A process
    // kill anywhere after this point can never restore B over uncleared data from A.
    await clearLocalSessionData();
    const session = await apiLogin(username, password);
    setUser(session.username);
    await transitionOperatorContext(session, 'signedIn', 'already-cleared');
  }, [transitionOperatorContext]);

  const signOut = useCallback(async () => {
    setCurrentStatus('loading');
    invalidateActiveSessionWork();
    queryClient.clear();
    setUser(null);
    // Local queue/photo purge and credential deletion run immediately; remote token
    // revocation is best-effort and cannot delay the signed-out security boundary.
    const localPurge = transitionOperatorContext(null, 'signedOut');
    const remoteRevoke = apiLogout();
    const [localResult, credentialResult] = await Promise.allSettled([localPurge, remoteRevoke]);
    if (localResult.status === 'rejected') throw localResult.reason;
    // auth.logout swallows network revocation failures; its only rejection is a
    // failed local SecureStore purge and must remain a hard session-boundary error.
    if (credentialResult.status === 'rejected') throw credentialResult.reason;
  }, [setCurrentStatus, transitionOperatorContext]);

  const businessProfile = businessProfileFor(tradeCode);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        organizationId,
        actorId,
        businessPortalId,
        tradeCode,
        businessProfile,
        signIn,
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
