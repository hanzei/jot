import React, { useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useTheme } from '../theme/ThemeContext';

export default function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const [shouldRender, setShouldRender] = useState(!isConnected);
  const opacity = useRef(new Animated.Value(isConnected ? 0 : 1)).current;

  useEffect(() => {
    if (!isConnected) {
      setShouldRender(true);
    }
    Animated.timing(opacity, {
      toValue: isConnected ? 0 : 1,
      duration: 300,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && isConnected) {
        setShouldRender(false);
      }
    });
  }, [isConnected, opacity]);

  if (!shouldRender) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          opacity,
          paddingTop: insets.top + 10,
          backgroundColor: colors.offlineBanner,
          borderBottomColor: colors.offlineBannerBorder,
        },
      ]}
      pointerEvents="none"
    >
      <View style={styles.content}>
        <Ionicons name="cloud-offline-outline" size={16} color={colors.offlineBannerText} />
        <Text style={[styles.text, { color: colors.offlineBannerText }]}>
          {t('offline.message')}
        </Text>
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
