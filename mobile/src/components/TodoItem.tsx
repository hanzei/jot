import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  PanResponder,
  type TextInput as TextInputType,
  type PanResponderGestureState,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import { VALIDATION, type Collaborator } from '@jot/shared';

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
  onIndent?: (delta: 1 | -1) => void;
}

const INDENT_SWIPE_THRESHOLD_PX = 50;
const SWIPE_ACTIVATION_PX = 10;

function isHorizontalSwipe(gestureState: PanResponderGestureState): boolean {
  return Math.abs(gestureState.dx) > Math.abs(gestureState.dy) && Math.abs(gestureState.dx) >= SWIPE_ACTIVATION_PX;
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
  onIndent,
}: TodoItemProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignPress;
  const assignedUser = assignedTo ? collaborators?.find((c) => c.userId === assignedTo) : undefined;
  const normalizedIndentLevel = Math.max(0, indentLevel);
  const onIndentRef = useRef(onIndent);
  useEffect(() => {
    onIndentRef.current = onIndent;
  }, [onIndent]);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) => {
          if (!editable || !onIndentRef.current) return false;
          return isHorizontalSwipe(gestureState);
        },
        onPanResponderRelease: (_event, gestureState) => {
          if (!editable || !onIndentRef.current) return;
          if (!isHorizontalSwipe(gestureState)) return;
          if (Math.abs(gestureState.dx) < INDENT_SWIPE_THRESHOLD_PX) return;
          onIndentRef.current(gestureState.dx > 0 ? 1 : -1);
        },
      }),
    [editable],
  );

  return (
    <View
      style={[styles.container, { marginLeft: normalizedIndentLevel * VALIDATION.INDENT_PX_PER_LEVEL }]}
      testID="todo-item-row"
      {...panResponder.panHandlers}
    >
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
        multiline
        submitBehavior="submit"
        textAlignVertical="top"
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
    alignItems: 'flex-start',
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
    minWidth: 0,
    fontSize: 16,
    paddingVertical: 4,
    paddingRight: 4,
  },
  completedText: {
    textDecorationLine: 'line-through' as const,
  },
  deleteBtn: {
    padding: 4,
    marginLeft: 'auto',
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
