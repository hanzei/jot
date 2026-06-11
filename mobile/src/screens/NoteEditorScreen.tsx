import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  InputAccessoryView,
  Keyboard,
  type TextInputProps,
  type TextInput as TextInputType,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useCreateNote, useUpdateNote, useDeleteNote, useRestoreNote, useDuplicateNote, useCreateNoteItem, useUpdateNoteItem, useDeleteNoteItem, useReorderNoteItems, useToggleNoteItemCompleted } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { isLocalId } from '../db/noteQueries';
import { useSSESubscription } from '../store/SSEContext';
import { useToast } from '../hooks/useToast';
import ListItem from '../components/ListItem';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import { buildCollaborators, generateId, VALIDATION, type Collaborator, type NoteType, type NoteItem, type CreateNoteRequest, type UpdateNoteRequest, type UpdateListNoteRequest, type UpdateTextNoteRequest, type PatchNoteItemRequest, type Label } from '@jot/shared';
import { useUsers } from '../store/UsersContext';
import { useTheme } from '../theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getCompletedSectionDividerColor, isWhiteHexColor } from '../utils/colorContrast';
import { fullMarkdownStyles, preprocessMarkdown } from '../utils/markdownStyles';

type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;
type EditorNavProp = NativeStackNavigationProp<RootStackParamList, 'NoteEditor'>;

const IOS_KEYBOARD_VERTICAL_OFFSET = 88;
const FOCUSED_INPUT_KEYBOARD_MARGIN = 120;
const MARKDOWN_TOOLBAR_ID = 'markdown-formatting-toolbar';
const LIST_INDENT_TOOLBAR_ID = 'list-indent-toolbar';

interface LocalItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  parentId: string | null;
  assigned_to: string;
}

function toLocalItems(serverItems: NoteItem[]): LocalItem[] {
  return [...serverItems]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      id: item.id,
      text: item.text,
      completed: item.completed,
      position: item.position,
      parentId: item.parent_id ?? null,
      assigned_to: item.assigned_to ?? '',
    }));
}

function serializeItems(items: LocalItem[]) {
  return items.map((item, i) => ({
    id: item.id,
    text: item.text,
    position: i,
    completed: item.completed,
    indent_level: item.parentId ? 1 : 0,
    assigned_to: item.assigned_to,
  }));
}

// Mergeable fields of a list item, used as the per-item baseline for diffing
// local edits against the last-saved state.
type ItemSnapshot = Pick<LocalItem, 'text' | 'completed' | 'parentId' | 'assigned_to'>;
const itemSnapshot = (item: LocalItem): ItemSnapshot => ({
  text: item.text,
  completed: item.completed,
  parentId: item.parentId,
  assigned_to: item.assigned_to,
});

// normalizeItemOrder walks top-level items in order and emits each one followed
// by its children (keeping a group contiguous). Orphaned children (parent gone)
// are promoted to top-level. Renumbers position = 0..N across the whole set.
function normalizeItemOrder(items: LocalItem[]): LocalItem[] {
  const childrenByParent = new Map<string, LocalItem[]>();
  for (const it of items) {
    if (it.parentId !== null) {
      const siblings = childrenByParent.get(it.parentId) ?? [];
      siblings.push(it);
      childrenByParent.set(it.parentId, siblings);
    }
  }
  const ordered: LocalItem[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    if (it.parentId !== null) continue;
    ordered.push(it);
    placed.add(it.id);
    for (const child of childrenByParent.get(it.id) ?? []) {
      ordered.push(child);
      placed.add(child.id);
    }
  }
  for (const it of items) {
    if (!placed.has(it.id)) ordered.push({ ...it, parentId: null });
  }
  return ordered.map((it, index) => ({ ...it, position: index }));
}

function itemHasChildren(items: LocalItem[], itemId: string): boolean {
  return items.some((it) => it.parentId === itemId);
}

function precedingTopLevelId(items: LocalItem[], itemId: string): string | null {
  let last: string | null = null;
  for (const it of items) {
    if (it.id === itemId) return last;
    if (it.parentId === null) last = it.id;
  }
  return null;
}

// applyCompletedCascade mirrors the server: toggling a top-level item also
// toggles all its children; toggling a child touches only that item.
function applyCompletedCascade(items: LocalItem[], itemId: string, completed: boolean): LocalItem[] {
  const target = items.find((item) => item.id === itemId);
  if (!target) return items;
  const cascadeToChildren = target.parentId === null;
  return items.map((item) => {
    if (item.id === itemId) return { ...item, completed };
    if (cascadeToChildren && item.parentId === itemId) return { ...item, completed };
    return item;
  });
}

