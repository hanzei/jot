import { useVisibleTopBanners } from './useTopBanners';

/**
 * Returns true when any top-of-screen banner is currently rendered (offline,
 * SSE reconnect, sync-error, revalidation-error, or sync-failures review).
 * Screens read this to skip their own `paddingTop: insets.top`, since the
 * topmost banner already occupies and pads the safe area.
 *
 * Derived from {@link useVisibleTopBanners} — the same source of truth the
 * banner renderer uses — so the header inset and the banner stack can never
 * disagree about whether a banner is showing.
 */
export function useBannerShown(): boolean {
  return useVisibleTopBanners().length > 0;
}
