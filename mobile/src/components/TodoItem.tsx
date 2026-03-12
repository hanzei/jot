import React from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NoteItem } from '../types';

interface Props {
  item: NoteItem;
  onTextChange: (text: string) => void;
  onToggle: () => void;
  onDelete: () => void;
}

export default function TodoItem({ item, onTextChange, onToggle, onDelete }: Props) {
  return (
    <View style={[styles.row, item.indent_level > 0 && styles.indented]}>
      <TouchableOpacity
        onPress={onToggle}
        style={styles.checkbox}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.completed }}
        accessibilityLabel={item.completed ? 'Mark incomplete' : 'Mark complete'}
      >
        <Ionicons
          name={item.completed ? 'checkbox' : 'square-outline'}
          size={22}
          color={item.completed ? '#1a73e8' : '#666'}
        />
      </TouchableOpacity>
      <TextInput
        style={[styles.input, item.completed && styles.inputCompleted]}
        value={item.text}
        onChangeText={onTextChange}
        placeholder="List item"
        accessibilityLabel="Todo item text"
        allowFontScaling
      />
      <TouchableOpacity
        onPress={onDelete}
        style={styles.deleteBtn}
        accessibilityRole="button"
        accessibilityLabel="Delete item"
      >
        <Ionicons name="close" size={18} color="#999" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    minHeight: 48,
  },
  indented: { paddingLeft: 24 },
  checkbox: { marginRight: 8, width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  input: { flex: 1, fontSize: 16, padding: 4 },
  inputCompleted: { textDecorationLine: 'line-through', color: '#999' },
  deleteBtn: { padding: 4, minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' },
});
