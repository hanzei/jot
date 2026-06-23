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

interface AuthState {
  user: User | null;
  settings: UserSettings | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * True when `revalidateSession` received a permanent non-401 HTTP error
   * (e.g. 403, 422) from the server. Network errors and 5xx/timeout are
   * transient and do not set this flag. Cleared on successful revalidation or
   * on logout/clearAuth.
   */
  revalidationFailed: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
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
  const queryClient = useQueryClient();

  const clearAuth = useCallback(() => {
    setUser(null);
    setSettings(null);
    setRevalidationFailed(false);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setOnUnauthorized(clearAuth);
    return () => {
      setOnUnauthorized(null);
    };
  }, [clearAuth]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
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

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const revalidateSession = useCallback(async (): Promise<boolean> => {
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
  }, [clearAuth]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      settings,
      isAuthenticated: user !== null,
      isLoading,
      revalidationFailed,
      login,
      register,
      logout,
      clearAuth,
      revalidateSession,
      setUser,
      setSettings,
    }),
    [user, settings, isLoading, revalidationFailed, login, register, logout, clearAuth, revalidateSession],
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
