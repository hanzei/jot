import React, { useState, useCallback, useMemo, useEffect, useRef, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  ScrollView,
  Keyboard,
} from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { updateMe } from '../api/settings';
import { useTranslation } from 'react-i18next';
import { useUpdateNote, useDeleteNote, useRestoreNote, usePermanentDeleteNote, useReorderNotes, useDuplicateNote } from '../hooks/useNotes';
import { useOfflineNotes, useOfflineNote } from '../hooks/useOfflineNotes';
import { useUsers } from '../store/UsersContext';
import { useAuth } from '../store/AuthContext';
import { useToast } from '../hooks/useToast';
import { useTheme } from '../theme/ThemeContext';
import SkeletonNoteList from '../components/SkeletonNoteList';
import NoteCard from '../components/NoteCard';
import NoteContextMenu, { ContextMenuViewContext } from '../components/NoteContextMenu';
import LabelPicker from '../components/LabelPicker';
import type { Note, NoteSort } from '@jot/shared';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { normalizeNoteSort, sortNotesForDisplay } from '../utils/noteSort';
import { isSortWarningDismissed, dismissSortWarning } from '../utils/sortWarningDismissed';
import { emptyTrash as emptyTrashNotes } from '../api/notes';
import { getLocalNotes, permanentDeleteLocalNote } from '../db/noteQueries';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useBannerShown } from '../hooks/useBannerShown';
import { styles } from './notesList/styles';
import { buildNoteSections, type LocalReorderState } from './notesList/noteListUtils';
import NotesListHeader from './notesList/NotesListHeader';
import MasonryGrid from './notesList/MasonryGrid';
import DraggableMasonry from './notesList/DraggableMasonry';
import FadeInView from '../components/FadeInView';
import { animateListReflow } from '../utils/layoutAnimation';
import {
  getDashboardLayout,
  setDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
} from '../utils/dashboardLayout';

interface NotesListScreenProps {
  variant?: 'notes' | 'archived' | 'trash' | 'my-tasks';
  labelId?: string;
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'MainDrawer'>;

const SEARCH_DEBOUNCE_MS = 300;
const EMPTY_NOTES: Note[] = [];
const EMPTY_LOCAL_ORDER: LocalReorderState = { pinned: null, unpinned: null };

export default function NotesListScreen({ variant = 'notes', labelId }: NotesListScreenProps) {
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const { user, settings, setSettings, isLocalMode } = useAuth();
  const [trashCount, setTrashCount] = useState(0);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const db = useSQLiteContext();
  const { isConnected } = useNetworkStatus();
  const bannerShown = useBannerShown();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { showToast } = useToast();
  const insets = useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const fabBottom = Math.max(insets.bottom + 20, 20);
  const listBottomPadding = variant === 'notes' ? fabBottom + 60 : insets.bottom + 80;

  const [contextMenuNote, setContextMenuNote] = useState<Note | null>(null);
  const [labelPickerNote, setLabelPickerNote] = useState<Note | null>(null);
  const [localOrder, setLocalOrder] = useState<LocalReorderState>({ pinned: null, unpinned: null });
  const [sortMode, setSortMode] = useState<NoteSort>(() => normalizeNoteSort(settings?.note_sort));
  const [isSortControlsOpen, setIsSortControlsOpen] = useState(false);
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_DASHBOARD_LAYOUT);
  const [sortWarningDismissed, setSortWarningDismissed] = useState<boolean | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortRequestIdRef = useRef(0);
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

  useEffect(() => {
    setSortMode(normalizeNoteSort(settings?.note_sort));
  }, [settings?.note_sort]);

  const params = useMemo(() => ({
    archived: variant === 'archived' ? true : undefined,
    trashed: variant === 'trash' ? true : undefined,
    search: debouncedSearch || undefined,
    label: variant === 'notes' ? labelId : undefined,
    my_tasks: variant === 'my-tasks' ? true : undefined,
    user_id: variant === 'my-tasks' ? user?.id : undefined,
  }), [variant, debouncedSearch, labelId, user?.id]);

