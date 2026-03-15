import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import UserAvatar from './UserAvatar';
import type { Collaborator } from '../utils/collaborators';

interface TodoItemProps {
  text: string;
  completed: boolean;
  indentLevel?: number;
  editable?: boolean;
  showDragHandle?: boolean;
  assignedTo?: string;
  isShared?: boolean;
  collaborators?: Collaborator[];
  onDrag?: () => void;
  onToggle?: () => void;
  onChangeText?: (text: string) => void;
  onDelete?: () => void;
  onSubmitEditing?: () => void;
  onAssignPress?: () => void;
}

function TodoItem({
  text,
  completed,
  indentLevel = 0,
  editable = true,
  showDragHandle = false,
  assignedTo,
  isShared,
  collaborators,
  onDrag,
  onToggle,
  onChangeText,
  onDelete,
  onSubmitEditing,
  onAssignPress,
}: TodoItemProps) {
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignPress;
  const assignedUser = assignedTo ? collaborators?.find((c) => c.userId === assignedTo) : undefined;

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
      {showAssignUI && (
        assignedTo ? (
          <TouchableOpacity
            onPress={!completed ? onAssignPress : undefined}
            style={styles.assignBtn}
            testID="todo-item-assignee"
            accessibilityLabel={`Assigned to ${assignedUser?.username ?? 'user'}`}
          >
            <UserAvatar
              userId={assignedTo}
              username={assignedUser?.username ?? '?'}
              hasProfileIcon={assignedUser?.hasProfileIcon}
              size="small"
            />
          </TouchableOpacity>
        ) : (
          !completed && (
            <TouchableOpacity
              onPress={onAssignPress}
              style={styles.assignBtn}
              testID="todo-item-assign"
              accessibilityLabel="Assign item"
            >
              <View style={styles.assignPlaceholder}>
                <Ionicons name="person-add-outline" size={12} color="#999" />
              </View>
            </TouchableOpacity>
          )
        )
      )}
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
  assignBtn: {
    padding: 4,
    marginLeft: 4,
  },
  assignPlaceholder: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#ccc',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default React.memo(TodoItem);
