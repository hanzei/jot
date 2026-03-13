import EventSource from 'react-native-sse';
import { BASE_URL, getStoredSession } from './client';
import { SSEEvent } from '../types';

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;

type SSECallback = (event: SSEEvent) => void;

export class SSEConnectionManager {
  private es: EventSource | null = null;
  private callback: SSECallback | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reconnectDelay = BASE_RECONNECT_DELAY_MS;

  async connect(onEvent: SSECallback): Promise<void> {
    this.callback = onEvent;
    this.closed = false;
    this.reconnectDelay = BASE_RECONNECT_DELAY_MS;

    await this.openConnection();
  }

  private async openConnection(): Promise<void> {
    if (this.closed) return;

    this.cleanup();

    const token = await getStoredSession();
    if (!token) return;

    const url = `${BASE_URL}/api/v1/events`;
    this.es = new EventSource(url, {
      headers: {
        Cookie: `jot_session=${token}`,
      },
    });

    this.es.addEventListener('message', (event) => {
      // Reset backoff on successful message
      this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
      if (!event.data) return;
      try {
        const parsed: SSEEvent = JSON.parse(event.data as string);
        this.callback?.(parsed);
      } catch {
        // Ignore unparseable messages (keepalives, comments)
      }
    });

    this.es.addEventListener('error', (event) => {
      const status = (event as { status?: number })?.status;
      if (status === 401) {
        // Session expired — do not reconnect
        this.disconnect();
        return;
      }
      // Schedule reconnect with exponential backoff
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.openConnection();
    }, delay);
  }

  disconnect(): void {
    this.closed = true;
    this.callback = null;
    this.cleanup();
  }

  private cleanup(): void {
    this.clearReconnectTimer();
    if (this.es) {
      this.es.removeAllEventListeners();
      this.es.close();
      this.es = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
