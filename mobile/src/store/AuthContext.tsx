import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { User, UserSettings } from '../types';
import { auth, getStoredSession, clearStoredSession, setOnUnauthorized } from '../api/client';

interface AuthState {
  user: User | null;
  settings: UserSettings | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

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
  }, [clearAuth]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const token = await getStoredSession();
        if (!token) {
          return;
        }
        const response = await auth.me();
        if (!cancelled) {
          setUser(response.user);
          setSettings(response.settings);
        }
      } catch {
        await clearStoredSession();
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
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const response = await auth.register({ username, password });
    setUser(response.user);
    setSettings(response.settings);
  }, []);

  const logout = useCallback(async () => {
    await auth.logout();
    clearAuth();
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
    }),
    [user, settings, isLoading, login, register, logout],
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
