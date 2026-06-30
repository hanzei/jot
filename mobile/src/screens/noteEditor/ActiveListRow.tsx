import React, { type ComponentProps, useCallback } from 'react';
import { useReorderableDrag, useIsActive, useReorderableDragStart } from 'react-native-reorderable-list';
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
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

  useReorderableDragStart(() => {
    'worklet';
    dragTranslateX.value = 0;
  });

  const handleDrag = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    drag();
  }, [drag]);

  const animatedStyle = useAnimatedStyle(() => {
    if (!isActive) return { transform: [{ translateX: 0 }] };
    const level = indentLevelFromDrag(dragTranslateX.value, indentBaseLevel, canIndent, canOutdent);
    return { transform: [{ translateX: (level - indentBaseLevel) * INDENT_PX }] };
  });

  return (
    <Reanimated.View style={animatedStyle}>
      <ListItem {...listItemProps} onDrag={handleDrag} isActive={isActive} />
    </Reanimated.View>
  );
}

export default React.memo(ActiveListRow);
