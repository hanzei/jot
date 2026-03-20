import { useEffect, useRef } from 'react';
import type { SSEEventType, SSEEvent } from '@jot/shared';

export type { SSEEventType, SSEEvent };

interface UseSSEOptions {
  enabled?: boolean;
  onEvent: (event: SSEEvent) => void;
  onConnected?: () => void;
}

export function useSSE({ enabled = true, onEvent, onConnected }: UseSSEOptions): void {
  // Store callbacks in refs so updates don't trigger reconnection.
  const onEventRef = useRef(onEvent);
  const onConnectedRef = useRef(onConnected);
  // Keep refs in sync after every render. useEffect (no deps) runs after every
  // render and is guaranteed to fire before the next scheduled effect, so the
  // EventSource handlers always see the latest callbacks.
  useEffect(() => {
    onEventRef.current = onEvent;
    onConnectedRef.current = onConnected;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const es = new EventSource('/api/v1/events', { withCredentials: true });

    es.onopen = () => {
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
      onEventRef.current(event);
    };

    // EventSource auto-reconnects on transient failures (readyState transitions
    // to CONNECTING). When the server closes the connection cleanly (e.g. 4xx),
    // readyState becomes CLOSED and no reconnection occurs. Session expiry is
    // handled by the axios 401 interceptor on the next regular API call, which
    // redirects to /login and tears down this component.
    es.onerror = () => {};

    return () => {
      es.close();
    };
  }, [enabled]); // connect once when enabled, close when disabled
}
