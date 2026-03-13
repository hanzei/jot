import React, { createContext, useContext, useRef, useCallback, useMemo } from 'react';
import { useSSE, SSENotificationCallback } from '../hooks/useSSE';
import { SSEEvent } from '../types';

interface SSEContextValue {
  subscribe: (listener: (event: SSEEvent) => void) => () => void;
}

const SSEContext = createContext<SSEContextValue | undefined>(undefined);

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const listenersRef = useRef<Set<(event: SSEEvent) => void>>(new Set());

  const handleNoteUpdated: SSENotificationCallback = useCallback((event) => {
    for (const listener of listenersRef.current) {
      listener(event);
    }
  }, []);

  useSSE(handleNoteUpdated);

  const value = useMemo<SSEContextValue>(() => ({
    subscribe: (listener: (event: SSEEvent) => void) => {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
  }), []);

  return <SSEContext.Provider value={value}>{children}</SSEContext.Provider>;
}

export function useSSESubscription(noteId: string | null, onUpdated: () => void): void {
  const context = useContext(SSEContext);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  React.useEffect(() => {
    if (!context || !noteId) return;
    const currentNoteId = noteId;
    return context.subscribe((event) => {
      if (event.type === 'note_updated' && event.note_id === currentNoteId) {
        onUpdatedRef.current();
      }
    });
  }, [context, noteId]);
}
