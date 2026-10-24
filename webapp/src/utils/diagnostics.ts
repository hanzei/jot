import { apiErrorCode, apiRequestId, isValidId } from '@jot/shared';

// In-memory state behind Settings > Diagnostics and the reports built from it.
// Nothing here is persisted or sent anywhere, and nothing carries a request or
// response body, so note content and credentials stay out.

/** How many failed requests are kept; older ones fall off the front. */
export const FAILED_REQUEST_LIMIT = 50;

export interface FailedRequest {
  /** ISO time the failure was seen. */
  time: string;
  method: string;
  /** Path with ID segments replaced by `{id}`, and no query string. */
  route: string;
  /** Null when the server never answered (network error, timeout). */
  status: number | null;
  /** The error envelope's code, else axios's own (`ERR_NETWORK`, `ECONNABORTED`). */
  code: string | null;
  requestId: string | null;
}

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

export interface SSEDiagnostics {
  status: SSEStatus;
  /** Failed connections since the stream was last open; each is retried. */
  reconnectAttempts: number;
  /** ISO time of the last event received, or null if none yet. */
  lastEventAt: string | null;
}

export interface DiagnosticsState {
  failedRequests: readonly FailedRequest[];
  sse: SSEDiagnostics;
}

const INITIAL_SSE: SSEDiagnostics = { status: 'connecting', reconnectAttempts: 0, lastEventAt: null };

// Replaced, never mutated, so useSyncExternalStore sees a new snapshot only on
// a real change.
let state: DiagnosticsState = { failedRequests: [], sse: INITIAL_SSE };
const listeners = new Set<() => void>();

function setState(next: DiagnosticsState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getDiagnostics(): DiagnosticsState {
  return state;
}

export function subscribeToDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `/notes/<id>/items/<id>?x=1` → `/notes/{id}/items/{id}`. */
export function routePattern(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.split('/').map((segment) => (isValidId(segment) ? '{id}' : segment)).join('/');
}

interface AxiosLikeError {
  code?: unknown;
  config?: { method?: unknown; url?: unknown };
  response?: { status?: unknown };
}

/** Records a failed API request from the axios error it rejected with. Cancellations are not failures. */
export function recordFailedRequest(err: unknown, now: Date = new Date()): void {
  if (typeof err !== 'object' || err === null) return;
  const { code, config, response } = err as AxiosLikeError;
  if (code === 'ERR_CANCELED') return;
  const status = response?.status;
  const entry: FailedRequest = {
    time: now.toISOString(),
    method: typeof config?.method === 'string' ? config.method.toUpperCase() : 'GET',
    route: typeof config?.url === 'string' ? routePattern(config.url) : 'unknown',
    status: typeof status === 'number' ? status : null,
    code: apiErrorCode(err) ?? (typeof code === 'string' ? code : null),
    requestId: apiRequestId(err),
  };
  setState({ ...state, failedRequests: [...state.failedRequests, entry].slice(-FAILED_REQUEST_LIMIT) });
}

export function updateSSEDiagnostics(update: Partial<SSEDiagnostics>): void {
  setState({ ...state, sse: { ...state.sse, ...update } });
}

/** Back to the state before any stream was opened, keeping the last event time. */
export function resetSSEDiagnostics(): void {
  updateSSEDiagnostics({ status: INITIAL_SSE.status, reconnectAttempts: 0 });
}

/** Drops the failed-request history, so the next user on this tab never sees it. */
export function clearFailedRequests(): void {
  setState({ ...state, failedRequests: [] });
}

/** Test-only: clears everything. */
export function resetDiagnosticsForTest(): void {
  setState({ failedRequests: [], sse: INITIAL_SSE });
}
