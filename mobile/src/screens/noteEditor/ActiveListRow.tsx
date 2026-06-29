import React, { type ComponentProps, useCallback } from 'react';
import { View } from 'react-native';
import { useReorderableDrag, useIsActive } from 'react-native-reorderable-list';
import * as Haptics from 'expo-haptics';
import ListItem from '../../components/ListItem';
import { styles } from './styles';

type ListItemProps = ComponentProps<typeof ListItem>;

interface ActiveListRowProps {
  /** Everything ListItem needs except the drag wiring, which this row supplies. */
  listItemProps: Omit<ListItemProps, 'onDrag' | 'isActive'>;
  /** Shadow color applied to the lifted row while it is being dragged. */
  draggingShadowColor: string;
}

/**
 * A single row of the active (unchecked) checklist, rendered by
 * react-native-reorderable-list. It must be a component (not an inline
 * renderItem return) so it can call the library's `useReorderableDrag` /
 * `useIsActive` hooks. The drag handle's long-press triggers `drag()`, and the
 * row lifts (shadow) while active.
 */
function ActiveListRow({ listItemProps, draggingShadowColor }: ActiveListRowProps) {
  const drag = useReorderableDrag();
  const isActive = useIsActive();

  const handleDrag = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    drag();
  }, [drag]);

  return (
    <View style={isActive ? [styles.draggingListItem, { shadowColor: draggingShadowColor }] : undefined}>
      <ListItem {...listItemProps} onDrag={handleDrag} isActive={isActive} />
    </View>
  );
}

export default React.memo(ActiveListRow);
