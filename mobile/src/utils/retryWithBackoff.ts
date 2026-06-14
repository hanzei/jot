import axios from 'axios';
import { isTransientHttpStatus } from '../db/syncQueue';

// Sync-loop safety knobs (see mobile/CLAUDE.md → "Sync Loop Safety").
/** Base delay before the first backoff retry. */
export const SYNC_RETRY_BASE_DELAY_MS = 1000;
/** Upper bound on the exponential backoff between retries. */
export const SYNC_RETRY_MAX_DELAY_MS = 60000;
/** Total attempts (the initial try plus retries) before giving up. */
export const SYNC_RETRY_MAX_ATTEMPTS = 4;

/**
 * Thrown when a retry loop stops early because it was cancelled (the caller
 * tore down, e.g. an effect cleanup) or the device went offline. It is *not* a
 * real sync failure — callers should swallow it and keep their local cache,
 * since a reconnect/remount will start a fresh sync.
 */
export class SyncAbortedError extends Error {
  constructor(public readonly reason: 'cancelled' | 'offline') {
    super(`Sync aborted: ${reason}`);
    this.name = 'SyncAbortedError';
  }
}

/**
 * A cooperative cancellation token with an interruptible sleep. Passing it to
 * `retrySync` lets a caller abort an in-flight backoff wait immediately (rather
 * than waiting out the timer) when it tears down or goes offline.
 */
export class SyncCanceller {
  private _cancelled = false;
  private wake: (() => void) | null = null;

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
    // Wake any in-progress sleep so the retry loop can observe the cancel.
    if (this.wake) this.wake();
  }

  /** Resolve after `ms`, or immediately if cancelled in the meantime. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this._cancelled) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

/**
 * Whether a thrown error is a *transient* failure worth retrying. Only network
 * errors and transient HTTP statuses (timeout/429/5xx) qualify; permanent client
 * errors (4xx) and non-network errors are not retried. Mirrors the queue-drain
 * retry policy via the shared `isTransientHttpStatus`.
 *
 * Unlike that policy, a 401 is treated as permanent here: the API response
 * interceptor reacts to a 401 by clearing the session and redirecting to login,
 * so retrying a background read would only fire more doomed authenticated
 * requests while the user is being logged out (mirrors `rethrowIfNotQueueable`).
 */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  if (status === 401) return false;
  return isTransientHttpStatus(status);
}

export interface RetrySyncOptions {
  /** Current connectivity. Checked before every attempt and before each backoff. */
  isConnected: () => boolean;
  /** Optional cancellation token; cancel to abort an in-flight wait/loop. */
  canceller?: SyncCanceller;
  /** Total attempts including the first. Defaults to {@link SYNC_RETRY_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** First backoff delay. Defaults to {@link SYNC_RETRY_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** Backoff cap. Defaults to {@link SYNC_RETRY_MAX_DELAY_MS}. */
  maxDelayMs?: number;
  /** Decide whether a thrown error is worth retrying. Defaults to {@link isTransientError}. */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * Stops early — throwing {@link SyncAbortedError} — when cancelled or offline,
 * so a flaky read does not busy-loop and connectivity loss hands control back
 * to the caller (a reconnect trigger starts a fresh sync). Permanent failures
 * and exhausted retries rethrow the original error so the caller can handle or
 * log them while keeping the local cache as a fallback.
 */
export async function retrySync<T>(fn: () => Promise<T>, options: RetrySyncOptions): Promise<T> {
  const {
    isConnected,
    canceller,
    maxAttempts = SYNC_RETRY_MAX_ATTEMPTS,
    baseDelayMs = SYNC_RETRY_BASE_DELAY_MS,
    maxDelayMs = SYNC_RETRY_MAX_DELAY_MS,
    shouldRetry = isTransientError,
  } = options;

  for (let attempt = 1; ; attempt++) {
    if (canceller?.cancelled) throw new SyncAbortedError('cancelled');
    if (!isConnected()) throw new SyncAbortedError('offline');

    try {
      return await fn();
    } catch (err) {
      if (canceller?.cancelled) throw new SyncAbortedError('cancelled');
      // Out of attempts, or a permanent error: surface the cause.
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      // Don't burn a retry while offline; a reconnect starts a fresh sync.
      if (!isConnected()) throw new SyncAbortedError('offline');

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (canceller) {
        await canceller.sleep(delay);
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
