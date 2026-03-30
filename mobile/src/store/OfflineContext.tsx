import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import NetInfo from '@react-native-community/netinfo';
import { useSQLiteContext } from 'expo-sqlite';
import { useQueryClient } from '@tanstack/react-query';
import { drainQueue } from '../db/syncQueue';
import { useAuth } from './AuthContext';
import { isSyncDrainPaused } from './serverSwitchLifecycle';
import { noteLocalQueryKey, noteLocalQueryScopeKey, notesLocalQueryScopeKey } from '../hooks/queryKeys';

interface OfflineContextValue {
  isConnected: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isConnected: true });

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const { revalidateSession } = useAuth();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef(true);
  const isDrainingRef = useRef(false);

  const handleReconnect = useCallback(async () => {
    if (isSyncDrainPaused()) return;
    // Re-validate session with the server (handles offline-authenticated users
    // and refreshes user/settings for all returning-online users).
    const stillAuthenticated = await revalidateSession();

    if (!stillAuthenticated) return;
    if (isDrainingRef.current) return;
    isDrainingRef.current = true;
    try {
      const { idMappings, discardedOperations } = await drainQueue(db);
      for (const { localId, serverNote } of idMappings) {
        queryClient.setQueryData(noteLocalQueryKey(localId), serverNote);
      }
      if (discardedOperations.length > 0) {
        console.warn(
          `Sync discarded ${discardedOperations.length} operation(s) that were rejected by the server:`,
          discardedOperations,
        );
      }
      queryClient.invalidateQueries({ queryKey: notesLocalQueryScopeKey() });
      queryClient.invalidateQueries({ queryKey: noteLocalQueryScopeKey() });
    } catch (err) {
      console.warn('Queue drain failed:', err);
    } finally {
      isDrainingRef.current = false;
    }
  }, [db, queryClient, revalidateSession]);

  useEffect(() => {
    // Seed the initial state from the real network status before subscribing to changes,
    // so isConnected is accurate on first render (default useState(true) can be wrong).
    // If we start online and are already authenticated, drain any queued operations
    // that accumulated while the app was closed.
    NetInfo.fetch().then((initial) => {
      const connected = initial.isConnected === true && initial.isInternetReachable !== false;
      prevConnectedRef.current = connected;
      setIsConnected(connected);
      if (connected) {
        handleReconnect().catch(() => {});
      }
    }).catch((err) => {
      console.warn('NetInfo.fetch failed, defaulting to online:', err);
    });

    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      setIsConnected(connected);

      if (connected && !prevConnectedRef.current) {
        // Transitioned from offline → online
        handleReconnect().catch(() => {});
      }
      prevConnectedRef.current = connected;
    });

    return () => unsubscribe();
  }, [handleReconnect]);

  const value = useMemo<OfflineContextValue>(() => ({ isConnected }), [isConnected]);

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineContext(): OfflineContextValue {
  return useContext(OfflineContext);
}
