import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { User } from '@jot/shared';
import { getUsers } from '../api/users';
import { getBaseUrl } from '../api/client';
import { useAuth } from './AuthContext';
import { useSQLiteContext } from 'expo-sqlite';
import { getLocalUsers, saveUsers } from '../db/userQueries';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import { refreshIconCacheForUsers } from '../utils/profileIconCache';

interface UsersState {
  usersById: Map<string, User>;
  refreshUsers: () => Promise<void>;
}

const UsersContext = createContext<UsersState | undefined>(undefined);

function buildUsersMap(seedUser: User | null | undefined, list: User[]): Map<string, User> {
  const map = new Map<string, User>();
  if (seedUser) map.set(seedUser.id, seedUser as User);
  for (const u of list) map.set(u.id, u);
  return map;
}

export function UsersProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();
  const { user, isAuthenticated } = useAuth();
  const { isConnected } = useNetworkStatus();
  const [usersById, setUsersById] = useState<Map<string, User>>(new Map());
  const isMountedRef = useRef(true);
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadUsers = useCallback(async (canceller?: SyncCanceller) => {
    // Load from SQLite first for immediate offline display
    try {
      const localUsers = await getLocalUsers(db);
      if (isMountedRef.current) {
        setUsersById(buildUsersMap(user, localUsers));
      }
    } catch { /* ignore — server fetch will follow */ }

    try {
      // Fetch from server (with retry/backoff) and persist to SQLite
      const users = await retrySync(getUsers, {
        isConnected: () => isConnectedRef.current,
        canceller,
      });
      if (!isMountedRef.current || canceller?.cancelled) return;
      await saveUsers(db, users);
      setUsersById(buildUsersMap(user, users));
      // Warm the icon cache opportunistically; errors are non-fatal.
      void refreshIconCacheForUsers(users, getBaseUrl());
    } catch (err) {
      // Cancelled or offline: expected; SQLite data is used as fallback.
      if (err instanceof SyncAbortedError) return;
      // Retries exhausted (or a permanent error): SQLite data is the fallback.
      console.warn('Background users sync failed after retries:', err);
    }
  }, [db, user]);

  // Re-runs on reconnect (isConnected false → true) so a transient failure
  // resumes once connectivity returns instead of waiting for the next mount.
  useEffect(() => {
    if (!isAuthenticated) {
      setUsersById(new Map());
      return;
    }
    const canceller = new SyncCanceller();
    loadUsers(canceller);
    return () => canceller.cancel();
  }, [isAuthenticated, isConnected, loadUsers]);

  const value = useMemo<UsersState>(
    () => ({ usersById, refreshUsers: loadUsers }),
    [usersById, loadUsers],
  );

  return <UsersContext.Provider value={value}>{children}</UsersContext.Provider>;
}

export function useUsers(): UsersState {
  const context = useContext(UsersContext);
  if (context === undefined) {
    throw new Error('useUsers must be used within a UsersProvider');
  }
  return context;
}
