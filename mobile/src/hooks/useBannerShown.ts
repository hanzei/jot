import { useOfflineContext } from '../store/OfflineContext';
import { useAuth } from '../store/AuthContext';

/**
 * Returns true when any top-of-screen banner is currently rendered (offline
 * banner, sync-error banner, revalidation-error banner, or the sync-failures
 * review banner). Screens use this to skip their own paddingTop: insets.top,
 * since the banner already occupies that space.
 */
export function useBannerShown(): boolean {
  const { isConnected, syncError, syncFailureCount, syncFailuresBannerDismissed } = useOfflineContext();
  const { revalidationFailed } = useAuth();
  return (
    !isConnected ||
    syncError ||
    revalidationFailed ||
    (syncFailureCount > 0 && !syncFailuresBannerDismissed)
  );
}
