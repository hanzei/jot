import { useOfflineContext } from '../store/OfflineContext';
import { useSSEContext } from '../store/SSEContext';
import { useAuth } from '../store/AuthContext';

/** The connection/session states the status banner can report. */
export type StatusBannerKey =
  | 'offline'
  | 'revalidation'
  | 'sseReconnect'
  | 'syncError';

/**
 * Props every top banner receives from {@link TopBanners}. Banners are purely
 * presentational: visibility and safe-area ownership are decided centrally by
 * {@link useTopBanners}.
 */
export interface TopBannerProps {
  /** Whether this banner is currently shown. Toggling animates a fade in/out. */
  visible: boolean;
  /**
   * Whether this banner owns the top safe-area inset. Only the upper of the
   * two shown banners applies it, so the inset is never doubled.
   */
  applyTopInset: boolean;
}

/** The two banner slots, in the order they stack from the top. */
export type TopBannerSlot = 'status' | 'syncFailures';

export interface TopBannersState {
  /** The one status to report, or null when the connection and session are fine. */
  status: StatusBannerKey | null;
  /**
   * The slots currently shown, top first. The first one owns the top
   * safe-area inset, and content below drops its own while any is shown.
   */
  shown: TopBannerSlot[];
}

/**
 * Which top-of-screen banners to show. There are two kinds, and at most one of
 * each:
 *
 * - **Status** — what is going on with the connection or session right now.
 *   Several of these are often true at once (a server outage is usually also
 *   a stalled sync), so only the most relevant one is shown, highest first:
 *   1. `offline` — the device has no connection.
 *   2. `revalidation` — the server rejected the session (e.g. 403). Ranked
 *      above the connection states because a rejected session also breaks the
 *      event stream and the sync, and this is the cause.
 *   3. `sseReconnect` — online, but the server's event stream is down: the
 *      server is unreachable. Changes queue and replay on their own.
 *   4. `syncError` — the queue keeps failing to drain. Retries are automatic.
 * - **Failed changes** — changes the server rejected for good, which only the
 *   user can resolve. Shown below the status whatever the connection state
 *   (they stay failed through it, and this banner is the way into the review
 *   screen), until dismissed.
 *
 * Both the renderer ({@link TopBanners}) and the safe-area inset logic
 * (`useBannerShown` → `ContentSafeArea`) derive from this, so they can never
 * disagree about whether a banner is showing.
 */
export function useTopBanners(): TopBannersState {
  const { isConnected, syncError, syncFailureCount, syncFailuresBannerDismissed } =
    useOfflineContext();
  const { sseReconnecting } = useSSEContext();
  const { revalidationFailed, isLocalMode } = useAuth();

  let status: StatusBannerKey | null = null;
  if (!isConnected) status = 'offline';
  else if (revalidationFailed) status = 'revalidation';
  else if (sseReconnecting && !isLocalMode) status = 'sseReconnect';
  else if (syncError) status = 'syncError';

  const shown: TopBannerSlot[] = [];
  if (status !== null) shown.push('status');
  if (syncFailureCount > 0 && !syncFailuresBannerDismissed) shown.push('syncFailures');
  return { status, shown };
}
