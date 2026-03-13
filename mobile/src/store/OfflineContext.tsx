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

interface OfflineContextValue {
  isConnected: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isConnected: true });

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const { isAuthenticated } = useAuth();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef(true);
  const isDrainingRef = useRef(false);

  const handleReconnect = useCallback(async () => {
    if (!isAuthenticated) return; // Don't replay queued operations when not logged in
    if (isDrainingRef.current) return;
    isDrainingRef.current = true;
    try {
      await drainQueue(db);
    } catch (err) {
      console.warn('Queue drain failed:', err);
    } finally {
      isDrainingRef.current = false;
    }
    // Full refetch to reconcile local state with server
    queryClient.invalidateQueries({ queryKey: ['notes-local'] });
    queryClient.invalidateQueries({ queryKey: ['note-local'] });
  }, [db, queryClient, isAuthenticated]);

  useEffect(() => {
    // Seed the initial state from the real network status before subscribing to changes,
    // so isConnected is accurate on first render (default useState(true) can be wrong).
    NetInfo.fetch().then((initial) => {
      const connected = initial.isConnected === true && initial.isInternetReachable !== false;
      prevConnectedRef.current = connected;
      setIsConnected(connected);
    }).catch(() => {});

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
