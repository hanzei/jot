import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { User, UserSettings } from '@jot/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  auth,
  getStoredSession,
  clearStoredSession,
  setOnUnauthorized,
  getStoredServerUrl,
  restoreServerUrl,
  cacheAuthProfile,
  getCachedAuthProfile,
  clearCachedProfile,
  initializeServerContext,
  getActiveServerId,
} from '../api/client';
import { isTransientHttpStatus } from '../db/syncQueue';
import { runOidcBrowserFlow, SsoFlowError } from './oidcFlow';
import { getLocalIdentity, enableLocalMode as persistEnableLocalMode, disableLocalMode, setLocalModeActive, updateLocalSettings, updateLocalUser } from './localMode';

/**
 * Why the session ended, for the login screen to explain (issue #853). The
 * server does not distinguish causes on a 401 (password change vs. revoked
 * session), so there is only one reason today; the type stays a union rather
 * than a boolean so a future distinguishable cause has somewhere to go.
 */
export type SessionEndedReason = 'unauthorized';

interface AuthState {
  user: User | null;
  /**
   * The server `user` was signed in to, or null in local mode or when signed
   * out. Right after a server switch `user` can still be the previous server's
   * account until revalidation replaces it; this tells consumers which server
   * it belongs to (issue #1264: the local-data owner check must not compare a
   * user against another server's database).
   */
  userServerId: string | null;
  settings: UserSettings | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * True when the app is running in serverless "local mode" (epic #511): the
   * user is signed in with an on-device identity and no server session exists.
   * Consumers use this to gate inherently multi-user / server-backed UI.
   */
  isLocalMode: boolean;
  /**
   * True when `revalidateSession` received a permanent non-401 HTTP error
   * (e.g. 403, 422) from the server. Network errors and 5xx/timeout are
   * transient and do not set this flag. Cleared on successful revalidation or
   * on logout/clearAuth.
   */
  revalidationFailed: boolean;
  /**
   * Set when `clearAuth` runs as a result of a 401 (a revoked session or a
   * password change elsewhere) rather than a user-initiated logout or leaving
   * local mode. `LoginScreen` surfaces it as a dismissible line; it never
   * persists to storage, so it cannot reappear on a later launch.
   */
  sessionEndedReason: SessionEndedReason | null;
  clearSessionEndedReason: () => void;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  /**
   * Sign in through the server's SSO provider.
   * Resolves `'cancelled'` when the user closed the browser sheet — a quiet
   * return, not an error. Rejects with `SsoFlowError` for a callback-reported
   * failure, or with the request error when the code exchange fails; neither
   * touches an existing stored session.
   */
  loginWithSso: () => Promise<'signedIn' | 'cancelled'>;
  /** Enter serverless local mode, provisioning a persistent on-device identity. */
  enableLocalMode: () => Promise<void>;
  /**
   * Called after the local→server upgrade drain succeeds and `flipToServerMode`
   * has already disabled local mode on disk + in the sync flag. Fetches the real
   * server profile, updates React auth state (user, settings, isLocalMode=false),
   * and caches the profile. If the profile fetch fails the React state still
   * transitions out of local mode so the app is not left in an inconsistent state.
   */
  completeServerUpgrade: () => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Ends the session on this device only: forgets the stored session and the
   * cached profile, then clears auth, with no `POST /logout`. For a session the
   * server has already ended itself, as when the account was deleted (#1317).
   * The server stays in the server list, so the login screen is that server's.
   */
  endSessionLocally: () => Promise<void>;
  clearAuth: (reason?: SessionEndedReason) => void;
  revalidateSession: () => Promise<boolean>;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  setSettings: (settings: UserSettings) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function getHttpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

function isUnauthorizedError(error: unknown): boolean {
  return getHttpStatus(error) === 401;
}

function isHttpResponseError(error: unknown): boolean {
  return typeof getHttpStatus(error) === 'number';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userServerId, setUserServerId] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [revalidationFailed, setRevalidationFailed] = useState(false);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [sessionEndedReason, setSessionEndedReason] = useState<SessionEndedReason | null>(null);
  const queryClient = useQueryClient();

  // Every place that sets `user` from a server answer (or that server's cached
  // profile) goes through here, so `userServerId` always names its server.
  // `serverId` is the active server captured *before* the request or cache
  // read: a server switch can land while it is in flight, and tagging the old
  // server's answer with the new server would let AccountDataGate treat that
  // user as a stranger to the new server's database and wipe it (#1264). A
  // stale tag only makes the gate stand aside, which is the safe direction.
  const applyServerProfile = useCallback((nextUser: User, nextSettings: UserSettings, serverId: string | null) => {
    setUser(nextUser);
    setSettings(nextSettings);
    setUserServerId(serverId);
  }, []);

  // The `setUser` consumers get: profile edits of the signed-in user only. A
  // different account (a save response or rollback that outlived a server
  // switch) would keep the current `userServerId` and be judged against the
  // wrong database by AccountDataGate (#1264), and signing in or out has its
  // own paths. Either way the update is dropped.
  const setProfileUser = useCallback<React.Dispatch<React.SetStateAction<User | null>>>((action) => {
    setUser((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      return prev && next && next.id === prev.id ? next : prev;
    });
  }, []);

  const clearAuth = useCallback((reason?: SessionEndedReason) => {
    setUser(null);
    setUserServerId(null);
    setSettings(null);
    setRevalidationFailed(false);
    setIsLocalMode(false);
    setSessionEndedReason(reason ?? null);
    queryClient.clear();
  }, [queryClient]);

  const clearSessionEndedReason = useCallback(() => {
    setSessionEndedReason(null);
  }, []);

  useEffect(() => {
    // The 401 funnel (API responses + SSE) always means the server rejected an
    // existing session, so this is the one clearAuth call site that always
    // carries a reason — ordinary logout and leaving local mode call clearAuth()
    // directly, with none.
    setOnUnauthorized(() => clearAuth('unauthorized'));
    return () => {
      setOnUnauthorized(null);
    };
  }, [clearAuth]);

  // Mirror the local-mode flag into a synchronous module-global so the non-React
  // sync machinery (queue enqueue/drain, SSE, write hooks) can short-circuit on it
  // without an async SecureStore read (epic #511, issue #514).
  useEffect(() => {
    setLocalModeActive(isLocalMode);
  }, [isLocalMode]);

  // Persist settings changes to the local identity when in local mode so they
  // survive app restarts (issue #516).
  useEffect(() => {
    if (!isLocalMode || !settings) return;
    void updateLocalSettings(settings);
  }, [isLocalMode, settings]);

  // Persist profile changes to the local identity when in local mode so they
  // survive app restarts. Unlike server mode, there is no `PATCH /users/me` to
  // round-trip through, so the on-device record is the source of truth (epic #511).
  useEffect(() => {
    if (!isLocalMode || !user) return;
    void updateLocalUser(user);
  }, [isLocalMode, user]);

  useEffect(() => {
    let cancelled = false;

    // Tracks the cached-profile read across the try/catch below so the
    // network-error fallback can reuse it instead of reading it twice.
    // `undefined` means the read was never attempted (e.g. an earlier step
    // failed first).
    let cachedProfile: Awaited<ReturnType<typeof getCachedAuthProfile>> | undefined;
    // The server this restore runs against, for applyServerProfile.
    let restoreServerId: string | null = null;

    async function restoreSession() {
      try {
        // Local mode is a first-class persistent state: when enabled, sign in
        // with the on-device identity and skip server context / session restore
        // entirely (no `GET /users/me`).
        const localIdentity = await getLocalIdentity();
        if (localIdentity) {
          if (!cancelled) {
            setUser(localIdentity.user);
            setSettings(localIdentity.settings);
            setUserServerId(null);
            setIsLocalMode(true);
          }
          return;
        }

        await initializeServerContext();
        restoreServerId = getActiveServerId();
        const storedUrl = await getStoredServerUrl();
        if (storedUrl) restoreServerUrl(storedUrl);
        const token = await getStoredSession();
        if (!token) {
          return;
        }

        // Start revalidation and the cache read together so the cache read
        // doesn't delay auth.me() from firing. The cached profile (if any)
        // renders the dashboard immediately without waiting for auth.me() to
        // resolve; auth.me() still corrects state once it resolves, the same
        // stale-while-revalidate pattern revalidateSession() uses on later
        // app foregrounds.
        const mePromise = auth.me();
        cachedProfile = await getCachedAuthProfile(restoreServerId ?? undefined);
        if (cachedProfile?.user && cachedProfile?.settings && !cancelled) {
          applyServerProfile(cachedProfile.user, cachedProfile.settings, restoreServerId);
          setIsLoading(false);
        }

        const response = await mePromise;
        if (!cancelled) {
          applyServerProfile(response.user, response.settings, restoreServerId);
          await cacheAuthProfile(response, restoreServerId ?? undefined);
        }
      } catch (error) {
        if (isUnauthorizedError(error)) {
          await clearStoredSession();
          await clearCachedProfile();
          clearAuth('unauthorized');
        } else {
          // Any non-401 failure: transient (network, timeout, 5xx, 429) or a
          // permanent-but-reachable error (e.g. 403, 422). Mirror
          // revalidateSession's stale-while-revalidate policy instead of logging
          // the user out — fall back to the cached profile and stay authenticated
          // when we have one. A server hiccup on launch must not force a re-login
          // and discard a valid cached session (issue: cold-start forced logout).
          const cached = cachedProfile !== undefined ? cachedProfile : await getCachedAuthProfile(restoreServerId ?? undefined);
          if (cached?.user && cached?.settings && !cancelled) {
            applyServerProfile(cached.user, cached.settings, restoreServerId);
            // Surface the revalidation warning only for permanent non-401 HTTP
            // errors, exactly as revalidateSession does. Transient errors stay
            // silent so a brief outage doesn't nag the user.
            if (isHttpResponseError(error) && !isTransientHttpStatus(getHttpStatus(error))) {
              setRevalidationFailed(true);
            }
          } else if (isHttpResponseError(error) && !isTransientHttpStatus(getHttpStatus(error))) {
            // No cached profile to render and the server actively rejected us
            // with a permanent (non-401, non-transient) error. We cannot show an
            // authenticated UI without a profile, so drop to the login screen.
            // The stored session is left intact so a later launch can retry
            // (only a 401 clears it).
            clearAuth();
          }
          // No cached profile + transient error (network, timeout, 5xx, 429):
          // leave unauthenticated for now (nothing to render), but keep the
          // stored session and skip the extra clearAuth()/queryClient.clear()
          // churn since a retry on the next launch may just work.
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, [clearAuth, applyServerProfile]);

  const login = useCallback(async (username: string, password: string) => {
    const serverId = getActiveServerId();
    const response = await auth.login({ username, password });
    applyServerProfile(response.user, response.settings, serverId);
    setSessionEndedReason(null);
    await cacheAuthProfile(response, serverId ?? undefined);
  }, [applyServerProfile]);

  const register = useCallback(async (username: string, password: string) => {
    const serverId = getActiveServerId();
    const response = await auth.register({ username, password });
    applyServerProfile(response.user, response.settings, serverId);
    setSessionEndedReason(null);
    await cacheAuthProfile(response, serverId ?? undefined);
  }, [applyServerProfile]);

  const loginWithSso = useCallback(async (): Promise<'signedIn' | 'cancelled'> => {
    const outcome = await runOidcBrowserFlow('login');
    if (outcome.type === 'cancelled') {
      return 'cancelled';
    }
    if (outcome.type === 'error') {
      throw new SsoFlowError(outcome.messageKey);
    }
    // The exchange stores the session and caches the profile under the server
    // it ran against, and rejects if the active server changed meanwhile.
    const serverId = getActiveServerId();
    const response = await auth.oidcNativeExchange(outcome.code, outcome.codeVerifier);
    applyServerProfile(response.user, response.settings, serverId);
    setSessionEndedReason(null);
    return 'signedIn';
  }, [applyServerProfile]);

  const enableLocalMode = useCallback(async () => {
    const identity = await persistEnableLocalMode();
    setUser(identity.user);
    setSettings(identity.settings);
    setUserServerId(null);
    setIsLocalMode(true);
  }, []);

  const completeServerUpgrade = useCallback(async () => {
    try {
      const serverId = getActiveServerId();
      const response = await auth.me();
      applyServerProfile(response.user, response.settings, serverId);
      await cacheAuthProfile(response, serverId ?? undefined);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        // Invalid session — clear auth state so the user lands on the login screen.
        clearAuth('unauthorized');
        throw err;
      }
      // Transient error — keep existing user/settings as a temporary
      // placeholder; the next revalidateSession or app restart will correct them.
    } finally {
      setIsLocalMode(false);
    }
  }, [clearAuth, applyServerProfile]);

  const logout = useCallback(async () => {
    // In local mode there is no server session to invalidate; leaving local mode
    // drops the persisted identity and returns the user to the login/setup flow.
    if (isLocalMode) {
      try {
        await disableLocalMode();
      } finally {
        clearAuth();
      }
      return;
    }
    try {
      await auth.logout();
    } finally {
      clearAuth();
    }
  }, [clearAuth, isLocalMode]);

  const endSessionLocally = useCallback(async () => {
    // Best-effort storage cleanup, as on a 401; auth clears regardless. The
    // stored session goes first, so a 401 that arrives later (a request that
    // was in flight) finds no session and does not flag the sign-out as
    // "session ended" (handleUnauthorizedSession).
    await Promise.allSettled([clearStoredSession(), clearCachedProfile()]);
    clearAuth();
  }, [clearAuth]);

  const revalidateSession = useCallback(async (): Promise<boolean> => {
    // No server to revalidate against in local mode; the local identity is
    // always valid.
    if (isLocalMode) {
      return true;
    }
    // Nothing to revalidate when signed out: without this, a cold start or
    // foreground with no stored session still issues an authenticated GET
    // /me, which 401s and manufactures a spurious "you were signed out"
    // banner (issue #962). getStoredSession() is memoised, so this costs
    // nothing on the hot path where a session does exist.
    const serverId = getActiveServerId();
    const token = await getStoredSession();
    if (!token) {
      return false;
    }
    try {
      const response = await auth.me();
      applyServerProfile(response.user, response.settings, serverId);
      await cacheAuthProfile(response, serverId ?? undefined);
      setRevalidationFailed(false);
      return true;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        await clearStoredSession();
        await clearCachedProfile();
        clearAuth('unauthorized');
        return false;
      }
      // Permanent non-401 error (e.g. 403, 422): the server is reachable but
      // rejecting the session for a non-auth reason. Stay authenticated (local
      // data is still usable) but surface a warning so the user isn't silently
      // left in a broken state. Network errors, timeouts, and 5xx are transient
      // and do not trigger the warning.
      if (!isTransientHttpStatus(getHttpStatus(error))) {
        setRevalidationFailed(true);
      }
      // auth.me() failed without handing us a fresh profile. This matters most
      // right after a server switch: client.ts's activeServerId already points
      // at the newly-selected server at this point, but React's `user` state
      // still holds whatever the previously-active server left behind, so the
      // drawer would show the old server's name/avatar under the new server's
      // context. Fall back to the newly-active server's own cached profile,
      // mirroring restoreSession()'s stale-while-revalidate fallback, so state
      // matches the server that's actually active even when offline.
      const cached = await getCachedAuthProfile(serverId ?? undefined);
      // A switch while auth.me() was in flight: this answer is for a server
      // that is no longer active, and the switch's own revalidation sets the user.
      if (cached?.user && cached?.settings && getActiveServerId() === serverId) {
        applyServerProfile(cached.user, cached.settings, serverId);
      }
      return true;
    }
  }, [clearAuth, isLocalMode, applyServerProfile]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      userServerId,
      settings,
      isAuthenticated: user !== null,
      isLoading,
      isLocalMode,
      revalidationFailed,
      sessionEndedReason,
      clearSessionEndedReason,
      login,
      register,
      loginWithSso,
      enableLocalMode,
      completeServerUpgrade,
      logout,
      endSessionLocally,
      clearAuth,
      revalidateSession,
      setUser: setProfileUser,
      setSettings,
    }),
    [
      user,
      userServerId,
      settings,
      isLoading,
      isLocalMode,
      revalidationFailed,
      sessionEndedReason,
      clearSessionEndedReason,
      login,
      register,
      loginWithSso,
      enableLocalMode,
      completeServerUpgrade,
      logout,
      endSessionLocally,
      clearAuth,
      revalidateSession,
      setProfileUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
