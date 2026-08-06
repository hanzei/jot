import React, { useMemo, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, type RefreshControlProps } from 'react-native';
import type { Note } from '@jot/shared';
import { useTheme } from '../../theme/ThemeContext';
import { animateListReflow } from '../../utils/layoutAnimation';
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
  /**
   * Signature of the active view/filter/sort/layout. When it changes the grid
   * swaps instantly (no enter/leave); only in-view note add/remove/reorder
   * within the *same* view animates — mirroring the webapp's AnimatedNoteGrid.
   */
  viewKey?: string;
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
    result[index % columns]!.push(note);
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
  viewKey,
}: MasonryGridProps) {
  const { colors } = useTheme();
  const isEmpty = sections.every((section) => section.data.length === 0);

  // Order-sensitive signature of every note id currently rendered. When it
  // changes *within the same view* (a note created, deleted, archived, pinned,
  // reordered, or arriving via sync) we queue a subtle layout animation for the
  // next commit so cards fade/slide in and out instead of popping. The first
  // populate and any view/search/sort switch swap instantly (guarded below), so
  // navigating never animates a whole list in. animateListReflow already no-ops
  // under the OS "Reduce Motion" setting.
  const idSignature = useMemo(
    () => sections.map((section) => `${section.key}:${section.data.map((note) => note.id).join(',')}`).join('|'),
    [sections],
  );
  const prevSignatureRef = useRef<string | null>(null);
  const prevViewKeyRef = useRef(viewKey);
  if (
    // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
    prevSignatureRef.current !== null &&
    // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
    prevViewKeyRef.current === viewKey &&
    // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
    prevSignatureRef.current !== idSignature
  ) {
    animateListReflow();
  }
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  prevSignatureRef.current = idSignature;
  // eslint-disable-next-line react-hooks/refs -- pre-existing, tracked in #777
  prevViewKeyRef.current = viewKey;

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
