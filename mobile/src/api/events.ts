import EventSource from 'react-native-sse';
import { getBaseUrl, getStoredSession } from './client';
import type { SSEEvent } from '@jot/shared';
import { getCurrentSwitchGenerationId, isSseQuiesced } from '../store/serverSwitchLifecycle';

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;
const WATCHDOG_INTERVAL_MS = 15_000;
// Server sends keepalives every 30s; 2.5× gives margin for two missed beats before reconnecting.
const STALL_TIMEOUT_MS = 75_000;

type SSECallback = (event: SSEEvent) => void;

/**
 * Connection lifecycle state reported to {@link StatusChangeCallback}.
 *
 * The distinction between `connecting` and `reconnecting` is what lets the UI
 * avoid flashing a "Connecting…" banner on every launch: an initial connect
 * (`connecting`) is expected to take a moment — especially on a cold start that
 * has to wake the radio and redo the TLS handshake — and is never an error,
 * whereas `reconnecting` means a connection attempt actually failed and a retry
 * is pending, which is the only state worth surfacing to the user.
 */
export type SSEStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type StatusChangeCallback = (status: SSEStatus) => void;

export class SSEConnectionManager {
  private es: EventSource | null = null;
  private callback: SSECallback | null = null;
  private statusChangeCallback: StatusChangeCallback | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventAt = Date.now();
  private closed = false;
  private reconnectDelay = BASE_RECONNECT_DELAY_MS;
  private generationId = getCurrentSwitchGenerationId();
  private _isConnected = false;
  private _reconnectAttempts = 0;

  isConnected(): boolean { return this._isConnected; }
  getReconnectAttempts(): number { return this._reconnectAttempts; }

  async connect(onEvent: SSECallback, onStatusChange?: StatusChangeCallback): Promise<void> {
    this.callback = onEvent;
    this.statusChangeCallback = onStatusChange;
    this.closed = false;
    this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
    this._reconnectAttempts = 0;
    this.generationId = getCurrentSwitchGenerationId();

    // Fresh connection lifecycle: this is an initial connect, not a retry, so
    // it must never surface the reconnect banner no matter how long it takes.
    this.statusChangeCallback?.('connecting');

    await this.openConnection();
  }

  private async openConnection(): Promise<void> {
    try {
      if (this.closed) return;
      if (isSseQuiesced()) return;

      this.cleanup();

      const token = await getStoredSession();
      // Re-check after async gap — disconnect() may have been called
      if (this.closed || !token || isSseQuiesced()) return;

      const url = `${getBaseUrl()}/api/v1/events`;
      this.es = new EventSource(url, {
        headers: {
          Cookie: `jot_session=${token}`,
        },
        // Disable the library's own reconnect loop (default: retry every 5s).
        // This manager owns retries via scheduleReconnect's exponential backoff;
        // with both active, the library's fixed-interval retries fire 'error'
        // events that keep resetting our timer and doubling the backoff, and can
        // race a second connection alongside the one we're about to open.
        pollingInterval: 0,
      });

      this.es.addEventListener('open', () => {
        this._isConnected = true;
        this._reconnectAttempts = 0;
        this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
        this.lastEventAt = Date.now();
        this.statusChangeCallback?.('connected');
      });

      this.es.addEventListener('message', (event) => {
        // Reset watchdog and backoff on any message (including keepalive empty-data events).
        this.lastEventAt = Date.now();
        this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
        if (!event.data) return;
        if (this.generationId !== getCurrentSwitchGenerationId() || isSseQuiesced()) {
          return;
        }
        try {
          const parsed: SSEEvent = JSON.parse(event.data as string);
          this.callback?.(parsed);
        } catch {
          // Ignore unparseable messages (keepalives, comments)
        }
      });

      this.es.addEventListener('error', (event) => {
        this._isConnected = false;
        const status = (event as { status?: number })?.status;
        if (status === 401) {
          // Session expired — do not reconnect
          this.disconnect();
          return;
        }
        // Schedule reconnect with exponential backoff; scheduleReconnect emits the
        // 'reconnecting' status so the UI can distinguish this genuine failure from
        // an in-progress initial connect.
        this.scheduleReconnect();
      });

      this.startWatchdog();
    } catch {
      // Handle errors (e.g., SecureStore failures) — schedule a retry
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (isSseQuiesced()) return;
    // A connection attempt failed and a retry is pending — this, not the initial
    // 'connecting', is what the reconnect banner keys off of.
    this.statusChangeCallback?.('reconnecting');
    this._reconnectAttempts++;
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.openConnection().catch(() => {
        // Handled inside openConnection; this catch prevents unhandled rejection
      });
    }, delay);
  }

  disconnect(): void {
    this.closed = true;
    this._isConnected = false;
    this.statusChangeCallback?.('disconnected');
    this.callback = null;
    this.cleanup();
  }

  private cleanup(): void {
    this.clearReconnectTimer();
    this.stopWatchdog();
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

  private startWatchdog(): void {
    this.lastEventAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      // If a reconnect is already scheduled (e.g. triggered by an error event),
      // don't interfere — cleanup() would cancel that timer and double the backoff.
      if (this.reconnectTimer !== null) return;
      if (Date.now() - this.lastEventAt > STALL_TIMEOUT_MS) {
        this._isConnected = false;
        this.cleanup();
        // scheduleReconnect emits the 'reconnecting' status.
        this.scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
