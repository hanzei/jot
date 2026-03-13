import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

export default function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
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
    <Animated.View style={[styles.banner, { opacity }]} pointerEvents="none">
      <Text style={styles.text}>
        {"You're offline. Changes will sync when you reconnect."}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#fef3c7',
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  text: {
    fontSize: 13,
    color: '#92400e',
    textAlign: 'center',
  },
});
