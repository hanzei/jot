import type { SSEConnectionManager } from './events';

let _manager: SSEConnectionManager | null = null;

type SseStateListener = () => void;
const listeners = new Set<SseStateListener>();

export function setActiveSseManager(manager: SSEConnectionManager | null): void {
  _manager = manager;
  notifySseStateChange();
}

export interface SseState {
  isConnected: boolean;
  reconnectAttempts: number;
}

export function getSseState(): SseState {
  return {
    isConnected: _manager?.isConnected() ?? false,
    reconnectAttempts: _manager?.getReconnectAttempts() ?? 0,
  };
}

/** Signal that the active manager's connection status changed; listeners re-read {@link getSseState}. */
export function notifySseStateChange(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to SSE state changes. Returns an unsubscribe function. */
export function subscribeToSseState(listener: SseStateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
