import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, useAnimatedValue, View, type LayoutChangeEvent } from 'react-native';
import { X, type LucideIcon } from 'lucide-react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

/** Duration of the show/hide animation. */
const ANIMATION_DURATION_MS = 300;
/** Kept in a constant because the animated height has to account for it. */
const BORDER_WIDTH = 1;

interface BannerProps {
  /** Whether the banner should be shown. Toggling animates it open/closed. */
  visible: boolean;
  icon: LucideIcon;
  text: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  /** Makes the banner body tappable (e.g. to open a review screen). */
  onPress?: () => void;
  /** Renders a trailing dismiss (✕) button wired to this handler. */
  onDismiss?: () => void;
  /** Accessibility label for the tappable body; required when onPress is set. */
  accessibilityLabel?: string;
  /** Accessibility label for the dismiss button; required when onDismiss is set. */
  dismissAccessibilityLabel?: string;
  testID?: string;
  /**
   * Whether to add the top safe-area inset. Defaults to true. Set false when
   * another banner already occupies the safe-area above this one, so the inset
   * isn't applied twice when banners stack.
   */
  applyTopInset?: boolean;
}

/**
 * A top-of-screen status banner that animates open and closed and applies the
 * top safe-area inset itself (screens use headerShown: false). Shared by
 * OfflineBanner, SyncErrorBanner, and the tappable SyncFailuresBanner so the
 * show/hide animation lives in one place.
 *
 * The banner sits *in flow* above the app content, so its height is what pushes
 * that content down — animating only the opacity would make the content jump a
 * full banner height at each end of the fade. It therefore animates `height`
 * between two ends chosen so the content never jumps:
 *
 * - **Open:** `topInset + row height`.
 * - **Closed:** `topInset` — the safe-area strip alone, not zero.
 *
 * The closed end is what makes the transition seamless. `ContentSafeArea`
 * zeroes the content's own top inset for exactly as long as `visible` is true,
 * and `applyTopInset` (owned by the topmost *visible* banner) flips on the same
 * commit — so the strip this banner adds and the inset the content drops are
 * the same size and cancel out. Total offset above the content is a continuous
 * `topInset → topInset + row height`, with no step at either end, including the
 * frame this unmounts on.
 */
export default function Banner({
  visible,
  icon: Icon,
  text,
  backgroundColor,
  borderColor,
  textColor,
  onPress,
  onDismiss,
  accessibilityLabel,
  dismissAccessibilityLabel,
  testID,
  applyTopInset = true,
}: BannerProps) {
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const topInset = applyTopInset ? insets.top : 0;
  const [shouldRender, setShouldRender] = useState(visible);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  // 0 = closed onto the safe-area strip and fully transparent, 1 = fully open.
  const progress = useAnimatedValue(visible ? 1 : 0);
  // A banner that is already visible on the very first render (the app launched
  // offline) has no transition to play, so it lays out at its natural height
  // instead of spending a frame closed while waiting for the measurement.
  const [openOnMount] = useState(visible);
  // The state `progress` is already animating towards, so a re-render that does
  // not change `visible` — and the first render, which starts settled — does not
  // kick off a redundant animation. `height` is JS-driven, so an animation that
  // has nothing to play still costs a frame callback every frame it runs.
  const animatingTo = useRef(visible);

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing, tracked in #777
      setShouldRender(true);
    }
    if (animatingTo.current === visible) return;
    animatingTo.current = visible;
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: ANIMATION_DURATION_MS,
      // `height` is a layout prop, so this cannot be driven off the UI thread.
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !visible) {
        setShouldRender(false);
      }
    });
  }, [visible, progress]);

  // The row keeps its natural height even while the container clips it (RN
  // views do not shrink by default), so this measures the open height whether
  // the banner is currently open or closed.
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setRowHeight((prev) => (prev === height ? prev : height));
  }, []);

  if (!shouldRender) return null;

  // Static banners stay non-interactive so they never intercept touches meant
  // for the content below; an interactive banner (onPress/onDismiss) opts in,
  // but not while it is animating closed.
  const interactive = !!onPress || !!onDismiss;

  const height = rowHeight === null
    ? (openOnMount ? undefined : topInset)
    : progress.interpolate({
      inputRange: [0, 1],
      outputRange: [topInset, topInset + rowHeight + BORDER_WIDTH],
    });

  const body = (
    <View style={styles.content}>
      <Icon size={16} color={textColor} />
      <Text style={[styles.text, { color: textColor }]}>{text}</Text>
    </View>
  );

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          opacity: progress,
          height,
          backgroundColor,
          borderBottomColor: borderColor,
        },
      ]}
      pointerEvents={interactive && visible ? 'auto' : 'none'}
      testID={testID}
    >
      <View
        style={[styles.row, { marginTop: topInset }]}
        onLayout={handleRowLayout}
        testID={testID ? `${testID}-row` : undefined}
      >
        {onPress ? (
          <TouchableOpacity
            style={styles.pressable}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={testID ? `${testID}-press` : undefined}
          >
            {body}
          </TouchableOpacity>
        ) : (
          <View style={styles.pressable}>{body}</View>
        )}
        {onDismiss && (
          <TouchableOpacity
            onPress={onDismiss}
            style={styles.dismiss}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={dismissAccessibilityLabel}
            testID={testID ? `${testID}-dismiss` : undefined}
          >
            <X size={18} color={textColor} />
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderBottomWidth: BORDER_WIDTH,
    // The row is clipped rather than resized as the height animates, so the
    // text does not reflow on every frame of the transition.
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressable: {
    flex: 1,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  text: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    flexShrink: 1,
  },
  dismiss: {
    padding: 2,
  },
});
