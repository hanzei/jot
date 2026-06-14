import { useOfflineContext } from '../store/OfflineContext';

/**
 * Returns true when any top-of-screen banner is currently rendered (offline
 * banner or sync-error banner). Screens use this to skip their own
 * paddingTop: insets.top, since the banner already occupies that space.
 */
export function useBannerShown(): boolean {
  const { isConnected, syncError } = useOfflineContext();
  return !isConnected || syncError;
}