  const { data: notes, isLoading, isError, refetch, isRefetching } = useOfflineNotes(params);

  // While searching or filtering by label outside the archive/trash views,
  // also surface archived matches in a separate section. My Tasks already
  // returns archived notes, so it needs no extra request — its archived
  // matches are split from `notes`.
  const showArchivedSplit = (!!debouncedSearch || !!labelId) && variant !== 'archived' && variant !== 'trash';
  const fetchArchivedSeparately = showArchivedSplit && variant !== 'my-tasks';
  const archivedParams = useMemo(() => ({
    archived: true,
    search: debouncedSearch || undefined,
    label: variant === 'notes' ? labelId : undefined,
  }), [debouncedSearch, labelId, variant]);
  const { data: archivedSearchNotes } = useOfflineNotes(archivedParams, { enabled: fetchArchivedSeparately });

  const { data: labelPickerNoteData } = useOfflineNote(labelPickerNote?.id ?? null);
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

  const handleToggleDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.toggleDrawer());
  }, [navigation]);

  const handleLabelPress = useCallback((pressedLabelId: string, pressedLabelName: string) => {
    navigation.dispatch(DrawerActions.jumpTo('Notes', { labelId: pressedLabelId, labelName: pressedLabelName }));
  }, [navigation]);

  const handleSortChange = useCallback(async (nextSort: NoteSort) => {
    if (nextSort === sortMode) {
      return;
    }

    const previousSort = sortMode;
    const previousSettings = settings;
    const requestId = ++sortRequestIdRef.current;

    setSortMode(nextSort);
    setLocalOrder(EMPTY_LOCAL_ORDER);
    if (previousSettings) {
      setSettings({ ...previousSettings, note_sort: nextSort });
    }

    if (isLocalMode) {
      return;
    }

    try {
      const response = await updateMe({ note_sort: nextSort });
      if (requestId !== sortRequestIdRef.current) {
        return;
      }
      setSettings(response.settings);
    } catch {
      if (requestId !== sortRequestIdRef.current) {
        return;
      }
      setSortMode(previousSort);
      if (previousSettings) {
        setSettings(previousSettings);
      }
      Alert.alert(t('common.error'), t('dashboard.sortUpdateFailed'));
    }
  }, [setSettings, settings, sortMode, isLocalMode, t]);

  const handleSortChipPress = useCallback((nextSort: NoteSort) => {
    setIsSortControlsOpen(false);
    void handleSortChange(nextSort);
  }, [handleSortChange]);

  useEffect(() => {
    let cancelled = false;
    setSortWarningDismissed(null);
    void isSortWarningDismissed(sortMode).then((dismissed) => {
      if (!cancelled) setSortWarningDismissed(dismissed);
    });
    return () => {
      cancelled = true;
    };
  }, [sortMode]);

  const handleDismissSortWarning = useCallback(() => {
    animateListReflow();
    setSortWarningDismissed(true);
    void dismissSortWarning(sortMode);
  }, [sortMode]);

  const handleToggleSort = useCallback(() => {
    animateListReflow();
    setIsSortControlsOpen((open) => !open);
  }, []);

  // Dashboard layout is a device-only preference, loaded once on mount. If the
  // user toggles before the async read resolves, their choice wins.
  const layoutToggledRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void getDashboardLayout().then((stored) => {
      if (!cancelled && !layoutToggledRef.current) setLayout(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the layout only after the user toggles it (not for the initial load,
  // which just reflects what was already stored).
  useEffect(() => {
    if (layoutToggledRef.current) void setDashboardLayout(layout);
  }, [layout]);

  const handleToggleLayout = useCallback(() => {
    animateListReflow();
    layoutToggledRef.current = true;
    setLayout((prev) => (prev === 'list' ? 'grid' : 'list'));
  }, []);

  const handleNotePress = useCallback(
    (noteId: string) => {
      if (variant === 'trash') return; // read-only
      Keyboard.dismiss();
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

  // Context menu actions. Each PATCH carries only the field being changed:
  // including unchanged title/content would re-assert a possibly-stale snapshot
  // (clobbering another device's edit) and, because content triggers the
  // base_version guard, turn a mere pin/color toggle into a 409 conflict.
  const handlePin = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({
        id: note.id,
        data: { pinned: !note.pinned },
      });
    } catch {
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [t, updateNote]);

  const handleArchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({
        id: note.id,
        data: { archived: true },
      });
      showToast(t('dashboard.noteArchived'), 'success', {
        label: t('dashboard.undo'),
        onPress: async () => {
          try {
            await updateNote.mutateAsync({
              id: note.id,
              data: { archived: false },
            });
            showToast(t('dashboard.noteUnarchived'));
          } catch {
            showToast(t('note.failedUnarchive'), 'error');
          }
        },
      });
    } catch {
      Alert.alert(t('common.error'), t('note.failedArchive'));
    }
  }, [showToast, t, updateNote]);

  const handleUnarchive = useCallback(async (note: Note) => {
    try {
      await updateNote.mutateAsync({
        id: note.id,
        data: { archived: false },
      });
      showToast(t('dashboard.noteUnarchived'));
    } catch {
      Alert.alert(t('common.error'), t('note.failedUnarchive'));
    }
  }, [showToast, t, updateNote]);

  const handleMoveToTrash = useCallback(async (note: Note) => {
    try {
      await deleteNote.mutateAsync(note.id);
      showToast(t('dashboard.noteDeleted'), 'success', {
        label: t('dashboard.undo'),
        onPress: async () => {
          try {
            await restoreNote.mutateAsync(note.id);
            showToast(t('dashboard.noteRestored'));
          } catch {
            showToast(t('note.failedRestore'), 'error');
          }
        },
      });
    } catch {
      Alert.alert(t('common.error'), t('note.failedMoveToTrash'));
    }
  }, [deleteNote, restoreNote, showToast, t]);

  const handleRestore = useCallback(async (note: Note) => {
    try {
      await restoreNote.mutateAsync(note.id);
      showToast(t('dashboard.noteRestored'));
    } catch {
      Alert.alert(t('common.error'), t('note.failedRestore'));
    }
  }, [restoreNote, showToast, t]);

  const handleDuplicate = useCallback(async (note: Note) => {
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

  const handleShare = useCallback((note: Note) => {
    navigation.navigate('Share', { noteId: note.id });
  }, [navigation]);

  const handleManageLabels = useCallback((note: Note) => {
    setLabelPickerNote(note);
  }, []);

  // Separate active from archived matches. For My Tasks the archived notes are
  // mixed into `notes`; otherwise they come from the dedicated archived fetch.
  const { activeNotes, archivedNotes } = useMemo(() => {
    const all = notes ?? EMPTY_NOTES;
    if (!showArchivedSplit) {
      return { activeNotes: all, archivedNotes: EMPTY_NOTES };
    }
    if (variant === 'my-tasks') {
      return {
        activeNotes: all.filter((n) => !n.archived),
        archivedNotes: all.filter((n) => n.archived),
      };
    }
    return { activeNotes: all, archivedNotes: archivedSearchNotes ?? EMPTY_NOTES };
  }, [notes, showArchivedSplit, variant, archivedSearchNotes]);

  const { pinned: pinnedNotes, other: otherNotes } = useMemo(
    () => sortNotesForDisplay(activeNotes, sortMode),
    [activeNotes, sortMode],
  );

  const displayedArchived = useMemo(() => {
    const { pinned, other } = sortNotesForDisplay(archivedNotes, sortMode);
    return [...pinned, ...other];
  }, [archivedNotes, sortMode]);

  // Clear local order overrides when server data, variant, or sort mode changes
  useEffect(() => {
    setLocalOrder(EMPTY_LOCAL_ORDER);
  }, [notes, variant, sortMode]);

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

  const hasPinned = pinnedNotes.length > 0;

  const noteSections = useMemo(
    () => buildNoteSections(displayPinned, displayUnpinned, displayedArchived, hasPinned, t),
    [displayPinned, displayUnpinned, displayedArchived, hasPinned, t],
  );

  const listEmptyComponent = useMemo(
    () =>
      isSearchLoading ? (
        <View style={styles.emptySearchContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : debouncedSearch || labelId ? (
        <FadeInView style={styles.emptySearchContainer} scaleFrom={0.97}>
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
        </FadeInView>
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

  const handleDragStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  // Masonry card renderers, shared by the list (1 column) and grid (2 columns)
  // layouts. The draggable variant omits onLongPress so the masonry's drag
  // gesture owns the long press; the static variant uses it to open the context
  // menu in the read-only trash view.
  const renderMasonryCardStatic = useCallback(
    (note: Note) => (
      <NoteCard
        note={note}
        onPress={() => handleNotePress(note.id)}
        onMenuPress={variant !== 'trash' ? () => handleOpenMenu(note) : undefined}
        onLongPress={variant === 'trash' ? () => handleOpenMenu(note) : undefined}
        onLabelPress={variant === 'notes' ? handleLabelPress : undefined}
      />
    ),
    [handleNotePress, handleOpenMenu, variant, handleLabelPress],
  );

  const renderMasonryCardDraggable = useCallback(
    (note: Note) => (
      <NoteCard
        note={note}
        onPress={() => handleNotePress(note.id)}
        onMenuPress={() => handleOpenMenu(note)}
        onLabelPress={handleLabelPress}
      />
    ),
    [handleNotePress, handleOpenMenu, handleLabelPress],
  );

  // Drag-and-drop is only available in the unfiltered notes variant while manual
  // sorting is active. Search and label filters both show a filtered subset
  // (and mix in archived matches), so reordering them would persist a partial
  // or misclassified manual order — disable dragging there.
  const isDraggable = variant === 'notes' && sortMode === 'manual' && !debouncedSearch && !labelId;

  // Signature of the active view/filter/sort/layout. The static grid swaps
  // instantly when it changes, so only in-view note changes (create, delete,
  // archive, pin, sync) animate — never a search/sort switch or first load.
  const gridViewKey = `${variant}|${debouncedSearch}|${labelId ?? ''}|${sortMode}|${layout}`;

  const handleGridSectionReorder = useCallback(
    (sectionKey: string, newData: Note[]) => {
      void handleDragEnd(newData, sectionKey === 'pinned');
    },
    [handleDragEnd],
  );

  const header = (
    <NotesListHeader
      variant={variant}
      bannerShown={bannerShown}
      topInset={insets.top}
      searchText={searchText}
      onSearchChange={setSearchText}
      onClearSearch={handleClearSearch}
      isSortOpen={isSortControlsOpen}
      onToggleSort={handleToggleSort}
      sortMode={sortMode}
      onSortSelect={handleSortChipPress}
      sortWarningDismissed={sortWarningDismissed}
      onDismissSortWarning={handleDismissSortWarning}
      onToggleDrawer={handleToggleDrawer}
      layout={layout}
      onToggleLayout={handleToggleLayout}
    />
  );

  // Show full-screen loading only on initial load (no prior data, no active search query).
  // Uses debouncedSearch (not searchText) so clearing the input mid-debounce doesn't
  // trigger the full-screen loader while the previous query is still in-flight.
  if (isLoading && !notes && !debouncedSearch) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header}
        <SkeletonNoteList />
      </View>
    );
  }

  if (isError) {
    const errorContent = (
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        contentContainerStyle={styles.errorScrollContent}
        testID="notes-error-state"
      >
        <View
          style={[
            styles.emptyContainer,
            { backgroundColor: colors.background },
          ]}
        >
          <Ionicons name="cloud-offline-outline" size={64} color={colors.handleColor} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('dashboard.failedLoadNotes')}</Text>
          <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>{t('dashboard.checkConnection')}</Text>
          <TouchableOpacity
            style={[styles.retryButton, { backgroundColor: colors.primary }]}
            onPress={() => {
              void handleRefresh();
            }}
            testID="retry-fetch"
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
          >
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );

    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {header}
        {errorContent}
      </View>
    );
  }

  const isEmpty = !isLoading && (!notes || notes.length === 0);

  if (isEmpty && !debouncedSearch && (variant !== 'notes' || !labelId)) {
    const emptyIcon: keyof typeof Ionicons.glyphMap =
      variant === 'trash' ? 'trash-outline' :
      variant === 'archived' ? 'archive-outline' :
      variant === 'my-tasks' ? 'clipboard-outline' : 'document-text-outline';
    return (
      <View style={[styles.emptyWrapper, { backgroundColor: colors.background }]}>
        {variant === 'notes' && header}
        {variant === 'trash' && (
          <View style={[styles.trashBanner, { backgroundColor: colors.warning, borderBottomColor: colors.warningBorder }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.warningText} style={styles.trashBannerIcon} />
            <Text style={[styles.trashBannerText, { color: colors.warningText }]}>
              {t('dashboard.binInfo')}
            </Text>
          </View>
        )}
        <ScrollView
          style={styles.emptyScroll}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          contentContainerStyle={styles.emptyScrollContent}
          testID="notes-empty-state"
        >
          <View style={styles.emptyContent}>
            <Ionicons
              name={emptyIcon}
              size={64}
              color={colors.handleColor}
            />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              {variant === 'notes' && t('dashboard.noNotesYet')}
              {variant === 'my-tasks' && t('dashboard.noAssignedListItems')}
              {variant === 'archived' && t('dashboard.noArchivedNotes')}
              {variant === 'trash' && t('dashboard.noBinnedNotes')}
            </Text>
            <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>
              {variant === 'notes' && t('dashboard.createFirstNote')}
              {variant === 'my-tasks' && t('dashboard.noMyTasksNotes')}
              {variant === 'archived' && t('dashboard.archivedNotesWillAppear')}
              {variant === 'trash' && t('dashboard.deletedNotesWillAppear')}
            </Text>
          </View>
        </ScrollView>
        {variant === 'notes' && (
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: colors.primary, bottom: fabBottom }]}
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

      {header}

      {/* Notes list — both the single-column list and the two-column grid are
          rendered by the same masonry engine; only the column count differs.
          The draggable masonry has nothing to drag (and no empty state) when
          there are no notes, so fall back to the static grid in that case. */}
      {isDraggable && noteSections.some((section) => section.data.length > 0) ? (
        <DraggableMasonry
          columns={layout === 'grid' ? 2 : 1}
          sections={noteSections}
          onSectionReorder={handleGridSectionReorder}
          onDragStart={handleDragStart}
          renderCard={renderMasonryCardDraggable}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          contentBottomPadding={listBottomPadding}
          topInset={insets.top}
        />
      ) : (
        <MasonryGrid
          columns={layout === 'grid' ? 2 : 1}
          sections={noteSections}
          renderCard={renderMasonryCardStatic}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
          contentBottomPadding={listBottomPadding}
          ListEmptyComponent={listEmptyComponent}
          viewKey={gridViewKey}
        />
      )}

      {variant === 'notes' && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.primary, bottom: fabBottom }]}
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
        onShare={handleShare}
        onManageLabels={handleManageLabels}
      />

      {labelPickerNote && (
        <LabelPicker
          visible
          noteId={labelPickerNote.id}
          noteLabels={(labelPickerNoteData ?? labelPickerNote).labels ?? []}
          onClose={() => setLabelPickerNote(null)}
        />
      )}
    </View>
  );
}
