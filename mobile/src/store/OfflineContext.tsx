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

interface OfflineContextValue {
  isConnected: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isConnected: true });

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const prevConnectedRef = useRef(true);
  const isDrainingRef = useRef(false);

  const handleReconnect = useCallback(async () => {
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
  }, [db, queryClient]);

  useEffect(() => {
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
