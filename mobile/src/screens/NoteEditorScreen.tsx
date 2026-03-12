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
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useNote, useCreateNote, useUpdateNote, useDeleteNote } from '../hooks/useNotes';
import TodoItem from '../components/TodoItem';
import { NoteType, NoteItem, UpdateNoteRequest } from '../types';
import type { RootStackParamList } from '../navigation/RootNavigator';

type EditorRouteProp = RouteProp<RootStackParamList, 'NoteEditor'>;

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;
const AUTO_SAVE_DEBOUNCE_MS = 1000;

interface LocalItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  indent_level: number;
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
    }));
}

function serializeItems(items: LocalItem[]) {
  return items.map((item, i) => ({
    text: item.text,
    position: i,
    completed: item.completed,
    indent_level: item.indent_level,
  }));
}

export default function NoteEditorScreen() {
  const navigation = useNavigation();
  const route = useRoute<EditorRouteProp>();
  const { noteId: initialNoteId } = route.params;

  const [noteId, setNoteId] = useState<string | null>(initialNoteId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('text');
  const [items, setItems] = useState<LocalItem[]>([]);
  const [checkedItemsCollapsed, setCheckedItemsCollapsed] = useState(false);
  const [hasCreated, setHasCreated] = useState(initialNoteId !== null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: existingNote } = useNote(noteId);
  const createMutation = useCreateNote();
  const updateMutation = useUpdateNote();
  const deleteMutation = useDeleteNote();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isInitializedRef = useRef(false);
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
      if (existingNote.items) {
        setItems(toLocalItems(existingNote.items));
      }
      isInitializedRef.current = true;
    }
  }, [existingNote]);

  const flushSave = useCallback(async (unmounting = false) => {
    const currentNoteId = noteIdRef.current;
    const currentTitle = titleRef.current;
    const currentContent = contentRef.current;
    const currentItems = itemsRef.current;
    const currentCollapsed = checkedItemsCollapsedRef.current;
    const currentNoteType = noteTypeRef.current;

    if (!currentNoteId) {
      if (!currentTitle && !currentContent && currentItems.length === 0) return;
      try {
        const newNote = await createMutateRef.current({
          title: currentTitle,
          content: currentContent,
          note_type: currentNoteType,
          items: currentNoteType === 'todo' ? serializeItems(currentItems) : undefined,
        });
        if (!isMountedRef.current || unmounting) return;
        setNoteId(newNote.id);
        setHasCreated(true);
        setSaveError(null);
        if (newNote.items) {
          setItems(toLocalItems(newNote.items));
        }
      } catch (err) {
        console.error('Failed to create note:', err);
        if (isMountedRef.current && !unmounting) {
          setSaveError('Failed to save note. Tap to retry.');
        }
      }
    } else {
      try {
        const updateData: UpdateNoteRequest = {
          title: currentTitle,
          content: currentContent,
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
      } catch (err) {
        console.error('Failed to update note:', err);
        if (isMountedRef.current && !unmounting) {
          setSaveError('Failed to save note. Tap to retry.');
        }
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

  // Flush pending save on unmount (prevent data loss)
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      flushSave(true);
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
      },
    ]);
    scheduleUpdate();
  }, [scheduleUpdate]);

  const handleToggleCollapsed = useCallback(() => {
    setCheckedItemsCollapsed((prev) => !prev);
    scheduleUpdate();
  }, [scheduleUpdate]);

  const handleDelete = useCallback(() => {
    if (!noteId) {
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
            // Cancel any pending save
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            await deleteMutation.mutateAsync(noteId);
            navigation.goBack();
          } catch {
            Alert.alert('Error', 'Failed to delete note');
          }
        },
      },
    ]);
  }, [noteId, deleteMutation, navigation]);

  const handleToggleNoteType = useCallback(() => {
    if (hasCreated) return;
    setNoteType((prev) => (prev === 'text' ? 'todo' : 'text'));
  }, [hasCreated]);

  // Build index lookup for items to avoid O(n) indexOf per item
  const itemIndexMap = useMemo(
    () => new Map(items.map((item, i) => [item.id, i])),
    [items],
  );
  const uncheckedItems = useMemo(() => items.filter((item) => !item.completed), [items]);
  const checkedItems = useMemo(() => items.filter((item) => item.completed), [items]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} testID="editor-back">
          <Ionicons name="arrow-back" size={24} color="#1a1a1a" />
        </TouchableOpacity>
        <View style={styles.headerRight}>
          {!hasCreated && (
            <TouchableOpacity onPress={handleToggleNoteType} style={styles.typeToggle} testID="toggle-note-type">
              <Ionicons
                name={noteType === 'text' ? 'list' : 'document-text-outline'}
                size={22}
                color="#2563eb"
              />
              <Text style={styles.typeToggleText}>
                {noteType === 'text' ? 'Todo' : 'Text'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {saveError && (
        <TouchableOpacity
          style={styles.errorBanner}
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
          <Text style={styles.errorText}>{saveError}</Text>
        </TouchableOpacity>
      )}

      <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={handleTitleChange}
          placeholder="Title"
          placeholderTextColor="#999"
          maxLength={MAX_TITLE_LENGTH}
          testID="note-title-input"
        />

        {noteType === 'text' ? (
          <TextInput
            style={styles.contentInput}
            value={content}
            onChangeText={handleContentChange}
            placeholder="Note"
            placeholderTextColor="#999"
            multiline
            textAlignVertical="top"
            maxLength={MAX_CONTENT_LENGTH}
            testID="note-content-input"
          />
        ) : (
          <View style={styles.todoContainer}>
            {uncheckedItems.map((item) => {
              const originalIndex = itemIndexMap.get(item.id);
              if (originalIndex === undefined) return null;
              return (
                <TodoItem
                  key={item.id}
                  text={item.text}
                  completed={item.completed}
                  indentLevel={item.indent_level}
                  onToggle={() => handleToggleItem(originalIndex)}
                  onChangeText={(text) => handleItemTextChange(originalIndex, text)}
                  onDelete={() => handleDeleteItem(originalIndex)}
                  onSubmitEditing={handleAddItem}
                />
              );
            })}

            <TouchableOpacity style={styles.addItemRow} onPress={handleAddItem} testID="add-todo-item">
              <Ionicons name="add" size={22} color="#2563eb" />
              <Text style={styles.addItemText}>Add item</Text>
            </TouchableOpacity>

            {checkedItems.length > 0 && (
              <View style={styles.checkedSection}>
                <TouchableOpacity
                  style={styles.checkedHeader}
                  onPress={handleToggleCollapsed}
                  testID="toggle-checked-items"
                >
                  <Ionicons
                    name={checkedItemsCollapsed ? 'chevron-forward' : 'chevron-down'}
                    size={18}
                    color="#999"
                  />
                  <Text style={styles.checkedHeaderText}>
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
                        onToggle={() => handleToggleItem(originalIndex)}
                        onChangeText={(text) => handleItemTextChange(originalIndex, text)}
                        onDelete={() => handleDeleteItem(originalIndex)}
                      />
                    );
                  })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <View style={styles.toolbar}>
        <TouchableOpacity onPress={handleDelete} style={styles.toolbarBtn} testID="delete-note-btn">
          <Ionicons name="trash-outline" size={22} color="#ef4444" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 56 : 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
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
    backgroundColor: '#eff6ff',
  },
  typeToggleText: {
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '500',
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: 16,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1a1a1a',
    paddingVertical: 16,
    paddingHorizontal: 0,
  },
  contentInput: {
    fontSize: 16,
    color: '#1a1a1a',
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
    color: '#2563eb',
  },
  checkedSection: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
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
    color: '#999',
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
    backgroundColor: '#fff',
  },
  toolbarBtn: {
    padding: 8,
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderBottomWidth: 1,
    borderBottomColor: '#fecaca',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    color: '#dc2626',
    fontSize: 14,
    textAlign: 'center',
  },
});
