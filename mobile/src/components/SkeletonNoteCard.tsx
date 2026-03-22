import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

interface SkeletonNoteCardProps {
  hasTitle?: boolean;
}

export default function SkeletonNoteCard({ hasTitle = true }: SkeletonNoteCardProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [opacity]);

  const placeholderStyle = { backgroundColor: colors.border, opacity };

  return (
    <View style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.cardBorder }]}>
      {hasTitle ? <Animated.View style={[styles.title, placeholderStyle]} /> : null}

      <Animated.View style={[styles.contentLine, styles.contentLineWide, placeholderStyle]} />
      <Animated.View style={[styles.contentLine, styles.contentLineMedium, placeholderStyle]} />
      <Animated.View style={[styles.contentLine, styles.contentLineNarrow, placeholderStyle]} />

      <View style={styles.footer}>
        <Animated.View style={[styles.chip, placeholderStyle]} />
        <Animated.View style={[styles.chip, styles.chipSmall, placeholderStyle]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 5,
  },
  title: {
    height: 16,
    width: '60%',
    borderRadius: 6,
    marginBottom: 8,
  },
  contentLine: {
    height: 14,
    borderRadius: 6,
    marginBottom: 8,
  },
  contentLineWide: {
    width: '90%',
  },
  contentLineMedium: {
    width: '75%',
  },
  contentLineNarrow: {
    width: '50%',
    marginBottom: 12,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    width: 56,
    height: 20,
    borderRadius: 10,
  },
  chipSmall: {
    width: 48,
  },
});
