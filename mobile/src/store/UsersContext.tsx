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

const EMPTY_USERS: Map<string, User> = new Map();

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
  // The map is tagged with the account it was loaded for and only surfaces while
  // that account is the signed-in one. Masking during render rather than clearing
  // in an effect closes two windows the effect left open: the frame after
  // sign-out where the previous session's collaborators were still readable, and
  // — because loadUsers only replaces the map once it resolves — every render of
  // account B's session before its own load lands.
  const [loaded, setLoaded] = useState<{ ownerId: string | null; byId: Map<string, User> }>({
    ownerId: null,
    byId: new Map(),
  });
  const ownerId = user?.id ?? null;
  const usersById = isAuthenticated && loaded.ownerId === ownerId ? loaded.byId : EMPTY_USERS;
  const isMountedRef = useRef(true);
  const isConnectedRef = useRef(isConnected);
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  isConnectedRef.current = isConnected;
  // Re-entrancy guard: skip a load while one is already running so the
  // isConnected/mount effect and the SSE-reconnect subscription can't start
  // duplicate refreshes (Sync Loop Safety), mirroring useOfflineNotes.
  const isSyncingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadUsers = useCallback(async (canceller?: SyncCanceller) => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      // Load from SQLite first for immediate offline display
      try {
        const localUsers = await getLocalUsers(db);
        // Cancellation is checked as well as mount: sign-out cancels this load and
        // clears the cache while the provider stays mounted, so publishing here
        // would refill it with the previous user's collaborators.
        if (isMountedRef.current && !canceller?.cancelled) {
          setLoaded({ ownerId: user?.id ?? null, byId: buildUsersMap(user, localUsers) });
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
        // Re-check: the persist above is another await the cancel can land in.
        if (!isMountedRef.current || canceller?.cancelled) return;
        setLoaded({ ownerId: user?.id ?? null, byId: buildUsersMap(user, users) });
        // Warm the icon cache opportunistically; errors are non-fatal.
        void refreshIconCacheForUsers(users, getBaseUrl());
      } catch (err) {
        // Cancelled or offline: expected; SQLite data is used as fallback.
        if (err instanceof SyncAbortedError) return;
        // Retries exhausted (or a permanent error): SQLite data is the fallback.
        console.warn('Background users sync failed after retries:', err);
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, [db, user]);

  // Re-runs on reconnect (isConnected false → true) so a transient failure
  // resumes once connectivity returns instead of waiting for the next mount.
  useEffect(() => {
    if (!isAuthenticated) return;
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
      // Keeps the owner tag: an event that arrives for a map belonging to a
      // previous account updates that map and stays masked, rather than
      // re-tagging it to the account now signed in.
      setLoaded((prev) => {
        const next = new Map(prev.byId);
        next.set(updatedUser.id, updatedUser);
        return { ownerId: prev.ownerId, byId: next };
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
