import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNotes, useUpdateNote, useDeleteNote } from '../hooks/useNotes';
import NoteCard from '../components/NoteCard';
import type { Note } from '../types';

export default function ArchivedScreen() {
  const { data: notes, isLoading, refetch } = useNotes({ archived: true });
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();

  const handleLongPress = useCallback(
    (note: Note) => {
      Alert.alert('Note options', note.title || 'Untitled', [
        {
          text: 'Unarchive',
          onPress: () =>
            updateNote.mutate({
              id: note.id,
              data: {
                title: note.title,
                content: note.content,
                pinned: note.pinned,
                archived: false,
                color: note.color,
                checked_items_collapsed: note.checked_items_collapsed,
              },
            }),
        },
        {
          text: 'Move to Trash',
          style: 'destructive',
          onPress: () => deleteNote.mutate(note.id),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [updateNote, deleteNote]
  );

  return (
    <SafeAreaView style={styles.container}>
      {isLoading ? (
        <ActivityIndicator style={styles.loader} size="large" />
      ) : (
        <FlatList
          data={notes ?? []}
          renderItem={({ item }) => (
            <NoteCard
              note={item}
              onPress={() => {}}
              onLongPress={() => handleLongPress(item)}
            />
          )}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No archived notes</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  loader: { flex: 1 },
  list: { padding: 8 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 48, fontSize: 16 },
});
