import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  Animated,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
  type TextInputProps,
  type TextInput as TextInputType,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { GripVertical, Square, SquareCheck, UserPlus, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import UserAvatar from './UserAvatar';
import InlineMarkdown from './InlineMarkdown';
import { renderInlineNodes } from './inlineNodes';
import { useTheme } from '../theme/ThemeContext';
import { getEffectiveColors } from '../theme/colors';
import { isReduceMotionEnabledSync } from '../utils/layoutAnimation';
import { inlineMarkdownNodes, inlineMarkdownToText } from '../utils/inlineMarkdown';
import { sourceOffsetAtPoint, type RenderedTextLine } from '../utils/inlineCaret';
import { inlineRendersAsSource, VALIDATION, type Collaborator, type TextSelection } from '@jot/shared';

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
  onBlur?: () => void;
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

// Delete (x) button geometry, mirroring the drag handle above: the button only
// renders while a row is focused, so its width is reserved with a same-sized
// spacer the rest of the time. Without that, focusing a row would shrink the
// text input's available width, reflowing text and causing an unwanted line
// break right when the item was selected.
const DELETE_BTN_ICON_SIZE = 22;
const DELETE_BTN_PADDING = 4;
const DELETE_BTN_WIDTH = DELETE_BTN_ICON_SIZE + DELETE_BTN_PADDING * 2;

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
  onBlur,
  onAcceptSuggestion,
}: ListItemProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [showSuggestions, setShowSuggestions] = useState(false);
  // The delete (x) button is only shown while this row is focused (the "selected"
  // row), so users are less likely to delete an item they didn't mean to.
  const [isFocused, setIsFocused] = useState(false);
  // Focused and editing are the same state (docs/specs/markdown-rendering.md §1.2),
  // so this is `isFocused` without its blur delay: the controls linger for 200ms
  // so a tap on one still lands, but the row must show source the instant it has
  // the caret and stop the instant it doesn't.
  const [isEditing, setIsEditing] = useState(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the native cursor position so Enter/submit can decide whether to
  // split the item at the cursor, insert before it, or append after it.
  // Seeded to the end of the current text and refined by onSelectionChange,
  // since onSubmitEditing's native event carries no selection info.
  const selectionRef = useRef({ start: text.length, end: text.length });
  // A caret position asked for by a tap on the rendered text, held as a
  // controlled `selection` until the input reports it landed — the same
  // force-and-release the note editor's formatting bar uses, for the same
  // reason: focus alone puts the caret wherever the platform likes.
  const [forcedSelection, setForcedSelection] = useState<TextSelection | null>(null);
  // Where the rendered form's lines landed, for mapping a tap back to a source
  // offset. A ref, not state: it is read inside a tap handler and never changes
  // what is on screen, so re-rendering the row for it would be pure churn.
  // Tagged with the text it measured, since a layout pass trails the text that
  // caused it and a tap in between would otherwise map through the old lines.
  const renderedLinesRef = useRef<{ text: string; lines: RenderedTextLine[] } | null>(null);
  // The row's own handle on its input. `inputRef` belongs to the note editor,
  // which uses it to move focus between rows, and is optional — but tap-to-edit
  // has to focus the field whether or not anyone passed one.
  const ownInputRef = useRef<TextInputType | null>(null);
  // Set by a tap on the rendered text, cleared by the effect below once the
  // input is back in flow. See there for why the focus cannot happen in the tap
  // handler itself.
  const focusAfterSwapRef = useRef(false);

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  const setInputRef = useCallback(
    (node: TextInputType | null) => {
      ownInputRef.current = node;
      if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  // Pop the checkbox in on mount when this row is the one the user just checked
  // off. Runs once (mount-only) so re-renders don't re-trigger it; respects the
  // OS Reduce Motion setting like the rest of the editor's animations.
  const [checkScale] = useState(
    () => new Animated.Value(popOnMount && !isReduceMotionEnabledSync() ? 0.5 : 1),
  );
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

  // Links are inert in an editable row and live in a read-only one, so only the
  // editable row's nodes are built here — `InlineMarkdown` owns the read-only
  // one and its live links (docs/specs/markdown-rendering.md §1.2).
  const nodes = useMemo(() => (editable ? inlineMarkdownNodes(text) : []), [editable, text]);

  // A row only swaps when rendering actually changes what is on screen. `buy
  // milk` renders to `buy milk`, so a list with no Markdown in it keeps the
  // always-live input it has always had and pays for none of this.
  const formatted = useMemo(() => nodes.length > 0 && !inlineRendersAsSource(nodes, text), [nodes, text]);
  const wantsRendered = formatted && !isEditing;

  // A drag must not change the row's height, so the form is frozen while one is
  // in flight: whatever the row was showing when the finger went down is what it
  // shows until the drop lands. Without it, anything that takes focus off the
  // field mid-gesture — the keyboard being dismissed, most likely — would collapse
  // the row to its other form while the reorderable list is dragging a cell it
  // has already measured.
  //
  // Adjusted during render rather than in an effect: an effect would apply it a
  // frame late, and that frame is the one the list measures in.
  const [frozenForm, setFrozenForm] = useState<boolean | null>(null);
  if (isActive !== (frozenForm !== null)) setFrozenForm(isActive ? wantsRendered : null);
  const showRendered = frozenForm ?? wantsRendered;

  const handleRenderedTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      renderedLinesRef.current = { text, lines: event.nativeEvent.lines };
    },
    [text],
  );

  // Entering edit mode from a tap has to place the caret itself: the user
  // pointed at the rendered text and the field behind it holds the source.
  //
  // It cannot focus the input here, though. While the rendered form is showing,
  // the input is out of flow, transparent and inside a `pointerEvents: 'none'`
  // wrapper — and neither platform will focus a field in that state. iOS refuses
  // `becomeFirstResponder` for a view with user interaction disabled; Android's
  // `requestFocus` falls through to the next focusable field in the window,
  // which is the note title at the top of the editor. So the tap ends the
  // rendered form and the effect below focuses once that has been committed.
  const handleRenderedPress = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      const measured = renderedLinesRef.current;
      const lines = measured?.text === text ? measured.lines : null;
      const offset = sourceOffsetAtPoint(nodes, text, lines, locationX, locationY);
      setIsEditing(true);
      focusAfterSwapRef.current = true;
      // Nothing to force when the caret is already there: the input would report
      // no selection change, so the controlled value would never be released.
      if (offset !== selectionRef.current.start || offset !== selectionRef.current.end) {
        setForcedSelection({ start: offset, end: offset });
      }
    },
    [nodes, text],
  );

  // The other half of the tap: focus the field on the commit that put it back in
  // flow. Keyed on `showRendered` rather than run unconditionally so a row
  // frozen mid-drag waits for the drop instead of focusing a field that is still
  // hidden.
  useEffect(() => {
    if (showRendered || !focusAfterSwapRef.current) return;
    focusAfterSwapRef.current = false;
    ownInputRef.current?.focus();
  }, [showRendered]);

  const {
    text: effectiveText,
    textSecondary: effectiveTextSecondary,
    icon: effectiveIcon,
    iconMuted: effectiveIconMuted,
    border: effectiveBorder,
  } = getEffectiveColors(hasNoteColor, colors);
  // One tone for both forms of the row rather than reasoned about twice:
  // whatever a completed row looks like, the rendered text and the input it
  // stands in for have to look like each other.
  const textTone = [
    { color: completed ? effectiveTextSecondary : effectiveText },
    completed && styles.completedText,
  ];
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
        // The item's words, not its Markdown source: every row renders the text,
        // so raw markers here would announce something the user never sees.
        accessibilityLabel={t('note.itemCheckbox', {
          item: inlineMarkdownToText(text) || t('note.listItemLabel'),
        })}
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
          {/* Every row renders the inline Markdown subset; an editable one shows
              source for exactly as long as it holds the caret
              (docs/specs/markdown-rendering.md §1.2). The input is never
              unmounted, only taken out of flow — moving focus between two
              mounted TextInputs keeps the software keyboard up, and moving it
              across an unmount does not. */}
          {editable ? (
            <View style={styles.textStack}>
              <View
                style={showRendered ? styles.offscreenInput : undefined}
                // While the rendered form is on top, the input must not take the
                // tap that is meant to place a caret in it.
                pointerEvents={showRendered ? 'none' : 'auto'}
              >
                <TextInput
                  ref={setInputRef}
                  autoFocus={autoFocus}
                  style={[styles.itemText, textTone]}
                  value={text}
                  selection={forcedSelection ?? undefined}
                  onChangeText={(newText) => {
                    onChangeText?.(newText);
                    // Approximate the cursor moving to the end of freshly typed text;
                    // onSelectionChange refines this once the native event arrives.
                    selectionRef.current = { start: newText.length, end: newText.length };
                    if (!completed) setShowSuggestions(newText.trim().length > 0);
                  }}
                  onSelectionChange={(event) => {
                    const selection = event.nativeEvent.selection;
                    selectionRef.current = selection;
                    // Release a tapped-for caret only once the input confirms it
                    // landed, so an event that arrives before the move is applied
                    // cannot cancel it.
                    setForcedSelection((forced) =>
                      forced && forced.start === selection.start && forced.end === selection.end
                        ? null
                        : forced,
                    );
                  }}
                  returnKeyType="next"
                  onSubmitEditing={() => onSubmitEditing?.(selectionRef.current.start)}
                  blurOnSubmit={false}
                  onFocus={(event) => {
                    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
                    setIsFocused(true);
                    setIsEditing(true);
                    onFocus?.(event);
                    if (!completed) setShowSuggestions(true);
                  }}
                  onBlur={() => {
                    onBlur?.();
                    setIsEditing(false);
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
              </View>
              {showRendered && (
                <Text
                  style={[styles.itemText, textTone]}
                  onPress={handleRenderedPress}
                  onTextLayout={handleRenderedTextLayout}
                  // The tap places a caret; a press highlight would announce a
                  // button that isn't there.
                  suppressHighlighting
                  // The input behind it is the row's real control and carries the
                  // value, so this is decoration for anyone not looking at it.
                  // The input is not relabelled with the rendered words to match:
                  // its value is the source, which is what a screen reader user
                  // is about to edit, and the row's checkbox already announces
                  // the words (`inlineMarkdownToText`).
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  testID="list-item-text-rendered"
                >
                  {/* Inert links: one tap in an editable row already means "put
                      the caret here", and a second meaning on the same pixel has
                      no way to resolve itself. */}
                  {renderInlineNodes(nodes, { links: false })}
                </Text>
              )}
            </View>
          ) : (
            <InlineMarkdown text={text} testID="list-item-text-readonly" style={[styles.itemText, textTone]} />
          )}
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
          {editable && onDelete ? (
            isFocused ? (
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
                <X size={DELETE_BTN_ICON_SIZE} color={effectiveIconMuted} />
              </TouchableOpacity>
            ) : (
              <View style={styles.deleteBtnSpacer} testID="list-item-delete-spacer" />
            )
          ) : null}
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
  // Holds the two forms of the row's text. Whichever is showing is the one in
  // flow, so this column — and therefore the row — is as tall as it.
  textStack: {
    flex: 1,
    minWidth: 0,
  },
  // Everything that decides how much vertical space a line of item text takes:
  // width, font metrics and padding. Both forms carry all of it, or the row
  // changes height on the swap for no reason other than the two being laid out
  // differently.
  //
  // Two of these are not obvious, and both are here to take the *platform* out
  // of the question rather than to match it:
  //
  // - `lineHeight`. Left unset, a Text and a TextInput each derive their line
  //   height from the font, and on Android the two do not agree — the input adds
  //   the font's own ascent/descent padding on top. Pinning it makes each box
  //   `lines × lineHeight + padding` from the same numbers on either platform.
  //   22 is what 16pt resolved to on the fonts this was measured against, so
  //   nothing moves today; the cost is that item text no longer follows an
  //   unusually tall face.
  // - `paddingLeft`. An Android TextInput inherits the theme's EditText padding
  //   on any side a style does not set (ReactTextInputManager.setPadding), and a
  //   Text inherits nothing — so leaving it unset indents the source form a few
  //   dp further than the rendered one, and wraps it that much earlier. Setting
  //   it costs Android those few dp it was never asked for, in both forms rather
  //   than one.
  itemText: {
    fontSize: 16,
    lineHeight: 22,
    paddingVertical: 4,
    paddingLeft: 0,
    paddingRight: 4,
  },
  // The input while the rendered form has the row: still mounted, still
  // focusable, just out of flow and invisible. `display: 'none'` would unmount
  // it natively and take the keyboard with it.
  offscreenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
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
    padding: DELETE_BTN_PADDING,
    marginLeft: 'auto',
  },
  deleteBtnSpacer: {
    width: DELETE_BTN_WIDTH,
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
