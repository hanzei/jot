import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import SSE from 'react-native-sse';
import { useAuthStore } from '../store/authStore';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8080';

export const useSync = () => {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const sseRef = useRef<SSE | null>(null);

  const connectSSE = () => {
    if (!user) return;

    sseRef.current = new SSE(`${BASE_URL}/api/v1/events`, {
      headers: {},
    });

    sseRef.current.addEventListener('note_created', () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    });

    sseRef.current.addEventListener('note_updated', () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    });

    sseRef.current.addEventListener('note_deleted', () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    });

    sseRef.current.addEventListener('note_shared', () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    });
  };

  const disconnectSSE = () => {
    sseRef.current?.close();
    sseRef.current = null;
  };

  useEffect(() => {
    if (!user) return;

    connectSSE();

    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        connectSSE();
      } else {
        disconnectSSE();
      }
    });

    return () => {
      disconnectSSE();
      subscription.remove();
    };
  }, [user]);
};
