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
import { useSQLiteContext } from 'expo-sqlite';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useUpdateNote, useDeleteNote, useRestoreNote, usePermanentDeleteNote, useReorderNotes, useDuplicateNote } from '../hooks/useNotes';
import { useOfflineNotes } from '../hooks/useOfflineNotes';
import { useUsers } from '../store/UsersContext';
import { useAuth } from '../store/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { isLocalId } from '../db/noteQueries';
import NoteCard from '../components/NoteCard';
import NoteContextMenu, { ContextMenuViewContext } from '../components/NoteContextMenu';
import ColorPicker from '../components/ColorPicker';
import type { Note } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { emptyTrash as emptyTrashNotes } from '../api/notes';
import { getLocalNotes, permanentDeleteLocalNote } from '../db/noteQueries';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

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
  const [trashCount, setTrashCount] = useState(0);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const { user } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const [contextMenuNote, setContextMenuNote] = useState<Note | null>(null);
  const [colorPickerNote, setColorPickerNote] = useState<Note | null>(null);
  const [localOrder, setLocalOrder] = useState<LocalReorderState>({ pinned: null, unpinned: null });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trashCountRef = useRef(0);
  trashCountRef.current = trashCount;
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
  const isSearchLoading = isLoading && !notes && !!debouncedSearch;
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const restoreNote = useRestoreNote();
  const permanentDeleteNote = usePermanentDeleteNote();
  const duplicateNote = useDuplicateNote();
  const reorderNotes = useReorderNotes();
  const navigation = useNavigation<NavigationProp>();

  const handleClearSearch = useCallback(() => {
    setSearchText('');
    setDebouncedSearch('');
  }, []);

  const handleRefresh = useCallback(async () => {
    await refetch();
    await refreshUsers();
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
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [t, updateNote]);

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
      Alert.alert(t('common.error'), t('note.failedArchive'));
    }
  }, [t, updateNote]);

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
      Alert.alert(t('common.error'), t('note.failedUnarchive'));
    }
  }, [t, updateNote]);

  const handleMoveToTrash = useCallback(async (note: Note) => {
    try {
      await deleteNote.mutateAsync(note.id);
    } catch {
      Alert.alert(t('common.error'), t('note.failedMoveToTrash'));
    }
  }, [deleteNote, t]);

  const handleRestore = useCallback(async (note: Note) => {
    try {
      await restoreNote.mutateAsync(note.id);
    } catch {
      Alert.alert(t('common.error'), t('note.failedRestore'));
    }
  }, [restoreNote, t]);

  const handleDuplicate = useCallback(async (note: Note) => {
    if (isLocalId(note.id)) {
      Alert.alert(t('common.error'), t('note.waitForSyncBeforeDuplicating'));
      return;
    }

    try {
      await duplicateNote.mutateAsync(note.id);
      Alert.alert(t('note.duplicate'), t('note.duplicated'));
    } catch {
      Alert.alert(t('common.error'), t('note.failedDuplicate'));
    }
  }, [duplicateNote, t]);

  const handleDeletePermanently = useCallback((note: Note) => {
    Alert.alert(
      t('note.deleteForeverTitle'),
      t('note.deleteForeverConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await permanentDeleteNote.mutateAsync(note.id);
            } catch {
              Alert.alert(t('common.error'), t('note.failedDelete'));
            }
          },
        },
      ],
    );
  }, [permanentDeleteNote, t]);

  const handleEmptyTrash = useCallback(() => {
    const currentTrashCount = trashCountRef.current;
    if (currentTrashCount === 0) {
      return;
    }

    Alert.alert(
      t('dashboard.emptyTrash'),
      t('dashboard.emptyTrashConfirmMessage', { count: currentTrashCount }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('dashboard.emptyTrash'),
          style: 'destructive',
          onPress: async () => {
            if (trashCountRef.current === 0) {
              return;
            }
            if (!isConnected) {
              Alert.alert(t('common.error'), t('dashboard.emptyTrashOffline'));
              return;
            }

            setIsEmptyingTrash(true);
            let serverTrashEmptied = false;
            try {
              await emptyTrashNotes();
              serverTrashEmptied = true;
              const trashedNotes = await getLocalNotes(db, { trashed: true });
              await Promise.all(trashedNotes.map((note) => permanentDeleteLocalNote(db, note.id)));
              Alert.alert(t('dashboard.emptyTrash'), t('dashboard.trashEmptied'));
            } catch {
              if (serverTrashEmptied) {
                Alert.alert(t('dashboard.emptyTrash'), t('dashboard.trashEmptied'));
              } else {
                Alert.alert(t('common.error'), t('dashboard.emptyTrashFailed'));
              }
            } finally {
              if (serverTrashEmptied) {
                await handleRefresh().catch(() => {});
              }
              setIsEmptyingTrash(false);
            }
          },
        },
      ],
    );
  }, [db, handleRefresh, isConnected, t]);

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
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [colorPickerNote, t, updateNote]);

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

  useEffect(() => {
    let cancelled = false;

    async function loadTrashCount() {
      if (variant !== 'trash') {
        setTrashCount(0);
        return;
      }

      try {
        const trashedNotes = await getLocalNotes(db, { trashed: true });
        if (!cancelled) {
          setTrashCount(trashedNotes.length);
        }
      } catch {
        // Keep the previous count if the local query fails transiently.
      }
    }

    void loadTrashCount();

    return () => {
      cancelled = true;
    };
  }, [db, notes, variant]);

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
      isSearchLoading ? (
        <View style={styles.emptySearchContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : debouncedSearch || labelId ? (
        <View style={styles.emptySearchContainer}>
          <Ionicons
            name={debouncedSearch ? 'search-outline' : 'pricetag-outline'}
            size={48}
            color={colors.handleColor}
          />
          <Text style={[styles.emptySearchTitle, { color: colors.textSecondary }]}>
            {debouncedSearch
              ? t('dashboard.noSearchResults', { query: debouncedSearch })
              : t('dashboard.noNotesForLabel')}
          </Text>
          {debouncedSearch && (
            <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>
              {t('dashboard.tryDifferentKeywords')}
            </Text>
          )}
        </View>
      ) : null,
    [isSearchLoading, debouncedSearch, labelId, colors, t],
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
        Alert.alert(t('common.error'), t('note.failedReorder'));
      }
    },
    [reorderNotes, t],
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

  // Show full-screen loading only on initial load (no prior data, no active search query).
  // Uses debouncedSearch (not searchText) so clearing the input mid-debounce doesn't
  // trigger the full-screen loader while the previous query is still in-flight.
  if (isLoading && !notes && !debouncedSearch) {
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
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('dashboard.failedLoadNotes')}</Text>
        <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>{t('dashboard.checkConnection')}</Text>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: colors.primary }]}
          onPress={() => refetch()}
          testID="retry-fetch"
        >
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isEmpty = !isLoading && (!notes || notes.length === 0);

  if (isEmpty && !debouncedSearch && (variant !== 'notes' || !labelId)) {
    const emptyIcon: keyof typeof Ionicons.glyphMap =
      variant === 'trash' ? 'trash-outline' :
      variant === 'archived' ? 'archive-outline' :
      variant === 'my-todo' ? 'clipboard-outline' : 'document-text-outline';
    return (
      <View style={[styles.emptyWrapper, { backgroundColor: colors.background }]}>
        {variant === 'trash' && (
          <View style={[styles.trashBanner, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.warningText} style={styles.trashBannerIcon} />
            <Text style={[styles.trashBannerText, { color: colors.warningText }]}>
              {t('dashboard.binInfo')}
            </Text>
          </View>
        )}
        <View style={styles.emptyContent}>
          <Ionicons
            name={emptyIcon}
            size={64}
            color={colors.handleColor}
          />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {variant === 'notes' && t('dashboard.noNotesYet')}
            {variant === 'my-todo' && t('dashboard.noAssignedTodos')}
            {variant === 'archived' && t('dashboard.noArchivedNotes')}
            {variant === 'trash' && t('dashboard.noBinnedNotes')}
          </Text>
          <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>
            {variant === 'notes' && t('dashboard.createFirstNote')}
            {variant === 'my-todo' && t('dashboard.noMyTodoNotes')}
            {variant === 'archived' && t('dashboard.archivedNotesWillAppear')}
            {variant === 'trash' && t('dashboard.deletedNotesWillAppear')}
          </Text>
        </View>
        {variant === 'notes' && (
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: colors.primary }]}
            onPress={handleCreateNote}
            testID="create-note-fab"
            accessibilityLabel={t('dashboard.newNote')}
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
          <View style={styles.trashBannerMessage}>
            <Ionicons name="information-circle-outline" size={16} color={colors.warningText} style={styles.trashBannerIcon} />
            <Text style={[styles.trashBannerText, { color: colors.warningText }]}>
              {t('dashboard.binInfo')}
            </Text>
          </View>
          {trashCount > 0 && (
            <TouchableOpacity
              style={[styles.emptyTrashButton, { borderColor: colors.warningText }, isEmptyingTrash ? styles.emptyTrashButtonDisabled : undefined]}
              onPress={handleEmptyTrash}
              disabled={isEmptyingTrash}
              testID="empty-trash-button"
              accessibilityLabel={t('dashboard.emptyTrash')}
              accessibilityRole="button"
            >
              {isEmptyingTrash ? (
                <ActivityIndicator size="small" color={colors.warningText} />
              ) : (
                <Text style={[styles.emptyTrashButtonText, { color: colors.warningText }]}>{t('dashboard.emptyTrash')}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Search bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.searchBackground, borderColor: colors.searchBorder }]}>
        <Ionicons name="search" size={18} color={colors.iconMuted} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t('dashboard.searchPlaceholder')}
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
              <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>{t('dashboard.pinned')}</Text>
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
              <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>{t('dashboard.otherNotes')}</Text>
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
          accessibilityLabel={t('dashboard.newNote')}
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
        onDuplicate={handleDuplicate}
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
  emptyWrapper: {
    flex: 1,
  },
  emptyContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
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
    textAlign: 'center',
  },
  emptySearchContainer: {
    paddingTop: 48,
    alignItems: 'center',
    gap: 8,
  },
  emptySearchTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  trashBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  trashBannerMessage: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  trashBannerIcon: {
    marginRight: 8,
  },
  trashBannerText: {
    fontSize: 13,
    flex: 1,
  },
  emptyTrashButton: {
    marginLeft: 12,
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTrashButtonDisabled: {
    opacity: 0.6,
  },
  emptyTrashButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    marginBottom: 8,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 44,
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
