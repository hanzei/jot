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
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCreateNote, useUpdateNote, useDeleteNote } from '../hooks/useNotes';
import { useOfflineNote } from '../hooks/useOfflineNotes';
import { isLocalId } from '../db/noteQueries';
import { useSSESubscription } from '../store/SSEContext';
import TodoItem from '../components/TodoItem';
import ColorPicker from '../components/ColorPicker';
import LabelPicker from '../components/LabelPicker';
import AssigneePicker from '../components/AssigneePicker';
import { buildCollaborators, Collaborator } from '../utils/collaborators';
import { useUsers } from '../store/UsersContext';
import { useTheme } from '../theme/ThemeContext';
import { NoteType, NoteItem, UpdateNoteRequest, Label } from '../types';
import type { RootStackParamList } from '../navigation/RootNavigator';

type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;
type EditorNavProp = NativeStackNavigationProp<RootStackParamList, 'NoteEditor'>;

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;
const AUTO_SAVE_DEBOUNCE_MS = 1000;

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

  const { colors } = useTheme();
  const { data: existingNote } = useOfflineNote(noteId);
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();

  // Show a toast when another user updates this note while editor is open
  useSSESubscription(noteId, useCallback(() => {
    setSyncToast((prev) => prev ?? 'This note was updated by another user');
  }, []));

  // Auto-dismiss sync toast after 4 seconds
  useEffect(() => {
    if (!syncToast) return;
    const timer = setTimeout(() => setSyncToast(null), 4000);
    return () => clearTimeout(timer);
  }, [syncToast]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
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

  const flushSave = useCallback(async (unmounting = false) => {
    // Skip save if editing an existing note that hasn't hydrated yet
    if (noteIdRef.current && !isInitializedRef.current) return;

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
        if (!currentTitle && !currentContent && currentItems.length === 0) return;
        const newNote = await createMutateRef.current({
          title: currentTitle,
          content: currentContent,
          note_type: currentNoteType,
          color: currentColor !== '#ffffff' ? currentColor : undefined,
          items: currentNoteType === 'todo' ? serializeItems(currentItems) : undefined,
        });
        if (!isMountedRef.current || unmounting) return;
        setNoteId(newNote.id);
        setHasCreated(true);
        setSaveError(null);
        if (newNote.items) {
          setItems(toLocalItems(newNote.items));
        }
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
        const updated = await updateMutateRef.current({
          id: currentNoteId,
          data: updateData,
        });
        if (!isMountedRef.current || unmounting) return;
        setSaveError(null);
        if (updated.items) {
          setItems(toLocalItems(updated.items));
        }
      }
    })();

    saveInFlightRef.current = thisPromise;
    try {
      await thisPromise;
    } catch (err) {
      console.error('Failed to save note:', err);
      if (isMountedRef.current && !unmounting) {
        setSaveError('Failed to save note. Tap to retry.');
      }
    } finally {
      if (saveInFlightRef.current === thisPromise) {
        saveInFlightRef.current = null;
      }
    }
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      flushSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
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
      if (newTitle.length > MAX_TITLE_LENGTH) return;
      setTitle(newTitle);
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (newContent.length > MAX_CONTENT_LENGTH) return;
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
      setItems((prev) => prev.map((item, i) => (i === index ? { ...item, text } : item)));
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleDeleteItem = useCallback(
    (index: number) => {
      setItems((prev) => prev.filter((_, i) => i !== index));
      scheduleUpdate();
    },
    [scheduleUpdate],
  );

  const handleAddItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      {
        id: nextTempId(),
        text: '',
        completed: false,
        position: prev.length,
        indent_level: 0,
        assigned_to: '',
      },
    ]);
    scheduleUpdate();
  }, [scheduleUpdate]);

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
    Alert.alert('Delete note', 'Move this note to trash?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
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
            Alert.alert('Error', 'Failed to delete note');
          }
        },
      },
    ]);
  }, [noteId, deleteMutation, navigation]);

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
      Alert.alert('Error', 'Failed to update note');
    }
  }, [noteId, updateMutation]);

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
      Alert.alert('Error', 'Failed to update note');
    }
  }, [noteId, updateMutation]);

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
      Alert.alert('Error', 'Failed to update note color');
    }
  }, [noteId, updateMutation]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'todo' : 'text'));
  }, [hasCreated]);

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
      return (
        <ScaleDecorator>
          <View style={isActive ? styles.draggingTodoItem : undefined}>
            <TodoItem
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
              onSubmitEditing={handleAddItem}
              onAssignPress={() => openAssigneePicker(item.id)}
            />
          </View>
        </ScaleDecorator>
      );
    },
    [handleToggleItem, handleItemTextChange, handleDeleteItem, handleAddItem, isNoteShared, collaborators, openAssigneePicker],
  );

  const hasNoteColor = color && color !== '#ffffff';
  const noteBackground = hasNoteColor ? color : colors.surface;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: noteBackground }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <View style={[styles.header, { backgroundColor: noteBackground, borderBottomColor: hasNoteColor ? 'transparent' : colors.borderLight }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} testID="editor-back">
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
                {noteType === 'text' ? 'Todo' : 'Text'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {saveError && (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: colors.errorLight }]}
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
          style={[styles.syncToast, { backgroundColor: colors.primaryLight }]}
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
          style={[styles.titleInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
          value={title}
          onChangeText={handleTitleChange}
          placeholder="Title"
          placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
          maxLength={MAX_TITLE_LENGTH}
          editable={!isHydrating}
          testID="note-title-input"
        />

        {noteType === 'text' ? (
          <TextInput
            style={[styles.contentInput, { color: hasNoteColor ? '#1a1a1a' : colors.text }]}
            value={content}
            onChangeText={handleContentChange}
            placeholder="Note"
            placeholderTextColor={hasNoteColor ? '#999' : colors.placeholder}
            multiline
            textAlignVertical="top"
            maxLength={MAX_CONTENT_LENGTH}
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
              <Text style={[styles.addItemText, { color: colors.primary }]}>Add item</Text>
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
                    {checkedItems.length} checked {checkedItems.length === 1 ? 'item' : 'items'}
                  </Text>
                </TouchableOpacity>

                {!checkedItemsCollapsed &&
                  checkedItems.map((item) => {
                    const originalIndex = itemIndexMap.get(item.id);
                    if (originalIndex === undefined) return null;
                    return (
                      <TodoItem
                        key={item.id}
                        text={item.text}
                        completed={item.completed}
                        indentLevel={item.indent_level}
                        assignedTo={item.assigned_to}
                        isShared={!!isNoteShared}
                        collaborators={collaborators}
                        onToggle={() => handleToggleItem(originalIndex)}
                        onChangeText={(text) => handleItemTextChange(originalIndex, text)}
                        onDelete={() => handleDeleteItem(originalIndex)}
                        onAssignPress={() => openAssigneePicker(item.id)}
                      />
                    );
                  })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <View style={[styles.toolbar, { backgroundColor: noteBackground, borderTopColor: hasNoteColor ? 'transparent' : colors.borderLight }]}>
        <TouchableOpacity
          onPress={() => setColorPickerVisible(true)}
          style={styles.toolbarBtn}
          testID="toolbar-color-btn"
          accessibilityLabel="Change color"
        >
          <Ionicons name="color-palette-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
        </TouchableOpacity>

        {noteId && !isLocalId(noteId) && (
          <TouchableOpacity
            onPress={() => setLabelPickerVisible(true)}
            style={styles.toolbarBtn}
            testID="toolbar-label-btn"
            accessibilityLabel="Labels"
          >
            <Ionicons name="pricetag-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

        {noteId && (
          <TouchableOpacity
            onPress={handleTogglePin}
            style={styles.toolbarBtn}
            testID="toolbar-pin-btn"
            accessibilityLabel={pinned ? 'Unpin note' : 'Pin note'}
          >
            <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={22} color={pinned ? colors.primary : (hasNoteColor ? '#444' : colors.icon)} />
          </TouchableOpacity>
        )}

        {noteId && (
          <TouchableOpacity
            onPress={handleToggleArchive}
            style={styles.toolbarBtn}
            testID="toolbar-archive-btn"
            accessibilityLabel={archived ? 'Unarchive note' : 'Archive note'}
          >
            <Ionicons
              name="archive-outline"
              size={22}
              color={archived ? colors.primary : (hasNoteColor ? '#444' : colors.icon)}
            />
          </TouchableOpacity>
        )}

        {noteId && !isLocalId(noteId) && existingNote && !existingNote.is_shared && (
          <TouchableOpacity
            onPress={() => navigation.navigate('Share', { noteId })}
            style={styles.toolbarBtn}
            testID="toolbar-share-btn"
            accessibilityLabel="Share note"
          >
            <Ionicons name="share-social-outline" size={22} color={hasNoteColor ? '#444' : colors.icon} />
          </TouchableOpacity>
        )}

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
    paddingTop: Platform.OS === 'ios' ? 56 : 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
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
    borderTopWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
    gap: 4,
  },
  toolbarBtn: {
    padding: 8,
  },
  errorBanner: {
    borderBottomWidth: 1,
    borderBottomColor: '#fecaca',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 14,
    textAlign: 'center',
  },
  syncToast: {
    borderBottomWidth: 1,
    borderBottomColor: '#bfdbfe',
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
