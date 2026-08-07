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
} from '../api/client';
import { isTransientHttpStatus } from '../db/syncQueue';
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
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [revalidationFailed, setRevalidationFailed] = useState(false);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [sessionEndedReason, setSessionEndedReason] = useState<SessionEndedReason | null>(null);
  const queryClient = useQueryClient();

  const clearAuth = useCallback((reason?: SessionEndedReason) => {
    setUser(null);
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

    async function restoreSession() {
      try {
        // Local mode is a first-class persistent state: when enabled, sign in
        // with the on-device identity and skip server context / session restore
        // entirely (no `GET /me`).
        const localIdentity = await getLocalIdentity();
        if (localIdentity) {
          if (!cancelled) {
            setUser(localIdentity.user);
            setSettings(localIdentity.settings);
            setIsLocalMode(true);
          }
          return;
        }

        await initializeServerContext();
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
        cachedProfile = await getCachedAuthProfile();
        if (cachedProfile?.user && cachedProfile?.settings && !cancelled) {
          setUser(cachedProfile.user);
          setSettings(cachedProfile.settings);
          setIsLoading(false);
        }

        const response = await mePromise;
        if (!cancelled) {
          setUser(response.user);
          setSettings(response.settings);
          await cacheAuthProfile(response);
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
          const cached = cachedProfile !== undefined ? cachedProfile : await getCachedAuthProfile();
          if (cached?.user && cached?.settings && !cancelled) {
            setUser(cached.user);
            setSettings(cached.settings);
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
  }, [clearAuth]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await auth.login({ username, password });
    setUser(response.user);
    setSettings(response.settings);
    await cacheAuthProfile(response);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const response = await auth.register({ username, password });
    setUser(response.user);
    setSettings(response.settings);
    await cacheAuthProfile(response);
  }, []);

  const enableLocalMode = useCallback(async () => {
    const identity = await persistEnableLocalMode();
    setUser(identity.user);
    setSettings(identity.settings);
    setIsLocalMode(true);
  }, []);

  const completeServerUpgrade = useCallback(async () => {
    try {
      const response = await auth.me();
      setUser(response.user);
      setSettings(response.settings);
      await cacheAuthProfile(response);
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
  }, [clearAuth]);

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

  const revalidateSession = useCallback(async (): Promise<boolean> => {
    // No server to revalidate against in local mode; the local identity is
    // always valid.
    if (isLocalMode) {
      return true;
    }
    try {
      const response = await auth.me();
      setUser(response.user);
      setSettings(response.settings);
      await cacheAuthProfile(response);
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
      const cached = await getCachedAuthProfile();
      if (cached?.user && cached?.settings) {
        setUser(cached.user);
        setSettings(cached.settings);
      }
      return true;
    }
  }, [clearAuth, isLocalMode]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      settings,
      isAuthenticated: user !== null,
      isLoading,
      isLocalMode,
      revalidationFailed,
      sessionEndedReason,
      clearSessionEndedReason,
      login,
      register,
      enableLocalMode,
      completeServerUpgrade,
      logout,
      clearAuth,
      revalidateSession,
      setUser,
      setSettings,
    }),
    [
      user,
      settings,
      isLoading,
      isLocalMode,
      revalidationFailed,
      sessionEndedReason,
      clearSessionEndedReason,
      login,
      register,
      enableLocalMode,
      completeServerUpgrade,
      logout,
      clearAuth,
      revalidateSession,
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
