import React, { useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

interface BannerProps {
  /** Whether the banner should be shown. Toggling animates a fade in/out. */
  visible: boolean;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}

/**
 * A top-of-screen status banner that fades in/out and applies the top safe-area
 * inset itself (screens use headerShown: false). Shared by OfflineBanner and
 * SyncErrorBanner so the show/hide animation lives in one place.
 */
export default function Banner({ visible, icon, text, backgroundColor, borderColor, textColor }: BannerProps) {
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const [shouldRender, setShouldRender] = useState(visible);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
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

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          opacity,
          paddingTop: insets.top + 10,
          backgroundColor,
          borderBottomColor: borderColor,
        },
      ]}
      pointerEvents="none"
    >
      <View style={styles.content}>
        <Ionicons name={icon} size={16} color={textColor} />
        <Text style={[styles.text, { color: textColor }]}>{text}</Text>
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
});
