import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { SSEEvent } from '@jot/shared';
import { CLIENT_ID } from '@/utils/api';
import {
  getDiagnostics,
  resetSSEDiagnostics,
  subscribeToDiagnostics,
  updateSSEDiagnostics,
  type SSEStatus,
} from '@/utils/diagnostics';

const getSSEStatus = () => getDiagnostics().sse.status;

export type { SSEEvent, SSEStatus };

// Backoff bounds for our manual reconnect loop. The native EventSource only
// auto-reconnects on transient failures; once it reaches CLOSED (e.g. the
// server returned a non-2xx while down, or refused the connection) it never
// retries on its own. We recreate it ourselves so the stream re-establishes
// once the server is reachable again. Backoff keeps a persistently-down or
// auth-rejecting server from being hammered (see the threat model in CLAUDE.md).
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

interface UseSSEOptions {
  onEvent: (event: SSEEvent) => void;
  onConnected?: () => void;
}

export function useSSE({ onEvent, onConnected }: UseSSEOptions): SSEStatus {
  // Store callbacks in refs so updates don't trigger reconnection.
  const onEventRef = useRef(onEvent);
  const onConnectedRef = useRef(onConnected);
  // Tracks whether the stream has opened at least once, so we can distinguish a
  // slow first connect ('connecting') from a dropped connection ('reconnecting').
  const hasConnectedRef = useRef(false);
  // Keep refs in sync after every render. useEffect (no deps) runs after every
  // render and is guaranteed to fire before the next scheduled effect, so the
  // EventSource handlers always see the latest callbacks.
  useEffect(() => {
    onEventRef.current = onEvent;
    onConnectedRef.current = onConnected;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    // Set on cleanup so a pending reconnect timer doesn't open a new stream
    // after the effect has torn down.
    let cancelled = false;
    // The diagnostics store owns the connection state: this hook reads its
    // status back, and Settings > Diagnostics reads all of it.
    let reconnectAttempts = 0;

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== undefined) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        // Grow the delay for the next attempt; reset to the floor on a
        // successful open (see onopen).
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        connect();
      }, reconnectDelay);
    };

    const connect = () => {
      if (cancelled) return;
      es = new EventSource('/api/v1/events', { withCredentials: true });

      es.onopen = () => {
        hasConnectedRef.current = true;
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        reconnectAttempts = 0;
        updateSSEDiagnostics({ status: 'connected', reconnectAttempts });
        onConnectedRef.current?.();
      };

      es.onmessage = (e: MessageEvent) => {
        updateSSEDiagnostics({ lastEventAt: new Date().toISOString() });
        let event: SSEEvent;
        try {
          event = JSON.parse(e.data as string) as SSEEvent;
        } catch {
          // ignore malformed events
          return;
        }
        // Drop events that originated from this tab to avoid redundant refetches.
        if (event.client_id && event.client_id === CLIENT_ID) return;
        onEventRef.current(event);
      };

      // EventSource auto-reconnects on transient failures (readyState
      // transitions to CONNECTING). When the connection reaches CLOSED the
      // browser has permanently given up, so we close it and schedule our own
      // reconnect. Session expiry is handled by the axios 401 interceptor on
      // the next regular API call, which redirects to /login and tears down
      // this component; the backoff above bounds retries until that happens.
      // Each error is one failed connection, retried by the browser or by
      // scheduleReconnect, so it counts as one reconnect attempt.
      es.onerror = () => {
        reconnectAttempts += 1;
        let next: SSEStatus;
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          next = hasConnectedRef.current ? 'reconnecting' : 'disconnected';
          scheduleReconnect();
        } else {
          next = hasConnectedRef.current ? 'reconnecting' : 'connecting';
        }
        updateSSEDiagnostics({ status: next, reconnectAttempts });
      };
    };

    // Reset on start rather than on teardown: when the root error boundary
    // unmounts the layout, its crash report should still show the stream's
    // last state, not a fresh one.
    resetSSEDiagnostics();
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []); // empty deps — connect once, stay connected (with manual reconnect)

  return useSyncExternalStore(subscribeToDiagnostics, getSSEStatus);
}
