import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNotes, useUpdateNote, useDeleteNote, useRestoreNote, usePermanentDeleteNote, useReorderNotes } from '../hooks/useNotes';
import { useLabels } from '../hooks/useLabels';
import NoteCard from '../components/NoteCard';
import NoteContextMenu, { ContextMenuViewContext } from '../components/NoteContextMenu';
import ColorPicker from '../components/ColorPicker';
import { Note } from '../types';
import type { RootStackParamList } from '../navigation/RootNavigator';

interface NotesListScreenProps {
  variant?: 'notes' | 'archived' | 'trash';
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'MainTabs'>;

const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_NOTES: Note[] = [];

interface LocalReorderState {
  pinned: Note[] | null;
  unpinned: Note[] | null;
}

export default function NotesListScreen({ variant = 'notes' }: NotesListScreenProps) {
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedLabelId, setSelectedLabelId] = useState<string | undefined>(undefined);
  const [contextMenuNote, setContextMenuNote] = useState<Note | null>(null);
  const [colorPickerNote, setColorPickerNote] = useState<Note | null>(null);
  const [localOrder, setLocalOrder] = useState<LocalReorderState>({ pinned: null, unpinned: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input by 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchText.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchText]);

  const params = useMemo(() => ({
    archived: variant === 'archived' ? true : undefined,
    trashed: variant === 'trash' ? true : undefined,
    search: debouncedSearch || undefined,
    label: variant === 'notes' ? selectedLabelId : undefined,
  }), [variant, debouncedSearch, selectedLabelId]);

  const { data: notes, isLoading, isError, refetch, isRefetching } = useNotes(params);
  const { data: allLabels } = useLabels();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const restoreNote = useRestoreNote();
  const permanentDeleteNote = usePermanentDeleteNote();
  const reorderNotes = useReorderNotes();
  const navigation = useNavigation<NavigationProp>();

  const handleClearSearch = useCallback(() => {
    setSearchText('');
    setDebouncedSearch('');
  }, []);

  const handleNotePress = useCallback(
    (noteId: string) => {
      if (variant === 'trash') return; // read-only
      navigation.navigate('NoteEditor', { noteId });
    },
    [navigation, variant],
  );

  const handleCreateNote = useCallback(() => {
    navigation.navigate('NoteEditor', { noteId: null });
  }, [navigation]);

  const handleOpenMenu = useCallback((note: Note) => {
    setContextMenuNote(note);
  }, []);

