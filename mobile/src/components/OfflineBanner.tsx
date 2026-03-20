import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useTheme } from '../theme/ThemeContext';

export default function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const { colors } = useTheme();
  const { t } = useTranslation();
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
    <Animated.View style={[styles.banner, { opacity, backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]} pointerEvents="none">
      <Text style={[styles.text, { color: colors.warningText }]}>
        {t('offline.message')}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  text: {
    fontSize: 13,
    textAlign: 'center',
  },
});
