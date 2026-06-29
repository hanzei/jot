import React from 'react';
import { View, Text, ScrollView, StyleSheet, type RefreshControlProps } from 'react-native';
import type { Note } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { styles as listStyles } from './styles';
import type { NoteSection } from './noteListUtils';

export const MASONRY_COLUMN_GAP = 12;
export const MASONRY_ROW_GAP = 12;
export const MASONRY_HORIZONTAL_PADDING = 12;

interface MasonryGridProps {
  sections: NoteSection[];
  renderCard: (note: Note) => React.ReactNode;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentBottomPadding: number;
  ListEmptyComponent?: React.ReactNode;
  /** Number of columns: 1 for the list layout, 2 for the grid. Defaults to 2. */
  columns?: number;
}

/**
 * Distributes a section's notes round-robin across the columns so each row
 * holds one card per column (a lightweight staggered layout that needs no
 * height measurement). Used for the non-draggable layouts (sorted modes,
 * archived/trash/search, and the My Tasks view). With a single column this is
 * the classic one-note-per-row list.
 */
function splitIntoColumns(notes: Note[], columns: number): Note[][] {
  const result: Note[][] = Array.from({ length: columns }, () => []);
  notes.forEach((note, index) => {
    result[index % columns].push(note);
  });
  return result;
}

export default function MasonryGrid({
  sections,
  renderCard,
  refreshControl,
  contentBottomPadding,
  ListEmptyComponent,
  columns = 2,
}: MasonryGridProps) {
  const { colors } = useTheme();
  const isEmpty = sections.every((section) => section.data.length === 0);

  return (
    <ScrollView
      keyboardShouldPersistTaps="always"
      refreshControl={refreshControl}
      contentContainerStyle={[styles.content, { paddingBottom: contentBottomPadding }]}
      testID="notes-masonry-grid"
    >
      {isEmpty
        ? ListEmptyComponent
        : sections.map((section) => {
            if (section.data.length === 0) return null;
            const columnNotesList = splitIntoColumns(section.data, columns);
            return (
              <View key={section.key}>
                {section.title ? (
                  <Text style={[listStyles.sectionHeader, { color: colors.textMuted }]}>{section.title}</Text>
                ) : null}
                <View style={styles.row}>
                  {columnNotesList.map((columnNotes, columnIndex) => (
                    <View key={columnIndex} style={styles.column} testID={`masonry-column-${columnIndex}`}>
                      {columnNotes.map((note) => (
                        <View key={note.id} style={styles.cardSlot}>
                          {renderCard(note)}
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            );
          })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: MASONRY_HORIZONTAL_PADDING,
  },
  row: {
    flexDirection: 'row',
    gap: MASONRY_COLUMN_GAP,
  },
  column: {
    flex: 1,
  },
  cardSlot: {
    marginBottom: MASONRY_ROW_GAP,
  },
});
