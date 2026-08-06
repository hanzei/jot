import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';
import { useBannerShown } from '../hooks/useBannerShown';

const ZERO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The device's real safe-area insets, kept intact for the few overlays that
 * render *above* the banner stack. Null outside {@link ContentSafeArea}.
 */
const DeviceSafeAreaInsetsContext = createContext<EdgeInsets | null>(null);

/**
 * Publishes the safe-area insets that apply to everything rendered *below* the
 * top banner stack, and wraps the app content in them.
 *
 * Screens use `headerShown: false` and pad the top safe area themselves, but
 * when a banner (offline, SSE reconnect, sync error, …) is visible the banner
 * already occupies and pads that area — so content below it must not pad it a
 * second time. Rather than have every screen remember to subtract it (which is
 * how the drawer, the Archive/Bin headers, and Diagnostics each ended up with a
 * doubled inset), this overrides `SafeAreaInsetsContext` for the whole subtree
 * with `top: 0` while a banner is shown.
 *
 * That makes `useSafeAreaInsets()` mean "the inset your content still has to
 * apply" everywhere below, so screens, components, and React Navigation's own
 * headers (which read the same context) are all correct by default and a new
 * screen cannot get it wrong. Only `top` is overridden; the other edges are
 * untouched.
 *
 * Must be rendered as a *sibling below* the banner stack, never around it —
 * the banners themselves need the real inset in order to pad it.
 *
 * The flip is deliberately instant rather than animated, and is what makes the
 * banner's open/close animation seamless: the topmost banner's closed height is
 * exactly the top inset dropped here, and both change on the same commit, so
 * they cancel out and the content slides rather than steps. See `Banner`.
 */
export function ContentSafeArea({ children }: PropsWithChildren) {
  const deviceInsets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  const bannerShown = useBannerShown();

  const contentInsets = useMemo(
    () => (bannerShown ? { ...deviceInsets, top: 0 } : deviceInsets),
    [bannerShown, deviceInsets],
  );

  return (
    <DeviceSafeAreaInsetsContext.Provider value={deviceInsets}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>{children}</SafeAreaInsetsContext.Provider>
    </DeviceSafeAreaInsetsContext.Provider>
  );
}

/**
 * The device's real safe-area insets, ignoring any banner. Use this *only* for
 * full-screen React Native `Modal`s that position content against the top edge:
 * a `Modal` renders in its own native window above the banner stack, so the
 * status bar is uncovered there and the real top inset applies again.
 *
 * Everything else — including bottom sheets, which only touch `insets.bottom` —
 * should keep using `useSafeAreaInsets()` / `SafeAreaInsetsContext`.
 */
export function useDeviceSafeAreaInsets(): EdgeInsets {
  const deviceInsets = useContext(DeviceSafeAreaInsetsContext);
  const fallbackInsets = useContext(SafeAreaInsetsContext);
  return deviceInsets ?? fallbackInsets ?? ZERO_INSETS;
}
