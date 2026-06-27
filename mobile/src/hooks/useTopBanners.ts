import { useOfflineContext } from '../store/OfflineContext';
import { useSSEContext } from '../store/SSEContext';
import { useAuth } from '../store/AuthContext';

/**
 * Identifiers for the top-of-screen status banners, listed in the fixed order
 * they stack from the top of the screen.
 */
export type TopBannerKey =
  | 'offline'
  | 'sseReconnect'
  | 'syncError'
  | 'revalidation'
  | 'syncFailures';

/**
 * Props every top banner receives from {@link TopBanners}. Banners are purely
 * presentational: visibility and safe-area ownership are decided centrally by
 * {@link useVisibleTopBanners} so the stack can never disagree with itself.
 */
export interface TopBannerProps {
  /** Whether this banner is currently shown. Toggling animates a fade in/out. */
  visible: boolean;
  /**
   * Whether this banner owns the top safe-area inset. Only the topmost visible
   * banner applies it, so the inset is never doubled when banners stack.
   */
  applyTopInset: boolean;
}

/**
 * Single source of truth for the top-of-screen banner stack: which banners are
 * currently visible, in the fixed order they stack from the top.
 *
 * Both the renderer ({@link TopBanners}) and the safe-area inset logic
 * (`useBannerShown`) derive from this list, so the top inset is always applied
 * exactly once — by whichever banner is topmost — and screens reliably know
 * whether a banner has already claimed the inset. Add a new banner here, in
 * stack order, and the inset handling stays correct everywhere automatically.
 *
 * This consolidates logic that previously lived in seven places (each banner's
 * `visible`, each banner's `applyTopInset`, and a separate `useBannerShown`),
 * which is how the SSE reconnect bar ended up with a doubled top inset.
 */
export function useVisibleTopBanners(): TopBannerKey[] {
  const { isConnected, syncError, syncFailureCount, syncFailuresBannerDismissed } =
    useOfflineContext();
  const { sseReconnecting } = useSSEContext();
  const { revalidationFailed, isLocalMode } = useAuth();

  const visible: TopBannerKey[] = [];
  // Offline takes priority; the connection-state banners below it are gated on
  // isConnected so they never compete with it. syncFailures is intentionally
  // not gated: dead-lettered changes stay failed regardless of connectivity, so
  // it stacks below the offline banner (rather than replacing it) when both
  // apply.
  if (!isConnected) visible.push('offline');
  if (isConnected && sseReconnecting && !isLocalMode) visible.push('sseReconnect');
  if (isConnected && syncError) visible.push('syncError');
  if (isConnected && revalidationFailed) visible.push('revalidation');
  if (syncFailureCount > 0 && !syncFailuresBannerDismissed) visible.push('syncFailures');
  return visible;
}
