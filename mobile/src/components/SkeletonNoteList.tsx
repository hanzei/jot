import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import SkeletonNoteCard from './SkeletonNoteCard';

const DEFAULT_COUNT = 5;

interface SkeletonNoteListProps {
  count?: number;
}

export default function SkeletonNoteList({ count = DEFAULT_COUNT }: SkeletonNoteListProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
      testID="notes-loading"
      accessible
      accessibilityState={{ busy: true }}
      accessibilityLabel={t('common.loading')}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {Array.from({ length: count }, (_, index) => (
          <SkeletonNoteCard key={`skeleton-note-${index}`} hasTitle={index % 3 !== 1} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: 8,
  },
});
