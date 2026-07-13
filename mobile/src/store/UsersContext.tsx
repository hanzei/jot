import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { User } from '@jot/shared';
import { getUsers } from '../api/users';
import { getBaseUrl } from '../api/client';
import { useAuth } from './AuthContext';
import { useSQLiteContext } from 'expo-sqlite';
import { getLocalUsers, saveUsers, upsertUser } from '../db/userQueries';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { retrySync, SyncAbortedError, SyncCanceller } from '../utils/retryWithBackoff';
import { refreshIconCacheForUsers } from '../utils/profileIconCache';
import { subscribeToProfileIconUpdates } from './profileIconEvents';
import { subscribeToReconnectResync } from './resyncEvents';

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

  // Catch up on SSE reconnect: a collaborator's profile change (or a newly-shared
  // user) that happened while the stream was down (e.g. app backgrounded) never
  // arrives as a live event, and a bare foreground doesn't flip isConnected to
  // re-run the effect above, so re-pull the user list here.
  useEffect(() => {
    if (!isAuthenticated) return;
    return subscribeToReconnectResync(() => {
      if (!isConnectedRef.current) return;
      const canceller = new SyncCanceller();
      loadUsers(canceller);
    });
  }, [isAuthenticated, loadUsers]);

  // Apply live profile_icon_updated SSE events (routed via the module bus because
  // UsersProvider sits above SSEProvider in the tree). Updating usersById is what
  // makes avatars re-render — components cache-bust off the user's updated_at — so
  // that's the essential step; persisting and warming the icon cache mirror the
  // post-fetch steps in loadUsers and keep SQLite/the cache consistent.
  useEffect(() => {
    return subscribeToProfileIconUpdates((updatedUser) => {
      if (!isMountedRef.current) return;
      setUsersById((prev) => {
        const next = new Map(prev);
        next.set(updatedUser.id, updatedUser);
        return next;
      });
      void upsertUser(db, updatedUser).catch((err) => {
        console.warn('Failed to persist profile icon update:', err);
      });
      void refreshIconCacheForUsers([updatedUser], getBaseUrl()).catch((err) => {
        console.warn('Failed to warm profile icon cache after update:', err);
      });
    });
  }, [db]);

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