  // Context menu actions
  const handlePin = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({ id: note.id, data: { pinned: !note.pinned } });
    } catch {
      Alert.alert('Error', 'Failed to update note');
    }
  }, [updateNote]);

  const handleArchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({ id: note.id, data: { archived: true } });
    } catch {
      Alert.alert('Error', 'Failed to archive note');
    }
  }, [updateNote]);

  const handleUnarchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({ id: note.id, data: { archived: false } });
    } catch {
      Alert.alert('Error', 'Failed to unarchive note');
    }
  }, [updateNote]);

  const handleMoveToTrash = useCallback(async (note: Note) => {
    try {
      await deleteNote.mutateAsync(note.id);
    } catch {
      Alert.alert('Error', 'Failed to move note to trash');
    }
  }, [deleteNote]);

  const handleRestore = useCallback(async (note: Note) => {
    try {
      await restoreNote.mutateAsync(note.id);
    } catch {
      Alert.alert('Error', 'Failed to restore note');
    }
  }, [restoreNote]);

  const handleDeletePermanently = useCallback((note: Note) => {
    Alert.alert(
      'Delete permanently',
      'This note will be deleted forever. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await permanentDeleteNote.mutateAsync(note.id);
            } catch {
              Alert.alert('Error', 'Failed to delete note');
            }
          },
        },
      ],
    );
  }, [permanentDeleteNote]);

  const handleChangeColor = useCallback((note: Note) => {
    setColorPickerNote(note);
  }, []);

  const handleShare = useCallback((_note: Note) => {
    Alert.alert('Share', 'Note sharing is coming soon.');
  }, []);

  const handleColorSelect = useCallback(async (color: string) => {
    if (!colorPickerNote) return;
    try {
      await updateNote.mutateAsync({ id: colorPickerNote.id, data: { color } });
    } catch {
      Alert.alert('Error', 'Failed to update note color');
    }
  }, [colorPickerNote, updateNote]);

  const handleLabelChipPress = useCallback((labelId: string) => {
    setSelectedLabelId((prev) => (prev === labelId ? undefined : labelId));
  }, []);

  const { pinnedNotes, otherNotes } = useMemo(() => {
    const pinned: Note[] = [];
    const other: Note[] = [];
    for (const n of notes ?? []) {
      (n.pinned ? pinned : other).push(n);
    }
    return { pinnedNotes: pinned, otherNotes: other };
  }, [notes]);

  // Clear local order overrides when server data changes
  useEffect(() => {
    setLocalOrder({ pinned: null, unpinned: null });
  }, [notes]);

  const displayPinned = localOrder.pinned ?? pinnedNotes;
  const displayUnpinned = localOrder.unpinned ?? otherNotes;

  // Refs to avoid stale closures in handleDragEnd
  const displayPinnedRef = useRef(displayPinned);
  displayPinnedRef.current = displayPinned;
  const displayUnpinnedRef = useRef(displayUnpinned);
  displayUnpinnedRef.current = displayUnpinned;

  const hasPinned = variant === 'notes' && pinnedNotes.length > 0;

  const listEmptyComponent = useMemo(
    () =>
      debouncedSearch || selectedLabelId ? (
        <View style={styles.emptySearchContainer}>
          <Text style={styles.emptySubtext}>No notes match your search</Text>
        </View>
      ) : null,
    [debouncedSearch, selectedLabelId],
  );

  const handleDragEnd = useCallback(
    async (newData: Note[], isPinnedSection: boolean) => {
      // Optimistically update local order
      setLocalOrder(prev => isPinnedSection
        ? { ...prev, pinned: newData }
        : { ...prev, unpinned: newData },
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

      // Build full reorder payload: pinned first, then unpinned
      const pinnedIds = isPinnedSection
        ? newData.map((n) => n.id)
        : displayPinnedRef.current.map((n) => n.id);
      const unpinnedIds = isPinnedSection
        ? displayUnpinnedRef.current.map((n) => n.id)
        : newData.map((n) => n.id);
      const allIds = [...pinnedIds, ...unpinnedIds];

      try {
        await reorderNotes.mutateAsync(allIds);
      } catch {
        // Revert optimistic update
        setLocalOrder(prev => isPinnedSection
          ? { ...prev, pinned: null }
          : { ...prev, unpinned: null },
        );
        Alert.alert('Error', 'Failed to reorder notes');
      }
    },
    [reorderNotes],
  );

  const handleDragEndPinned = useCallback(
    ({ data }: { data: Note[] }) => handleDragEnd(data, true),
    [handleDragEnd],
  );

  const handleDragEndUnpinned = useCallback(
    ({ data }: { data: Note[] }) => handleDragEnd(data, false),
    [handleDragEnd],
  );

  const handleDragStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const renderDraggableNoteCard = useCallback(
    ({ item, drag, isActive }: { item: Note; drag: () => void; isActive: boolean }) => (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={drag}
          disabled={isActive}
          activeOpacity={0.7}
          style={isActive ? styles.draggingCard : undefined}
        >
          <NoteCard
            note={item}
            onPress={() => handleNotePress(item.id)}
            onMenuPress={() => handleOpenMenu(item)}
          />
        </TouchableOpacity>
      </ScaleDecorator>
    ),
    [handleNotePress, handleOpenMenu],
  );

  const renderNonDraggableNoteCard = useCallback(
    ({ item }: { item: Note }) => (
      <NoteCard
        note={item}
        onPress={() => handleNotePress(item.id)}
        onMenuPress={variant !== 'trash' ? () => handleOpenMenu(item) : undefined}
        onLongPress={variant === 'trash' ? () => handleOpenMenu(item) : undefined}
      />
    ),
    [handleNotePress, handleOpenMenu, variant],
  );

  if (isLoading && !notes) {
    return (
      <View style={styles.loadingContainer} testID="notes-loading">
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.emptyContainer} testID="notes-error-state">
        <Ionicons name="cloud-offline-outline" size={64} color="#d1d5db" />
        <Text style={styles.emptyTitle}>Failed to load notes</Text>
        <Text style={styles.emptySubtext}>Check your connection and try again</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => refetch()}
          testID="retry-fetch"
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isEmpty = !isLoading && (!notes || notes.length === 0);

  if (isEmpty && !debouncedSearch && !selectedLabelId) {
    return (
      <View style={styles.emptyContainer}>
        {variant === 'trash' && (
          <View style={styles.trashBanner}>
            <Text style={styles.trashBannerText}>
              Items in Trash are automatically deleted after 7 days
            </Text>
          </View>
        )}
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
          <TouchableOpacity
            style={styles.fab}
            onPress={handleCreateNote}
            testID="create-note-fab"
            accessibilityLabel="Create note"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={28} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // Drag-and-drop is only available in the notes variant (not archived/trash)
  const isDraggable = variant === 'notes';

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* Trash banner */}
      {variant === 'trash' && (
        <View style={styles.trashBanner}>
          <Ionicons name="information-circle-outline" size={16} color="#92400e" style={styles.trashBannerIcon} />
          <Text style={styles.trashBannerText}>
            Items in Trash are automatically deleted after 7 days
          </Text>
        </View>
      )}

      {/* Search bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={18} color="#999" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes..."
          placeholderTextColor="#999"
          value={searchText}
          onChangeText={setSearchText}
          returnKeyType="search"
          testID="search-input"
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={handleClearSearch} testID="clear-search">
            <Ionicons name="close-circle" size={18} color="#999" />
          </TouchableOpacity>
        )}
      </View>

      {/* Label filter chips (notes only) */}
      {variant === 'notes' && allLabels && allLabels.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.labelChipsRow}
          testID="label-filter-row"
        >
          <TouchableOpacity
            style={[styles.labelChip, !selectedLabelId && styles.labelChipActive]}
            onPress={() => setSelectedLabelId(undefined)}
            testID="label-chip-all"
          >
            <Text style={[styles.labelChipText, !selectedLabelId && styles.labelChipTextActive]}>
              All
            </Text>
          </TouchableOpacity>
          {allLabels.map((label) => (
            <TouchableOpacity
              key={label.id}
              style={[styles.labelChip, selectedLabelId === label.id && styles.labelChipActive]}
              onPress={() => handleLabelChipPress(label.id)}
              testID={`label-chip-${label.id}`}
            >
              <Text
                style={[
                  styles.labelChipText,
                  selectedLabelId === label.id && styles.labelChipTextActive,
                ]}
              >
                {label.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Notes list */}
      {isDraggable && hasPinned ? (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#2563eb" />
          }
          contentContainerStyle={styles.listContent}
          testID="notes-section-list"
        >
          {displayPinned.length > 0 && (
            <>
              <Text style={styles.sectionHeader}>Pinned</Text>
              <DraggableFlatList
                data={displayPinned}
                keyExtractor={(item) => item.id}
                renderItem={renderDraggableNoteCard}
                onDragBegin={handleDragStart}
                onDragEnd={handleDragEndPinned}
                scrollEnabled={false}
              />
            </>
          )}
          {displayUnpinned.length > 0 && (
            <>
              <Text style={styles.sectionHeader}>Others</Text>
              <DraggableFlatList
                data={displayUnpinned}
                keyExtractor={(item) => item.id}
                renderItem={renderDraggableNoteCard}
                onDragBegin={handleDragStart}
                onDragEnd={handleDragEndUnpinned}
                scrollEnabled={false}
              />
            </>
          )}
          {displayPinned.length === 0 && displayUnpinned.length === 0 && listEmptyComponent}
        </ScrollView>
      ) : isDraggable ? (
        <DraggableFlatList
          data={displayUnpinned}
          keyExtractor={(item) => item.id}
          renderItem={renderDraggableNoteCard}
          onDragBegin={handleDragStart}
          onDragEnd={handleDragEndUnpinned}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#2563eb" />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={listEmptyComponent}
          testID="notes-flat-list"
        />
      ) : (
        <FlatList
          data={notes ?? EMPTY_NOTES}
          keyExtractor={(item) => item.id}
          renderItem={renderNonDraggableNoteCard}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#2563eb" />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={listEmptyComponent}
          testID="notes-flat-list"
        />
      )}

      {variant === 'notes' && (
        <TouchableOpacity
          style={styles.fab}
          onPress={handleCreateNote}
          testID="create-note-fab"
          accessibilityLabel="Create note"
          accessibilityRole="button"
        >
          <Ionicons name="add" size={28} color="#fff" />
        </TouchableOpacity>
      )}

      <NoteContextMenu
        visible={contextMenuNote !== null}
        note={contextMenuNote}
        viewContext={variant as ContextMenuViewContext}
        onClose={() => setContextMenuNote(null)}
        onPin={handlePin}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        onMoveToTrash={handleMoveToTrash}
        onRestore={handleRestore}
        onDeletePermanently={handleDeletePermanently}
        onChangeColor={handleChangeColor}
        onShare={handleShare}
      />

      <ColorPicker
        visible={colorPickerNote !== null}
        currentColor={colorPickerNote?.color ?? '#ffffff'}
        onSelect={handleColorSelect}
        onClose={() => setColorPickerNote(null)}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
  trashBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
  },
  trashBannerIcon: {
    marginRight: 8,
  },
  trashBannerText: {
    fontSize: 13,
    color: '#92400e',
    flex: 1,
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
  labelChipsRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  labelChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  labelChipActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#2563eb',
  },
  labelChipText: {
    fontSize: 13,
    color: '#666',
  },
  labelChipTextActive: {
    color: '#2563eb',
    fontWeight: '600',
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
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2563eb',
  },
  retryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
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
  draggingCard: {
    opacity: 0.9,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
});
