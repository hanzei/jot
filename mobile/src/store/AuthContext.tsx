import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { User, UserSettings } from '@jot/shared';
import { auth, getStoredSession, clearStoredSession, setOnUnauthorized, getStoredServerUrl, restoreServerUrl, cacheAuthProfile, getCachedAuthProfile, clearCachedProfile } from '../api/client';

interface AuthState {
  user: User | null;
  settings: UserSettings | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  revalidateSession: () => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  setSettings: (settings: UserSettings) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function isUnauthorizedError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearAuth = useCallback(() => {
    setUser(null);
    setSettings(null);
  }, []);

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
        } else {
          // Network error — try to restore from cached profile
          const cached = await getCachedAuthProfile();
          if (cached && !cancelled) {
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
  }, []);

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

  const revalidateSession = useCallback(async () => {
    try {
      const response = await auth.me();
      setUser(response.user);
      setSettings(response.settings);
      await cacheAuthProfile(response);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        await clearStoredSession();
        await clearCachedProfile();
        clearAuth();
      }
    }
  }, [clearAuth]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      settings,
      isAuthenticated: user !== null,
      isLoading,
      login,
      register,
      logout,
      revalidateSession,
      setUser,
      setSettings,
    }),
    [user, settings, isLoading, login, register, logout, revalidateSession],
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
