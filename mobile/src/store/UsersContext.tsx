import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { User } from '@jot/shared';
import { getUsers } from '../api/users';
import { useAuth } from './AuthContext';
import { useSQLiteContext } from 'expo-sqlite';
import { getLocalUsers, saveUsers } from '../db/userQueries';

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
  const [usersById, setUsersById] = useState<Map<string, User>>(new Map());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadUsers = useCallback(async () => {
    // Load from SQLite first for immediate offline display
    try {
      const localUsers = await getLocalUsers(db);
      if (isMountedRef.current) {
        setUsersById(buildUsersMap(user, localUsers));
      }
    } catch { /* ignore — server fetch will follow */ }

    // Fetch from server and persist to SQLite
    try {
      const users = await getUsers();
      if (!isMountedRef.current) return;
      await saveUsers(db, users);
      setUsersById(buildUsersMap(user, users));
    } catch {
      // Silently fail — SQLite data will be used as fallback
    }
  }, [db, user]);

  useEffect(() => {
    if (isAuthenticated) {
      loadUsers();
    } else {
      setUsersById(new Map());
    }
  }, [isAuthenticated, loadUsers]);

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
