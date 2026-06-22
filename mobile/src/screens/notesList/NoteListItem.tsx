import React, { useCallback } from 'react';
import type { Note } from '@jot/shared';
import NoteCard from '../../components/NoteCard';

interface NoteListItemProps {
  note: Note;
  onPress: (id: string) => void;
  onMenuPress?: (note: Note) => void;
  onLongPress?: (note: Note) => void;
  onLabelPress?: (labelId: string, labelName: string) => void;
}

const NoteListItem = React.memo(function NoteListItem({
  note,
  onPress,
  onMenuPress,
  onLongPress,
  onLabelPress,
}: NoteListItemProps) {
  const handlePress = useCallback(() => onPress(note.id), [onPress, note.id]);
  const handleMenuPress = useCallback(() => onMenuPress?.(note), [onMenuPress, note]);
  const handleLongPress = useCallback(() => onLongPress?.(note), [onLongPress, note]);

  return (
    <NoteCard
      note={note}
      onPress={handlePress}
      onMenuPress={onMenuPress ? handleMenuPress : undefined}
      onLongPress={onLongPress ? handleLongPress : undefined}
      onLabelPress={onLabelPress}
    />
  );
});

export default NoteListItem;