export default function NoteEditorScreen() {
  const navigation = useNavigation<EditorNavProp>();
  const route = useRoute<EditorRouteProp>();
  const { noteId: initialNoteId } = route.params;
  const { t, i18n } = useTranslation();

  const [noteId, setNoteId] = useState<string | null>(initialNoteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [items, setItems] = useState<LocalItem[]>([]);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [archived, setArchived] = useState(false);
  const [color, setColor] = useState('#ffffff');
  const [labels, setLabels] = useState<Label[]>([]);
  const [hasCreated, setHasCreated] = useState(initialNoteId !== null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [labelPickerVisible, setLabelPickerVisible] = useState(false);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [isEditingContent, setIsEditingContent] = useState(initialNoteId === null);
  const [listItemFocused, setListItemFocused] = useState(false);
  const focusedListItemIdRef = useRef<string | null>(null);
  const { usersById } = useUsers();
  const { showToast } = useToast();

  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { data: existingNote } = useOfflineNote(noteId);
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();
  const restoreMutation = useRestoreNote();
  const duplicateMutation = useDuplicateNote();
  const createItemMutation = useCreateNoteItem();
  const updateItemMutation = useUpdateNoteItem();
  const deleteItemMutation = useDeleteNoteItem();
  const reorderItemsMutation = useReorderNoteItems();
  const toggleItemCompletedMutation = useToggleNoteItemCompleted();

  // Show a toast when another user updates this note while editor is open
  useSSESubscription(noteId, useCallback(() => {
    setSyncToast((prev) => prev ?? t('note.updatedByAnotherUser'));
  }, [t]));

  // Auto-dismiss sync toast after 4 seconds
  useEffect(() => {
    if (!syncToast) return;
    const timer = setTimeout(() => setSyncToast(null), 4000);
    return () => clearTimeout(timer);
  }, [syncToast]);

  useEffect(() => {
    setSaveError(null);
    setSyncToast(null);
  }, [i18n.language]);

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setIsEditingContent(false);
      if (listItemBlurTimerRef.current) {
        clearTimeout(listItemBlurTimerRef.current);
        listItemBlurTimerRef.current = null;
      }
      setListItemFocused(false);
      focusedListItemIdRef.current = null;
    });
    return () => sub.remove();
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  const hasPendingChangesRef = useRef(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const requiresHydrationRef = useRef(initialNoteId !== null);

  // Refs for current state to avoid stale closures in debounced save
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const noteTypeRef = useRef(noteType);
  noteTypeRef.current = noteType;
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const checkedItemsCollapsedRef = useRef(checkedItemsCollapsed);
  checkedItemsCollapsedRef.current = checkedItemsCollapsed;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const colorRef = useRef(color);
  colorRef.current = color;
  const createMutateRef = useRef(createMutation.mutateAsync);
  createMutateRef.current = createMutation.mutateAsync;
  const updateMutateRef = useRef(updateMutation.mutateAsync);
  updateMutateRef.current = updateMutation.mutateAsync;
  const createItemRef = useRef(createItemMutation.mutateAsync);
  createItemRef.current = createItemMutation.mutateAsync;
  const updateItemRef = useRef(updateItemMutation.mutateAsync);
  updateItemRef.current = updateItemMutation.mutateAsync;
  const deleteItemRef = useRef(deleteItemMutation.mutateAsync);
  deleteItemRef.current = deleteItemMutation.mutateAsync;
  const reorderItemsRef = useRef(reorderItemsMutation.mutateAsync);
  reorderItemsRef.current = reorderItemsMutation.mutateAsync;
  const toggleItemCompletedRef = useRef(toggleItemCompletedMutation.mutateAsync);
  toggleItemCompletedRef.current = toggleItemCompletedMutation.mutateAsync;
  // Baseline of the last-saved state, used to diff local edits into granular
  // per-item operations (and field-only scalar patches) instead of re-sending
  // the whole note — so a save here can't overwrite another device's edits.
  const savedItemsRef = useRef<Map<string, ItemSnapshot>>(new Map());
  const savedOrderRef = useRef<string[]>([]);
  const savedScalarsRef = useRef({ title: '', content: '', pinned: false, archived: false, color: '#ffffff', checked_items_collapsed: false });
  const isHydratingRef = useRef(initialNoteId !== null && !existingNote);
  isHydratingRef.current = initialNoteId !== null && !existingNote;

  const titleInputRef = useRef<TextInputType>(null);
  const contentInputRef = useRef<TextInputType>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const itemInputRefsMap = useRef(new Map<string, React.RefObject<TextInputType | null>>());
  const listItemBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getItemRef = useCallback((id: string): React.RefObject<TextInputType | null> => {
    if (!itemInputRefsMap.current.has(id)) {
      itemInputRefsMap.current.set(id, React.createRef<TextInputType>());
    }
    return itemInputRefsMap.current.get(id)!;
  }, []);

  // New list items get a server-format ID up front so they keep a stable
  // identity across granular per-item updates and offline replay.
  function nextTempId(): string {
    return generateId();
  }

  // Load existing note data
  useEffect(() => {
    if (existingNote && !isInitializedRef.current) {
      setNoteType(existingNote.note_type);
      setPinned(existingNote.pinned);
      setArchived(existingNote.archived);
      setColor(existingNote.color);
      setLabels(existingNote.labels ?? []);
      let initialItems: LocalItem[] = [];
      if (existingNote.note_type === 'list') {
        setTitle(existingNote.title);
        setCheckedItemsCollapsed(existingNote.checked_items_collapsed);
        if (existingNote.items) {
          initialItems = toLocalItems(existingNote.items);
          setItems(initialItems);
        }
      } else {
        setContent(existingNote.content);
      }
      // Seed the save baseline from the hydrated note so the first edit diffs
      // against the server state rather than re-sending everything.
      savedScalarsRef.current = {
        title: existingNote.note_type === 'list' ? existingNote.title : '',
        content: existingNote.note_type === 'text' ? existingNote.content : '',
        pinned: existingNote.pinned,
        archived: existingNote.archived,
        color: existingNote.color,
        checked_items_collapsed: existingNote.note_type === 'list' ? existingNote.checked_items_collapsed : false,
      };
      savedItemsRef.current = new Map(initialItems.map((it) => [it.id, itemSnapshot(it)]));
      savedOrderRef.current = initialItems.map((it) => it.id);
      isInitializedRef.current = true;
      requiresHydrationRef.current = false;
    }
  }, [existingNote]);

  // Keep labels in sync when note data refreshes after label mutations
  useEffect(() => {
    if (existingNote && isInitializedRef.current) {
      setLabels(existingNote.labels ?? []);
    }
  }, [existingNote?.labels]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the queue drains, OfflineContext sets the React Query cache for the old local
  // ID to hold the server note. Detect this by checking whether the cached note's id
  // now differs from the local ID we hold, and update noteId + route params accordingly.
  useEffect(() => {
    if (existingNote && noteId && existingNote.id !== noteId) {
      setNoteId(existingNote.id);
      navigation.setParams({ noteId: existingNote.id });
    }
  }, [existingNote?.id, noteId, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persists list-item changes as granular create/patch/delete/reorder ops by
  // diffing the current items against the saved baseline.
  const persistItemDiff = useCallback(async (currentNoteId: string, currentItems: LocalItem[]) => {
    const base = savedItemsRef.current;
    const curIds = new Set(currentItems.map((it) => it.id));

    // Advance the baseline incrementally after each successful op so a later
    // failure does not re-send already-applied ops on the next retry (which
    // would re-create items and get stuck on 409 Conflict).
    for (const it of currentItems) {
      const snap = base.get(it.id);
      if (!snap) {
        try {
          await createItemRef.current({
            noteId: currentNoteId,
            item: {
              id: it.id,
              text: it.text,
              position: it.position,
              completed: it.completed,
              parent_id: it.parentId,
              assigned_to: it.assigned_to || undefined,
            },
          });
        } catch (err) {
          // 409 means a prior attempt already created this item; treat as done.
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status !== 409) throw err;
        }
        base.set(it.id, itemSnapshot(it));
        continue;
      }
      const data: PatchNoteItemRequest = {};
      if (it.text !== snap.text) data.text = it.text;
      if (it.completed !== snap.completed) data.completed = it.completed;
      if (it.parentId !== snap.parentId) data.parent_id = it.parentId ?? '';
      if (it.assigned_to !== snap.assigned_to) data.assigned_to = it.assigned_to;
      if (Object.keys(data).length > 0) {
        await updateItemRef.current({ noteId: currentNoteId, itemId: it.id, data });
        base.set(it.id, itemSnapshot(it));
      }
    }

    for (const id of [...base.keys()]) {
      if (!curIds.has(id)) {
        await deleteItemRef.current({ noteId: currentNoteId, itemId: id });
        base.delete(id);
      }
    }

    const curOrder = currentItems.map((it) => it.id);
    const orderChanged = curOrder.length !== savedOrderRef.current.length
      || curOrder.some((id, i) => savedOrderRef.current[i] !== id);
    if (orderChanged && curOrder.length > 0) {
      await reorderItemsRef.current({ noteId: currentNoteId, itemIds: curOrder });
    }
    savedOrderRef.current = curOrder;
  }, []);

  const flushSave = useCallback(async (unmounting = false): Promise<boolean> => {
    if (!hasPendingChangesRef.current) return true;
    // If an existing note has local edits flagged but hasn't hydrated yet,
    // treat this as a failed flush so callers can retry after hydration.
    if (requiresHydrationRef.current && noteIdRef.current && !isInitializedRef.current) return false;

    // Serialize mutations: chain onto any in-flight save to prevent concurrent writes
    const predecessor = saveInFlightRef.current;
    const thisPromise = (async () => {
      if (predecessor) {
        try { await predecessor; } catch { /* handled by prior caller */ }
      }

      const currentNoteId = noteIdRef.current;
      const currentTitle = titleRef.current;
      const currentContent = contentRef.current;
      const currentItems = itemsRef.current;
      const currentCollapsed = checkedItemsCollapsedRef.current;
      const currentNoteType = noteTypeRef.current;
      const currentColor = colorRef.current;
      const currentPinned = pinnedRef.current;
      const currentArchived = archivedRef.current;

      const captureBaseline = () => {
        savedScalarsRef.current = {
          title: currentTitle,
          content: currentContent,
          pinned: currentPinned,
          archived: currentArchived,
          color: currentColor,
          checked_items_collapsed: currentCollapsed,
        };
        savedItemsRef.current = new Map(currentItems.map((it) => [it.id, itemSnapshot(it)]));
        savedOrderRef.current = currentItems.map((it) => it.id);
      };

      if (!currentNoteId) {
        const isEmpty = currentNoteType === 'list'
          ? !currentTitle && currentItems.length === 0
          : !currentContent;
        if (isEmpty) {
          hasPendingChangesRef.current = false;
          return true;
        }
        const req: CreateNoteRequest = currentNoteType === 'list'
          ? {
              note_type: 'list',
              title: currentTitle,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
              items: serializeItems(currentItems),
            }
          : {
              note_type: 'text',
              content: currentContent,
              color: !isWhiteHexColor(currentColor) ? currentColor : undefined,
            };
        const newNote = await createMutateRef.current(req);
        hasPendingChangesRef.current = false;
        // The server honors the client-supplied item IDs, so the items we just
        // sent become the baseline for subsequent granular edits.
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        noteIdRef.current = newNote.id;
        setNoteId(newNote.id);
        setHasCreated(true);
        setSaveError(null);
      } else {
        // Patch only the scalar fields that changed, so a list-item edit never
        // re-sends the title and vice versa, and another device's concurrent
        // changes to untouched fields are preserved.
        const base = savedScalarsRef.current;
        const scalarData: UpdateNoteRequest = {};
        if (currentNoteType === 'list') {
          if (currentTitle !== base.title) (scalarData as UpdateListNoteRequest).title = currentTitle;
          if (currentCollapsed !== base.checked_items_collapsed) (scalarData as UpdateListNoteRequest).checked_items_collapsed = currentCollapsed;
        } else if (currentContent !== base.content) {
          (scalarData as UpdateTextNoteRequest).content = currentContent;
        }
        if (currentPinned !== base.pinned) scalarData.pinned = currentPinned;
        if (currentArchived !== base.archived) scalarData.archived = currentArchived;
        if (currentColor !== base.color) scalarData.color = currentColor;

        if (Object.keys(scalarData).length > 0) {
          await updateMutateRef.current({ id: currentNoteId, data: scalarData });
        }

        // Items are persisted as granular per-item operations.
        if (currentNoteType === 'list') {
          await persistItemDiff(currentNoteId, currentItems);
        }

        hasPendingChangesRef.current = false;
        captureBaseline();
        if (!isMountedRef.current || unmounting) return true;
        setSaveError(null);
      }

      return true;
    })();

    saveInFlightRef.current = thisPromise;
    try {
      await thisPromise;
      return true;
    } catch (err) {
      console.error('Failed to save note:', err);
      if (isMountedRef.current && !unmounting) {
        setSaveError(t('note.failedSaveChanges'));
      }
      return false;
    } finally {
      if (saveInFlightRef.current === thisPromise) {
        saveInFlightRef.current = null;
      }
    }
  }, [t, persistItemDiff]);

  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      flushSave();
    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
  }, [flushSave]);

  const markDirtyAndScheduleUpdate = useCallback(() => {
    hasPendingChangesRef.current = true;
    scheduleUpdate();
  }, [scheduleUpdate]);

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    return flushSave();
  }, [flushSave]);

  // Keep input refs bounded to currently rendered items.
  useEffect(() => {
    const activeItemIds = new Set(items.map((item) => item.id));
    for (const id of itemInputRefsMap.current.keys()) {
      if (!activeItemIds.has(id)) {
        itemInputRefsMap.current.delete(id);
      }
    }
  }, [items]);

  // Intercept navigation away to flush pending edits before leaving the screen.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (intentionalExitRef.current || !hasPendingChangesRef.current) {
        return;
      }
      event.preventDefault();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void (async () => {
        const saveSucceeded = await flushSave();
        if (!saveSucceeded) {
          return;
        }
        intentionalExitRef.current = true;
        navigation.dispatch(event.data.action);
      })();
    });
    return unsubscribe;
  }, [flushSave, navigation]);

  // Flush pending save on unmount (prevent data loss), skip if intentionally exiting
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!intentionalExitRef.current && hasPendingChangesRef.current) {
        flushSave(true);
      }
    };
  }, [flushSave]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (newTitle.length > VALIDATION.TITLE_MAX_LENGTH) return;
      setTitle(newTitle);
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (newContent.length > VALIDATION.CONTENT_MAX_LENGTH) return;
      setContent(newContent);
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleItemCompletedToggle = useCallback(
    async (itemId: string, completed: boolean) => {
      const before = itemsRef.current;
      const target = before.find((item) => item.id === itemId);
      if (!target || target.completed === completed) return;

      // Optimistic cascade applied immediately
      const cascaded = applyCompletedCascade(before, itemId, completed);
      setItems(cascaded);

      // For unsaved new notes, let the bulk-create carry completed flags
      if (!noteIdRef.current) {
        markDirtyAndScheduleUpdate();
        return;
      }

      // Cancel any pending debounced save to avoid a race with the toggle API call
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      try {
        const serverItems = await toggleItemCompletedRef.current({
          noteId: noteIdRef.current,
          itemId,
          completed,
        });
        if (serverItems.length > 0) {
          // Online: reconcile only completed flags from server response
          const completedById = new Map(serverItems.map((item) => [item.id, item.completed]));
          setItems((prev) =>
            prev.map((item) => {
              const serverCompleted = completedById.get(item.id);
              return serverCompleted === undefined ? item : { ...item, completed: serverCompleted };
            }),
          );
          // Advance the baseline so the diff engine does not re-patch completed
          for (const [id, comp] of completedById) {
            const snap = savedItemsRef.current.get(id);
            if (snap) savedItemsRef.current.set(id, { ...snap, completed: comp });
          }
        } else {
          // Offline: cascade was applied to local DB; advance baseline here too
          for (const item of cascaded) {
            const snap = savedItemsRef.current.get(item.id);
            if (snap && snap.completed !== item.completed) {
              savedItemsRef.current.set(item.id, { ...snap, completed: item.completed });
            }
          }
        }
      } catch {
        setItems(before);
        setSaveError(t('note.failedSaveChanges'));
      }
    },
    [markDirtyAndScheduleUpdate, t],
  );

  const handleItemTextChange = useCallback(
    (index: number, text: string) => {
      if (!text.includes('\n')) {
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      // Multi-line paste: split into separate items
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      if (lines.length <= 1) {
        const singleText = (lines[0] ?? '').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: singleText } : item)));
        markDirtyAndScheduleUpdate();
        return;
      }

      const isCompleted = itemsRef.current[index]?.completed ?? false;

      if (isCompleted) {
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: lines.join(' ').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
          ),
        );
        markDirtyAndScheduleUpdate();
        return;
      }

      const prepasteItems = [...itemsRef.current];
      const [firstLine, ...remainingLines] = lines;
      const newIds = remainingLines.map(() => nextTempId());

      setItems((prev) => {
        const sourceParentId = prev[index]?.parentId ?? null;
        const newItems: LocalItem[] = remainingLines.map((line, i) => ({
          id: newIds[i],
          text: line.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH),
          completed: false,
          position: 0,
          parentId: sourceParentId,
          assigned_to: '',
        }));
        const updated = prev.map((item, i) =>
          i === index ? { ...item, text: firstLine.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
        );
        updated.splice(index + 1, 0, ...newItems);
        return updated.map((item, i) => ({ ...item, position: i }));
      });
      markDirtyAndScheduleUpdate();

      showToast(t('note.itemsPasted', { count: remainingLines.length }), 'info', {
        label: t('dashboard.undo'),
        onPress: () => {
          setItems(prepasteItems);
          markDirtyAndScheduleUpdate();
        },
      });

      const lastId = newIds[newIds.length - 1];
      const lastItemRef = getItemRef(lastId);
      setTimeout(() => lastItemRef.current?.focus(), 50);
    },
    [markDirtyAndScheduleUpdate, getItemRef, showToast, t],
  );

  const handleDeleteItem = useCallback(
    (index: number) => {
      const removedItemId = itemsRef.current[index]?.id;
      setItems((prev) => prev.filter((_, i) => i !== index));
      if (removedItemId) {
        itemInputRefsMap.current.delete(removedItemId);
      }
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleAddItem = useCallback(() => {
    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
    ]);
    markDirtyAndScheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [markDirtyAndScheduleUpdate, getItemRef]);

  const handleInsertItemAfter = useCallback((index: number) => {
    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => {
      const newItem: LocalItem = {
        id: newId,
        text: '',
        completed: false,
        position: index + 1,
        parentId: prev[index]?.parentId ?? null,
        assigned_to: '',
      };
      const next = [...prev.slice(0, index + 1), newItem, ...prev.slice(index + 1)];
      return next.map((item, i) => ({ ...item, position: i }));
    });
    markDirtyAndScheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [markDirtyAndScheduleUpdate, getItemRef]);

  const handleBackspaceOnEmpty = useCallback((index: number) => {
    const currentItems = itemsRef.current;
    const item = currentItems[index];
    if (!item || item.text !== '') {
      return;
    }
    const removedItemId = item.id;
    const focusTargetId = index > 0 ? (currentItems[index - 1]?.id ?? null) : null;
    setItems((prev) => prev.filter((_, i) => i !== index));
    itemInputRefsMap.current.delete(removedItemId);
    markDirtyAndScheduleUpdate();
    setTimeout(() => {
      if (focusTargetId) itemInputRefsMap.current.get(focusTargetId)?.current?.focus();
    }, 50);
  }, [markDirtyAndScheduleUpdate]);

  const handleIndentItem = useCallback(
    (index: number, delta: 1 | -1) => {
      const currentItems = itemsRef.current;
      const target = currentItems[index];
      if (!target) return;

      let newParentId: string | null = target.parentId;
      if (delta === 1) {
        if (target.parentId !== null) return; // already nested
        if (itemHasChildren(currentItems, target.id)) return; // would create a grandchild
        const parentId = precedingTopLevelId(currentItems, target.id);
        if (!parentId) return; // nothing to nest under
        newParentId = parentId;
      } else {
        if (target.parentId === null) return; // already top-level
        newParentId = null;
      }

      setItems((prev) =>
        normalizeItemOrder(
          prev.map((item) => (item.id === target.id ? { ...item, parentId: newParentId } : item)),
        ),
      );
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleAcceptSuggestion = useCallback(
    (itemId: string, suggestionText: string) => {
      // Capture the completed item ID from the ref snapshot so we can focus it after setItems
      const restoredId = itemsRef.current.find(
        (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
      )?.id;

      setItems((prev) => {
        const completedItem = prev.find(
          (item) => item.completed && item.text.trim().toLowerCase() === suggestionText.toLowerCase(),
        );

        if (!completedItem) {
          return prev.map((item) => (item.id === itemId ? { ...item, text: suggestionText } : item));
        }

        const currentUnchecked = prev.filter((item) => !item.completed);
        // itemId is always an unchecked item so findIndex should never return -1; Math.max guards against stale ref races
        const insertAt = Math.max(0, currentUnchecked.findIndex((item) => item.id === itemId));

        const filtered = prev.filter(
          (item) => item.id !== itemId && item.id !== completedItem.id,
        );

        const restoredItem: LocalItem = { ...completedItem, completed: false };
        const remainingUncompleted = filtered.filter((item) => !item.completed);
        const remainingCompleted = filtered.filter((item) => item.completed);

        const newUncompleted = [
          ...remainingUncompleted.slice(0, insertAt),
          restoredItem,
          ...remainingUncompleted.slice(insertAt),
        ].map((item, i) => ({ ...item, position: i }));

        return [
          ...newUncompleted,
          ...remainingCompleted.map((item, i) => ({ ...item, position: newUncompleted.length + i })),
        ];
      });

      markDirtyAndScheduleUpdate();

      if (restoredId) {
        setTimeout(() => {
          itemInputRefsMap.current.get(restoredId)?.current?.focus();
        }, 50);
      }
    },
    [markDirtyAndScheduleUpdate],
  );

  // Metadata actions (pin/archive/color) flush pending item edits first, then
  // PATCH only the field that changed. Sending just the changed scalar avoids
  // re-sending (and clobbering) items or other fields edited concurrently
  // elsewhere. The caller advances the saved baseline only after the PATCH
  // succeeds (see commitMetadataBaseline).
  const buildMetadataUpdateData = useCallback((overrides: Partial<UpdateNoteRequest>): UpdateNoteRequest => {
    return { ...overrides } as UpdateNoteRequest;
  }, []);

  const commitMetadataBaseline = useCallback((overrides: Partial<UpdateNoteRequest>) => {
    Object.assign(savedScalarsRef.current, overrides);
  }, []);

  const handleTitleSubmit = useCallback(() => {
    if (noteTypeRef.current === 'text') {
      contentInputRef.current?.focus();
    } else {
      const firstUnchecked = itemsRef.current.find((item) => !item.completed);
      if (firstUnchecked) {
        itemInputRefsMap.current.get(firstUnchecked.id)?.current?.focus();
      } else {
        const newId = nextTempId();
        const newItemRef = getItemRef(newId);
        setItems((prev) => [
          ...prev,
          { id: newId, text: '', completed: false, position: prev.length, parentId: null, assigned_to: '' },
        ]);
        markDirtyAndScheduleUpdate();
        setTimeout(() => newItemRef.current?.focus(), 50);
      }
    }
  }, [markDirtyAndScheduleUpdate, getItemRef]);

  const handleToggleCollapsed = useCallback(() => {
    setCheckedItemsCollapsed((prev) => !prev);
    markDirtyAndScheduleUpdate();
  }, [markDirtyAndScheduleUpdate]);

  const collaborators = useMemo<Collaborator[]>(() => {
    if (!existingNote) return [];
    const hasShares = existingNote.shared_with && existingNote.shared_with.length > 0;
    if (!existingNote.is_shared && !hasShares) return [];
    return buildCollaborators(existingNote.user_id, existingNote.shared_with, usersById);
  }, [existingNote, usersById]);

  const isNoteShared = useMemo(() => {
    return (existingNote?.shared_with && existingNote.shared_with.length > 0) || existingNote?.is_shared;
  }, [existingNote?.shared_with, existingNote?.is_shared]);

  const handleAssignItem = useCallback(
    (itemId: string, userId: string) => {
      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, assigned_to: userId } : item)),
      );
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const openAssigneePicker = useCallback((itemId: string) => {
    setAssigningItemId(itemId);
    setAssigneePickerVisible(true);
  }, []);

  const handleDelete = useCallback(() => {
    if (!noteId) {
      intentionalExitRef.current = true;
      navigation.goBack();
      return;
    }
    Alert.alert(t('note.deleteConfirmTitle'), t('note.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            intentionalExitRef.current = true;
            if (saveInFlightRef.current) {
              try { await saveInFlightRef.current; } catch { /* already handled */ }
            }
            await deleteMutation.mutateAsync(noteId);
            showToast(t('dashboard.noteDeleted'), 'success', {
              label: t('dashboard.undo'),
              onPress: async () => {
                try {
                  await restoreMutation.mutateAsync(noteId);
                  showToast(t('dashboard.noteRestored'));
                } catch {
                  showToast(t('note.failedRestore'), 'error');
                }
              },
            });
            navigation.goBack();
          } catch {
            intentionalExitRef.current = false;
            Alert.alert(t('common.error'), t('note.failedDelete'));
          }
        },
      },
    ]);
  }, [deleteMutation, navigation, noteId, restoreMutation, showToast, t]);

  const handleTogglePin = useCallback(async () => {
    if (!noteId) return;
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const newPinned = !pinnedRef.current;
    setPinned(newPinned);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: buildMetadataUpdateData({ pinned: newPinned }),
      });
      commitMetadataBaseline({ pinned: newPinned });
    } catch {
      setPinned(!newPinned);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, noteId, t, updateMutation]);

  const handleToggleArchive = useCallback(async () => {
    if (!noteId) return;
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const newArchived = !archivedRef.current;
    setArchived(newArchived);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: buildMetadataUpdateData({ archived: newArchived }),
      });
      commitMetadataBaseline({ archived: newArchived });
      if (newArchived) {
        showToast(t('dashboard.noteArchived'), 'success', {
          label: t('dashboard.undo'),
          onPress: async () => {
            try {
              await updateMutation.mutateAsync({
                id: noteId,
                data: buildMetadataUpdateData({ archived: false }),
              });
              commitMetadataBaseline({ archived: false });
              setArchived(false);
              showToast(t('dashboard.noteUnarchived'));
            } catch {
              showToast(t('note.failedUnarchive'), 'error');
            }
          },
        });
      } else {
        showToast(t('dashboard.noteUnarchived'));
      }
    } catch {
      setArchived(!newArchived);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, noteId, showToast, t, updateMutation]);

  const handleColorSelect = useCallback(async (selectedColor: string) => {
    const saveSucceeded = await flushPendingChanges();
    if (!saveSucceeded) {
      return;
    }
    const prevColor = colorRef.current;
    setColor(selectedColor);
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) {
      // Newly-created notes may not have committed noteId into render state yet.
      // Keep this change dirty so autosave (or beforeRemove flush) persists color.
      markDirtyAndScheduleUpdate();
      return;
    }
    if (isHydratingRef.current) {
      // Existing note data is still loading; avoid sending a metadata-only update
      // with placeholder refs that could overwrite hydrated title/content.
      markDirtyAndScheduleUpdate();
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: currentNoteId,
        data: buildMetadataUpdateData({ color: selectedColor }),
      });
      commitMetadataBaseline({ color: selectedColor });
    } catch {
      setColor(prevColor);
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [buildMetadataUpdateData, commitMetadataBaseline, flushPendingChanges, markDirtyAndScheduleUpdate, t, updateMutation]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'list' : 'text'));
  }, [hasCreated]);

  const handleDuplicate = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const saveSucceeded = await flushSave();
    if (!saveSucceeded) {
      return;
    }

    const currentNoteId = noteIdRef.current;
    if (!currentNoteId || isLocalId(currentNoteId)) {
      Alert.alert(t('common.error'), t('note.waitForSyncBeforeDuplicating'));
      return;
    }

    try {
      const duplicatedNote = await duplicateMutation.mutateAsync(currentNoteId);
      intentionalExitRef.current = true;
      Alert.alert(t('note.duplicate'), t('note.duplicated'));
      navigation.replace('NoteEditor', { noteId: duplicatedNote.id });
    } catch {
      Alert.alert(t('common.error'), t('note.failedDuplicate'));
    }
  }, [duplicateMutation, flushSave, navigation, t]);

  // Disable inputs while waiting for existing note to hydrate
  const isHydrating = initialNoteId !== null && !existingNote;

  // Build index lookup for items to avoid O(n) indexOf per item
  const itemIndexMap = useMemo(
    () => new Map(items.map((item, i) => [item.id, i])),
    [items],
  );
  const itemIndexMapRef = useRef(itemIndexMap);
  itemIndexMapRef.current = itemIndexMap;

  const uncheckedItems = useMemo(() => items.filter((item) => !item.completed), [items]);
  const checkedItems = useMemo(() => items.filter((item) => item.completed), [items]);

  const completedItemTexts = useMemo(() => {
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const item of checkedItems) {
      const trimmed = item.text.trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        texts.push(trimmed);
      }
    }
    return texts;
  }, [checkedItems]);

  // Use ref to avoid recreating handleListReorder on every items change
  const checkedItemsRef = useRef(checkedItems);
  checkedItemsRef.current = checkedItems;

  const handleListReorder = useCallback(
    (reorderedUnchecked: LocalItem[]) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      // Merge reordered unchecked with existing checked items, then normalize
      // so that each parent's children stay contiguous in the combined array.
      setItems(normalizeItemOrder([...reorderedUnchecked, ...checkedItemsRef.current]));
      markDirtyAndScheduleUpdate();
    },
    [markDirtyAndScheduleUpdate],
  );

  const handleListDragStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const handleListItemFocus = useCallback<NonNullable<TextInputProps['onFocus']>>((event) => {
    const nativeTarget = event.nativeEvent.target;
    if (nativeTarget == null) return;

    // Use ScrollView's native keyboard helper so focused list item inputs stay visible.
    const responder = scrollViewRef.current?.getScrollResponder?.();
    if (
      responder &&
      typeof responder.scrollResponderScrollNativeHandleToKeyboard === 'function'
    ) {
      responder.scrollResponderScrollNativeHandleToKeyboard(
        nativeTarget,
        FOCUSED_INPUT_KEYBOARD_MARGIN,
        true,
      );
      return;
    }
  }, []);

  const handleFocusListItem = useCallback(
    (itemId: string, event: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      if (listItemBlurTimerRef.current) {
        clearTimeout(listItemBlurTimerRef.current);
        listItemBlurTimerRef.current = null;
      }
      focusedListItemIdRef.current = itemId;
      setListItemFocused(true);
      handleListItemFocus(event);
    },
    [handleListItemFocus],
  );

  const handleBlurListItem = useCallback(() => {
    // Delay so toolbar button onPress fires before state clears (Android blur-before-press ordering)
    listItemBlurTimerRef.current = setTimeout(() => {
      listItemBlurTimerRef.current = null;
      focusedListItemIdRef.current = null;
      setListItemFocused(false);
    }, 200);
  }, []);

  const handleListIndent = useCallback(
    (delta: 1 | -1) => {
      const id = focusedListItemIdRef.current;
      if (!id) return;
      const index = itemIndexMapRef.current.get(id);
      if (index === undefined) return;
      handleIndentItem(index, delta);
    },
    [handleIndentItem],
  );

  const hasNoteColor = !!color && !isWhiteHexColor(color);

  const listIndentToolbarContent = noteType === 'list' ? (
    <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceVariant, borderTopColor: colors.border }]}>
      <TouchableOpacity onPress={() => handleListIndent(-1)} style={styles.fmtBtn} accessibilityLabel={t('note.outdentItem')} testID="list-outdent-btn">
        <Ionicons name="arrow-back-outline" size={18} color={colors.text} />
      </TouchableOpacity>
      <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
      <TouchableOpacity onPress={() => handleListIndent(1)} style={styles.fmtBtn} accessibilityLabel={t('note.indentItem')} testID="list-indent-btn">
        <Ionicons name="arrow-forward-outline" size={18} color={colors.text} />
      </TouchableOpacity>
    </View>
  ) : null;

  const renderListItem = useCallback(
    ({ item, drag, isActive }: { item: LocalItem; drag: () => void; isActive: boolean }) => {
      const originalIndex = itemIndexMapRef.current.get(item.id);
      if (originalIndex === undefined) return null;
      const itemRef = getItemRef(item.id);
      return (
        <ScaleDecorator>
          <View style={isActive ? [styles.draggingListItem, { shadowColor: isDark ? colors.border : '#000' }] : undefined}>
            <ListItem
              inputRef={itemRef}
              text={item.text}
              completed={item.completed}
              isActive={isActive}
              indentLevel={item.parentId ? 1 : 0}
              showDragHandle
              assignedTo={item.assigned_to}
              isShared={!!isNoteShared}
              collaborators={collaborators}
              hasNoteColor={hasNoteColor}
              completedItemTexts={completedItemTexts}
              onDrag={drag}
              onToggle={() => { void handleItemCompletedToggle(item.id, !item.completed); }}
              onChangeText={(text) => handleItemTextChange(originalIndex, text)}
              onDelete={() => handleDeleteItem(originalIndex)}
              onSubmitEditing={() => handleInsertItemAfter(originalIndex)}
              onBackspaceOnEmpty={() => handleBackspaceOnEmpty(originalIndex)}
              onAssignPress={() => openAssigneePicker(item.id)}
              onFocus={(event) => handleFocusListItem(item.id, event)}
              onBlur={handleBlurListItem}
              onIndent={(delta) => handleIndentItem(originalIndex, delta)}
              onAcceptSuggestion={(text) => handleAcceptSuggestion(item.id, text)}
              inputAccessoryViewID={Platform.OS === 'ios' ? LIST_INDENT_TOOLBAR_ID : undefined}
            />
          </View>
        </ScaleDecorator>
      );
    },
    [getItemRef, handleItemCompletedToggle, handleItemTextChange, handleDeleteItem, handleInsertItemAfter, handleBackspaceOnEmpty, isNoteShared, collaborators, openAssigneePicker, handleIndentItem, isDark, colors, handleFocusListItem, handleBlurListItem, hasNoteColor, completedItemTexts, handleAcceptSuggestion],
  );

  const applyToolbarEdit = useCallback((updater: (prev: string) => string) => {
    const next = updater(contentRef.current);
    if (next === contentRef.current || next.length > VALIDATION.CONTENT_MAX_LENGTH) {
      return;
    }
    setContent(next);
    markDirtyAndScheduleUpdate();
    contentInputRef.current?.focus();
  }, [markDirtyAndScheduleUpdate]);

  const wrapMobileSelection = useCallback((before: string, after: string) => {
    applyToolbarEdit((prev) => prev + before + after);
  }, [applyToolbarEdit]);

  const insertMobileBullet = useCallback(() => {
    applyToolbarEdit((prev) => {
      const insert = (prev.endsWith('\n') || prev === '') ? '- ' : '\n- ';
      return prev + insert;
    });
  }, [applyToolbarEdit]);

  const insertMobileHeading = useCallback(() => {
    applyToolbarEdit((prev) => {
      const lines = prev.split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine.startsWith('## ')) return prev;
      return prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + '## ';
    });
  }, [applyToolbarEdit]);

  const noteBackground = hasNoteColor ? color : colors.surface;
  const completedSectionDividerColor = hasNoteColor
    ? getCompletedSectionDividerColor(noteBackground)
    : colors.borderLight;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: noteBackground }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? IOS_KEYBOARD_VERTICAL_OFFSET : 0}
    >
      <View style={[styles.header, { backgroundColor: noteBackground, borderBottomColor: hasNoteColor ? 'transparent' : colors.borderLight, paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          testID="editor-back"
        >
          <Ionicons name="arrow-back" size={24} color={hasNoteColor ? '#1a1a1a' : colors.text} />
        </TouchableOpacity>
        <View style={styles.headerRight}>
          {noteType === 'text' && isEditingContent && hasCreated ? (
            <TouchableOpacity
              onPress={() => { Keyboard.dismiss(); setIsEditingContent(false); }}
              style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]}
              testID="done-editing-btn"
            >
              <Text style={[styles.typeToggleText, { color: colors.primary }]}>
                {t('common.done')}
              </Text>
            </TouchableOpacity>
          ) : (
            !hasCreated && (
              <TouchableOpacity onPress={handleToggleNoteType} style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]} testID="toggle-note-type">
                <Ionicons
                  name={noteType === 'text' ? 'list' : 'document-text-outline'}
                  size={22}
                  color={colors.primary}
                />
                <Text style={[styles.typeToggleText, { color: colors.primary }]}>
                  {noteType === 'text' ? t('note.typeList') : t('note.typeText')}
                </Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>

      {saveError && (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: colors.errorLight, borderBottomColor: colors.error }]}
          onPress={() => {
            setSaveError(null);
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            flushSave();
          }}
          testID="save-error-banner"
        >
          <Text style={[styles.errorText, { color: colors.error }]}>{saveError}</Text>
        </TouchableOpacity>
      )}

      {syncToast && (
        <TouchableOpacity
          style={[styles.syncToast, { backgroundColor: colors.primaryLight, borderBottomColor: colors.primary }]}
          onPress={() => setSyncToast(null)}
          testID="sync-toast"
        >
          <Text style={[styles.syncToastText, { color: colors.primary }]}>{syncToast}</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentContainer}
        keyboardShouldPersistTaps="handled"
      >
        {noteType === 'list' && (
          <TextInput
            ref={titleInputRef}
            style={[styles.titleInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
            value={title}
            onChangeText={handleTitleChange}
            placeholder={t('note.titlePlaceholder')}
            placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
            maxLength={VALIDATION.TITLE_MAX_LENGTH}
            returnKeyType="next"
            onSubmitEditing={handleTitleSubmit}
            blurOnSubmit={false}
            editable={!isHydrating}
            testID="note-title-input"
          />
        )}

        {noteType === 'text' ? (
          <>
            {isEditingContent ? (
              <TextInput
                ref={contentInputRef}
                autoFocus
                inputAccessoryViewID={Platform.OS === 'ios' ? MARKDOWN_TOOLBAR_ID : undefined}
                multiline
                autoCapitalize="sentences"
                placeholder={t('note.contentPlaceholder')}
                placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
                style={[styles.contentInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
                value={content}
                onChangeText={handleContentChange}
                textAlignVertical="top"
                editable={!isHydrating}
                testID="note-content-input"
              />
            ) : (
              <TouchableOpacity
                onPress={() => setIsEditingContent(true)}
                activeOpacity={1}
                testID="content-preview"
                style={styles.contentPreview}
              >
                {content ? (
                  <Markdown style={fullMarkdownStyles(hasNoteColor ? '#1a1a1a' : colors.text)}>
                    {preprocessMarkdown(content)}
                  </Markdown>
                ) : (
                  <Text style={{ color: hasNoteColor ? '#999' : colors.placeholder, fontSize: 14 }}>
                    {t('note.contentPlaceholder')}
                  </Text>
                )}
              </TouchableOpacity>
            )}

            {/* Android: formatting toolbar in layout (shown when editing) */}
            {Platform.OS === 'android' && isEditingContent && (
              <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceVariant, borderTopColor: colors.border }]}>
                <TouchableOpacity onPress={() => wrapMobileSelection('**', '**')} style={styles.fmtBtn} accessibilityLabel={t('note.formatBold')}>
                  <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => wrapMobileSelection('*', '*')} style={styles.fmtBtn} accessibilityLabel={t('note.formatItalic')}>
                  <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
                </TouchableOpacity>
                <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
                <TouchableOpacity onPress={insertMobileHeading} style={styles.fmtBtn} accessibilityLabel={t('note.formatHeading')}>
                  <Text style={[styles.fmtBtnText, { color: colors.text }]}>H₂</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={insertMobileBullet} style={styles.fmtBtn} accessibilityLabel={t('note.formatBulletList')}>
                  <Text style={[styles.fmtBtnText, { color: colors.text }]}>• list</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* iOS: formatting toolbar as InputAccessoryView (docks above keyboard) */}
            {Platform.OS === 'ios' && noteType === 'text' && (
              <InputAccessoryView nativeID={MARKDOWN_TOOLBAR_ID}>
                <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceVariant, borderTopColor: colors.border }]}>
                  <TouchableOpacity onPress={() => wrapMobileSelection('**', '**')} style={styles.fmtBtn} accessibilityLabel={t('note.formatBold')}>
                    <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => wrapMobileSelection('*', '*')} style={styles.fmtBtn} accessibilityLabel={t('note.formatItalic')}>
                    <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
                  </TouchableOpacity>
                  <View style={[styles.fmtSep, { backgroundColor: colors.border }]} />
                  <TouchableOpacity onPress={insertMobileHeading} style={styles.fmtBtn} accessibilityLabel={t('note.formatHeading')}>
                    <Text style={[styles.fmtBtnText, { color: colors.text }]}>H₂</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={insertMobileBullet} style={styles.fmtBtn} accessibilityLabel={t('note.formatBulletList')}>
                    <Text style={[styles.fmtBtnText, { color: colors.text }]}>• list</Text>
                  </TouchableOpacity>
                </View>
              </InputAccessoryView>
            )}
          </>
        ) : (
          <View style={styles.listContainer}>
            <DraggableFlatList
              data={uncheckedItems}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
              onDragBegin={handleListDragStart}
              onDragEnd={({ data }) => handleListReorder(data)}
              renderItem={renderListItem}
            />

            <TouchableOpacity style={styles.addItemRow} onPress={handleAddItem} testID="add-list-item">
              <Ionicons name="add" size={22} color={colors.primary} />
              <Text style={[styles.addItemText, { color: colors.primary }]}>{t('note.addItem')}</Text>
            </TouchableOpacity>

            {checkedItems.length > 0 && (
              <View style={[styles.checkedSection, { borderTopColor: completedSectionDividerColor }]} testID="checked-items-section">
                <TouchableOpacity
                  style={styles.checkedHeader}
                  onPress={handleToggleCollapsed}
                  testID="toggle-checked-items"
                >
                  <Ionicons
                    name={checkedItemsCollapsed ? 'chevron-forward' : 'chevron-down'}
                    size={18}
                    color={hasNoteColor ? '#888' : colors.iconMuted}
                  />
                  <Text style={[styles.checkedHeaderText, { color: hasNoteColor ? '#777' : colors.textMuted }]}>
                    {t('note.completedItems', { count: checkedItems.length })}
                  </Text>
                </TouchableOpacity>

                {!checkedItemsCollapsed && (() => {
                  const completedIds = new Set(checkedItems.map((i) => i.id));
                  const itemsById = new Map(items.map((i) => [i.id, i]));
                  const rows: React.ReactElement[] = [];
                  let lastGhostParentId: string | null = null;

                  checkedItems.forEach((item) => {
                    const originalIndex = itemIndexMap.get(item.id);
                    if (originalIndex === undefined) return;
                    const parent = item.parentId ? itemsById.get(item.parentId) : undefined;
                    const parentIsCompleted = item.parentId ? completedIds.has(item.parentId) : false;

                    if (parent && !parentIsCompleted) {
                      if (lastGhostParentId !== parent.id) {
                        lastGhostParentId = parent.id;
                        rows.push(
                          <View
                            key={`ghost-${parent.id}`}
                            style={styles.ghostParent}
                            accessibilityLabel={t('note.completedItemGroup', { title: parent.text })}
                          >
                            <View style={styles.ghostCheckbox} />
                            <Text style={[styles.ghostParentText, { color: hasNoteColor ? '#888' : colors.textMuted }]} numberOfLines={1}>
                              {parent.text}
                            </Text>
                          </View>,
                        );
                      }
                    } else {
                      lastGhostParentId = null;
                    }

                    rows.push(
                      <ListItem
                        key={item.id}
                        inputRef={getItemRef(item.id)}
                        text={item.text}
                        completed={item.completed}
                        isActive={false}
                        indentLevel={item.parentId ? 1 : 0}
                        assignedTo={item.assigned_to}
                        isShared={!!isNoteShared}
                        collaborators={collaborators}
                        hasNoteColor={hasNoteColor}
                        onToggle={() => { void handleItemCompletedToggle(item.id, !item.completed); }}
                        onChangeText={(text) => handleItemTextChange(originalIndex, text)}
                        onDelete={() => handleDeleteItem(originalIndex)}
                        onSubmitEditing={() => handleInsertItemAfter(originalIndex)}
                        onBackspaceOnEmpty={() => handleBackspaceOnEmpty(originalIndex)}
                        onAssignPress={() => openAssigneePicker(item.id)}
                        onFocus={(event) => handleFocusListItem(item.id, event)}
                        onBlur={handleBlurListItem}
                        onIndent={(delta) => handleIndentItem(originalIndex, delta)}
                        inputAccessoryViewID={Platform.OS === 'ios' ? LIST_INDENT_TOOLBAR_ID : undefined}
                      />,
                    );
                  });

                  return rows;
                })()}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Android: show toolbar when a list item is focused (state-gated since no native focus binding) */}
      {Platform.OS === 'android' && listItemFocused && listIndentToolbarContent}

      {/* iOS: InputAccessoryView is implicitly focus-gated via inputAccessoryViewID on the TextInput */}
      {Platform.OS === 'ios' && listIndentToolbarContent !== null && (
        <InputAccessoryView nativeID={LIST_INDENT_TOOLBAR_ID}>
          {listIndentToolbarContent}
        </InputAccessoryView>
      )}

      <View style={[styles.toolbar, { backgroundColor: noteBackground, borderTopColor: hasNoteColor ? 'transparent' : colors.border, paddingBottom: insets.bottom || 8 }]}>
        {/* Color picker button */}
        <TouchableOpacity
          onPress={() => setColorPickerVisible(true)}
          style={styles.toolbarBtn}
          testID="toolbar-color-btn"
          accessibilityLabel={t('note.changeColor')}
        >
          <Ionicons name="color-palette-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
        </TouchableOpacity>

        {/* Share (only when note is saved, synced, hydrated, and owned by current user) */}
        {noteId && !isLocalId(noteId) && existingNote && !existingNote.is_shared && (
          <TouchableOpacity
            onPress={() => navigation.navigate('Share', { noteId })}
            style={styles.toolbarBtn}
            testID="toolbar-share-btn"
            accessibilityLabel={t('note.share')}
          >
            <Ionicons name="share-social-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Pin / Unpin */}
        {noteId && (
          <TouchableOpacity
            onPress={handleTogglePin}
            style={styles.toolbarBtn}
            testID="toolbar-pin-btn"
            accessibilityLabel={pinned ? t('note.unpin') : t('note.pin')}
          >
            <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={22} color={pinned ? colors.primary : (hasNoteColor ? '#444' : colors.icon)} />
          </TouchableOpacity>
        )}

        {/* Archive / Unarchive */}
        {noteId && (
          <TouchableOpacity
            onPress={handleToggleArchive}
            style={styles.toolbarBtn}
            testID="toolbar-archive-btn"
            accessibilityLabel={archived ? t('note.unarchive') : t('note.archive')}
          >
            <Ionicons
              name="archive-outline"
              size={22}
              color={archived ? colors.primary : (hasNoteColor ? '#444' : colors.icon)}
            />
          </TouchableOpacity>
        )}

        {noteId && !isLocalId(noteId) && (
          <TouchableOpacity
            onPress={handleDuplicate}
            style={styles.toolbarBtn}
            testID="toolbar-duplicate-btn"
            accessibilityLabel={t('note.duplicate')}
          >
            <Ionicons name="copy-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {/* Label button (only when note is saved and synced to server) */}
        {noteId && !isLocalId(noteId) && (
          <TouchableOpacity
            onPress={() => setLabelPickerVisible(true)}
            style={styles.toolbarBtn}
            testID="toolbar-label-btn"
            accessibilityLabel={t('labels.title')}
          >
            <Ionicons name="pricetag-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        <View style={styles.toolbarSpacer} />

        {/* Delete */}
        <TouchableOpacity onPress={handleDelete} style={styles.toolbarBtn} testID="delete-note-btn">
          <Ionicons name="trash-outline" size={22} color={colors.error} />
        </TouchableOpacity>
      </View>

      <ColorPicker
        visible={colorPickerVisible}
        currentColor={color}
        onSelect={handleColorSelect}
        onClose={() => setColorPickerVisible(false)}
      />

      {noteId && (
        <LabelPicker
          visible={labelPickerVisible}
          noteId={noteId}
          noteLabels={labels}
          onClose={() => setLabelPickerVisible(false)}
        />
      )}

      <AssigneePicker
        visible={assigneePickerVisible}
        collaborators={collaborators}
        currentAssigneeId={
          assigningItemId
            ? items.find((i) => i.id === assigningItemId)?.assigned_to ?? ''
            : ''
        }
        onAssign={(userId) => {
          if (assigningItemId) {
            handleAssignItem(assigningItemId, userId);
          }
        }}
        onClose={() => {
          setAssigneePickerVisible(false);
          setAssigningItemId(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  typeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  typeToggleText: {
    fontSize: 14,
    fontWeight: '500',
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: 16,
  },
  scrollContentContainer: {
    paddingBottom: 96,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '600',
    paddingVertical: 16,
    paddingHorizontal: 0,
  },
  contentInput: {
    fontSize: 16,
    lineHeight: 24,
    minHeight: 200,
    paddingHorizontal: 0,
  },
  listContainer: {
    paddingBottom: 16,
  },
  addItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  addItemText: {
    fontSize: 16,
  },
  checkedSection: {
    marginTop: 16,
    borderTopWidth: 1,
    paddingTop: 8,
  },
  checkedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  checkedHeaderText: {
    fontSize: 14,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  toolbarBtn: {
    padding: 10,
    borderRadius: 20,
  },
  toolbarSpacer: {
    flex: 1,
  },
  errorBanner: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 14,
    textAlign: 'center',
  },
  syncToast: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  syncToastText: {
    fontSize: 14,
    textAlign: 'center',
  },
  draggingListItem: {
    borderRadius: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  contentPreview: {
    flex: 1,
    paddingHorizontal: 0,
    paddingTop: 8,
    minHeight: 120,
  },
  formattingToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fmtBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  fmtBtnText: {
    fontSize: 14,
  },
  fmtSep: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    marginHorizontal: 4,
  },
  ghostParent: {
    flexDirection: 'row',
    alignItems: 'center',
    opacity: 0.55,
    paddingVertical: 4,
    gap: 8,
  },
  ghostCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#aaa',
    flexShrink: 0,
  },
  ghostParentText: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
});
