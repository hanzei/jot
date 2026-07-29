import React, { type ComponentProps, useCallback, useEffect } from 'react';
import { useReorderableDrag, useIsActive, useReorderableDragStart } from 'react-native-reorderable-list';
import Reanimated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { VALIDATION } from '@jot/shared';
import ListItem from '../../components/ListItem';
import { indentLevelFromDrag } from './listItemModel';

// Local number copy so the animated-style worklet can multiply by it on the UI
// thread without a property access on the imported VALIDATION object.
const INDENT_PX = VALIDATION.INDENT_PX_PER_LEVEL;

type ListItemProps = ComponentProps<typeof ListItem>;

interface ActiveListRowProps {
  /** Everything ListItem needs except the drag wiring, which this row supplies. */
  listItemProps: Omit<ListItemProps, 'onDrag' | 'isActive'>;
  /** Live horizontal drag distance, written by the list pan's onChange. */
  dragTranslateX: SharedValue<number>;
  /** Indent level of this item when a drag begins (0 top-level, 1 nested). */
  indentBaseLevel: number;
  /** Whether this item may be indented further during a drag. */
  canIndent: boolean;
  /** Whether this item may be outdented during a drag. */
  canOutdent: boolean;
}

/**
 * A single row of the active (unchecked) checklist, rendered by
 * react-native-reorderable-list. It must be a component (not an inline
 * renderItem return) so it can call the library's `useReorderableDrag` /
 * `useIsActive` hooks. The drag handle's long-press triggers `drag()`, and the
 * row lifts (shadow) while active.
 *
 * While active, the row also follows the finger horizontally: the list pan's
 * onChange records translationX into `dragTranslateX`, and this row snaps that to
 * an indent step so it visibly shifts as you drag sideways (Google Keep style).
 * The drag start resets the shared value so each drag begins from zero.
 *
 * The displayed indent is the sum of the committed level (ListItem's marginLeft,
 * from `indentBaseLevel`) plus a transform for the still-uncommitted delta. The
 * delta is held in `displayLevel`: while dragging it tracks the live drag, and on
 * drop it keeps the committed level until this row re-renders with its new
 * `indentBaseLevel`. Without that hold the transform would snap to zero a frame
 * before the new marginLeft lands, making the row flash back to its pre-drag
 * level and then jump to the dropped level.
 *
 * The lift cue (a subtle scale) comes from the reorderable list's own cell
 * animation, so this row adds no shadow/box of its own.
 */
function ActiveListRow({
  listItemProps,
  dragTranslateX,
  indentBaseLevel,
  canIndent,
  canOutdent,
}: ActiveListRowProps) {
  const drag = useReorderableDrag();
  const isActive = useIsActive();

  // The level this row should currently display. Seeded from (and kept in step
  // with) the committed level, but free to lead it during and right after a drag.
  const displayLevel = useSharedValue(indentBaseLevel);

  useReorderableDragStart(() => {
    'worklet';
    dragTranslateX.set(0);
  });

  // While this row is the lifted one, snap the live horizontal drag distance to a
  // target indent level. When the drag ends `isActive` flips false and this stops
  // updating, so `displayLevel` freezes at the dropped level until the committed
  // re-render catches up (see the effect below) — that hold is what removes the
  // snap-back flash on release.
  useAnimatedReaction(
    () => dragTranslateX.get(),
    (translateX) => {
      if (!isActive) return;
      displayLevel.set(indentLevelFromDrag(translateX, indentBaseLevel, canIndent, canOutdent));
    },
    [isActive, indentBaseLevel, canIndent, canOutdent],
  );

  // Once the drop is committed (or the indent changes outside a drag, e.g. via
  // normalization or sync), the new committed level arrives as `indentBaseLevel`
  // and ListItem's marginLeft renders it. Bring `displayLevel` back in step so the
  // transform contributes nothing and the two never disagree.
  useEffect(() => {
    displayLevel.set(indentBaseLevel);
  }, [indentBaseLevel, displayLevel]);

  const handleDrag = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    drag();
  }, [drag]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (displayLevel.get() - indentBaseLevel) * INDENT_PX }],
  }));

  return (
    <Reanimated.View style={animatedStyle}>
      <ListItem {...listItemProps} onDrag={handleDrag} isActive={isActive} />
    </Reanimated.View>
  );
}

export default React.memo(ActiveListRow);
