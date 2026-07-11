/**
 * Best-effort belief about whether the Jot *server* is currently reachable.
 *
 * This is deliberately distinct from NetInfo's device-level connectivity
 * (`OfflineContext.isConnected`): the device can have a perfectly good internet
 * connection while the Jot server itself is down, restarting, or unroutable. In
 * that gap a write would otherwise stall for the full request timeout (see
 * `WRITE_REQUEST_TIMEOUT_MS`) before the offline-queue fallback engages, which
 * is what makes the app feel frozen — e.g. being unable to leave a note with
 * unsaved edits until the timeout fires.
 *
 * Tracking server reachability lets the write path skip straight to the local
 * persist + enqueue path once the server is known-unreachable, and resume
 * hitting the network the moment it answers again. The signal is updated from
 * the axios interceptors (a response of any status means the server answered; a
 * transport failure means it did not) and from the SSE stream opening, and is
 * re-armed to reachable whenever the device regains connectivity so a new link
 * gets a fresh probe.
 *
 * This module intentionally has no imports so it can be depended on from the
 * api client, the sync layer, and screens without risking an import cycle.
 */

let serverReachable = true;

type ReachabilityListener = (reachable: boolean) => void;
const listeners = new Set<ReachabilityListener>();

/** Current best-effort belief about server reachability (defaults to reachable). */
export function isServerReachable(): boolean {
  return serverReachable;
}

function setReachable(next: boolean): void {
  if (serverReachable === next) return;
  serverReachable = next;
  for (const listener of listeners) listener(next);
}

/**
 * Record that the server answered — a successful response, an HTTP error status
 * (still proof the server is up), the SSE stream opening, or a fresh device
 * connection worth re-probing.
 */
export function markServerReachable(): void {
  setReachable(true);
}

/**
 * Record that a request failed at the transport layer (timeout, connection
 * refused, DNS failure) — the server did not answer.
 */
export function markServerUnreachable(): void {
  setReachable(false);
}

/** Subscribe to reachability transitions. Returns an unsubscribe function. */
export function subscribeToServerReachability(listener: ReachabilityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
