import { useOfflineContext } from '../store/OfflineContext';
import { useSSEContext } from '../store/SSEContext';
import { useAuth } from '../store/AuthContext';
import { useNoteFailureBarShown } from '../store/noteFailureBar';

/** Identifiers for the top-of-screen status banners. */
export type TopBannerKey =
  | 'offline'
  | 'sseReconnect'
  | 'syncError'
  | 'syncFailures'
  | 'revalidation';

/**
 * Props every top banner receives from {@link TopBanners}. Banners are purely
 * presentational: visibility and safe-area ownership are decided centrally by
 * {@link useTopBanner}.
 */
export interface TopBannerProps {
  /** Whether this banner is currently shown. Toggling animates a fade in/out. */
  visible: boolean;
  /**
   * Whether this banner owns the top safe-area inset — true for the banner
   * that is shown, so the inset is applied exactly once.
   */
  applyTopInset: boolean;
}

/**
 * The single top-of-screen banner to show, or null. At most one is ever
 * shown: several states are often true at once (a server outage is usually
 * also a stalled sync), and stacking a banner for each made the top of the
 * screen a wall of warnings that mostly repeated each other.
 *
 * Priority, highest first:
 *
 * 1. `offline` — the device has no connection; nothing else matters until it
 *    does.
 * 2. `sseReconnect` — online, but the server's event stream is down: the
 *    server is unreachable. Changes queue and replay on their own.
 * 3. `syncError` — the server is reachable but the queue keeps failing to
 *    drain. Retries are automatic.
 * 4. `syncFailures` — changes the server rejected for good, which need the
 *    user to review them. Shown only once the connection states above are
 *    clear, since during an outage the cause is the connection, and hidden
 *    while a focused note shows its own failed-change bar, which says the
 *    same thing about that note.
 * 5. `revalidation` — the session couldn't be verified; the app uses local
 *    data.
 *
 * Both the renderer ({@link TopBanners}) and the safe-area inset logic
 * (`useBannerShown` → `ContentSafeArea`) derive from this, so the top inset is
 * applied exactly once, by the shown banner, and content below sees a top
 * inset of 0 for exactly as long as a banner is claiming it.
 */
export function useTopBanner(): TopBannerKey | null {
  const { isConnected, syncError, syncFailureCount, syncFailuresBannerDismissed } =
    useOfflineContext();
  const { sseReconnecting } = useSSEContext();
  const { revalidationFailed, isLocalMode } = useAuth();
  const noteFailureBarShown = useNoteFailureBarShown();

  if (!isConnected) return 'offline';
  if (sseReconnecting && !isLocalMode) return 'sseReconnect';
  if (syncError) return 'syncError';
  if (syncFailureCount > 0 && !syncFailuresBannerDismissed && !noteFailureBarShown) return 'syncFailures';
  if (revalidationFailed) return 'revalidation';
  return null;
}
