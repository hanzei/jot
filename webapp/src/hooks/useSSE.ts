import { useEffect, useRef, useState } from 'react';
import type { SSEEvent } from '@jot/shared';
import { CLIENT_ID } from '@/utils/api';

export type { SSEEvent };

// Connection lifecycle exposed to the UI:
// - 'connecting'   — establishing the very first connection (never opened yet).
// - 'connected'    — the stream is open and receiving events.
// - 'reconnecting' — the connection dropped after having been open and we are
//                    retrying (browser auto-reconnect, or our own manual retry
//                    after the browser gave up).
// - 'disconnected' — the browser gave up reconnecting (EventSource CLOSED) and
//                    we have not yet re-established the stream. This is a
//                    transient state: a manual reconnect is always scheduled.
export type SSEStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

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
  const [status, setStatus] = useState<SSEStatus>('connecting');
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
        setStatus('connected');
        onConnectedRef.current?.();
      };

      es.onmessage = (e: MessageEvent) => {
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
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          setStatus(hasConnectedRef.current ? 'reconnecting' : 'disconnected');
          scheduleReconnect();
        } else {
          setStatus(hasConnectedRef.current ? 'reconnecting' : 'connecting');
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []); // empty deps — connect once, stay connected (with manual reconnect)

  return status;
}
