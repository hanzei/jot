import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Note, User } from '@jot/shared';
import NoteCard from './NoteCard';

interface SortableNoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: ((noteId: string) => Promise<void> | void) | undefined;
  onShare: (note: Note) => void;
  onRestore?: ((noteId: string) => void) | undefined;
  onPermanentlyDelete?: ((noteId: string) => void) | undefined;
  currentUserId?: string | undefined;
  usersById?: Map<string, User> | undefined;
  disabled?: boolean;
  inBin?: boolean;
  onRefresh?: (() => void) | undefined;
  onLabelClick?: ((labelId: string) => void) | undefined;
}

export default function SortableNoteCard({
  note,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  onRestore,
  onPermanentlyDelete,
  currentUserId,
  usersById,
  disabled = false,
  inBin = false,
  onRefresh,
  onLabelClick,
}: SortableNoteCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: note.id,
    disabled: disabled
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-drag-disabled={disabled ? 'true' : 'false'}
      {...(!disabled ? attributes : {})}
      {...(!disabled ? listeners : {})}
      className={`group select-none relative ${
        disabled ? 'cursor-default' : isDragging ? 'cursor-grabbing scale-105 shadow-xl' : 'cursor-grab'
      }`}
    >
      <div className="group" style={{ pointerEvents: isDragging ? 'none' : 'auto' }}>
        <NoteCard
          note={note}
          onEdit={onEdit}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onShare={onShare}
          onRestore={onRestore}
          onPermanentlyDelete={onPermanentlyDelete}
          currentUserId={currentUserId}
          usersById={usersById}
          inBin={inBin}
          onRefresh={onRefresh}
          onLabelClick={onLabelClick}
        />
      </div>
    </div>
  );
}