import React, { createContext, useContext, useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { useSSE, SSENotificationCallback } from '../hooks/useSSE';
import type { SSEStatus } from '../api/events';
import type { SSEEvent } from '@jot/shared';

// How long the SSE must stay in the 'reconnecting' state before we surface the
// banner, so a single self-healing retry doesn't flash it. The banner is gated
// on 'reconnecting' (a connection attempt that actually failed and is retrying),
// not on a bare "not connected": an initial connect — including a slow cold
// start that has to wake the radio and redo the TLS handshake — reports
// 'connecting' and never trips the banner no matter how long it takes. That
// status distinction, not this delay, is what fixes the launch flash; the delay
// only needs to outlast one reconnect backoff (BASE_RECONNECT_DELAY_MS = 3s in
// api/events) so a quick retry-and-recover stays silent.
const SSE_BANNER_DELAY_MS = 5000;

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
  const [sseStatus, setSseStatus] = useState<SSEStatus>('connecting');
  const [sseReconnecting, setSseReconnecting] = useState(false);

  // Only a genuine reconnect (a connection attempt that failed and is retrying)
  // can surface the banner — an in-progress initial connect never does — and
  // even then only once it outlasts the delay, so a quick self-healing retry
  // stays silent.
  useEffect(() => {
    if (sseStatus !== 'reconnecting') {
      setSseReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setSseReconnecting(true), SSE_BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sseStatus]);

  const handleNoteUpdated: SSENotificationCallback = useCallback((event) => {
    for (const listener of listenersRef.current) {
      listener(event);
    }
  }, []);

  useSSE(handleNoteUpdated, setSseStatus);

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
