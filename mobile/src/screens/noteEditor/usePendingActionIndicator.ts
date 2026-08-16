import { useCallback, useEffect, useRef, useState } from 'react';
import { isServerReachable } from '../../api/serverReachability';

// Menu-action pending bar: only show it once an action has been in flight for
// this long, so fast actions never flash it; and once shown, keep it up for at
// least the min-visible window so it can't blink out a frame later.
const PENDING_BAR_DELAY_MS = 600;
const PENDING_BAR_MIN_VISIBLE_MS = 300;

export interface PendingActionIndicator {
  /**
   * Whether to render the pending bar. Also gates the overflow-menu button, so
   * a second tap can't fire a concurrent action while one is still in flight.
   */
  isPending: boolean;
  /** Runs `fn`, surfacing the pending bar if it turns out to be slow. */
  withPendingIndicator: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Visible pending state for menu/overflow actions (delete, restore, convert,
 * share, manage labels, redirect-share) while they await a write. The sheet
 * that triggered them has already closed, so without this the screen would
 * otherwise sit with no feedback for up to the write timeout on the first
 * action of a fresh outage (issue #697).
 *
 * The indicator is shown only while the server is believed reachable. When it's
 * already known unreachable, the write underneath skips the network entirely
 * (isOnlineWriteAllowed) and resolves near-instantly, so no indicator is needed
 * — the action already feels immediate. When reachable (including the
 * stale-true case on the very first request of a fresh outage), the write may
 * genuinely block for up to the write timeout, so surface that wait instead of
 * leaving the screen looking frozen.
 *
 * The bar is shown on a delay, not immediately: a fast action (the common case
 * — an existing note with no pending edits) finishes before
 * PENDING_BAR_DELAY_MS and never surfaces the bar at all, so it no longer
 * flashes in and shoves the note down. Once the bar does appear it stays up for
 * at least PENDING_BAR_MIN_VISIBLE_MS, so an action finishing just past the
 * delay threshold doesn't produce a one-frame blink either.
 */
export function usePendingActionIndicator(): PendingActionIndicator {
  const [isPending, setIsPending] = useState(false);
  // Tracks overlapping calls (e.g. Pin and Archive tapped in quick succession).
  // The show-delay is armed once while any call is pending, and the bar only
  // hides once every in-flight call has finished, so one call's finally doesn't
  // hide the bar while a sibling is still awaiting its write.
  const pendingCountRef = useRef(0);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp (ms) at which the bar became visible, or 0 while it is hidden.
  const shownAtRef = useRef(0);
  const isMountedRef = useRef(true);

  // Clear the show/hide timers on unmount so a timer armed just before the
  // screen closed can't fire a state update afterwards.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const withPendingIndicator = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    const showPending = isServerReachable();
    if (showPending) {
      pendingCountRef.current += 1;
      // A fresh action cancels any in-flight min-visible hide: the bar should
      // stay up (or appear) rather than blink off between back-to-back actions.
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      // Arm the delayed show once, only while the bar isn't already visible.
      if (shownAtRef.current === 0 && delayTimerRef.current === null) {
        delayTimerRef.current = setTimeout(() => {
          delayTimerRef.current = null;
          if (pendingCountRef.current > 0 && isMountedRef.current) {
            shownAtRef.current = Date.now();
            setIsPending(true);
          }
        }, PENDING_BAR_DELAY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      if (showPending) {
        pendingCountRef.current -= 1;
        if (pendingCountRef.current === 0) {
          if (delayTimerRef.current !== null) {
            // Finished before the delay elapsed — the bar never showed, so just
            // cancel the pending show.
            clearTimeout(delayTimerRef.current);
            delayTimerRef.current = null;
          } else if (shownAtRef.current > 0) {
            // The bar is visible — keep it up for the remainder of the minimum
            // visible window so it doesn't blink out.
            const remaining = PENDING_BAR_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current);
            const hide = () => {
              hideTimerRef.current = null;
              shownAtRef.current = 0;
              if (isMountedRef.current) setIsPending(false);
            };
            if (remaining <= 0) hide();
            else hideTimerRef.current = setTimeout(hide, remaining);
          }
        }
      }
    }
  }, []);

  return { isPending, withPendingIndicator };
}
