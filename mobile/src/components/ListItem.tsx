import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  Animated,
  type TextInputProps,
  type TextInput as TextInputType,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import { isReduceMotionEnabledSync } from '../utils/layoutAnimation';
import { VALIDATION, type Collaborator } from '@jot/shared';

interface ListItemProps {
  text: string;
  completed: boolean;
  indentLevel?: number;
  editable?: boolean;
  isActive?: boolean;
  showDragHandle?: boolean;
  assignedTo?: string;
  isShared?: boolean;
  collaborators?: Collaborator[];
  inputRef?: React.RefObject<TextInputType | null>;
  inputAccessoryViewID?: string;
  hasNoteColor?: boolean;
  completedItemTexts?: string[];
  /**
   * When true, the checkbox pops (scales up from small) once on mount. Set only
   * for the item the user just checked off, so the completed-section row it
   * mounts into animates — without popping every completed row on load/expand.
   */
  popOnMount?: boolean;
  onDrag?: () => void;
  onToggle?: () => void;
  onChangeText?: (text: string) => void;
  onDelete?: () => void;
  onSubmitEditing?: () => void;
  onBackspaceOnEmpty?: () => void;
  onAssignPress?: () => void;
  onFocus?: TextInputProps['onFocus'];
  onAcceptSuggestion?: (text: string) => void;
}

// Press-and-hold duration on the drag handle before a reorder drag begins.
const DRAG_HANDLE_LONG_PRESS_MS = 180;

