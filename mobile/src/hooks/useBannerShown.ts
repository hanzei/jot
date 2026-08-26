import { useVisibleTopBanners } from './useTopBanners';

/**
 * Returns true when any top-of-screen banner is currently rendered (offline,
 * SSE reconnect, sync-error, revalidation-error, or sync-failures review).
 *
 * The topmost visible banner pads the top safe area itself, so content below it
 * must not pad it again. `ContentSafeArea` is the single consumer of this: it
 * zeroes the top inset for the whole subtree below the banners, which is what
 * keeps screens, components, and React Navigation's headers from
 * double-counting it. Screens read `useSafeAreaInsets()`, not this hook.
 *
 * Derived from {@link useVisibleTopBanners} — the same source of truth the
 * banner renderer uses — so the content inset and the banner stack can never
 * disagree about whether a banner is showing.
 */
export function useBannerShown(): boolean {
  return useVisibleTopBanners().length > 0;
}
