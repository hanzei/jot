import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import SkeletonNoteCard from './SkeletonNoteCard';

const DEFAULT_COUNT = 5;

interface SkeletonNoteListProps {
  count?: number;
}

export default function SkeletonNoteList({ count = DEFAULT_COUNT }: SkeletonNoteListProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} testID="notes-loading">
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        scrollEnabled={false}
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
