import React, { createContext, useContext, useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { useSSE, SSENotificationCallback } from '../hooks/useSSE';
import type { SSEEvent } from '@jot/shared';

// How long the SSE must be disconnected before we surface the banner. Matches
// the webapp's SHOW_DELAY_MS so brief self-healing reconnects don't flash it.
const SSE_BANNER_DELAY_MS = 2000;

interface SSEContextValue {
  subscribe: (listener: (event: SSEEvent) => void) => () => void;
  /** True once SSE has been disconnected for SSE_BANNER_DELAY_MS. */
  sseReconnecting: boolean;
}

// A concrete default (rather than undefined) so consumers like
// useVisibleTopBanners can read SSE state from anywhere in the tree without a
// provider throwing — mirroring OfflineContext and the safe-area-inset
// convention in mobile/CLAUDE.md.
const SSEContext = createContext<SSEContextValue>({
  subscribe: () => () => {},
  sseReconnecting: false,
});

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const listenersRef = useRef<Set<(event: SSEEvent) => void>>(new Set());
  const [sseConnected, setSseConnected] = useState(false);
  const [sseReconnecting, setSseReconnecting] = useState(false);

  // Delay surfacing the banner so brief, self-healing reconnects don't flash it.
  useEffect(() => {
    if (sseConnected) {
      setSseReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setSseReconnecting(true), SSE_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sseConnected]);

  const handleNoteUpdated: SSENotificationCallback = useCallback((event) => {
    for (const listener of listenersRef.current) {
      listener(event);
    }
  }, []);

  useSSE(handleNoteUpdated, setSseConnected);

  const value = useMemo<SSEContextValue>(() => ({
    subscribe: (listener: (event: SSEEvent) => void) => {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
    sseReconnecting,
  }), [sseReconnecting]);

  return <SSEContext.Provider value={value}>{children}</SSEContext.Provider>;
}

export function useSSEContext(): SSEContextValue {
  return useContext(SSEContext);
}

export function useSSESubscription(noteId: string | null, onUpdated: () => void): void {
  const context = useContext(SSEContext);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  React.useEffect(() => {
    if (!context || !noteId) return;
    const currentNoteId = noteId;
    return context.subscribe((event) => {
      if (event.type === 'note_updated' && event.data.note_id === currentNoteId) {
        onUpdatedRef.current();
      }
    });
  }, [context, noteId]);
}
