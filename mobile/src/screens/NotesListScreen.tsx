import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  SectionList,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNotes } from '../hooks/useNotes';
import NoteCard from '../components/NoteCard';
import { Note } from '../types';
import type { RootStackParamList } from '../navigation/RootNavigator';

interface NotesListScreenProps {
  variant?: 'notes' | 'archived' | 'trash';
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'MainTabs'>;

export default function NotesListScreen({ variant = 'notes' }: NotesListScreenProps) {
  const [searchText, setSearchText] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');

  const params = useMemo(() => ({
    archived: variant === 'archived' ? true : undefined,
    trashed: variant === 'trash' ? true : undefined,
    search: submittedSearch || undefined,
  }), [variant, submittedSearch]);

  const { data: notes, isLoading, refetch, isRefetching } = useNotes(params);
  const navigation = useNavigation<NavigationProp>();

  const handleSearch = useCallback(() => {
    setSubmittedSearch(searchText.trim());
  }, [searchText]);

  const handleClearSearch = useCallback(() => {
    setSearchText('');
    setSubmittedSearch('');
  }, []);

  const handleNotePress = useCallback(
    (noteId: string) => {
      navigation.navigate('NoteEditor', { noteId });
    },
    [navigation],
  );

  const handleCreateNote = useCallback(() => {
    navigation.navigate('NoteEditor', { noteId: null });
  }, [navigation]);

  const { pinnedNotes, otherNotes } = useMemo(() => {
    const pinned: Note[] = [];
    const other: Note[] = [];
    for (const n of notes ?? []) {
      (n.pinned ? pinned : other).push(n);
    }
    return { pinnedNotes: pinned, otherNotes: other };
  }, [notes]);
  const hasPinned = pinnedNotes.length > 0;

  const renderNoteCard = useCallback(
    ({ item }: { item: Note }) => (
      <NoteCard note={item} onPress={() => handleNotePress(item.id)} />
    ),
    [handleNotePress],
  );

  const isEmpty = !isLoading && (!notes || notes.length === 0);

  if (isEmpty && !submittedSearch) {
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="document-text-outline" size={64} color="#d1d5db" />
        <Text style={styles.emptyTitle}>
          {variant === 'notes' && 'No notes yet'}
          {variant === 'archived' && 'No archived notes'}
          {variant === 'trash' && 'Trash is empty'}
        </Text>
        <Text style={styles.emptySubtext}>
          {variant === 'notes' && 'Tap + to create your first note'}
          {variant === 'archived' && 'Archived notes will appear here'}
          {variant === 'trash' && 'Deleted notes will appear here'}
        </Text>
        {variant === 'notes' && (
          <TouchableOpacity style={styles.fab} onPress={handleCreateNote} testID="create-note-fab">
            <Ionicons name="add" size={28} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const sections = hasPinned
    ? [
        { title: 'Pinned', data: pinnedNotes },
        { title: 'Others', data: otherNotes },
      ].filter((s) => s.data.length > 0)
    : [{ title: '', data: otherNotes }];

  return (
    <View style={styles.container}>
      {variant === 'notes' && (
        <View style={styles.searchContainer}>
          <Ionicons name="search" size={18} color="#999" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search notes..."
            placeholderTextColor="#999"
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
            testID="search-input"
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={handleClearSearch} testID="clear-search">
              <Ionicons name="close-circle" size={18} color="#999" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {hasPinned ? (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderNoteCard}
          renderSectionHeader={({ section: { title } }) =>
            title ? (
              <Text style={styles.sectionHeader}>{title}</Text>
            ) : null
          }
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#2563eb" />
          }
          contentContainerStyle={styles.listContent}
          testID="notes-section-list"
        />
      ) : (
        <FlatList
          data={notes ?? []}
          keyExtractor={(item) => item.id}
          renderItem={renderNoteCard}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#2563eb" />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            submittedSearch ? (
              <View style={styles.emptySearchContainer}>
                <Text style={styles.emptySubtext}>No notes match your search</Text>
              </View>
            ) : null
          }
          testID="notes-flat-list"
        />
      )}

      {variant === 'notes' && (
        <TouchableOpacity style={styles.fab} onPress={handleCreateNote} testID="create-note-fab">
          <Ionicons name="add" size={28} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 8,
  },
  emptySearchContainer: {
    paddingTop: 48,
    alignItems: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    margin: 16,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    height: 40,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#1a1a1a',
    paddingVertical: 0,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  listContent: {
    paddingBottom: 80,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
});
