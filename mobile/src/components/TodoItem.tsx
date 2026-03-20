import React from 'react';
import { View, TextInput, StyleSheet, type TextInput as TextInputType } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import type { Collaborator } from '@jot/shared';

interface TodoItemProps {
  text: string;
  completed: boolean;
  indentLevel?: number;
  editable?: boolean;
  showDragHandle?: boolean;
  assignedTo?: string;
  isShared?: boolean;
  collaborators?: Collaborator[];
  inputRef?: React.RefObject<TextInputType | null>;
  onDrag?: () => void;
  onToggle?: () => void;
  onChangeText?: (text: string) => void;
  onDelete?: () => void;
  onSubmitEditing?: () => void;
  onBackspaceOnEmpty?: () => void;
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
  inputRef,
  onDrag,
  onToggle,
  onChangeText,
  onDelete,
  onSubmitEditing,
  onBackspaceOnEmpty,
  onAssignPress,
}: TodoItemProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignPress;
  const assignedUser = assignedTo ? collaborators?.find((c) => c.userId === assignedTo) : undefined;

  return (
    <View style={[styles.container, { marginLeft: indentLevel * 24 }]}>
      {showDragHandle && onDrag && (
        <TouchableOpacity
          onPressIn={onDrag}
          style={styles.dragHandle}
          testID="todo-item-drag-handle"
          accessibilityLabel={t('note.dragToReorder')}
        >
          <Ionicons name="reorder-three" size={20} color={colors.iconMuted} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={editable ? onToggle : undefined}
        style={styles.checkbox}
        testID="todo-item-checkbox"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: completed, disabled: !editable }}
        accessibilityLabel={t('note.itemCheckbox', { item: text || t('note.listItemLabel') })}
      >
        <Ionicons
          name={completed ? 'checkbox' : 'square-outline'}
          size={22}
          color={completed ? colors.primary : colors.iconMuted}
        />
      </TouchableOpacity>
      <TextInput
        ref={inputRef}
        style={[styles.textInput, { color: completed ? colors.textMuted : colors.text }, completed && styles.completedText]}
        value={text}
        onChangeText={onChangeText}
        editable={editable}
        placeholder={t('note.itemPlaceholder')}
        placeholderTextColor={colors.placeholder}
        returnKeyType="next"
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={false}
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === 'Backspace' && text === '') {
            onBackspaceOnEmpty?.();
          }
        }}
        testID="todo-item-text"
      />
      {showAssignUI && assignedTo ? (
        <TouchableOpacity
          onPress={!completed ? onAssignPress : undefined}
          style={styles.assignBtn}
          testID="todo-item-assignee"
          accessibilityLabel={t('note.assignedTo', {
            name: assignedUser?.username ?? t('common.unknown'),
          })}
        >
          <UserAvatar
            userId={assignedTo}
            username={assignedUser?.username ?? '?'}
            hasProfileIcon={assignedUser?.hasProfileIcon}
            size="small"
          />
        </TouchableOpacity>
      ) : showAssignUI && !completed ? (
        <TouchableOpacity
          onPress={onAssignPress}
          style={styles.assignBtn}
          testID="todo-item-assign"
          accessibilityLabel={t('note.assignItem')}
        >
          <View style={[styles.assignPlaceholder, { borderColor: colors.border }]}>
            <Ionicons name="person-add-outline" size={12} color={colors.iconMuted} />
          </View>
        </TouchableOpacity>
      ) : null}
      <View style={styles.spacer} />
      {editable && onDelete && (
        <TouchableOpacity onPress={onDelete} style={styles.deleteBtn} testID="todo-item-delete">
          <Ionicons name="close" size={18} color={colors.iconMuted} />
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
    flexShrink: 1,
    fontSize: 16,
    paddingVertical: 4,
  },
  spacer: {
    flex: 1,
  },
  completedText: {
    textDecorationLine: 'line-through' as const,
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
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default React.memo(TodoItem);
