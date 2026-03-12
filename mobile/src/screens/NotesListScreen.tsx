import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNotes, useDeleteNote, useUpdateNote } from '../hooks/useNotes';
import { useSync } from '../hooks/useSync';
import NoteCard from '../components/NoteCard';
import NoteEditorScreen from './NoteEditorScreen';
import ShareScreen from './ShareScreen';
import type { Note } from '../types';

export default function NotesListScreen() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [editingNote, setEditingNote] = useState<Note | null | undefined>(undefined);
  const [sharingNote, setSharingNote] = useState<Note | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  const { data: notes, isLoading, refetch } = useNotes({
    search: debouncedSearch || undefined,
  });
  const deleteNote = useDeleteNote();
  const updateNote = useUpdateNote();

  useSync();

  const handleSearchChange = (text: string) => {
    setSearch(text);
    if (searchTimeout) clearTimeout(searchTimeout);
    const t = setTimeout(() => setDebouncedSearch(text), 300);
    setSearchTimeout(t);
  };

  const handleLongPress = useCallback((note: Note) => {
    Alert.alert('Note options', note.title || 'Untitled', [
      {
        text: note.pinned ? 'Unpin' : 'Pin',
        onPress: () =>
          updateNote.mutate({
            id: note.id,
            data: {
              title: note.title,
              content: note.content,
              pinned: !note.pinned,
              archived: note.archived,
              color: note.color,
              checked_items_collapsed: note.checked_items_collapsed,
              items: note.items?.map((i) => ({
                text: i.text,
                position: i.position,
                completed: i.completed,
                indent_level: i.indent_level,
              })),
            },
          }),
      },
      {
        text: 'Archive',
        onPress: () =>
          updateNote.mutate({
            id: note.id,
            data: {
              title: note.title,
              content: note.content,
              pinned: note.pinned,
              archived: true,
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
      {
        text: 'Share',
        onPress: () => setSharingNote(note),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [updateNote, deleteNote]);

  const pinnedNotes = notes?.filter((n) => n.pinned) ?? [];
  const otherNotes = notes?.filter((n) => !n.pinned) ?? [];

  const renderItem = ({ item }: { item: Note }) => (
    <NoteCard
      note={item}
      onPress={() => setEditingNote(item)}
      onLongPress={() => handleLongPress(item)}
    />
  );

  const listData: Note[] = [
    ...(pinnedNotes.length > 0 ? pinnedNotes : []),
    ...(otherNotes.length > 0 ? otherNotes : []),
  ];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">Jot</Text>
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={20} color="#999" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes"
          value={search}
          onChangeText={handleSearchChange}
          accessibilityLabel="Search notes"
          allowFontScaling
        />
      </View>

      {isLoading ? (
        <ActivityIndicator style={styles.loader} size="large" />
      ) : (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={isLoading} onRefresh={refetch} />
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {search ? 'No notes match your search' : 'No notes yet. Tap + to create one.'}
            </Text>
          }
        />
      )}

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setEditingNote(null)}
        accessibilityRole="button"
        accessibilityLabel="Create new note"
      >
        <Ionicons name="add" size={32} color="#fff" />
      </TouchableOpacity>

      <Modal
        visible={editingNote !== undefined}
        animationType="slide"
        onRequestClose={() => setEditingNote(undefined)}
      >
        {editingNote !== undefined && (
          <NoteEditorScreen
            note={editingNote}
            onClose={() => setEditingNote(undefined)}
            onShare={(note) => {
              setEditingNote(undefined);
              setSharingNote(note);
            }}
          />
        )}
      </Modal>

      <Modal
        visible={sharingNote !== null}
        animationType="slide"
        onRequestClose={() => setSharingNote(null)}
      >
        {sharingNote && (
          <ShareScreen note={sharingNote} onClose={() => setSharingNote(null)} />
        )}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  headerTitle: { fontSize: 28, fontWeight: 'bold' },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    padding: 8,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    minHeight: 48,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 16 },
  loader: { flex: 1 },
  list: { padding: 8 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 48, fontSize: 16 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1a73e8',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
});
