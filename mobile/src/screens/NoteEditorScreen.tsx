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
  type TextInput as TextInputType,
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useCreateNote, useUpdateNote, useDeleteNote, useDuplicateNote } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { isLocalId } from '../db/noteQueries';
import { useSSESubscription } from '../store/SSEContext';
import TodoItem from '../components/TodoItem';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import { buildCollaborators, VALIDATION, type Collaborator, type NoteType, type NoteItem, type UpdateNoteRequest, type Label } from '@jot/shared';
import { useUsers } from '../store/UsersContext';
import { useTheme } from '../theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../navigation/RootNavigator';

type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;
type EditorNavProp = NativeStackNavigationProp<RootStackParamList, 'NoteEditor'>;

interface LocalItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  indent_level: number;
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
      indent_level: item.indent_level,
      assigned_to: item.assigned_to ?? '',
    }));
}

function serializeItems(items: LocalItem[]) {
  return items.map((item, i) => ({
    text: item.text,
    position: i,
    completed: item.completed,
    indent_level: item.indent_level,
    assigned_to: item.assigned_to,
  }));
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
  const { usersById } = useUsers();

  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { data: existingNote } = useOfflineNote(noteId);
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();
  const duplicateMutation = useDuplicateNote();

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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const tempIdCounterRef = useRef(0);

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

  const titleInputRef = useRef<TextInputType>(null);
  const contentInputRef = useRef<TextInputType>(null);
  const itemInputRefsMap = useRef(new Map<string, React.RefObject<TextInputType | null>>());

  const getItemRef = useCallback((id: string): React.RefObject<TextInputType | null> => {
    if (!itemInputRefsMap.current.has(id)) {
      itemInputRefsMap.current.set(id, React.createRef<TextInputType>());
    }
    return itemInputRefsMap.current.get(id)!;
  }, []);

  function nextTempId(): string {
    return `temp-${++tempIdCounterRef.current}`;
  }

  // Load existing note data
  useEffect(() => {
    if (existingNote && !isInitializedRef.current) {
      setTitle(existingNote.title);
      setContent(existingNote.content);
      setNoteType(existingNote.note_type);
      setCheckedItemsCollapsed(existingNote.checked_items_collapsed);
      setPinned(existingNote.pinned);
      setArchived(existingNote.archived);
      setColor(existingNote.color);
      setLabels(existingNote.labels ?? []);
      if (existingNote.items) {
        setItems(toLocalItems(existingNote.items));
      }
      isInitializedRef.current = true;
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

  const flushSave = useCallback(async (unmounting = false): Promise<boolean> => {
    // Skip save if editing an existing note that hasn't hydrated yet
    if (noteIdRef.current && !isInitializedRef.current) return false;

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

      if (!currentNoteId) {
        if (!currentTitle && !currentContent && currentItems.length === 0) return true;
        const newNote = await createMutateRef.current({
          title: currentTitle,
          content: currentContent,
          note_type: currentNoteType,
          color: currentColor !== '#ffffff' ? currentColor : undefined,
          items: currentNoteType === 'todo' ? serializeItems(currentItems) : undefined,
        });
        if (!isMountedRef.current || unmounting) return true;
        setNoteId(newNote.id);
        setHasCreated(true);
        setSaveError(null);
      } else {
        const updateData: UpdateNoteRequest = {
          title: currentTitle,
          content: currentContent,
          pinned: pinnedRef.current,
          archived: archivedRef.current,
          color: currentColor,
          checked_items_collapsed: currentCollapsed,
        };
        if (currentNoteType === 'todo') {
          updateData.items = serializeItems(currentItems);
        }
        await updateMutateRef.current({
          id: currentNoteId,
          data: updateData,
        });
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
  }, [t]);

  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      flushSave();
    }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
  }, [flushSave]);

  // Flush pending save on unmount (prevent data loss), skip if intentionally exiting
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (!intentionalExitRef.current) {
        flushSave(true);
      }
    };
  }, [flushSave]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      if (newTitle.length > VALIDATION.TITLE_MAX_LENGTH) return;
      setTitle(newTitle);
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (newContent.length > VALIDATION.CONTENT_MAX_LENGTH) return;
      setContent(newContent);
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleToggleItem = useCallback(
    (index: number) => {
      setItems((prev) =>
        prev.map((item, i) => (i === index ? { ...item, completed: !item.completed } : item)),
      );
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleItemTextChange = useCallback(
    (index: number, text: string) => {
      if (!text.includes('\n')) {
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text } : item)));
        scheduleUpdate();
        return;
      }

      // Multi-line paste: split into separate items
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

      if (lines.length <= 1) {
        const singleText = (lines[0] ?? '').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH);
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text: singleText } : item)));
        scheduleUpdate();
        return;
      }

      const isCompleted = itemsRef.current[index]?.completed ?? false;

      if (isCompleted) {
        setItems((prev) =>
          prev.map((item, i) =>
            i === index ? { ...item, text: lines.join(' ').slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
          ),
        );
        scheduleUpdate();
        return;
      }

      const [firstLine, ...remainingLines] = lines;
      const newIds = remainingLines.map(() => nextTempId());

      setItems((prev) => {
        const sourceIndentLevel = prev[index]?.indent_level ?? 0;
        const newItems: LocalItem[] = remainingLines.map((line, i) => ({
          id: newIds[i],
          text: line.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH),
          completed: false,
          position: 0,
          indent_level: sourceIndentLevel,
          assigned_to: '',
        }));
        const updated = prev.map((item, i) =>
          i === index ? { ...item, text: firstLine.slice(0, VALIDATION.ITEM_TEXT_MAX_LENGTH) } : item,
        );
        updated.splice(index + 1, 0, ...newItems);
        return updated.map((item, i) => ({ ...item, position: i }));
      });
      scheduleUpdate();

      const lastId = newIds[newIds.length - 1];
      const lastItemRef = getItemRef(lastId);
      setTimeout(() => lastItemRef.current?.focus(), 50);
    },
    [scheduleUpdate, getItemRef],
  );

  const handleDeleteItem = useCallback(
    (index: number) => {
      setItems((prev) => prev.filter((_, i) => i !== index));
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleAddItem = useCallback(() => {
    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => [
      ...prev,
      { id: newId, text: '', completed: false, position: prev.length, indent_level: 0, assigned_to: '' },
    ]);
    scheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [scheduleUpdate, getItemRef]);

  const handleInsertItemAfter = useCallback((index: number) => {
    const newId = nextTempId();
    const newItemRef = getItemRef(newId);
    setItems((prev) => {
      const newItem: LocalItem = {
        id: newId,
        text: '',
        completed: false,
        position: index + 1,
        indent_level: prev[index]?.indent_level ?? 0,
        assigned_to: '',
      };
      const next = [...prev.slice(0, index + 1), newItem, ...prev.slice(index + 1)];
      return next.map((item, i) => ({ ...item, position: i }));
    });
    scheduleUpdate();
    setTimeout(() => newItemRef.current?.focus(), 50);
  }, [scheduleUpdate, getItemRef]);

  const handleBackspaceOnEmpty = useCallback((index: number) => {
    let focusTargetId: string | null = null;
    setItems((prev) => {
      const item = prev[index];
      if (!item || item.text !== '') return prev;
      focusTargetId = index > 0 ? (prev[index - 1]?.id ?? null) : null;
      return prev.filter((_, i) => i !== index);
    });
    scheduleUpdate();
    setTimeout(() => {
      if (focusTargetId) itemInputRefsMap.current.get(focusTargetId)?.current?.focus();
    }, 50);
  }, [scheduleUpdate]);

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
          { id: newId, text: '', completed: false, position: prev.length, indent_level: 0, assigned_to: '' },
        ]);
        scheduleUpdate();
        setTimeout(() => newItemRef.current?.focus(), 50);
      }
    }
  }, [scheduleUpdate, getItemRef]);

  const handleToggleCollapsed = useCallback(() => {
    setCheckedItemsCollapsed((prev) => !prev);
    scheduleUpdate();
  }, [scheduleUpdate]);

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
      scheduleUpdate();
    },
    [scheduleUpdate],
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
            navigation.goBack();
          } catch {
            intentionalExitRef.current = false;
            Alert.alert(t('common.error'), t('note.failedDelete'));
          }
        },
      },
    ]);
  }, [deleteMutation, navigation, noteId, t]);

  const handleTogglePin = useCallback(async () => {
    if (!noteId) return;
    const newPinned = !pinnedRef.current;
    setPinned(newPinned);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: {
          title: titleRef.current,
          content: contentRef.current,
          pinned: newPinned,
          archived: archivedRef.current,
          color: colorRef.current,
          checked_items_collapsed: checkedItemsCollapsedRef.current,
        },
      });
    } catch {
      setPinned(!newPinned);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [noteId, t, updateMutation]);

  const handleToggleArchive = useCallback(async () => {
    if (!noteId) return;
    const newArchived = !archivedRef.current;
    setArchived(newArchived);
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: {
          title: titleRef.current,
          content: contentRef.current,
          pinned: pinnedRef.current,
          archived: newArchived,
          color: colorRef.current,
          checked_items_collapsed: checkedItemsCollapsedRef.current,
        },
      });
    } catch {
      setArchived(!newArchived);
      Alert.alert(t('common.error'), t('note.failedUpdate'));
    }
  }, [noteId, t, updateMutation]);

  const handleColorSelect = useCallback(async (selectedColor: string) => {
    const prevColor = colorRef.current;
    setColor(selectedColor);
    if (!noteId) return;
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        data: {
          title: titleRef.current,
          content: contentRef.current,
          pinned: pinnedRef.current,
          archived: archivedRef.current,
          color: selectedColor,
          checked_items_collapsed: checkedItemsCollapsedRef.current,
        },
      });
    } catch {
      setColor(prevColor);
      Alert.alert(t('common.error'), t('note.failedColorUpdate'));
    }
  }, [noteId, t, updateMutation]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'todo' : 'text'));
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

  // Use ref to avoid recreating handleTodoReorder on every items change
  const checkedItemsRef = useRef(checkedItems);
  checkedItemsRef.current = checkedItems;

  const handleTodoReorder = useCallback(
    (reorderedUnchecked: LocalItem[]) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      // Merge reordered unchecked with existing checked items
      setItems([...reorderedUnchecked, ...checkedItemsRef.current]);
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleTodoDragStart = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const renderTodoItem = useCallback(
    ({ item, drag, isActive }: { item: LocalItem; drag: () => void; isActive: boolean }) => {
      const originalIndex = itemIndexMapRef.current.get(item.id);
      if (originalIndex === undefined) return null;
      const itemRef = getItemRef(item.id);
      return (
        <ScaleDecorator>
          <View style={isActive ? [styles.draggingTodoItem, { shadowColor: isDark ? colors.border : '#000' }] : undefined}>
            <TodoItem
              inputRef={itemRef}
              text={item.text}
              completed={item.completed}
              indentLevel={item.indent_level}
              showDragHandle
              assignedTo={item.assigned_to}
              isShared={!!isNoteShared}
              collaborators={collaborators}
              onDrag={drag}
              onToggle={() => handleToggleItem(originalIndex)}
              onChangeText={(text) => handleItemTextChange(originalIndex, text)}
              onDelete={() => handleDeleteItem(originalIndex)}
              onSubmitEditing={() => handleInsertItemAfter(originalIndex)}
              onBackspaceOnEmpty={() => handleBackspaceOnEmpty(originalIndex)}
              onAssignPress={() => openAssigneePicker(item.id)}
            />
          </View>
        </ScaleDecorator>
      );
    },
    [getItemRef, handleToggleItem, handleItemTextChange, handleDeleteItem, handleInsertItemAfter, handleBackspaceOnEmpty, isNoteShared, collaborators, openAssigneePicker, isDark, colors],
  );

  const hasNoteColor = color && color !== '#ffffff';
  const noteBackground = hasNoteColor ? color : colors.surface;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: noteBackground }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
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
          {!hasCreated && (
            <TouchableOpacity onPress={handleToggleNoteType} style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]} testID="toggle-note-type">
              <Ionicons
                name={noteType === 'text' ? 'list' : 'document-text-outline'}
                size={22}
                color={colors.primary}
              />
              <Text style={[styles.typeToggleText, { color: colors.primary }]}>
                {noteType === 'text' ? t('note.typeTodo') : t('note.typeText')}
              </Text>
            </TouchableOpacity>
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
        style={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
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

        {noteType === 'text' ? (
          <TextInput
            ref={contentInputRef}
            style={[styles.contentInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
            value={content}
            onChangeText={handleContentChange}
            placeholder={t('note.contentPlaceholder')}
            placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
            multiline
            textAlignVertical="top"
            maxLength={VALIDATION.CONTENT_MAX_LENGTH}
            editable={!isHydrating}
            testID="note-content-input"
          />
        ) : (
          <View style={styles.todoContainer}>
            <DraggableFlatList
              data={uncheckedItems}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
              onDragBegin={handleTodoDragStart}
              onDragEnd={({ data }) => handleTodoReorder(data)}
              renderItem={renderTodoItem}
            />

            <TouchableOpacity style={styles.addItemRow} onPress={handleAddItem} testID="add-todo-item">
              <Ionicons name="add" size={22} color={colors.primary} />
              <Text style={[styles.addItemText, { color: colors.primary }]}>{t('note.addItem')}</Text>
            </TouchableOpacity>

            {checkedItems.length > 0 && (
              <View style={[styles.checkedSection, { borderTopColor: colors.borderLight }]}>
                <TouchableOpacity
                  style={styles.checkedHeader}
                  onPress={handleToggleCollapsed}
                  testID="toggle-checked-items"
                >
                  <Ionicons
                    name={checkedItemsCollapsed ? 'chevron-forward' : 'chevron-down'}
                    size={18}
                    color={colors.iconMuted}
                  />
                  <Text style={[styles.checkedHeaderText, { color: colors.textMuted }]}>
                    {t('note.completedItems', { count: checkedItems.length })}
                  </Text>
                </TouchableOpacity>

                {!checkedItemsCollapsed &&
                  checkedItems.map((item) => {
                    const originalIndex = itemIndexMap.get(item.id);
                    if (originalIndex === undefined) return null;
                    return (
                      <TodoItem
                        key={item.id}
                        inputRef={getItemRef(item.id)}
                        text={item.text}
                        completed={item.completed}
                        indentLevel={item.indent_level}
                        assignedTo={item.assigned_to}
                        isShared={!!isNoteShared}
                        collaborators={collaborators}
                        onToggle={() => handleToggleItem(originalIndex)}
                        onChangeText={(text) => handleItemTextChange(originalIndex, text)}
                        onDelete={() => handleDeleteItem(originalIndex)}
                        onSubmitEditing={() => handleInsertItemAfter(originalIndex)}
                        onBackspaceOnEmpty={() => handleBackspaceOnEmpty(originalIndex)}
                        onAssignPress={() => openAssigneePicker(item.id)}
                      />
                    );
                  })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <View style={[styles.toolbar, { backgroundColor: noteBackground, borderTopColor: hasNoteColor ? 'transparent' : colors.border }]}>
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
  todoContainer: {
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
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
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
  draggingTodoItem: {
    borderRadius: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
});
