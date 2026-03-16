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
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useUpdateNote, useDeleteNote, useRestoreNote, usePermanentDeleteNote, useReorderNotes } from '../hooks/useNotes';
import { useOfflineNotes } from '../hooks/useOfflineNotes';
import { useUsers } from '../store/UsersContext';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import NoteCard from '../components/NoteCard';
import NoteContextMenu, { ContextMenuViewContext } from '../components/NoteContextMenu';
import ColorPicker from '../components/ColorPicker';
import { Note } from '../types';
import type { RootStackParamList } from '../navigation/RootNavigator';

interface NotesListScreenProps {
  variant?: 'notes' | 'archived' | 'trash' | 'my-todo';
  labelId?: string;
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'MainDrawer'>;

const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_NOTES: Note[] = [];

interface LocalReorderState {
  pinned: Note[] | null;
  unpinned: Note[] | null;
}

export default function NotesListScreen({ variant = 'notes', labelId }: NotesListScreenProps) {
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const { user } = useAuth();
  const { colors } = useTheme();

  const [contextMenuNote, setContextMenuNote] = useState<Note | null>(null);
  const [colorPickerNote, setColorPickerNote] = useState<Note | null>(null);
  const [localOrder, setLocalOrder] = useState<LocalReorderState>({ pinned: null, unpinned: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refreshUsers } = useUsers();

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
    label: variant === 'notes' ? labelId : undefined,
    my_todo: variant === 'my-todo' ? true : undefined,
    user_id: variant === 'my-todo' ? user?.id : undefined,
  }), [variant, debouncedSearch, labelId, user?.id]);

  const { data: notes, isLoading, isError, refetch, isRefetching } = useOfflineNotes(params);
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

  const handleRefresh = useCallback(() => {
    refetch();
    refreshUsers();
  }, [refetch, refreshUsers]);

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
      await updateNote.mutateAsync({
        id: note.id,
        data: {
          title: note.title,
          content: note.content,
          pinned: !note.pinned,
          archived: note.archived,
          color: note.color,
          checked_items_collapsed: note.checked_items_collapsed,
        },
      });
    } catch {
      Alert.alert('Error', 'Failed to update note');
    }
  }, [updateNote]);

  const handleArchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({
        id: note.id,
        data: {
          title: note.title,
          content: note.content,
          pinned: note.pinned,
          archived: true,
          color: note.color,
          checked_items_collapsed: note.checked_items_collapsed,
        },
      });
    } catch {
      Alert.alert('Error', 'Failed to archive note');
    }
  }, [updateNote]);

  const handleUnarchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({
        id: note.id,
        data: {
          title: note.title,
          content: note.content,
          pinned: note.pinned,
          archived: false,
          color: note.color,
          checked_items_collapsed: note.checked_items_collapsed,
        },
      });
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

  const handleShare = useCallback((note: Note) => {
    navigation.navigate('Share', { noteId: note.id });
  }, [navigation]);

  const handleColorSelect = useCallback(async (color: string) => {
    if (!colorPickerNote) return;
    try {
      await updateNote.mutateAsync({
        id: colorPickerNote.id,
        data: {
          title: colorPickerNote.title,
          content: colorPickerNote.content,
          pinned: colorPickerNote.pinned,
          archived: colorPickerNote.archived,
          color,
          checked_items_collapsed: colorPickerNote.checked_items_collapsed,
        },
      });
    } catch {
      Alert.alert('Error', 'Failed to update note color');
    }
  }, [colorPickerNote, updateNote]);

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
      debouncedSearch || labelId ? (
        <View style={styles.emptySearchContainer}>
          <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>
            {debouncedSearch ? 'No notes match your search' : 'No notes for this label'}
          </Text>
        </View>
      ) : null,
    [debouncedSearch, labelId, colors],
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
        <View style={isActive ? styles.draggingCard : undefined}>
          <NoteCard
            note={item}
            onPress={() => handleNotePress(item.id)}
            onLongPress={drag}
            onMenuPress={() => handleOpenMenu(item)}
          />
        </View>
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
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]} testID="notes-loading">
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.emptyContainer, { backgroundColor: colors.background }]} testID="notes-error-state">
        <Ionicons name="cloud-offline-outline" size={64} color={colors.handleColor} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Failed to load notes</Text>
        <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>Check your connection and try again</Text>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: colors.primary }]}
          onPress={() => refetch()}
          testID="retry-fetch"
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isEmpty = !isLoading && (!notes || notes.length === 0);

  if (isEmpty && !debouncedSearch && (variant !== 'notes' || !labelId)) {
    return (
      <View style={[styles.emptyContainer, { backgroundColor: colors.background }]}>
        {variant === 'trash' && (
          <View style={[styles.trashBanner, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}>
            <Text style={[styles.trashBannerText, { color: colors.warningText }]}>
              Items in Trash are automatically deleted after 7 days
            </Text>
          </View>
        )}
        <Ionicons
          name={variant === 'my-todo' ? 'clipboard-outline' : 'document-text-outline'}
          size={64}
          color={colors.handleColor}
        />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {variant === 'notes' && 'No notes yet'}
          {variant === 'my-todo' && 'No assigned todos'}
          {variant === 'archived' && 'No archived notes'}
          {variant === 'trash' && 'Trash is empty'}
        </Text>
        <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>
          {variant === 'notes' && 'Tap + to create your first note'}
          {variant === 'my-todo' && 'No notes with todos assigned to you'}
          {variant === 'archived' && 'Archived notes will appear here'}
          {variant === 'trash' && 'Deleted notes will appear here'}
        </Text>
        {variant === 'notes' && (
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: colors.primary }]}
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

  // Drag-and-drop is only available in the notes variant (not archived/trash/my-todo)
  const isDraggable = variant === 'notes';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Trash banner */}
      {variant === 'trash' && (
        <View style={[styles.trashBanner, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warningText} style={styles.trashBannerIcon} />
          <Text style={[styles.trashBannerText, { color: colors.warningText }]}>
            Items in Trash are automatically deleted after 7 days
          </Text>
        </View>
      )}

      {/* Search bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.searchBackground, borderColor: colors.searchBorder }]}>
        <Ionicons name="search" size={18} color={colors.iconMuted} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search notes..."
          placeholderTextColor={colors.placeholder}
          value={searchText}
          onChangeText={setSearchText}
          returnKeyType="search"
          testID="search-input"
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={handleClearSearch} testID="clear-search">
            <Ionicons name="close-circle" size={18} color={colors.iconMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Notes list */}
      {isDraggable && hasPinned ? (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          contentContainerStyle={styles.listContent}
          testID="notes-section-list"
        >
          {displayPinned.length > 0 && (
            <>
              <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>Pinned</Text>
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
              <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>Others</Text>
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
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
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
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={listEmptyComponent}
          testID="notes-flat-list"
        />
      )}

      {variant === 'notes' && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.primary }]}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
  },
  emptySearchContainer: {
    paddingTop: 48,
    alignItems: 'center',
  },
  trashBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  trashBannerIcon: {
    marginRight: 8,
  },
  trashBannerText: {
    fontSize: 13,
    flex: 1,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 40,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
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
