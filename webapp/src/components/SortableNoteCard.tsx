import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Note, User } from '@jot/shared';
import NoteCard from './NoteCard';

interface SortableNoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onDuplicate?: (noteId: string) => Promise<void> | void;
  onShare: (note: Note) => void;
  onRestore?: (noteId: string) => void;
  onPermanentlyDelete?: (noteId: string) => void;
  currentUserId?: string;
  usersById?: Map<string, User>;
  disabled?: boolean;
  inBin?: boolean;
  onRefresh?: () => void;
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
        />
      </div>
    </div>
  );
}