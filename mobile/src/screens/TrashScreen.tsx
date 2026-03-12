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
import { useNotes, useRestoreNote, usePermanentlyDeleteNote } from '../hooks/useNotes';
import NoteCard from '../components/NoteCard';
import type { Note } from '../types';

export default function TrashScreen() {
  const { data: notes, isLoading, refetch } = useNotes({ trashed: true });
  const restoreNote = useRestoreNote();
  const permanentlyDeleteNote = usePermanentlyDeleteNote();

  const handleLongPress = useCallback(
    (note: Note) => {
      Alert.alert('Note options', note.title || 'Untitled', [
        {
          text: 'Restore',
          onPress: () => restoreNote.mutate(note.id),
        },
        {
          text: 'Delete Permanently',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Delete Permanently', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => permanentlyDeleteNote.mutate(note.id),
              },
            ]),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [restoreNote, permanentlyDeleteNote]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>Items in Trash are deleted after 7 days</Text>
      </View>
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
            <Text style={styles.emptyText}>Trash is empty</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  banner: {
    backgroundColor: '#fff3cd',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ffc107',
  },
  bannerText: { textAlign: 'center', color: '#856404', fontSize: 14 },
  loader: { flex: 1 },
  list: { padding: 8 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 48, fontSize: 16 },
});
