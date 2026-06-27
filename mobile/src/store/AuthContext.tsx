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
import { getLocalIdentity, enableLocalMode as persistEnableLocalMode, disableLocalMode, setLocalModeActive, updateLocalSettings } from './localMode';

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
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  /** Enter serverless local mode, provisioning a persistent on-device identity. */
  enableLocalMode: () => Promise<void>;
  logout: () => Promise<void>;
  clearAuth: () => void;
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
  const queryClient = useQueryClient();

  const clearAuth = useCallback(() => {
    setUser(null);
    setSettings(null);
    setRevalidationFailed(false);
    setIsLocalMode(false);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setOnUnauthorized(clearAuth);
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

  useEffect(() => {
    let cancelled = false;

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
        const response = await auth.me();
        if (!cancelled) {
          setUser(response.user);
          setSettings(response.settings);
          await cacheAuthProfile(response);
        }
      } catch (error) {
        if (isUnauthorizedError(error)) {
          await clearStoredSession();
          await clearCachedProfile();
          clearAuth();
        } else if (isHttpResponseError(error)) {
          clearAuth();
        } else {
          // Network error — try to restore from cached profile
          const cached = await getCachedAuthProfile();
          if (cached?.user && cached?.settings && !cancelled) {
            setUser(cached.user);
            setSettings(cached.settings);
          }
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
        clearAuth();
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
      login,
      register,
      enableLocalMode,
      logout,
      clearAuth,
      revalidateSession,
      setUser,
      setSettings,
    }),
    [user, settings, isLoading, isLocalMode, revalidationFailed, login, register, enableLocalMode, logout, clearAuth, revalidateSession],
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
