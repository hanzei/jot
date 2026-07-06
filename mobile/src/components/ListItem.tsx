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
import { GripVertical, Square, SquareCheck, UserPlus, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import { useTheme } from '../theme/ThemeContext';
import { getEffectiveColors } from '../theme/colors';
import { isReduceMotionEnabledSync } from '../utils/layoutAnimation';
import { VALIDATION, type Collaborator } from '@jot/shared';

interface ListItemProps {
  text: string;
  completed: boolean;
  indentLevel?: number;
  editable?: boolean;
  isActive?: boolean;
  showDragHandle?: boolean;
  /**
   * Reserve the drag handle's horizontal footprint without rendering a handle,
   * so rows that never show one (e.g. completed items) keep their checkboxes
   * aligned with the active rows that do.
   */
  reserveDragHandleSpace?: boolean;
  assignedTo?: string;
  isShared?: boolean;
  collaborators?: Collaborator[];
  inputRef?: React.RefObject<TextInputType | null>;
  autoFocus?: boolean;
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
  onSubmitEditing?: (cursorPosition: number) => void;
  onBackspaceOnEmpty?: () => void;
  onAssignPress?: () => void;
  onFocus?: TextInputProps['onFocus'];
  onAcceptSuggestion?: (text: string) => void;
}

// Press-and-hold duration on the drag handle before a reorder drag begins.
const DRAG_HANDLE_LONG_PRESS_MS = 180;

// Drag handle geometry. These feed both styles.dragHandle / the GripVertical
// icon below and the exported DRAG_HANDLE_WIDTH, so the reserved width stays in
// sync with the actual handle if any of them change.
const DRAG_HANDLE_ICON_SIZE = 22;
const DRAG_HANDLE_PADDING = 4;
const DRAG_HANDLE_MARGIN_RIGHT = 4;

// Horizontal footprint of the drag handle (icon + padding on both sides +
// marginRight). Exported so rows that don't render a handle — e.g. the
// completed-items section — can reserve the same width and keep their checkboxes
// aligned with the active rows above.
export const DRAG_HANDLE_WIDTH = DRAG_HANDLE_ICON_SIZE + DRAG_HANDLE_PADDING * 2 + DRAG_HANDLE_MARGIN_RIGHT;

// Delay before hiding focus-gated controls (delete/assign) and suggestions on
// blur, so a tap on those controls — which blurs the input first — still lands
// before they unmount.
const BLUR_HIDE_DELAY_MS = 200;

function ListItem({
  text,
  completed,
  indentLevel = 0,
  editable = true,
  isActive = false,
  showDragHandle = false,
  reserveDragHandleSpace = false,
  assignedTo,
  isShared,
  collaborators,
  inputRef,
  autoFocus = false,
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
  // The delete (x) button is only shown while this row is focused (the "selected"
  // row), so users are less likely to delete an item they didn't mean to.
  const [isFocused, setIsFocused] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the native cursor position so Enter/submit can decide whether to
  // split the item at the cursor, insert before it, or append after it.
  // Seeded to the end of the current text and refined by onSelectionChange,
  // since onSubmitEditing's native event carries no selection info.
  const selectionRef = useRef({ start: text.length, end: text.length });

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

  const {
    text: effectiveText,
    textSecondary: effectiveTextSecondary,
    icon: effectiveIcon,
    iconMuted: effectiveIconMuted,
    border: effectiveBorder,
  } = getEffectiveColors(hasNoteColor, colors);
  const showAssignUI = isShared && collaborators && collaborators.length > 0 && onAssignPress;
  const assignedUser = assignedTo ? collaborators?.find((c) => c.userId === assignedTo) : undefined;
  const normalizedIndentLevel = Math.max(0, indentLevel);

  // Indenting/outdenting is driven entirely by dragging the row sideways
  // (handled by the reorderable list in NoteEditorScreen); this component hosts
  // no indent gesture or control of its own.
  return (
    <View
      style={[styles.container, { marginLeft: normalizedIndentLevel * VALIDATION.INDENT_PX_PER_LEVEL }]}
      testID="list-item-row"
    >
      {showDragHandle && onDrag ? (
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
          <GripVertical size={DRAG_HANDLE_ICON_SIZE} color={effectiveIcon} />
        </TouchableOpacity>
      ) : reserveDragHandleSpace ? (
        <View style={styles.dragHandleSpacer} testID="list-item-drag-handle-spacer" />
      ) : null}
      <TouchableOpacity
        onPress={editable ? onToggle : undefined}
        style={styles.checkbox}
        testID="list-item-checkbox"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: completed, disabled: !editable }}
        accessibilityLabel={t('note.itemCheckbox', { item: text || t('note.listItemLabel') })}
      >
        <Animated.View style={{ transform: [{ scale: checkScale }] }}>
          {completed ? (
            <SquareCheck size={22} color={effectiveIcon} />
          ) : (
            <Square size={22} color={effectiveIcon} />
          )}
        </Animated.View>
      </TouchableOpacity>
      <View style={styles.inputColumn}>
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            autoFocus={autoFocus}
            style={[styles.textInput, { color: completed ? effectiveTextSecondary : effectiveText }, completed && styles.completedText]}
            value={text}
            onChangeText={(newText) => {
              onChangeText?.(newText);
              // Approximate the cursor moving to the end of freshly typed text;
              // onSelectionChange refines this once the native event arrives.
              selectionRef.current = { start: newText.length, end: newText.length };
              if (!completed) setShowSuggestions(newText.trim().length > 0);
            }}
            onSelectionChange={(event) => {
              selectionRef.current = event.nativeEvent.selection;
            }}
            editable={editable}
            returnKeyType="next"
            onSubmitEditing={() => onSubmitEditing?.(selectionRef.current.start)}
            blurOnSubmit={false}
            onFocus={(event) => {
              if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
              setIsFocused(true);
              onFocus?.(event);
              if (!completed) setShowSuggestions(true);
            }}
            onBlur={() => {
              // Delay hiding so a tap on the delete button (which blurs the input
              // first) still lands before the button unmounts.
              blurTimeoutRef.current = setTimeout(() => {
                setShowSuggestions(false);
                setIsFocused(false);
              }, BLUR_HIDE_DELAY_MS);
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
          ) : showAssignUI && !completed && isFocused ? (
            <TouchableOpacity
              onPress={onAssignPress}
              style={styles.assignBtn}
              testID="list-item-assign"
              accessibilityLabel={t('note.assignItem')}
            >
              <View style={[styles.assignPlaceholder, { borderColor: effectiveBorder }]}>
                <UserPlus size={12} color={effectiveIconMuted} />
              </View>
            </TouchableOpacity>
          ) : null}
          {editable && onDelete && isFocused && (
            <TouchableOpacity
              onPress={onDelete}
              style={styles.deleteBtn}
              // Keep the tap target generous even though the button's own padding
              // is small — a smaller footprint keeps the row height stable when
              // this button appears on focus (see deleteBtn style note).
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              testID="list-item-delete"
              accessibilityLabel={t('note.removeItem')}
            >
              <X size={22} color={effectiveIconMuted} />
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
    padding: DRAG_HANDLE_PADDING,
    marginRight: DRAG_HANDLE_MARGIN_RIGHT,
  },
  dragHandleSpacer: {
    width: DRAG_HANDLE_WIDTH,
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
    // Match the checkbox's padding (4) so this button — which only appears while
    // the row is focused — has the same height as the always-present checkbox.
    // A larger padding made the focused row taller than the unfocused one,
    // shifting every item below it down when a row was selected. The tap target
    // is kept comfortable via hitSlop on the button itself.
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
