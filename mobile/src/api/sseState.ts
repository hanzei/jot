import type { SSEConnectionManager } from './events';

let _manager: SSEConnectionManager | null = null;

export function setActiveSseManager(manager: SSEConnectionManager | null): void {
  _manager = manager;
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