function ListItem({
  text,
  completed,
  indentLevel = 0,
  editable = true,
  isActive = false,
  showDragHandle = false,
  assignedTo,
  isShared,
  collaborators,
  inputRef,
  inputAccessoryViewID,
  hasNoteColor = false,
  completedItemTexts,
  popOnMount = false,
  onDrag,
  onToggle,
  onChangeText,
  onDelete,
  onSubmitEditing,
  onBackspaceOnEmpty,
  onAssignPress,
  onFocus,
  onAcceptSuggestion,
}: ListItemProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  // Pop the checkbox in on mount when this row is the one the user just checked
  // off. Runs once (mount-only) so re-renders don't re-trigger it; respects the
  // OS Reduce Motion setting like the rest of the editor's animations.
  const checkScaleRef = useRef<Animated.Value | null>(null);
  if (checkScaleRef.current === null) {
    checkScaleRef.current = new Animated.Value(popOnMount && !isReduceMotionEnabledSync() ? 0.5 : 1);
  }
  const checkScale = checkScaleRef.current;
  useEffect(() => {
    if (!popOnMount || isReduceMotionEnabledSync()) return;
    const animation = Animated.spring(checkScale, {
      toValue: 1,
      friction: 4,
      tension: 160,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
    // Mount-only: popOnMount/checkScale are fixed for this row's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const suggestions = useMemo(() => {
    if (!completedItemTexts || !text.trim()) return [];
    const q = text.trim().toLowerCase();
    const results: string[] = [];
    for (const s of completedItemTexts) {
      const lower = s.toLowerCase();
      if (lower.includes(q) && lower !== q) {
        results.push(s);
        if (results.length === 5) break;
      }
    }
    return results;
  }, [text, completedItemTexts]);

  const effectiveText = hasNoteColor ? '#1a1a1a' : colors.text;
  const effectiveTextMuted = hasNoteColor ? '#777' : colors.textMuted;
  const effectivePlaceholder = hasNoteColor ? '#999' : colors.placeholder;
  const effectiveIconMuted = hasNoteColor ? '#888' : colors.iconMuted;
  const effectiveBorder = hasNoteColor ? '#bbb' : colors.border;
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignPress;
  const assignedUser = assignedTo ? collaborators?.find((c) => c.userId === assignedTo) : undefined;
  const normalizedIndentLevel = Math.max(0, indentLevel);

  // Indenting/outdenting is driven by dragging the row sideways (handled by the
  // reorderable list in NoteEditorScreen) and by the indent toolbar buttons —
  // this component no longer hosts a swipe-to-indent gesture of its own.
  return (
    <View
      style={[styles.container, { marginLeft: normalizedIndentLevel * VALIDATION.INDENT_PX_PER_LEVEL }]}
      testID="list-item-row"
    >
      {showDragHandle && onDrag && (
        <TouchableOpacity
          onLongPress={onDrag}
          // Shorten the press-and-hold before a drag starts; the default (~500ms)
          // feels sluggish for a dedicated drag handle.
          delayLongPress={DRAG_HANDLE_LONG_PRESS_MS}
          disabled={isActive}
          // Don't dim on press: the long-press hands off to the reorder drag
          // without a press-out, which otherwise leaves the handle stuck faded.
          activeOpacity={1}
          style={styles.dragHandle}
          testID="list-item-drag-handle"
          accessibilityLabel={t('note.dragToReorderIndent')}
        >
          {/* Six-dot drag-handle glyph: the conventional "grab to drag" affordance
              (drag vertically to reorder, horizontally to indent/outdent). */}
          <MaterialIcons name="drag-indicator" size={22} color={effectiveIconMuted} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={editable ? onToggle : undefined}
        style={styles.checkbox}
        testID="list-item-checkbox"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: completed, disabled: !editable }}
        accessibilityLabel={t('note.itemCheckbox', { item: text || t('note.listItemLabel') })}
      >
        <Animated.View style={{ transform: [{ scale: checkScale }] }}>
          <Ionicons
            name={completed ? 'checkbox' : 'square-outline'}
            size={22}
            color={completed ? colors.primary : effectiveIconMuted}
          />
        </Animated.View>
      </TouchableOpacity>
      <View style={styles.inputColumn}>
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            style={[styles.textInput, { color: completed ? effectiveTextMuted : effectiveText }, completed && styles.completedText]}
            value={text}
            onChangeText={(newText) => {
              onChangeText?.(newText);
              if (!completed) setShowSuggestions(newText.trim().length > 0);
            }}
            editable={editable}
            placeholder={t('note.itemPlaceholder')}
            placeholderTextColor={effectivePlaceholder}
            returnKeyType="next"
            onSubmitEditing={onSubmitEditing}
            blurOnSubmit={false}
            onFocus={(event) => {
              onFocus?.(event);
              if (!completed) setShowSuggestions(true);
            }}
            onBlur={() => {
              blurTimeoutRef.current = setTimeout(() => setShowSuggestions(false), 200);
            }}
            multiline
            submitBehavior="submit"
            textAlignVertical="top"
            inputAccessoryViewID={inputAccessoryViewID}
            onKeyPress={({ nativeEvent }) => {
              if (nativeEvent.key === 'Backspace' && text === '') {
                onBackspaceOnEmpty?.();
              }
            }}
            testID="list-item-text"
          />
          {showAssignUI && assignedTo ? (
            <TouchableOpacity
              onPress={!completed ? onAssignPress : undefined}
              style={styles.assignBtn}
              testID="list-item-assignee"
              accessibilityLabel={t('note.assignedTo', {
                name: assignedUser?.username ?? t('common.unknown'),
              })}
            >
              <UserAvatar
                userId={assignedTo}
                username={assignedUser?.username ?? '?'}
                hasProfileIcon={assignedUser?.hasProfileIcon}
                iconVersion={assignedUser?.iconVersion}
                size="small"
              />
            </TouchableOpacity>
          ) : showAssignUI && !completed ? (
            <TouchableOpacity
              onPress={onAssignPress}
              style={styles.assignBtn}
              testID="list-item-assign"
              accessibilityLabel={t('note.assignItem')}
            >
              <View style={[styles.assignPlaceholder, { borderColor: effectiveBorder }]}>
                <Ionicons name="person-add-outline" size={12} color={effectiveIconMuted} />
              </View>
            </TouchableOpacity>
          ) : null}
          {editable && onDelete && (
            <TouchableOpacity onPress={onDelete} style={styles.deleteBtn} testID="list-item-delete">
              <Ionicons name="close" size={18} color={effectiveIconMuted} />
            </TouchableOpacity>
          )}
        </View>
        {showSuggestions && suggestions.length > 0 && !completed && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={styles.suggestionsRow}
            contentContainerStyle={styles.suggestionsContent}
            accessibilityLabel={t('note.completedSuggestions')}
          >
            {suggestions.map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.suggestionChip, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
                onPress={() => {
                  if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
                  setShowSuggestions(false);
                  onAcceptSuggestion?.(s);
                }}
                testID={`suggestion-chip-${s}`}
                accessibilityRole="button"
              >
                <Text style={[styles.suggestionChipText, { color: colors.primary }]} numberOfLines={1}>
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
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
  inputColumn: {
    flex: 1,
    minWidth: 0,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
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
  suggestionsRow: {
    marginTop: 2,
    marginBottom: 2,
  },
  suggestionsContent: {
    gap: 6,
    paddingRight: 8,
  },
  suggestionChip: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
    maxWidth: 180,
  },
  suggestionChipText: {
    fontSize: 13,
  },
});

export default React.memo(ListItem);
