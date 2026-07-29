import React, { useContext, useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, useAnimatedValue, View } from 'react-native';
import { X, type LucideIcon } from 'lucide-react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

interface BannerProps {
  /** Whether the banner should be shown. Toggling animates a fade in/out. */
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
 * A top-of-screen status banner that fades in/out and applies the top safe-area
 * inset itself (screens use headerShown: false). Shared by OfflineBanner,
 * SyncErrorBanner, and the tappable SyncFailuresBanner so the show/hide
 * animation lives in one place.
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
  const [shouldRender, setShouldRender] = useState(visible);
  const opacity = useAnimatedValue(visible ? 1 : 0);

  useEffect(() => {
    if (visible) {
      // Grandfathered: mounts the banner before the fade-in; the exit fade needs the node to outlive visible=false.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShouldRender(true);
    }
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) {
        setShouldRender(false);
      }
    });
  }, [visible, opacity]);

  if (!shouldRender) return null;

  // Static banners stay non-interactive so they never intercept touches meant
  // for the content below; an interactive banner (onPress/onDismiss) opts in.
  const interactive = !!onPress || !!onDismiss;

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
          opacity,
          paddingTop: (applyTopInset ? insets.top : 0) + 10,
          backgroundColor,
          borderBottomColor: borderColor,
        },
      ]}
      pointerEvents={interactive ? 'auto' : 'none'}
      testID={testID}
    >
      <View style={styles.row}>
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
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
