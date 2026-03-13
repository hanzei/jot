import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

interface TodoItemProps {
  text: string;
  completed: boolean;
  indentLevel?: number;
  editable?: boolean;
  showDragHandle?: boolean;
  onDrag?: () => void;
  onToggle?: () => void;
  onChangeText?: (text: string) => void;
  onDelete?: () => void;
  onSubmitEditing?: () => void;
}

function TodoItem({
  text,
  completed,
  indentLevel = 0,
  editable = true,
  showDragHandle = false,
  onDrag,
  onToggle,
  onChangeText,
  onDelete,
  onSubmitEditing,
}: TodoItemProps) {
  return (
    <View style={[styles.container, { marginLeft: indentLevel * 24 }]}>
      {showDragHandle && onDrag && (
        <TouchableOpacity
          onPressIn={onDrag}
          style={styles.dragHandle}
          testID="todo-item-drag-handle"
          accessibilityLabel="Drag to reorder"
        >
          <Ionicons name="reorder-three" size={20} color="#999" />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={editable ? onToggle : undefined}
        style={styles.checkbox}
        testID="todo-item-checkbox"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: completed, disabled: !editable }}
        accessibilityLabel={`${text || 'List item'} checkbox`}
      >
        <Ionicons
          name={completed ? 'checkbox' : 'square-outline'}
          size={22}
          color={completed ? '#2563eb' : '#999'}
        />
      </TouchableOpacity>
      <TextInput
        style={[styles.textInput, completed && styles.completedText]}
        value={text}
        onChangeText={onChangeText}
        editable={editable}
        placeholder="List item"
        placeholderTextColor="#999"
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={false}
        testID="todo-item-text"
      />
      {editable && onDelete && (
        <TouchableOpacity onPress={onDelete} style={styles.deleteBtn} testID="todo-item-delete">
          <Ionicons name="close" size={18} color="#999" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    minHeight: 40,
  },
  dragHandle: {
    padding: 4,
    marginRight: 4,
  },
  checkbox: {
    padding: 4,
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    color: '#1a1a1a',
    paddingVertical: 4,
  },
  completedText: {
    textDecorationLine: 'line-through',
    color: '#999',
  },
  deleteBtn: {
    padding: 4,
    marginLeft: 4,
  },
});

export default React.memo(TodoItem);
