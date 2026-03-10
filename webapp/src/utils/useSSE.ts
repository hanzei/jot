import { useEffect, useRef } from 'react';
import { Note } from '@/types';

export type SSEEventType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'note_shared'
  | 'note_unshared';

export interface SSEEvent {
  type: SSEEventType;
  note_id: string;
  note: Note | null;
  source_user_id: string;
}

interface UseSSEOptions {
  onEvent: (event: SSEEvent) => void;
  onConnected?: () => void;
}

export function useSSE({ onEvent, onConnected }: UseSSEOptions): void {
  // Store callbacks in refs so updates don't trigger reconnection.
  const onEventRef = useRef(onEvent);
  const onConnectedRef = useRef(onConnected);
  onEventRef.current = onEvent;
  onConnectedRef.current = onConnected;

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
      onEventRef.current(event);
    };

    // onerror is intentionally a no-op: EventSource auto-reconnects natively.
    // onopen will fire again on reconnect, triggering onConnected -> loadNotes().
    es.onerror = () => {};

    return () => {
      es.close();
    };
  }, []); // empty deps — connect once, stay connected
}
