import { useEffect, useRef } from 'react';
import type { SSEEvent } from '@jot/shared';
import { CLIENT_ID } from '@/utils/api';

export type { SSEEvent };

interface UseSSEOptions {
  onEvent: (event: SSEEvent) => void;
  onConnected?: () => void;
}

export function useSSE({ onEvent, onConnected }: UseSSEOptions): void {
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
      // Drop events that originated from this tab to avoid redundant refetches.
      if (event.client_id && event.client_id === CLIENT_ID) return;
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
  }, []); // empty deps — connect once, stay connected
}
