import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { UserInfo } from '@jot/shared';
import { getUsers } from '../api/users';
import { useAuth } from './AuthContext';

interface UsersState {
  usersById: Map<string, UserInfo>;
  refreshUsers: () => Promise<void>;
}

const UsersContext = createContext<UsersState | undefined>(undefined);

export function UsersProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [usersById, setUsersById] = useState<Map<string, UserInfo>>(new Map());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const users = await getUsers();
      if (!isMountedRef.current) return;
      const map = new Map<string, UserInfo>();
      if (user) map.set(user.id, user as UserInfo);
      for (const u of users) map.set(u.id, u);
      setUsersById(map);
    } catch {
      // Silently fail — users map will be empty until next refresh
    }
  }, [user]);

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
