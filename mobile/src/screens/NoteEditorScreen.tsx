import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCreateNote, useUpdateNote, useDeleteNote } from '../hooks/useNotes';
import ColorPicker from '../components/ColorPicker';
import TodoItem from '../components/TodoItem';
import type { Note, NoteItem } from '../types';

interface Props {
  note: Note | null;
  onClose: () => void;
  onShare: (note: Note) => void;
}

export default function NoteEditorScreen({ note, onClose, onShare }: Props) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [color, setColor] = useState(note?.color ?? '#ffffff');
  const [noteType, setNoteType] = useState(note?.note_type ?? 'text');
  const [items, setItems] = useState<NoteItem[]>(note?.items ?? []);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(note?.id ?? null);

  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasCreated = useRef(!!note?.id);

  const saveNote = useCallback(
    async (t: string, c: string, col: string, its: NoteItem[]) => {
      if (!t && !c && its.length === 0) return;

      const itemPayload = its.map((i) => ({
        text: i.text,
        position: i.position,
        completed: i.completed,
        indent_level: i.indent_level,
      }));

      if (!hasCreated.current) {
        hasCreated.current = true;
        const created = await createNote.mutateAsync({
          title: t,
          content: c,
          note_type: noteType,
          color: col,
          items: noteType === 'todo' ? itemPayload : undefined,
        });
        setCurrentNoteId(created.id);
      } else if (currentNoteId) {
        await updateNote.mutateAsync({
          id: currentNoteId,
          data: {
            title: t,
            content: c,
            pinned: note?.pinned ?? false,
            archived: note?.archived ?? false,
            color: col,
            checked_items_collapsed: note?.checked_items_collapsed ?? false,
            items: noteType === 'todo' ? itemPayload : undefined,
          },
        });
      }
    },
    [currentNoteId, noteType, note, createNote, updateNote]
  );

  const scheduleSave = useCallback(
    (t: string, c: string, col: string, its: NoteItem[]) => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
      saveTimeout.current = setTimeout(() => saveNote(t, c, col, its), 1000);
    },
    [saveNote]
  );

  useEffect(() => {
    return () => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
    };
  }, []);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    scheduleSave(text, content, color, items);
  };

  const handleContentChange = (text: string) => {
    setContent(text);
    scheduleSave(title, text, color, items);
  };

  const handleColorChange = (newColor: string) => {
    setColor(newColor);
    setShowColorPicker(false);
    scheduleSave(title, content, newColor, items);
  };

  const handleAddItem = () => {
    const newItem: NoteItem = {
      id: `temp_${Date.now()}`,
      note_id: currentNoteId ?? '',
      text: '',
      completed: false,
      position: items.length,
      indent_level: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const updated = [...items, newItem];
    setItems(updated);
    scheduleSave(title, content, color, updated);
  };

  const handleItemChange = (index: number, text: string) => {
    const updated = items.map((item, i) => (i === index ? { ...item, text } : item));
    setItems(updated);
    scheduleSave(title, content, color, updated);
  };

  const handleItemToggle = (index: number) => {
    const updated = items.map((item, i) =>
      i === index ? { ...item, completed: !item.completed } : item
    );
    setItems(updated);
    scheduleSave(title, content, color, updated);
  };

  const handleItemDelete = (index: number) => {
    const updated = items.filter((_, i) => i !== index);
    setItems(updated);
    scheduleSave(title, content, color, updated);
  };

  const handleDelete = () => {
    Alert.alert('Move to Trash', 'Move this note to trash?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Move to Trash',
        style: 'destructive',
        onPress: () => {
          if (currentNoteId) deleteNote.mutate(currentNoteId);
          onClose();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: color }]}>
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="arrow-back" size={24} color="#333" />
        </TouchableOpacity>
        <View style={styles.toolbarActions}>
          <TouchableOpacity
            onPress={() => setShowColorPicker(!showColorPicker)}
            style={styles.toolbarBtn}
            accessibilityRole="button"
            accessibilityLabel="Change color"
          >
            <Ionicons name="color-palette-outline" size={24} color="#333" />
          </TouchableOpacity>
          {currentNoteId && (
            <TouchableOpacity
              onPress={() => {
                const currentNote = note ?? {
                  id: currentNoteId,
                  title,
                  content,
                  color,
                  note_type: noteType,
                  user_id: '',
                  pinned: false,
                  archived: false,
                  position: 0,
                  checked_items_collapsed: false,
                  is_shared: false,
                  labels: [],
                  items,
                  deleted_at: null,
                  created_at: '',
                  updated_at: '',
                } as Note;
                onShare(currentNote);
              }}
              style={styles.toolbarBtn}
              accessibilityRole="button"
              accessibilityLabel="Share note"
            >
              <Ionicons name="person-add-outline" size={24} color="#333" />
            </TouchableOpacity>
          )}
          {currentNoteId && (
            <TouchableOpacity
              onPress={handleDelete}
              style={styles.toolbarBtn}
              accessibilityRole="button"
              accessibilityLabel="Delete note"
            >
              <Ionicons name="trash-outline" size={24} color="#333" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {showColorPicker && (
        <ColorPicker currentColor={color} onSelect={handleColorChange} />
      )}

      {!note && (
        <View style={styles.typeToggle}>
          <TouchableOpacity
            onPress={() => setNoteType('text')}
            style={[styles.typeBtn, noteType === 'text' && styles.typeBtnActive]}
            accessibilityRole="button"
            accessibilityLabel="Text note"
          >
            <Text style={[styles.typeBtnText, noteType === 'text' && styles.typeBtnTextActive]}>
              Text
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setNoteType('todo')}
            style={[styles.typeBtn, noteType === 'todo' && styles.typeBtnActive]}
            accessibilityRole="button"
            accessibilityLabel="Todo list"
          >
            <Text style={[styles.typeBtnText, noteType === 'todo' && styles.typeBtnTextActive]}>
              Todo
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          style={styles.titleInput}
          placeholder="Title"
          value={title}
          onChangeText={handleTitleChange}
          multiline
          maxLength={200}
          accessibilityLabel="Note title"
          allowFontScaling
        />

        {noteType === 'text' ? (
          <TextInput
            style={styles.contentInput}
            placeholder="Note..."
            value={content}
            onChangeText={handleContentChange}
            multiline
            maxLength={10000}
            textAlignVertical="top"
            accessibilityLabel="Note content"
            allowFontScaling
          />
        ) : (
          <View>
            {items.map((item, index) => (
              <TodoItem
                key={item.id}
                item={item}
                onTextChange={(text) => handleItemChange(index, text)}
                onToggle={() => handleItemToggle(index)}
                onDelete={() => handleItemDelete(index)}
              />
            ))}
            <TouchableOpacity
              style={styles.addItemBtn}
              onPress={handleAddItem}
              accessibilityRole="button"
              accessibilityLabel="Add todo item"
            >
              <Ionicons name="add" size={20} color="#666" />
              <Text style={styles.addItemText}>Add item</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  toolbarActions: { flexDirection: 'row', alignItems: 'center' },
  toolbarBtn: { marginLeft: 16, minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  typeToggle: { flexDirection: 'row', padding: 8, gap: 8 },
  typeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  typeBtnActive: { backgroundColor: '#1a73e8', borderColor: '#1a73e8' },
  typeBtnText: { color: '#666', fontSize: 14 },
  typeBtnTextActive: { color: '#fff' },
  scroll: { flex: 1, padding: 16 },
  titleInput: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  contentInput: { fontSize: 16, minHeight: 200 },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    minHeight: 48,
  },
  addItemText: { color: '#666', marginLeft: 8, fontSize: 16 },
});
